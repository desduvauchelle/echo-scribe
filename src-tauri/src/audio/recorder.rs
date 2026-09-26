use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, Stream};
use thiserror::Error;
use tracing::{info, warn};

/// Number of amplitude buckets sent to the overlay for visualization.
const LEVEL_BUCKETS: usize = 16;

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error("no default input device")]
    NoDevice,
    #[error("preferred input device '{0}' not found")]
    PreferredDeviceMissing(String),
    #[error("failed to build input stream: {0}")]
    BuildStream(String),
    #[error("failed to start input stream: {0}")]
    StartStream(String),
    #[error("recorder is not running")]
    NotRunning,
}

impl RecorderError {
    /// Short slug for the failure category, used in the UI/event payload so
    /// the frontend can tailor the message without parsing the error string.
    pub fn kind(&self) -> &'static str {
        match self {
            RecorderError::NoDevice => "no_device",
            RecorderError::PreferredDeviceMissing(_) => "preferred_missing",
            RecorderError::BuildStream(_) => "build_stream",
            RecorderError::StartStream(_) => "start_stream",
            RecorderError::NotRunning => "not_running",
        }
    }
}

/// Optional callback that receives amplitude levels for overlay visualization.
pub type LevelCallback = Arc<dyn Fn(Vec<f32>) + Send + Sync>;
pub type ChunkCallback = Arc<dyn Fn(&[f32], u32, u16) + Send + Sync>;

pub struct Recorder {
    stream: Option<Stream>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
    level_callback: Option<LevelCallback>,
    preferred_device_name: Option<String>,
    /// Name of the device the most recent successful start() actually used.
    active_device_name: Option<String>,
    chunk_callback: Option<ChunkCallback>,
    buffer_limit_secs: Arc<AtomicUsize>,
    levels_enabled: Arc<AtomicBool>,
    stream_failed: Arc<AtomicBool>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            stream: None,
            samples: Arc::new(Mutex::new(Vec::new())),
            sample_rate: 0,
            channels: 0,
            level_callback: None,
            preferred_device_name: None,
            active_device_name: None,
            chunk_callback: None,
            buffer_limit_secs: Arc::new(AtomicUsize::new(0)),
            levels_enabled: Arc::new(AtomicBool::new(true)),
            stream_failed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Register a callback that receives audio level data (16 f32 values in
    /// 0..1) at roughly 20 Hz. Used to drive the overlay waveform bars.
    pub fn set_level_callback<F: Fn(Vec<f32>) + Send + Sync + 'static>(&mut self, cb: F) {
        self.level_callback = Some(Arc::new(cb));
    }

    /// Standby audio is bounded in RAM. Zero preserves normal dictation.
    pub fn set_buffer_limit_secs(&self, seconds: usize) {
        self.buffer_limit_secs.store(seconds, Ordering::Relaxed);
    }

    pub fn set_levels_enabled(&self, enabled: bool) {
        self.levels_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn set_chunk_callback(&mut self, callback: Option<ChunkCallback>) {
        self.chunk_callback = callback;
    }

    pub fn stream_failed(&self) -> bool {
        self.stream_failed.load(Ordering::Relaxed)
    }

    pub fn discard(&mut self) {
        self.stream.take();
        if let Ok(mut samples) = self.samples.lock() {
            samples.clear();
        }
    }

    /// Set the preferred input device by name. `None` (default) means "use the
    /// system default input." When set to `Some(name)`, `start()` will refuse
    /// to record (returning [`RecorderError::PreferredDeviceMissing`]) if the
    /// named device is not currently enumerable — no silent fallback.
    pub fn set_preferred_device(&mut self, name: Option<String>) {
        self.preferred_device_name = name;
    }

    /// Returns the name of the device the last successful `start()` used, or
    /// `None` if the recorder has never started successfully.
    pub fn active_device_name(&self) -> Option<&str> {
        self.active_device_name.as_deref()
    }

    pub fn start(&mut self) -> Result<(), RecorderError> {
        let host = cpal::default_host();
        let (device, resolved_name) = if let Some(preferred) = &self.preferred_device_name {
            let mut found: Option<cpal::Device> = None;
            match host.input_devices() {
                Ok(it) => {
                    for d in it {
                        if let Ok(n) = d.name() {
                            if n == *preferred {
                                found = Some(d);
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        ?e,
                        "failed to enumerate input devices while resolving preferred"
                    );
                }
            }
            match found {
                Some(d) => (d, preferred.clone()),
                None => return Err(RecorderError::PreferredDeviceMissing(preferred.clone())),
            }
        } else {
            let d = host.default_input_device().ok_or(RecorderError::NoDevice)?;
            let n = d.name().unwrap_or_else(|_| "<unknown>".to_string());
            (d, n)
        };

        let config = device
            .default_input_config()
            .map_err(|e| RecorderError::BuildStream(e.to_string()))?;
        self.sample_rate = config.sample_rate().0;
        self.channels = config.channels();
        info!(
            device = %resolved_name,
            sample_rate = self.sample_rate,
            channels = self.channels,
            format = ?config.sample_format(),
            "starting recorder"
        );

        // Reset buffer
        if let Ok(mut s) = self.samples.lock() {
            s.clear();
        }

        let samples = Arc::clone(&self.samples);
        let level_cb = self.level_callback.clone();
        let chunk_cb = self.chunk_callback.clone();
        let buffer_limit = Arc::clone(&self.buffer_limit_secs);
        let levels_enabled = Arc::clone(&self.levels_enabled);
        self.stream_failed.store(false, Ordering::Relaxed);
        let stream_failed = Arc::clone(&self.stream_failed);
        let sample_rate = self.sample_rate;
        // Accumulate samples between level emissions. At 48 kHz we want ~50 ms
        // windows (2400 samples) to emit levels at ~20 Hz.
        let emit_threshold = (self.sample_rate as usize / 20).max(512);
        let pending_count = Arc::new(Mutex::new(0usize));

        let stream_config = config.config();
        let channels = self.channels;
        let stream = match config.sample_format() {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    append_samples_bounded(
                        &samples,
                        data,
                        buffer_limit.load(Ordering::Relaxed)
                            * sample_rate as usize
                            * channels as usize,
                    );
                    if let Some(ref cb) = chunk_cb {
                        cb(data, sample_rate, channels);
                    }
                    if let Some(ref cb) = level_cb
                        .as_ref()
                        .filter(|_| levels_enabled.load(Ordering::Relaxed))
                    {
                        maybe_emit_levels(data, channels, &pending_count, emit_threshold, cb);
                    }
                },
                move |err| {
                    stream_failed.store(true, Ordering::Relaxed);
                    warn!(?err, "input stream error");
                },
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples_bounded(
                        &samples,
                        &converted,
                        buffer_limit.load(Ordering::Relaxed)
                            * sample_rate as usize
                            * channels as usize,
                    );
                    if let Some(ref cb) = chunk_cb {
                        cb(&converted, sample_rate, channels);
                    }
                    if let Some(ref cb) = level_cb
                        .as_ref()
                        .filter(|_| levels_enabled.load(Ordering::Relaxed))
                    {
                        maybe_emit_levels(&converted, channels, &pending_count, emit_threshold, cb);
                    }
                },
                move |err| {
                    stream_failed.store(true, Ordering::Relaxed);
                    warn!(?err, "input stream error");
                },
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples_bounded(
                        &samples,
                        &converted,
                        buffer_limit.load(Ordering::Relaxed)
                            * sample_rate as usize
                            * channels as usize,
                    );
                    if let Some(ref cb) = chunk_cb {
                        cb(&converted, sample_rate, channels);
                    }
                    if let Some(ref cb) = level_cb
                        .as_ref()
                        .filter(|_| levels_enabled.load(Ordering::Relaxed))
                    {
                        maybe_emit_levels(&converted, channels, &pending_count, emit_threshold, cb);
                    }
                },
                move |err| {
                    stream_failed.store(true, Ordering::Relaxed);
                    warn!(?err, "input stream error");
                },
                None,
            ),
            other => {
                return Err(RecorderError::BuildStream(format!(
                    "unsupported sample format {:?}",
                    other
                )))
            }
        }
        .map_err(|e| RecorderError::BuildStream(e.to_string()))?;

        stream
            .play()
            .map_err(|e| RecorderError::StartStream(e.to_string()))?;
        self.stream = Some(stream);
        self.active_device_name = Some(resolved_name);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(Vec<f32>, u32), RecorderError> {
        let stream = self.stream.take().ok_or(RecorderError::NotRunning)?;
        drop(stream); // dropping stops the cpal stream
        let samples = self
            .samples
            .lock()
            .map(|mut s| std::mem::take(&mut *s))
            .unwrap_or_default();
        info!(sample_count = samples.len(), "stopped recorder");
        Ok((samples, self.sample_rate))
    }

    /// Channel count of the most recently started capture stream. Returns 0
    /// if the recorder has never been started.
    pub fn channels(&self) -> u16 {
        self.channels
    }
}

fn append_samples_bounded(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32], limit: usize) {
    if let Ok(mut b) = buf.lock() {
        if limit == 0 {
            b.extend_from_slice(data);
        } else if data.len() >= limit {
            b.clear();
            b.extend_from_slice(&data[data.len() - limit..]);
        } else {
            let excess = (b.len() + data.len()).saturating_sub(limit);
            b.drain(..excess);
            b.extend_from_slice(data);
        }
    }
}

#[cfg(test)]
mod buffer_tests {
    use super::*;

    #[test]
    fn standby_keeps_only_recent_audio_then_promotes_without_losing_preroll() {
        let samples = Arc::new(Mutex::new(Vec::new()));
        append_samples_bounded(&samples, &[1.0, 2.0, 3.0], 3);
        append_samples_bounded(&samples, &[4.0, 5.0], 3);
        assert_eq!(*samples.lock().unwrap(), vec![3.0, 4.0, 5.0]);
        append_samples_bounded(&samples, &[6.0, 7.0], 8);
        assert_eq!(*samples.lock().unwrap(), vec![3.0, 4.0, 5.0, 6.0, 7.0]);
        append_samples_bounded(&samples, &[8.0, 9.0, 10.0, 11.0], 3);
        assert_eq!(*samples.lock().unwrap(), vec![9.0, 10.0, 11.0]);
    }

    #[test]
    fn normal_dictation_remains_unbounded_and_discard_releases_audio() {
        let mut recorder = Recorder::new();
        append_samples_bounded(&recorder.samples, &[1.0, 2.0, 3.0], 0);
        append_samples_bounded(&recorder.samples, &[4.0], 0);
        assert_eq!(recorder.samples.lock().unwrap().len(), 4);
        recorder.discard();
        assert!(recorder.samples.lock().unwrap().is_empty());
    }
}

/// Accumulates sample count and emits levels once we cross the threshold.
fn maybe_emit_levels(
    data: &[f32],
    channels: u16,
    pending: &Arc<Mutex<usize>>,
    threshold: usize,
    cb: &LevelCallback,
) {
    let mut count = match pending.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    *count += data.len();
    if *count < threshold {
        return;
    }
    *count = 0;

    let levels = compute_levels(data, channels.max(1) as usize);
    cb(levels);
}

/// Compute `LEVEL_BUCKETS` amplitude values from the most recent audio chunk.
///
/// We mix to mono, split into buckets, and compute RMS for each. The result
/// is normalized to 0..1 with a gentle power curve and gain so quiet speech
/// still shows visible movement.
fn compute_levels(data: &[f32], channels: usize) -> Vec<f32> {
    // Mix to mono by averaging channels.
    let mono: Vec<f32> = if channels > 1 {
        data.chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        data.to_vec()
    };

    if mono.is_empty() {
        return vec![0.0; LEVEL_BUCKETS];
    }

    let chunk_size = (mono.len() / LEVEL_BUCKETS).max(1);
    let mut levels = Vec::with_capacity(LEVEL_BUCKETS);

    for i in 0..LEVEL_BUCKETS {
        let start = i * chunk_size;
        let end = ((i + 1) * chunk_size).min(mono.len());
        if start >= mono.len() {
            levels.push(0.0);
            continue;
        }
        let slice = &mono[start..end];
        // RMS amplitude.
        let rms = (slice.iter().map(|s| s * s).sum::<f32>() / slice.len() as f32).sqrt();
        // Convert to dB, normalize to 0..1 range.
        // dB range: -55 (silence) to -8 (loud speech).
        let db = if rms > 0.0 { 20.0 * rms.log10() } else { -55.0 };
        let db_min = -55.0_f32;
        let db_max = -8.0_f32;
        let normalized = ((db - db_min) / (db_max - db_min)).clamp(0.0, 1.0);
        // Apply gain and power curve for perceptual responsiveness.
        let level = (normalized * 1.3).min(1.0).powf(0.7);
        levels.push(level);
    }

    levels
}
