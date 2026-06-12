//! End-to-end speech recognition pipeline: resample → Parakeet inference.
//!
//! The pipeline owns a lazily-initialized [`ParakeetEngine`]. The active model
//! is set via [`AsrPipeline::set_active_model`] (typically from `lib.rs::run`'s
//! setup hook, after reading saved settings, or from the
//! `set_active_speech_model` Tauri command). The engine itself is loaded on
//! the first `transcribe()` call to keep app startup fast.
//!
//! An optional idle-unload background task (see [`AsrPipeline::spawn_unloader`])
//! evicts the engine from memory after a configurable idle duration, mirroring
//! the LLM engine's lifecycle. Default: 120 s. `Duration::ZERO` = never unload.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use thiserror::Error;
use tracing::{info, warn};

use super::downloader::{is_downloaded, model_dir};
use super::parakeet::{EngineError, ParakeetEngine};
use super::registry::ModelEntry;
use crate::audio::resample::resample_to_16k_mono;
use crate::util::rss::current_rss_mib;

#[derive(Debug, Error)]
pub enum AsrError {
    #[error("no speech model is active")]
    NoActiveModel,
    #[error("active speech model {0} is not downloaded yet")]
    NotDownloaded(String),
    #[error("engine error: {0}")]
    Engine(#[from] EngineError),
    #[error("inference task panicked")]
    Join,
}

pub struct AsrPipeline {
    engine: Arc<Mutex<Option<ParakeetEngine>>>,
    active_model: Arc<RwLock<Option<ModelEntry>>>,
    last_used: Arc<Mutex<Instant>>,
    unload_after: Arc<Mutex<Duration>>,
}

/// Split a buffer of `len` samples into consecutive `[start, end)` windows of
/// at most `window` samples each. The final window may be shorter. Returns an
/// empty vec when `len == 0` or `window == 0`.
fn window_ranges(len: usize, window: usize) -> Vec<(usize, usize)> {
    if len == 0 || window == 0 {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + window).min(len);
        ranges.push((start, end));
        start = end;
    }
    ranges
}

impl Default for AsrPipeline {
    fn default() -> Self {
        Self::new(Duration::from_secs(120))
    }
}

impl AsrPipeline {
    pub fn new(unload_after: Duration) -> Self {
        Self {
            engine: Arc::new(Mutex::new(None)),
            active_model: Arc::new(RwLock::new(None)),
            last_used: Arc::new(Mutex::new(Instant::now())),
            unload_after: Arc::new(Mutex::new(unload_after)),
        }
    }

    /// Update the idle-unload timeout at runtime. `Duration::ZERO` disables
    /// automatic unloading ("keep loaded").
    pub fn set_unload_timeout(&self, d: Duration) {
        if let Ok(mut g) = self.unload_after.lock() {
            *g = d;
        }
    }

    /// Spawn the periodic idle-unload checker. Must be called from inside a
    /// running tokio runtime. Calling it twice is harmless but wasteful.
    pub fn spawn_unloader(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(this) = weak.upgrade() else {
                    return;
                };
                this.maybe_unload();
            }
        });
    }

    fn maybe_unload(&self) {
        let (idle_for, unload_after) = {
            let idle = match self.last_used.lock() {
                Ok(g) => g.elapsed(),
                Err(_) => return,
            };
            let ua = match self.unload_after.lock() {
                Ok(g) => *g,
                Err(_) => return,
            };
            (idle, ua)
        };
        if unload_after.is_zero() || idle_for < unload_after {
            return;
        }
        if let Ok(mut guard) = self.engine.lock() {
            if guard.is_some() {
                let rss_before_mib = current_rss_mib();
                info!(
                    target: "mem",
                    idle_secs = idle_for.as_secs(),
                    rss_mib_before = rss_before_mib,
                    "[mem] unloading idle ASR engine"
                );
                *guard = None;
                drop(guard);
                let rss_after_mib = current_rss_mib();
                info!(
                    target: "mem",
                    rss_mib_after = rss_after_mib,
                    freed_mib = rss_before_mib.saturating_sub(rss_after_mib),
                    "[mem] ASR engine dropped"
                );
            }
        }
    }

    /// True if the ONNX engine is currently resident in memory. Best-effort —
    /// returns false if the engine slot is contended (a load or unload is in
    /// flight). Used by the memory sampler to log loaded/unloaded state.
    pub fn is_loaded(&self) -> bool {
        match self.engine.try_lock() {
            Ok(g) => g.is_some(),
            Err(_) => false,
        }
    }

    /// Seconds since the last successful transcription. Used by the memory
    /// sampler to correlate RSS with idleness. Returns 0 on lock contention.
    pub fn idle_for(&self) -> Duration {
        match self.last_used.lock() {
            Ok(g) => g.elapsed(),
            Err(_) => Duration::ZERO,
        }
    }

    fn touch(&self) {
        if let Ok(mut g) = self.last_used.lock() {
            *g = Instant::now();
        }
    }

    /// Update the active model. Drops any cached engine so the new model is
    /// loaded on the next `transcribe()` call.
    pub fn set_active_model(&self, entry: ModelEntry) {
        info!(model = %entry.id, "activating speech model");
        if let Ok(mut g) = self.active_model.write() {
            *g = Some(entry);
        }
        if let Ok(mut g) = self.engine.lock() {
            *g = None;
        }
    }

    pub fn active_model_id(&self) -> Option<String> {
        self.active_model
            .read()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.id.clone()))
    }

    /// True if there's an active model AND it's already on disk.
    pub fn ready(&self) -> bool {
        let g = match self.active_model.read() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match g.as_ref() {
            Some(m) => is_downloaded(m),
            None => false,
        }
    }

    /// Fire-and-forget background load of the Parakeet engine. Call this as
    /// soon as recording starts so the engine is warm by the time the user
    /// releases the hotkey. If the engine is already loaded this is a no-op.
    pub fn warm_up(&self) {
        let model_path: Option<PathBuf> = {
            let guard = match self.active_model.read() {
                Ok(g) => g,
                Err(_) => return,
            };
            guard
                .as_ref()
                .filter(|e| is_downloaded(e))
                .map(|e| model_dir(e))
        };
        let Some(model_path) = model_path else { return };
        let engine_slot = Arc::clone(&self.engine);
        // Drop the handle — fire and forget.
        let _ = tokio::task::spawn_blocking(move || {
            let mut guard = match engine_slot.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if guard.is_none() {
                let rss_before_mib = current_rss_mib();
                info!(
                    target: "mem",
                    path = %model_path.display(),
                    rss_mib_before = rss_before_mib,
                    "[mem] pre-loading Parakeet engine (optimistic warm-up)"
                );
                match ParakeetEngine::load(&model_path) {
                    Ok(eng) => {
                        *guard = Some(eng);
                        let rss_after_mib = current_rss_mib();
                        info!(
                            target: "mem",
                            rss_mib_after = rss_after_mib,
                            load_mib = rss_after_mib.saturating_sub(rss_before_mib),
                            "[mem] Parakeet engine loaded (warm-up)"
                        );
                    }
                    Err(e) => warn!(error = ?e, "warm-up load failed; will retry on transcribe"),
                }
            }
        });
    }

    /// Resample to 16 kHz mono and run Parakeet inference. Both steps run on
    /// `tokio::task::spawn_blocking` because they're CPU-bound and the engine
    /// holds an ONNX session that's expensive to share across runtimes.
    pub async fn transcribe(
        &self,
        samples: Vec<f32>,
        from_rate: u32,
        channels: u16,
    ) -> Result<String, AsrError> {
        let t0 = Instant::now();

        // Resolve the active model + path before spawning blocking work.
        let model_path: PathBuf = {
            let guard = self
                .active_model
                .read()
                .map_err(|_| AsrError::NoActiveModel)?;
            let entry = guard.as_ref().ok_or(AsrError::NoActiveModel)?;
            if !is_downloaded(entry) {
                return Err(AsrError::NotDownloaded(entry.id.clone()));
            }
            model_dir(entry)
        };

        let engine_slot = Arc::clone(&self.engine);
        let input_samples = samples.len();

        // Resample on a blocking thread so we don't hog the runtime.
        let resampled = tokio::task::spawn_blocking(move || {
            resample_to_16k_mono(&samples, from_rate, channels)
        })
        .await
        .map_err(|_| AsrError::Join)?;

        let resample_ms = t0.elapsed().as_millis();

        if resampled.is_empty() {
            warn!("resampled buffer is empty; skipping inference");
            return Ok(String::new());
        }

        let resampled_samples = resampled.len();

        // Strip silent frames so Parakeet only sees speech audio.
        // filter_silence returns the original buffer if the whole recording
        // is below the energy threshold, so this is always safe.
        let resampled = crate::audio::vad::filter_silence(&resampled);
        let post_vad_samples = resampled.len();

        // Run inference. The engine itself is `Send` and we hold it through a
        // blocking task to keep the ONNX session pinned to one thread for the
        // duration of the call.
        let t1 = Instant::now();
        let text = tokio::task::spawn_blocking(move || -> Result<String, AsrError> {
            let mut guard = engine_slot.lock().map_err(|_| AsrError::Join)?;
            if guard.is_none() {
                let rss_before_mib = current_rss_mib();
                info!(
                    target: "mem",
                    path = %model_path.display(),
                    rss_mib_before = rss_before_mib,
                    "[mem] lazy-loading Parakeet engine"
                );
                let eng = ParakeetEngine::load(&model_path)?;
                *guard = Some(eng);
                let rss_after_mib = current_rss_mib();
                info!(
                    target: "mem",
                    rss_mib_after = rss_after_mib,
                    load_mib = rss_after_mib.saturating_sub(rss_before_mib),
                    "[mem] Parakeet engine loaded (lazy)"
                );
            }
            let eng = guard.as_mut().expect("engine just loaded");
            let text = eng.transcribe(&resampled)?;
            Ok(text)
        })
        .await
        .map_err(|_| AsrError::Join)??;

        let inference_ms = t1.elapsed().as_millis();
        let total_ms = t0.elapsed().as_millis();
        // Audio length in ms (16 kHz mono → ms = samples / 16).
        let audio_ms = resampled_samples / 16;
        let post_vad_ms = post_vad_samples / 16;
        // Real-time factor: inference_ms / audio_ms. <1 = faster than realtime.
        // On Apple Silicon w/ CoreML we expect ~0.1–0.3 for the 0.6B int8 model;
        // RTF >= 1.0 strongly suggests CoreML isn't binding ops and we're on CPU.
        let rtf = if audio_ms > 0 {
            inference_ms as f64 / audio_ms as f64
        } else {
            0.0
        };
        info!(
            input_samples,
            audio_ms,
            post_vad_ms,
            resample_ms,
            inference_ms,
            total_ms,
            rtf = format!("{:.2}", rtf),
            text_len = text.len(),
            "transcription complete"
        );

        self.touch();
        Ok(text)
    }

    /// Read a 16kHz mono Int16 WAV file written by ChunkedWavWriter and return f32 samples.
    pub fn load_wav_16k_mono_int16(
        path: &std::path::Path,
    ) -> Result<(Vec<f32>, u32, u16), AsrError> {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| AsrError::Engine(EngineError::Io(e.to_string())))?;
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err(AsrError::Engine(EngineError::Io("not a WAV file".into())));
        }
        let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
        let bits_per_sample = u16::from_le_bytes(bytes[34..36].try_into().unwrap());
        if bits_per_sample != 16 {
            return Err(AsrError::Engine(EngineError::Io(format!(
                "expected 16-bit PCM, got {bits_per_sample}"
            ))));
        }
        // Find "data" chunk.
        let mut idx = 12;
        let mut data_offset = 44;
        let mut data_len = 0u32;
        while idx + 8 <= bytes.len() {
            let id = &bytes[idx..idx + 4];
            let size = u32::from_le_bytes(bytes[idx + 4..idx + 8].try_into().unwrap()) as usize;
            if id == b"data" {
                data_offset = idx + 8;
                data_len = size as u32;
                break;
            }
            idx += 8 + size;
        }
        let header_count = (data_len as usize) / 2;
        // Clamp to actual available bytes in case the header lies (e.g. a truncated file).
        let available = bytes.len().saturating_sub(data_offset) / 2;
        let count = header_count.min(available);
        let mut samples = Vec::with_capacity(count);
        for i in 0..count {
            let lo = bytes[data_offset + i * 2];
            let hi = bytes[data_offset + i * 2 + 1];
            let s = i16::from_le_bytes([lo, hi]) as f32 / 32768.0;
            samples.push(s);
        }
        Ok((samples, sample_rate, channels))
    }

    /// Transcribe a WAV file produced by ChunkedWavWriter. Returns the trimmed text.
    pub async fn transcribe_file(&self, path: &std::path::Path) -> Result<String, AsrError> {
        let (samples, rate, channels) = Self::load_wav_16k_mono_int16(path)?;
        self.transcribe(samples, rate, channels).await
    }

    /// Transcribe arbitrary-length audio by windowing the samples into
    /// ~60-second chunks, transcribing each via [`Self::transcribe`], and
    /// joining the non-empty results with single spaces. Calls `progress(pct)`
    /// with 0..=100 after each chunk completes.
    pub async fn transcribe_long(
        &self,
        samples: Vec<f32>,
        from_rate: u32,
        channels: u16,
        progress: impl Fn(u8) + Send + 'static,
    ) -> Result<String, AsrError> {
        const WINDOW_SECS: usize = 60;
        let window = WINDOW_SECS * from_rate as usize * channels.max(1) as usize;
        let ranges = window_ranges(samples.len(), window);
        if ranges.is_empty() {
            return Ok(String::new());
        }
        let total = ranges.len();
        let mut parts: Vec<String> = Vec::with_capacity(total);
        for (i, (start, end)) in ranges.into_iter().enumerate() {
            let chunk = samples[start..end].to_vec();
            let text = self.transcribe(chunk, from_rate, channels).await?;
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
            let pct = ((i + 1) * 100 / total) as u8;
            progress(pct);
        }
        Ok(parts.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ranges_splits_correctly() {
        // exact multiple
        assert_eq!(window_ranges(10, 5), vec![(0, 5), (5, 10)]);
        // remainder: last window short
        assert_eq!(window_ranges(12, 5), vec![(0, 5), (5, 10), (10, 12)]);
        // len < window: single full-length window
        assert_eq!(window_ranges(3, 5), vec![(0, 3)]);
        // empty
        assert_eq!(window_ranges(0, 5), Vec::<(usize, usize)>::new());
    }
}

#[cfg(test)]
mod transcribe_file_tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_silence_wav(path: &std::path::Path, seconds: u32) {
        let sr: u32 = 16_000;
        let samples = sr * seconds;
        let data_bytes = samples * 2;
        let riff = 36 + data_bytes;
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&riff.to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&sr.to_le_bytes()).unwrap();
        f.write_all(&(sr * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_bytes.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; data_bytes as usize]).unwrap();
    }

    #[test]
    fn load_wav_returns_correct_sample_count() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("silence.wav");
        write_silence_wav(&path, 2);
        let (samples, rate, channels) = AsrPipeline::load_wav_16k_mono_int16(&path).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(channels, 1);
        assert_eq!(samples.len(), 32_000);
    }
}
