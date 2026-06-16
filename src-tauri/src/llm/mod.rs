//! Local LLM (llama.cpp / Gemma) — model registry, downloader, inference
//! wrapper, and the unified [`Llm`] orchestrator consumed by Tauri commands
//! and (in Phase 4) the classifier.
//!
//! Lifecycle (analogous to [`crate::asr::pipeline::AsrPipeline`]):
//!  - The [`Llm`] handle is created at app startup with a default unload
//!    timeout (typically 5 minutes).
//!  - The user's saved active model id is restored via [`Llm::set_active_model`].
//!  - On the first [`Llm::generate`] call after activation, the GGUF is
//!    lazy-loaded inside `spawn_blocking` (loading a 4B Q4 GGUF on Apple
//!    Silicon takes a couple of seconds).
//!  - A background tokio task ticks once a minute and unloads the engine if
//!    `last_used` is older than `unload_after`. This keeps RAM/VRAM free
//!    during idle stretches between voice captures.

pub mod downloader;
pub mod engine;
pub mod prompt;
pub mod rag;
pub mod registry;
pub mod action_launcher;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use thiserror::Error;
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

pub use downloader::{
    disk_bytes, has_incomplete_download, is_downloaded, model_dir, model_file_path,
    model_storage_dir, LlmDownloadError, LlmDownloadProgress,
};
pub use engine::{EngineError, GenerateRequest, LlmEngine};
pub use registry::{LlmModelEntry, LlmModelFile};

use crate::util::rss::current_rss_mib;

/// Abstraction for one-shot LLM generation. Implemented by [`Llm`] for the
/// production path; mocked in classifier tests so we don't need a real model
/// loaded to exercise validation/parsing.
///
/// We avoid `async_trait` (not in our dep tree) by returning a boxed future
/// directly. Trait methods cannot be `async fn` while remaining
/// object-safe, so this is the lowest-friction path.
pub type GenerateFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, LlmError>> + Send + 'a>>;

pub trait LlmGenerator: Send + Sync {
    fn generate<'a>(&'a self, req: GenerateRequest) -> GenerateFuture<'a>;
}

impl LlmGenerator for Llm {
    fn generate<'a>(&'a self, req: GenerateRequest) -> GenerateFuture<'a> {
        Box::pin(Llm::generate(self, req))
    }
}

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("no llm model is active")]
    NoActiveModel,
    #[error("active llm model {0} is not downloaded yet")]
    NotDownloaded(String),
    #[error("engine error: {0}")]
    Engine(#[from] EngineError),
    #[error("inference task panicked")]
    Join,
}

/// Context window used when loading any model in the registry. Capped at the
/// model's own `context_length`. Bumped from 8192 to 16384 to give features
/// like the daily recap room to summarize a full day's input. Memory cost:
/// ~0.5–1 GB extra KV-cache RAM while a model is loaded.
const DEFAULT_N_CTX: u32 = 16384;

pub struct Llm {
    /// `tokio::sync::Mutex` because we hold the lock across an `await` inside
    /// `generate()` (the `spawn_blocking` join). A std `Mutex` would deadlock
    /// the runtime if held across yield points.
    engine: Arc<Mutex<Option<LlmEngine>>>,
    active_model: Arc<RwLock<Option<LlmModelEntry>>>,
    last_used: Arc<std::sync::Mutex<Instant>>,
    /// Wrapped so `set_unload_timeout` can update it without rebuilding Llm.
    /// `Duration::ZERO` means "never unload".
    unload_after: Arc<std::sync::Mutex<Duration>>,
}

impl Llm {
    /// Create a new orchestrator with the given idle-unload timeout. The
    /// background unload task is **not** spawned here — call
    /// [`Self::spawn_unloader`] from inside a tokio context (typically
    /// `tauri::async_runtime::spawn` during `setup()`).
    pub fn new(unload_after: Duration) -> Arc<Self> {
        Arc::new(Self {
            engine: Arc::new(Mutex::new(None)),
            active_model: Arc::new(RwLock::new(None)),
            last_used: Arc::new(std::sync::Mutex::new(Instant::now())),
            unload_after: Arc::new(std::sync::Mutex::new(unload_after)),
        })
    }

    /// Update the idle-unload timeout at runtime. `Duration::ZERO` disables
    /// automatic unloading ("keep loaded").
    pub fn set_unload_timeout(&self, d: Duration) {
        if let Ok(mut g) = self.unload_after.lock() {
            *g = d;
        }
    }

    /// Spawn the periodic idle-unload checker. Must be called from inside a
    /// running tokio runtime (e.g. via `tauri::async_runtime::spawn`).
    /// Calling it twice is harmless but wasteful.
    pub fn spawn_unloader(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(this) = weak.upgrade() else {
                    return;
                };
                if let Err(e) = this.maybe_unload().await {
                    warn!(error = %e, "llm idle-unload check failed");
                }
            }
        });
    }

    async fn maybe_unload(&self) -> Result<(), LlmError> {
        let (idle_for, unload_after) = {
            let idle = self
                .last_used
                .lock()
                .map_err(|_| LlmError::Join)?
                .elapsed();
            let ua = *self.unload_after.lock().map_err(|_| LlmError::Join)?;
            (idle, ua)
        };
        if unload_after.is_zero() || idle_for < unload_after {
            return Ok(());
        }
        let mut guard = self.engine.lock().await;
        if guard.is_some() {
            let rss_before_mib = current_rss_mib();
            info!(
                target: "mem",
                idle_secs = idle_for.as_secs(),
                rss_mib_before = rss_before_mib,
                "[mem] unloading idle llm engine"
            );
            *guard = None;
            drop(guard);
            let rss_after_mib = current_rss_mib();
            info!(
                target: "mem",
                rss_mib_after = rss_after_mib,
                freed_mib = rss_before_mib.saturating_sub(rss_after_mib),
                "[mem] llm engine dropped"
            );
        }
        Ok(())
    }

    /// True if the GGUF engine is currently resident in memory. Best-effort:
    /// returns false on lock contention (load or generation in flight).
    pub fn is_loaded(&self) -> bool {
        match self.engine.try_lock() {
            Ok(g) => g.is_some(),
            Err(_) => false,
        }
    }

    /// Seconds since the last completed generation. Returns 0 on lock
    /// contention. Pairs with [`is_loaded`] for the memory sampler.
    pub fn idle_for(&self) -> Duration {
        match self.last_used.lock() {
            Ok(g) => g.elapsed(),
            Err(_) => Duration::ZERO,
        }
    }

    /// Activate `entry`. Drops any cached engine so the next `generate` call
    /// picks up the new GGUF.
    pub fn set_active_model(&self, entry: LlmModelEntry) {
        info!(model = %entry.id, "activating llm model");
        // Synchronously drop the cached engine. We use `try_lock` because
        // this is called from sync command handlers — if a generation is in
        // flight the engine drop will happen on the next idle pass.
        if let Ok(mut g) = self.engine.try_lock() {
            *g = None;
        }
        // active_model uses the async RwLock; same fallback pattern.
        if let Ok(mut g) = self.active_model.try_write() {
            *g = Some(entry);
        }
    }

    pub fn active_model_id(&self) -> Option<String> {
        let g = self.active_model.try_read().ok()?;
        g.as_ref().map(|m| m.id.clone())
    }

    /// True iff there's an active model AND it's already on disk.
    pub fn ready(&self) -> bool {
        let g = match self.active_model.try_read() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match g.as_ref() {
            Some(m) => is_downloaded(m),
            None => false,
        }
    }

    /// Run one prompt. Lazy-loads the engine on first call after activation.
    pub async fn generate(&self, req: GenerateRequest) -> Result<String, LlmError> {
        // Resolve active model + on-disk path before any blocking work.
        let (model_path, n_ctx): (PathBuf, u32) = {
            let guard = self.active_model.read().await;
            let entry = guard.as_ref().ok_or(LlmError::NoActiveModel)?;
            if !is_downloaded(entry) {
                return Err(LlmError::NotDownloaded(entry.id.clone()));
            }
            let path = model_file_path(entry).ok_or_else(|| {
                LlmError::Engine(EngineError::Load("no file in registry entry".into()))
            })?;
            let n_ctx = entry.context_length.min(DEFAULT_N_CTX).max(2048);
            (path, n_ctx)
        };

        // Touch last_used early so the unload tick doesn't race the load.
        if let Ok(mut g) = self.last_used.lock() {
            *g = Instant::now();
        }

        let engine_slot = Arc::clone(&self.engine);
        let last_used = Arc::clone(&self.last_used);

        let text = tokio::task::spawn_blocking(move || -> Result<String, LlmError> {
            let mut guard = engine_slot.blocking_lock();
            if guard.is_none() {
                let rss_before_mib = current_rss_mib();
                info!(
                    target: "mem",
                    path = %model_path.display(),
                    n_ctx,
                    rss_mib_before = rss_before_mib,
                    "[mem] lazy-loading llama engine"
                );
                let eng = LlmEngine::load(&model_path, n_ctx)?;
                *guard = Some(eng);
                let rss_after_mib = current_rss_mib();
                info!(
                    target: "mem",
                    rss_mib_after = rss_after_mib,
                    load_mib = rss_after_mib.saturating_sub(rss_before_mib),
                    "[mem] llama engine loaded"
                );
            }
            let eng = guard.as_ref().expect("engine just loaded");
            let out = eng.generate(req)?;
            if let Ok(mut g) = last_used.lock() {
                *g = Instant::now();
            }
            Ok(out)
        })
        .await
        .map_err(|_| LlmError::Join)??;

        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_default_resolves() {
        let id = registry::default_id();
        assert!(registry::lookup(id).is_some());
    }
}
