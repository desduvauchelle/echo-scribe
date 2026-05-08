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

use super::prompt::{build_gemma4_prompt, strip_trailing_stops};

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
            stop_strings: vec![
                "<turn|>".to_string(),
                "<|turn>".to_string(),
                "<end_of_turn>".to_string(),
            ],
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

        // Gemma 4 uses <|turn> to open a turn and <turn|> to close it.
        // <turn|> is also registered as an EOG token so is_eog_token() catches
        // it mid-loop, but we also add both as stop strings as a text-level
        // safety net and to catch multi-turn hallucination (<|turn> starting
        // a new role-play turn before the EOG token is emitted).
        // <end_of_turn> / <start_of_turn> (Gemma 1-3 tokens) are kept as
        // fallbacks in case the model emits them anyway.
        let mut req = req;
        for token in ["<turn|>", "<|turn>", "<end_of_turn>", "<start_of_turn>"] {
            if !req.stop_strings.iter().any(|s| s == token) {
                req.stop_strings.push(token.to_string());
            }
        }

        // Build the prompt in Gemma 4's native <|turn>/<turn|> format directly.
        // llama.cpp's apply_chat_template cannot parse the Jinja2 template
        // embedded in Gemma 4 GGUFs (returns ffi error -1), and its built-in
        // "gemma" named template uses the Gemma 1–3 <start_of_turn> format
        // which produces garbled output on Gemma 4. Building manually is the
        // reliable path.
        let prompt = build_gemma4_prompt(
            req.system.as_deref(),
            &req.history,
            &req.user,
        );

        debug!(prompt_len = prompt.len(), "built gemma4 prompt");

        // Tokenize. BOS is NOT included in the prompt string above, so we
        // ask the tokenizer to prepend it here.
        let tokens = self
            .model
            .str_to_token(&prompt, AddBos::Always)
            .map_err(|e| EngineError::Tokenize(e.to_string()))?;

        if tokens.is_empty() {
            return Err(EngineError::Tokenize("empty token vector".into()));
        }

        let n_prompt = tokens.len();
        let n_ctx_required = n_prompt + req.max_tokens;
        if (n_ctx_required as u64) > (self.n_ctx as u64) {
            // llama.cpp's decode calls ggml_abort() (= SIGABRT, kills process)
            // when the KV cache overflows. Reject the request instead so the
            // caller can recover.
            return Err(EngineError::Request(format!(
                "prompt ({} tokens) + max_tokens ({}) exceeds n_ctx ({}); shorten input or reduce max_tokens",
                n_prompt, req.max_tokens, self.n_ctx
            )));
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── GenerateRequest::default ──────────────────────────────────────────

    #[test]
    fn default_stop_strings_include_gemma4_turn_tokens() {
        let req = GenerateRequest::default();
        assert!(
            req.stop_strings.iter().any(|s| s == "<turn|>"),
            "default stop_strings must include Gemma 4 EOT token <turn|>"
        );
        assert!(
            req.stop_strings.iter().any(|s| s == "<|turn>"),
            "default stop_strings must include Gemma 4 turn-start token <|turn> \
             to prevent multi-turn hallucination"
        );
    }

    // ── generate() stop-string injection ─────────────────────────────────
    // The engine merges Gemma 4 turn tokens into req.stop_strings.

    #[test]
    fn hit_stop_string_catches_gemma4_turn_tokens() {
        let stops = vec!["<turn|>".to_string(), "<|turn>".to_string()];
        assert!(hit_stop_string("hello<turn|>", &stops));
        assert!(hit_stop_string("hello<|turn>user", &stops));
        assert!(hit_stop_string("<turn|>", &stops));
        assert!(!hit_stop_string("hello", &stops));
        assert!(!hit_stop_string("", &stops));
    }

    #[test]
    fn hit_stop_string_empty_stops_never_matches() {
        assert!(!hit_stop_string("hello<turn|>", &[]));
    }

    #[test]
    fn strip_trailing_stops_removes_gemma4_eot() {
        let stops = vec!["<turn|>".to_string(), "<|turn>".to_string()];
        assert_eq!(strip_trailing_stops("hello<turn|>", &stops), "hello");
        assert_eq!(strip_trailing_stops("hello<turn|>  \n", &stops), "hello");
        // Mid-string occurrence should NOT be stripped (only trailing).
        assert_eq!(
            strip_trailing_stops("foo<turn|>bar", &stops),
            "foo<turn|>bar"
        );
    }

    // ── History poisoning regression ──────────────────────────────────────
    // Root cause: if generate() returns text with bare template tokens, the
    // frontend stores them in history. The next call embeds them verbatim in
    // the prompt, causing double-encoded turn markers that confuse the model.
    //
    // generate() injects Gemma 4 turn tokens as stops and
    // strip_trailing_stops removes them, so history content is always clean.

    #[test]
    fn strip_trailing_stops_prevents_eot_poisoning() {
        let stops = vec!["<turn|>".to_string(), "<|turn>".to_string()];
        let raw = "Sure, here is a summary<turn|>";
        let cleaned = strip_trailing_stops(raw, &stops);
        assert!(!cleaned.contains("<turn|>"));
        assert_eq!(cleaned, "Sure, here is a summary");
    }

    #[test]
    fn strip_trailing_stops_prevents_new_turn_poisoning() {
        let stops = vec!["<turn|>".to_string(), "<|turn>".to_string()];
        let raw = "Here is what I found<|turn>";
        let cleaned = strip_trailing_stops(raw, &stops);
        assert!(!cleaned.contains("<|turn>"));
        assert_eq!(cleaned, "Here is what I found");
    }

    #[test]
    fn strip_trailing_stops_handles_double_eot() {
        let stops = vec!["<turn|>".to_string()];
        let raw = "hello<turn|><turn|>";
        let cleaned = strip_trailing_stops(raw, &stops);
        assert_eq!(cleaned, "hello");
    }
}
