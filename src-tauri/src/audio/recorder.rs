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
    #[error("failed to build input stream: {0}")]
    BuildStream(String),
    #[error("failed to start input stream: {0}")]
    StartStream(String),
    #[error("recorder is not running")]
    NotRunning,
}

/// Optional callback that receives amplitude levels for overlay visualization.
pub type LevelCallback = Arc<dyn Fn(Vec<f32>) + Send + Sync>;

pub struct Recorder {
    stream: Option<Stream>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
    level_callback: Option<LevelCallback>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            stream: None,
            samples: Arc::new(Mutex::new(Vec::new())),
            sample_rate: 0,
            channels: 0,
            level_callback: None,
        }
    }

    /// Register a callback that receives audio level data (16 f32 values in
    /// 0..1) at roughly 20 Hz. Used to drive the overlay waveform bars.
    pub fn set_level_callback<F: Fn(Vec<f32>) + Send + Sync + 'static>(&mut self, cb: F) {
        self.level_callback = Some(Arc::new(cb));
    }

    pub fn start(&mut self) -> Result<(), RecorderError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or(RecorderError::NoDevice)?;
        let config = device
            .default_input_config()
            .map_err(|e| RecorderError::BuildStream(e.to_string()))?;
        self.sample_rate = config.sample_rate().0;
        self.channels = config.channels();
        info!(sample_rate = self.sample_rate, channels = self.channels, format = ?config.sample_format(), "starting recorder");

        // Reset buffer
        if let Ok(mut s) = self.samples.lock() {
            s.clear();
        }

        let samples = Arc::clone(&self.samples);
        let level_cb = self.level_callback.clone();
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
                    append_samples(&samples, data);
                    if let Some(ref cb) = level_cb {
                        maybe_emit_levels(data, channels, &pending_count, emit_threshold, cb);
                    }
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples(&samples, &converted);
                    if let Some(ref cb) = level_cb {
                        maybe_emit_levels(&converted, channels, &pending_count, emit_threshold, cb);
                    }
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples(&samples, &converted);
                    if let Some(ref cb) = level_cb {
                        maybe_emit_levels(&converted, channels, &pending_count, emit_threshold, cb);
                    }
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            other => return Err(RecorderError::BuildStream(format!("unsupported sample format {:?}", other))),
        }
        .map_err(|e| RecorderError::BuildStream(e.to_string()))?;

        stream.play().map_err(|e| RecorderError::StartStream(e.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(Vec<f32>, u32), RecorderError> {
        let stream = self.stream.take().ok_or(RecorderError::NotRunning)?;
        drop(stream); // dropping stops the cpal stream
        let samples = self.samples.lock().map(|s| s.clone()).unwrap_or_default();
        info!(sample_count = samples.len(), "stopped recorder");
        Ok((samples, self.sample_rate))
    }

    /// Channel count of the most recently started capture stream. Returns 0
    /// if the recorder has never been started.
    pub fn channels(&self) -> u16 {
        self.channels
    }
}

fn append_samples(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32]) {
    if let Ok(mut b) = buf.lock() {
        b.extend_from_slice(data);
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
        let db = if rms > 0.0 {
            20.0 * rms.log10()
        } else {
            -55.0
        };
        let db_min = -55.0_f32;
        let db_max = -8.0_f32;
        let normalized = ((db - db_min) / (db_max - db_min)).clamp(0.0, 1.0);
        // Apply gain and power curve for perceptual responsiveness.
        let level = (normalized * 1.3).min(1.0).powf(0.7);
        levels.push(level);
    }

    levels
}
