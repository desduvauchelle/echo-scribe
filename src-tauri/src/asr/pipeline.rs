//! End-to-end speech recognition pipeline: resample → Parakeet inference.
//!
//! The pipeline owns a lazily-initialized [`ParakeetEngine`]. The active model
//! is set via [`AsrPipeline::set_active_model`] (typically from `lib.rs::run`'s
//! setup hook, after reading saved settings, or from the
//! `set_active_speech_model` Tauri command). The engine itself is loaded on
//! the first `transcribe()` call to keep app startup fast.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use thiserror::Error;
use tracing::{info, warn};

use super::downloader::{is_downloaded, model_dir};
use super::parakeet::{EngineError, ParakeetEngine};
use super::registry::ModelEntry;
use crate::audio::resample::resample_to_16k_mono;

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
}

impl Default for AsrPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl AsrPipeline {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(Mutex::new(None)),
            active_model: Arc::new(RwLock::new(None)),
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

    /// Resample to 16 kHz mono and run Parakeet inference. Both steps run on
    /// `tokio::task::spawn_blocking` because they're CPU-bound and the engine
    /// holds an ONNX session that's expensive to share across runtimes.
    pub async fn transcribe(
        &self,
        samples: Vec<f32>,
        from_rate: u32,
        channels: u16,
    ) -> Result<String, AsrError> {
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

        // Resample on a blocking thread so we don't hog the runtime.
        let resampled = tokio::task::spawn_blocking(move || {
            resample_to_16k_mono(&samples, from_rate, channels)
        })
        .await
        .map_err(|_| AsrError::Join)?;

        if resampled.is_empty() {
            warn!("resampled buffer is empty; skipping inference");
            return Ok(String::new());
        }

        // Run inference. The engine itself is `Send` and we hold it through a
        // blocking task to keep the ONNX session pinned to one thread for the
        // duration of the call.
        let text = tokio::task::spawn_blocking(move || -> Result<String, AsrError> {
            let mut guard = engine_slot.lock().map_err(|_| AsrError::Join)?;
            if guard.is_none() {
                info!(path = %model_path.display(), "lazy-loading Parakeet engine");
                let eng = ParakeetEngine::load(&model_path)?;
                *guard = Some(eng);
            }
            let eng = guard.as_mut().expect("engine just loaded");
            let text = eng.transcribe(&resampled)?;
            Ok(text)
        })
        .await
        .map_err(|_| AsrError::Join)??;

        Ok(text)
    }
}
