//! Automatic speech recognition (Parakeet) — model registry, downloader,
//! inference wrapper, and the unified [`pipeline::AsrPipeline`] consumed by
//! [`crate::coordinator`].

pub mod downloader;
pub mod parakeet;
pub mod pipeline;
pub mod postprocess;
pub mod registry;
