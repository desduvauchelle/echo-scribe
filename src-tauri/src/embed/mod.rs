//! Local text-embedding runtime (EmbeddingGemma via llama-cpp-2) and the
//! orchestrator that loads/unloads it. Mirrors the `llm` module's lifecycle.

pub mod catalog;
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
