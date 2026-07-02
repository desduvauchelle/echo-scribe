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
