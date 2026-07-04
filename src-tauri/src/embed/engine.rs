//! Thin llama-cpp-2 wrapper that produces a pooled sentence embedding.
//! A fresh context is created per call so each embedding starts from clean
//! state (correctness over throughput; the indexer is a background job).

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;

use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use tracing::info;

use super::EmbedError;

pub struct EmbedEngine {
    // Backend must outlive model + context (llama.cpp requirement).
    _backend: Arc<LlamaBackend>,
    model: Arc<LlamaModel>,
}

impl EmbedEngine {
    pub fn load(model_path: &Path) -> Result<Self, EmbedError> {
        let backend = LlamaBackend::init().map_err(|e| EmbedError::Backend(e.to_string()))?;
        let model_params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
        info!(target: "embed", path = %model_path.display(), "loading embedding GGUF");
        let model = LlamaModel::load_from_file(&backend, model_path, &model_params)
            .map_err(|e| EmbedError::Load(e.to_string()))?;
        Ok(Self {
            _backend: Arc::new(backend),
            model: Arc::new(model),
        })
    }

    /// Native embedding dimension reported by the model (768 for EmbeddingGemma).
    pub fn n_embd(&self) -> usize {
        usize::try_from(self.model.n_embd()).unwrap_or(0)
    }

    /// Embed one already-prefixed string. Returns the raw `n_embd`-length vector
    /// (NOT yet truncated/normalized — the orchestrator does that).
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        let tokens = self
            .model
            .str_to_token(text, AddBos::Always)
            .map_err(|e| EmbedError::Tokenize(e.to_string()))?;
        let n = tokens.len().max(1);

        // Embeddings ON + mean pooling => read one pooled vector per sequence.
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(2048))
            .with_n_batch(2048)
            .with_embeddings(true)
            .with_pooling_type(LlamaPoolingType::Mean);

        let mut ctx = self
            .model
            .new_context(&self._backend, ctx_params)
            .map_err(|e| EmbedError::Context(e.to_string()))?;

        let mut batch = LlamaBatch::new(n, 1);
        for (i, tok) in tokens.iter().enumerate() {
            // logits=false: with mean pooling the pooled embedding is read via
            // embeddings_seq_ith regardless of per-token logit flags.
            batch
                .add(*tok, i as i32, &[0], false)
                .map_err(|e| EmbedError::Decode(format!("batch.add: {e}")))?;
        }
        ctx.decode(&mut batch)
            .map_err(|e| EmbedError::Decode(format!("decode: {e}")))?;

        let emb = ctx
            .embeddings_seq_ith(0)
            .map_err(|e| EmbedError::Embeddings(format!("{e:?}")))?;
        Ok(emb.to_vec())
    }
}
