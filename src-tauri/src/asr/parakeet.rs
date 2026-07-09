//! Thin synchronous wrapper around `transcribe_rs::onnx::parakeet::ParakeetModel`.
//!
//! The wrapper hides the upstream API surface so the rest of the codebase can
//! stay agnostic of which engine is loaded (we may swap engines later).
//! Inference is blocking; callers run it on `tokio::task::spawn_blocking`.

use std::path::Path;

use thiserror::Error;
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;
use transcribe_rs::TranscriptionSegment;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("failed to load Parakeet model at {path}: {source}")]
    Load {
        path: String,
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("transcription failed: {0}")]
    Transcribe(Box<dyn std::error::Error + Send + Sync>),
    #[error("io: {0}")]
    Io(String),
}

/// Loaded Parakeet engine. `transcribe_rs::ParakeetModel` is `Send` (per the
/// 0.3.0 release notes) so we can park it in an `Arc<Mutex<…>>` and bounce it
/// between blocking tasks.
pub struct ParakeetEngine {
    model: ParakeetModel,
}

impl ParakeetEngine {
    /// Load a Parakeet ONNX model from a directory laid out as transcribe-rs
    /// expects (encoder-int8.onnx + .data, decoder_joint-int8.onnx, vocab.txt).
    pub fn load(model_path: &Path) -> Result<Self, EngineError> {
        let model = ParakeetModel::load(&model_path.to_path_buf(), &Quantization::Int8)
            .map_err(|e| EngineError::Load {
                path: model_path.display().to_string(),
                source: Box::new(e),
            })?;
        Ok(Self { model })
    }

    /// Run inference on 16 kHz mono `f32` samples (range -1..1). Returns the
    /// recognized text with no leading/trailing whitespace.
    pub fn transcribe(&mut self, samples_16k_mono: &[f32]) -> Result<String, EngineError> {
        let result = self
            .model
            .transcribe_with(samples_16k_mono, &ParakeetParams::default())
            .map_err(|e| EngineError::Transcribe(Box::new(e)))?;
        Ok(result.text.trim().to_string())
    }

    /// Run inference on 16 kHz mono `f32` samples and return the native
    /// sentence-level timed segments (`start`/`end` in **seconds**, relative to
    /// the first sample). Used by caption generation. Returns an empty vec when
    /// the model produced no timed segments (e.g. all-silence input).
    ///
    /// transcribe-rs 0.3.11 exposes Parakeet-TDT's native alignment via
    /// `TimestampGranularity::Segment`; it already subtracts the 250 ms
    /// leading-silence pad it adds internally, so the returned times are
    /// chunk-relative with no further correction needed here.
    pub fn transcribe_segments(
        &mut self,
        samples_16k_mono: &[f32],
    ) -> Result<Vec<TranscriptionSegment>, EngineError> {
        let result = self
            .model
            .transcribe_with(
                samples_16k_mono,
                &ParakeetParams {
                    timestamp_granularity: Some(TimestampGranularity::Segment),
                    ..Default::default()
                },
            )
            .map_err(|e| EngineError::Transcribe(Box::new(e)))?;
        Ok(result.segments.unwrap_or_default())
    }
}
