//! Synchronous wrapper around `llama-cpp-2` for one-shot prompt → completion.
//!
//! The engine owns a [`LlamaBackend`] (initialized once per process) and a
//! loaded [`LlamaModel`]. For each [`Self::generate`] call it builds a fresh
//! [`LlamaContext`] — this keeps state isolation simple at the cost of having
//! to re-allocate KV cache per request. For Phase 4's classifier (one short
//! call per voice capture) that overhead is negligible compared with token
//! generation.
//!
//! ### Grammar / structured output
//!
//! `llama-cpp-2` 0.1.146 exposes [`LlamaSampler::grammar`] which accepts a
//! GBNF string + root rule and returns a sampler that constrains generation
//! to that grammar. We chain it into the sampler stack when
//! [`GenerateRequest::grammar_gbnf`] is set; otherwise we use a standard
//! temp + top-p + dist (sampling-from-distribution) chain.
//!
//! Calls to [`Self::generate`] are CPU/Metal bound — wrap them in
//! `tokio::task::spawn_blocking` from async contexts.

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use thiserror::Error;
use tracing::{debug, info, warn};

use super::prompt::{build_chat_messages, strip_trailing_stops};

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("llama backend init failed: {0}")]
    Backend(String),
    #[error("model load failed: {0}")]
    Load(String),
    #[error("context init failed: {0}")]
    Context(String),
    #[error("tokenize failed: {0}")]
    Tokenize(String),
    #[error("decode failed: {0}")]
    Decode(String),
    #[error("chat template failed: {0}")]
    ChatTemplate(String),
    #[error("invalid grammar: {0}")]
    Grammar(String),
    #[error("invalid request: {0}")]
    Request(String),
}

#[derive(Debug, Clone)]
pub struct GenerateRequest {
    pub system: Option<String>,
    pub user: String,
    /// Previous conversation turns as (role, content) pairs,
    /// oldest first. Role is "user" or "assistant".
    pub history: Vec<(String, String)>,
    pub max_tokens: usize,
    pub temperature: f32,
    pub stop_strings: Vec<String>,
    pub grammar_gbnf: Option<String>,
}

impl Default for GenerateRequest {
    fn default() -> Self {
        Self {
            system: None,
            user: String::new(),
            history: Vec::new(),
            max_tokens: 256,
            temperature: 0.7,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
        }
    }
}

pub struct LlmEngine {
    /// Backend is held for the lifetime of the engine (and thus the model).
    /// llama.cpp requires the backend to outlive every model + context.
    _backend: Arc<LlamaBackend>,
    model: Arc<LlamaModel>,
    n_ctx: u32,
}

impl LlmEngine {
    /// Load a GGUF from `model_path`. `n_ctx` is the maximum context length
    /// the model will be configured with; pick this small enough to fit in
    /// VRAM/RAM but large enough for the longest prompt+response pair you
    /// expect. 8192 is a reasonable default for our short classifier prompts.
    pub fn load(model_path: &Path, n_ctx: u32) -> Result<Self, EngineError> {
        let backend = LlamaBackend::init().map_err(|e| EngineError::Backend(e.to_string()))?;
        // -1 = full GPU offload (Metal on Apple Silicon). We cast to u32 with
        // wrap to 0xFFFFFFFF; llama.cpp interprets a saturated value as
        // "all layers".
        let model_params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);

        info!(
            path = %model_path.display(),
            n_ctx,
            "loading GGUF model"
        );

        let model = LlamaModel::load_from_file(&backend, model_path, &model_params)
            .map_err(|e| EngineError::Load(e.to_string()))?;

        Ok(Self {
            _backend: Arc::new(backend),
            model: Arc::new(model),
            n_ctx,
        })
    }

    pub fn n_ctx(&self) -> u32 {
        self.n_ctx
    }

    /// Run one prompt → completion synchronously. Wraps the whole flow:
    /// build chat messages, apply the model's chat template, tokenize, run
    /// prefill, sample tokens until EOS / max_tokens / stop string.
    pub fn generate(&self, req: GenerateRequest) -> Result<String, EngineError> {
        if req.user.trim().is_empty() {
            return Err(EngineError::Request("user prompt is empty".into()));
        }
        if req.max_tokens == 0 {
            return Err(EngineError::Request("max_tokens must be > 0".into()));
        }

        // Build messages and apply the model's baked-in chat template. Gemma
        // 3 GGUFs ship with a template that adds the appropriate <start_of_turn>
        // / <end_of_turn> markers, so we don't roll our own.
        let template = self
            .model
            .chat_template(None)
            .map_err(|e| EngineError::ChatTemplate(e.to_string()))?;
        let messages = build_chat_messages(req.system.as_deref(), &req.history, &req.user)
            .map_err(|e| EngineError::Request(format!("nul byte in prompt: {e}")))?;
        let prompt = self
            .model
            .apply_chat_template(&template, &messages, /* add_ass = */ true)
            .map_err(|e| EngineError::ChatTemplate(e.to_string()))?;

        debug!(prompt_len = prompt.len(), "applied chat template");

        // Tokenize. The chat template already includes BOS markers via the
        // model's template, so we pass AddBos::Never to avoid duplication.
        let tokens = self
            .model
            .str_to_token(&prompt, AddBos::Never)
            .map_err(|e| EngineError::Tokenize(e.to_string()))?;

        if tokens.is_empty() {
            return Err(EngineError::Tokenize("empty token vector".into()));
        }

        let n_prompt = tokens.len();
        let n_ctx_required = n_prompt + req.max_tokens;
        if (n_ctx_required as u64) > (self.n_ctx as u64) {
            warn!(
                n_prompt,
                max_tokens = req.max_tokens,
                n_ctx = self.n_ctx,
                "prompt + max_tokens exceeds n_ctx; truncation may occur"
            );
        }

        // Build a fresh context.
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(self.n_ctx))
            .with_n_batch(self.n_ctx.max(512));
        let mut ctx = self
            .model
            .new_context(&self._backend, ctx_params)
            .map_err(|e| EngineError::Context(e.to_string()))?;

        // Prefill: feed the prompt as a single batch.
        let mut batch = LlamaBatch::new(n_prompt.max(512), 1);
        for (i, tok) in tokens.iter().enumerate() {
            let is_last = i == n_prompt - 1;
            batch
                .add(*tok, i as i32, &[0], is_last)
                .map_err(|e| EngineError::Decode(format!("batch.add: {e}")))?;
        }
        ctx.decode(&mut batch)
            .map_err(|e| EngineError::Decode(format!("prefill decode: {e}")))?;

        // Build sampler chain. Order matters — temperature applies last
        // before the dist sampler picks a token.
        let mut samplers = Vec::with_capacity(4);
        if let Some(g) = req.grammar_gbnf.as_ref() {
            let s = LlamaSampler::grammar(&self.model, g, "root")
                .map_err(|e| EngineError::Grammar(e.to_string()))?;
            samplers.push(s);
        }
        samplers.push(LlamaSampler::top_k(40));
        samplers.push(LlamaSampler::top_p(0.95, 1));
        samplers.push(LlamaSampler::temp(req.temperature.max(0.0)));
        samplers.push(LlamaSampler::dist(rand_seed()));
        let mut sampler = LlamaSampler::chain_simple(samplers);

        let mut output = String::new();
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        let mut n_cur = n_prompt as i32;
        let mut n_decoded = 0usize;

        while n_decoded < req.max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);

            if self.model.is_eog_token(token) {
                debug!("EOG token reached");
                break;
            }

            // Convert token to text and stream into the output.
            match self
                .model
                .token_to_piece(token, &mut decoder, /* special = */ false, None)
            {
                Ok(piece) => output.push_str(&piece),
                Err(e) => {
                    warn!(?e, "token_to_piece failed mid-stream; stopping");
                    break;
                }
            }

            // Stop-string check (we strip them off the tail post-hoc too,
            // but breaking early avoids generating beyond a stop).
            if hit_stop_string(&output, &req.stop_strings) {
                debug!("stop string hit");
                break;
            }

            // Feed the sampled token back in for the next decode step.
            batch.clear();
            batch
                .add(LlamaToken(token.0), n_cur, &[0], true)
                .map_err(|e| EngineError::Decode(format!("batch.add: {e}")))?;
            ctx.decode(&mut batch)
                .map_err(|e| EngineError::Decode(format!("step decode: {e}")))?;
            n_cur += 1;
            n_decoded += 1;
        }

        Ok(strip_trailing_stops(&output, &req.stop_strings))
    }
}

fn hit_stop_string(output: &str, stops: &[String]) -> bool {
    stops.iter().any(|s| !s.is_empty() && output.contains(s.as_str()))
}

fn rand_seed() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos.wrapping_mul(2_654_435_761)
}
