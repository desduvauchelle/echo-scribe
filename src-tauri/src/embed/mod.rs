//! Local text-embedding runtime (EmbeddingGemma via llama-cpp-2) and the
//! orchestrator that loads/unloads it. Mirrors the `llm` module's lifecycle.

pub mod catalog;
pub mod engine;
pub mod math;

/// The embedding model id (matches `embed-models.json`).
pub const EMBED_MODEL_ID: &str = "embeddinggemma-300m-q8";

/// Stored vector dimension after Matryoshka truncation + renormalization.
pub const EMBED_DIM: usize = 256;

/// EmbeddingGemma requires task-specific prompt prefixes. Mismatched prefixes
/// silently tank retrieval quality, so they are centralized here.
pub fn document_prompt(text: &str) -> String {
    format!("title: none | text: {text}")
}

pub fn query_prompt(text: &str) -> String {
    format!("task: search result | query: {text}")
}

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("embedding model not downloaded: {0}")]
    NotDownloaded(String),
    #[error("backend init failed: {0}")]
    Backend(String),
    #[error("model load failed: {0}")]
    Load(String),
    #[error("context init failed: {0}")]
    Context(String),
    #[error("tokenize failed: {0}")]
    Tokenize(String),
    #[error("decode failed: {0}")]
    Decode(String),
    #[error("read embeddings failed: {0}")]
    Embeddings(String),
}

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

use engine::EmbedEngine;

/// Seam between the indexer and the embedding model, so the indexer is
/// testable with a stub. Synchronous/blocking by design — callers run it
/// inside `spawn_blocking`.
pub trait EmbedDocs: Send + Sync {
    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError>;
}

/// Loads the embedding model on first use, embeds text, and unloads after an
/// idle period. All access is synchronous (no `await` held), so a plain
/// `std::sync::Mutex` is correct and simpler than the LLM's tokio mutex.
pub struct Embedder {
    engine: Arc<Mutex<Option<EmbedEngine>>>,
    last_used: Arc<Mutex<Instant>>,
    unload_after: Duration,
}

impl Embedder {
    pub fn new(unload_after: Duration) -> Arc<Self> {
        Arc::new(Self {
            engine: Arc::new(Mutex::new(None)),
            last_used: Arc::new(Mutex::new(Instant::now())),
            unload_after,
        })
    }

    /// Embed query text (applies the query prompt + 256-dim normalization).
    pub fn embed_query_blocking(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        let raw = self.embed_raw(&[query_prompt(text)])?;
        Ok(math::truncate_renormalize(&raw[0], EMBED_DIM))
    }

    /// Embed document passages (applies the document prompt + normalization).
    pub fn embed_documents_blocking(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let prefixed: Vec<String> = texts.iter().map(|t| document_prompt(t)).collect();
        let raw = self.embed_raw(&prefixed)?;
        Ok(raw
            .iter()
            .map(|v| math::truncate_renormalize(v, EMBED_DIM))
            .collect())
    }

    /// Lazy-load the engine and embed each already-prefixed string.
    fn embed_raw(&self, prefixed: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        if !catalog::is_downloaded() {
            return Err(EmbedError::NotDownloaded(EMBED_MODEL_ID.to_string()));
        }
        let mut guard = self.engine.lock().expect("embed engine mutex");
        if guard.is_none() {
            let path = catalog::model_file_path()
                .ok_or_else(|| EmbedError::Load("no file in catalog entry".into()))?;
            info!(target: "mem", "[mem] lazy-loading embedding engine");
            *guard = Some(EmbedEngine::load(&path)?);
        }
        let eng = guard.as_ref().expect("engine just loaded");
        let mut out = Vec::with_capacity(prefixed.len());
        for t in prefixed {
            out.push(eng.embed(t)?);
        }
        if let Ok(mut g) = self.last_used.lock() {
            *g = Instant::now();
        }
        Ok(out)
    }

    pub fn is_loaded(&self) -> bool {
        matches!(self.engine.try_lock(), Ok(g) if g.is_some())
    }

    pub fn idle_for(&self) -> Duration {
        match self.last_used.lock() {
            Ok(g) => g.elapsed(),
            Err(_) => Duration::ZERO,
        }
    }

    /// Background task: drop the engine after `unload_after` of inactivity.
    pub fn spawn_unloader(self: &Arc<Self>) {
        if self.unload_after.is_zero() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(this) = weak.upgrade() else { return };
                let idle = this.idle_for();
                if idle < this.unload_after {
                    continue;
                }
                // Clone the inner Arc so the lock guard borrows this local
                // (which lives to the end of the loop body) rather than `this`.
                // A `match` with a named guard binding avoids the if-let
                // scrutinee-temporary lifetime trap.
                let engine = Arc::clone(&this.engine);
                let mut guard = match engine.try_lock() {
                    Ok(g) => g,
                    Err(_) => {
                        warn!(target: "mem", "embed engine busy; deferring idle-unload");
                        continue;
                    }
                };
                if guard.is_some() {
                    info!(target: "mem", idle_secs = idle.as_secs(), "[mem] unloading idle embedding engine");
                    *guard = None;
                }
            }
        });
    }
}

impl EmbedDocs for Embedder {
    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.embed_documents_blocking(texts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run only when the model is present:
    ///   (download it first via the `download_embedding_model` command)
    ///   cargo test --lib embed::tests::sanity -- --ignored --nocapture
    #[test]
    #[ignore]
    fn sanity_similar_beats_dissimilar() {
        if !catalog::is_downloaded() {
            eprintln!("SKIP: embedding model not downloaded");
            return;
        }
        let e = Embedder::new(Duration::from_secs(60));
        let q = e.embed_query_blocking("when is the project deadline").unwrap();
        assert_eq!(q.len(), EMBED_DIM, "expected {EMBED_DIM}-dim vector");

        let docs = e
            .embed_documents_blocking(&[
                "The deadline for the launch is next Friday.".to_string(),
                "I had a tuna sandwich for lunch.".to_string(),
            ])
            .unwrap();
        let sim_related = math::dot(&q, &docs[0]);
        let sim_unrelated = math::dot(&q, &docs[1]);
        eprintln!("related={sim_related:.3} unrelated={sim_unrelated:.3}");
        assert!(
            sim_related > sim_unrelated,
            "semantic ranking failed: related {sim_related} !> unrelated {sim_unrelated}"
        );
    }
}
