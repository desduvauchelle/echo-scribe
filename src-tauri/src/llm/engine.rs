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
use std::time::Instant;

use llama_cpp_2::context::params::{LlamaContextParams, KvCacheType};
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
    pub n_ctx: Option<u32>,
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
            n_ctx: None,
        }
    }
}

/// Process-wide llama.cpp backend. `llama_backend_init` may only run once per
/// process, but both the LLM engine and the embedding engine (`crate::embed`)
/// need a backend — whichever loads second must reuse the first one's, or its
/// init fails with `BackendAlreadyInitialized` forever after.
static SHARED_BACKEND: std::sync::Mutex<Option<Arc<LlamaBackend>>> = std::sync::Mutex::new(None);

pub fn shared_backend() -> Result<Arc<LlamaBackend>, EngineError> {
    let mut guard = SHARED_BACKEND
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(backend) = guard.as_ref() {
        return Ok(Arc::clone(backend));
    }
    let backend =
        Arc::new(LlamaBackend::init().map_err(|e| EngineError::Backend(e.to_string()))?);
    *guard = Some(Arc::clone(&backend));
    Ok(backend)
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
        let backend = shared_backend()?;
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
            _backend: backend,
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

        let t_start = Instant::now();

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
        let requested_n_ctx = req.n_ctx.unwrap_or(4096).min(self.n_ctx).max(2048);
        let n_ctx_required = n_prompt + req.max_tokens;
        if (n_ctx_required as u64) > (requested_n_ctx as u64) {
            // llama.cpp's decode calls ggml_abort() (= SIGABRT, kills process)
            // when the KV cache overflows. Reject the request instead so the
            // caller can recover.
            return Err(EngineError::Request(format!(
                "prompt ({} tokens) + max_tokens ({}) exceeds requested n_ctx ({}); shorten input or reduce max_tokens",
                n_prompt, req.max_tokens, requested_n_ctx
            )));
        }

        // Build a fresh context with memory optimizations (Flash Attention + symmetric Q8_0 KV cache).
        // llama-cpp-2 0.1.146: with_flash_attention_policy takes a
        // `llama_cpp_sys_2::llama_flash_attn_type` (= c_int): AUTO=-1, OFF=0,
        // ON=1. We don't depend on llama-cpp-sys-2 directly and llama-cpp-2
        // doesn't re-export the constant, so pass 1 as the integer literal.
        // cache_type_{k,v} were renamed to type_{k,v} in the same release.
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(requested_n_ctx))
            .with_n_batch(requested_n_ctx.max(512))
            .with_flash_attention_policy(1)
            .with_type_k(KvCacheType::Q8_0)
            .with_type_v(KvCacheType::Q8_0);

        let mut ctx = match self.model.new_context(&self._backend, ctx_params.clone()) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    error = %e,
                    "Failed to initialize optimized LLM context (Flash Attention + Q8 KV Cache). \
                     Falling back to standard context parameters..."
                );
                let fallback_params = LlamaContextParams::default()
                    .with_n_ctx(NonZeroU32::new(requested_n_ctx))
                    .with_n_batch(requested_n_ctx.max(512));
                self.model
                    .new_context(&self._backend, fallback_params)
                    .map_err(|err| EngineError::Context(format!("fallback context creation failed: {}", err)))?
            }
        };

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

        let prefill_ms = t_start.elapsed().as_millis() as u64;
        let t_decode_start = Instant::now();

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

        let decode_secs = t_decode_start.elapsed().as_secs_f64();
        let decode_tok_s = if decode_secs > 0.0 {
            n_decoded as f64 / decode_secs
        } else {
            0.0
        };
        info!(
            target: "llm_bench",
            n_prompt,
            n_decoded,
            prefill_ms,
            decode_tok_s,
            "llm generate timing"
        );

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

    /// Shared prompt for the MLX-vs-GGUF spike. Use the SAME text on the MLX
    /// side (`mlx_lm.generate --prompt ...`) so prefill sizes match.
    const BENCH_PROMPT: &str = "Write a detailed, multi-paragraph explanation \
of how on-device speech-to-text systems work, covering audio capture, feature \
extraction, acoustic modeling, and decoding. Aim for at least 400 words.";

    /// GGUF decode-throughput baseline for the MLX-vs-llama.cpp spike.
    /// Ignored by default (loads a multi-GB model). Run with:
    ///   cargo test --release --lib llm::engine::tests::bench_gguf_gemma4_e2b -- --ignored --nocapture
    /// The `llm generate timing` line prints n_prompt / n_decoded / prefill_ms / decode_tok_s.
    #[test]
    #[ignore]
    fn bench_gguf_gemma4_e2b() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter("llm_bench=info")
            .with_test_writer()
            .try_init();

        let entry = crate::llm::registry::lookup("gemma-4-e2b-it-q4_k_m")
            .expect("gemma-4-e2b-it-q4_k_m must be in the registry");
        if !crate::llm::is_downloaded(&entry) {
            println!("gemma-4-e2b-it-q4_k_m not downloaded; skipping benchmark.");
            return;
        }
        let model_path =
            crate::llm::model_file_path(&entry).expect("model file path should exist");
        let engine = LlmEngine::load(&model_path, 16384).expect("model should load");

        // Warm-up so weight fault-in / Metal pipeline build doesn't skew timing.
        let _ = engine.generate(GenerateRequest {
            user: "Say hello.".to_string(),
            max_tokens: 8,
            n_ctx: Some(2048),
            ..Default::default()
        });

        // Timed run: stops cleared so it generates the full 256-token budget.
        let out = engine
            .generate(GenerateRequest {
                system: Some("You are a helpful writing assistant.".to_string()),
                user: BENCH_PROMPT.to_string(),
                history: Vec::new(),
                max_tokens: 256,
                temperature: 0.7,
                stop_strings: Vec::new(),
                grammar_gbnf: None,
                n_ctx: Some(4096),
            })
            .expect("generation should succeed");
        assert!(!out.is_empty(), "benchmark generation produced no output");
    }

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

    #[test]
    fn test_dynamic_context_sizing_and_kv_cache() {
        let default_model_id = crate::llm::registry::default_id();
        let Some(entry) = crate::llm::registry::lookup(default_model_id) else {
            return;
        };
        
        if !crate::llm::is_downloaded(&entry) {
            println!("Default LLM model not downloaded. Skipping integration test.");
            return;
        }
        
        let model_path = crate::llm::model_file_path(&entry).expect("Model file path should exist");
        
        let engine = LlmEngine::load(&model_path, 16384).expect("Should load model");
        
        let req_short = GenerateRequest {
            system: Some("You are a helpful assistant.".to_string()),
            user: "Write a one word greeting.".to_string(),
            history: Vec::new(),
            max_tokens: 10,
            temperature: 0.5,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(2048),
        };
        let res_short = engine.generate(req_short).expect("Generation with short context should succeed");
        assert!(!res_short.is_empty());
        
        let req_overflow = GenerateRequest {
            system: Some("You are a helpful assistant.".to_string()),
            user: "Write a story.".to_string(),
            history: Vec::new(),
            max_tokens: 4000,
            temperature: 0.5,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(2048),
        };
        let err = engine.generate(req_overflow);
        assert!(err.is_err(), "Overflow request should return an error");
        let err_msg = err.unwrap_err().to_string();
        assert!(err_msg.contains("exceeds requested n_ctx"), "Error message should complain about context overflow: {}", err_msg);
    }
}
