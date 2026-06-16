# Chat Memory v2 — Semantic Foundation (M1 + M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local embedding model and a background indexer that embeds every history item plus existing meeting/daily summaries into a SQLite vector store — the searchable foundation that the M3/M4 hybrid-retrieval chat rewrite will sit on.

**Architecture:** A second, tiny llama-cpp-2 model (EmbeddingGemma-300m) runs alongside the Gemma generation engine behind its own idle-unloading `Embedder` orchestrator. A background scheduler (mirroring `daily_summary::scheduler`) chunks each source into ~passages, embeds them (256-dim, L2-normalized via Matryoshka truncation), and upserts `{vec, text, content_hash}` into a new `embeddings` table. Indexing is idempotent and incremental via a `content_hash` recorded in `embedding_index_state`. No chat behavior changes in this plan — it produces a populated, verifiable vector store.

**Tech Stack:** Rust, Tauri v2, `llama-cpp-2` 0.1.146 (Metal), `rusqlite` + SQLite FTS5, `sha2`, `tokio`. Frontend: TypeScript (`src/lib/api.ts` bindings only; UI lands in M4).

**Scope note:** This is plan 1 of 2. M3 (hybrid retrieval), M4 (chat rewrite + Settings/ChatView UI), M5 (polish) are a separate plan written after this foundation is validated — in particular after the M1 sanity test confirms two llama-cpp-2 contexts coexist under Metal.

---

## File Structure

**New files:**
- `src-tauri/embed-models.json` — embedding model catalog (mirrors `llm-models.json` shape).
- `src-tauri/src/embed/mod.rs` — `Embedder` orchestrator, `EmbedDocs` trait, constants (`EMBED_MODEL_ID`, `EMBED_DIM`), prompt prefixes, `EmbedError`.
- `src-tauri/src/embed/math.rs` — vector utils: normalize, truncate+renormalize, dot, `vec_to_blob`/`blob_to_vec`.
- `src-tauri/src/embed/catalog.rs` — loads `embed-models.json`; exposes the single embedding `model()` + `model_file_path()` + `is_downloaded()` (reusing `llm::downloader`).
- `src-tauri/src/embed/engine.rs` — `EmbedEngine`: loads the GGUF, runs a pooled forward pass, returns raw `n_embd` vectors.
- `src-tauri/src/chat_memory/mod.rs` — module root + `SourceDoc` type.
- `src-tauri/src/chat_memory/chunk.rs` — passage chunker.
- `src-tauri/src/chat_memory/source.rs` — render meeting/daily summaries + collect all `SourceDoc`s.
- `src-tauri/src/chat_memory/indexer.rs` — `collect_source_docs`, `index_docs`, `index_pending`, scheduler `spawn`, `IndexStats`/`IndexError`.
- `src-tauri/src/db/embeddings.rs` — `EmbeddingRow`, upsert/state/count queries.

**Modified files:**
- `src-tauri/src/lib.rs` — declare modules; build `Embedder`; spawn its unloader; add to mem sampler; add to `AppState`; spawn indexer scheduler.
- `src-tauri/src/commands.rs` — `AppState.embedder` field; `download_embedding_model` + `embedding_index_status` commands; register both in the handler.
- `src-tauri/src/db/mod.rs` — `pub mod embeddings;` + a test-only in-memory constructor if absent.
- `src-tauri/src/db/schema.rs` — append migration v19.
- `src/lib/api.ts` — `downloadEmbeddingModel` + `getEmbeddingIndexStatus` bindings.

---

# Milestone 1 — Embedding Runtime

### Task 1: Vector math utilities

**Files:**
- Create: `src-tauri/src/embed/mod.rs` (module shell for now)
- Create: `src-tauri/src/embed/math.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod embed;`)

- [ ] **Step 1: Declare the module.** In `src-tauri/src/lib.rs`, add alongside the other top-level `mod` declarations:

```rust
mod embed;
```

- [ ] **Step 2: Create the module shell.** Create `src-tauri/src/embed/mod.rs`:

```rust
//! Local text-embedding runtime (EmbeddingGemma via llama-cpp-2) and the
//! orchestrator that loads/unloads it. Mirrors the `llm` module's lifecycle.

pub mod math;
```

- [ ] **Step 3: Write the failing test.** Create `src-tauri/src/embed/math.rs`:

```rust
//! Pure vector helpers. No model state — fully unit-testable.

/// L2-normalize in place. A zero vector is left unchanged.
pub fn normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Truncate to `dim` (Matryoshka) then L2-normalize. If `v` is shorter than
/// `dim`, it is used as-is (then normalized).
pub fn truncate_renormalize(v: &[f32], dim: usize) -> Vec<f32> {
    let take = dim.min(v.len());
    let mut out = v[..take].to_vec();
    normalize(&mut out);
    out
}

/// Dot product. For L2-normalized inputs this equals cosine similarity.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Pack f32 little-endian for BLOB storage.
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    b
}

/// Unpack a little-endian f32 BLOB. Trailing bytes that don't form a full
/// f32 are ignored.
pub fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_makes_unit_length() {
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        let len = (v[0] * v[0] + v[1] * v[1]).sqrt();
        assert!((len - 1.0).abs() < 1e-6, "len was {len}");
    }

    #[test]
    fn normalize_leaves_zero_vector() {
        let mut v = vec![0.0, 0.0, 0.0];
        normalize(&mut v);
        assert_eq!(v, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn truncate_renormalize_truncates_and_unit_normalizes() {
        let v = vec![1.0, 2.0, 3.0, 4.0];
        let out = truncate_renormalize(&v, 2);
        assert_eq!(out.len(), 2);
        let len = (out[0] * out[0] + out[1] * out[1]).sqrt();
        assert!((len - 1.0).abs() < 1e-6);
    }

    #[test]
    fn dot_of_identical_unit_vectors_is_one() {
        let mut a = vec![1.0, 2.0, 2.0];
        normalize(&mut a);
        assert!((dot(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn blob_roundtrip() {
        let v = vec![0.5, -1.25, 3.0, 0.0];
        let back = blob_to_vec(&vec_to_blob(&v));
        assert_eq!(v, back);
    }
}
```

- [ ] **Step 4: Run the tests, expect FAIL (module not yet compiled / wired).** Run:

```bash
cd src-tauri && cargo test --lib embed::math:: 2>&1 | tail -20 && cd ..
```

Expected: compiles and tests PASS (these are pure functions). If it fails to compile, fix the `mod embed;` wiring until it builds.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/embed/mod.rs src-tauri/src/embed/math.rs src-tauri/src/lib.rs
git commit -m "feat(embed): vector math utilities (normalize, matryoshka truncate, blob codec)"
```

---

### Task 2: Embedding model catalog

**Files:**
- Create: `src-tauri/embed-models.json`
- Create: `src-tauri/src/embed/catalog.rs`
- Modify: `src-tauri/src/embed/mod.rs` (add `pub mod catalog;` + constants)

- [ ] **Step 1: Create the catalog JSON.** Create `src-tauri/embed-models.json`. The URL + size were verified live (HTTP 206, content-length 333590944) against the official llama.cpp `ggml-org` org on 2026-06-16. `sha256` is `PLACEHOLDER` exactly like `llm-models.json` (the downloader skips verification and logs a warning).

```json
{
  "version": 1,
  "_comment": "Text-embedding model registry. EmbeddingGemma-300m (Q8_0 GGUF) from the official ggml-org (llama.cpp) repo. Native dim 768; we use the first 256 dims (Matryoshka) after L2-normalization. Input context 2048. sha256 PLACEHOLDER => downloader skips verification. size_bytes measured via HTTP HEAD on 2026-06-16.",
  "models": [
    {
      "id": "embeddinggemma-300m-q8",
      "display_name": "EmbeddingGemma 300m (Q8_0)",
      "family": "embeddinggemma",
      "size_label": "318 MB",
      "size_bytes": 333590944,
      "context_length": 2048,
      "is_default": true,
      "supported": true,
      "files": [
        {
          "name": "embeddinggemma-300M-Q8_0.gguf",
          "url": "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf",
          "sha256": "PLACEHOLDER",
          "size_bytes": 333590944
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Add constants + catalog module to `embed/mod.rs`.** Edit `src-tauri/src/embed/mod.rs` to read:

```rust
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
```

- [ ] **Step 3: Write the catalog + a failing test.** Create `src-tauri/src/embed/catalog.rs`:

```rust
//! Loads the embedding-model catalog and reuses the LLM downloader for
//! fetch/path/exists logic (the registry entry shape is identical).

use crate::llm::downloader;
use crate::llm::registry::LlmModelEntry;
use std::path::PathBuf;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../../embed-models.json");

#[derive(serde::Deserialize)]
struct Catalog {
    models: Vec<LlmModelEntry>,
}

static CATALOG: OnceLock<Vec<LlmModelEntry>> = OnceLock::new();

fn entries() -> &'static [LlmModelEntry] {
    CATALOG
        .get_or_init(|| {
            serde_json::from_str::<Catalog>(CATALOG_JSON)
                .expect("embed-models.json is valid")
                .models
        })
        .as_slice()
}

/// The single embedding model entry.
pub fn model() -> &'static LlmModelEntry {
    entries()
        .iter()
        .find(|m| m.id == super::EMBED_MODEL_ID)
        .expect("embedding model present in catalog")
}

/// On-disk path to the model file (reuses the LLM downloader layout).
pub fn model_file_path() -> Option<PathBuf> {
    downloader::model_file_path(model())
}

/// True when the model file exists on disk.
pub fn is_downloaded() -> bool {
    downloader::is_downloaded(model())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_and_has_the_model() {
        let m = model();
        assert_eq!(m.id, super::super::EMBED_MODEL_ID);
        assert!(!m.files.is_empty());
        assert!(m.files[0].url.starts_with("https://"));
    }
}
```

- [ ] **Step 4: Run, expect PASS.** Run:

```bash
cd src-tauri && cargo test --lib embed::catalog:: 2>&1 | tail -20 && cd ..
```

Expected: PASS. If `LlmModelEntry` is not `Deserialize`-constructible here, confirm it derives `Deserialize` (it does per `registry.rs`).

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/embed-models.json src-tauri/src/embed/mod.rs src-tauri/src/embed/catalog.rs
git commit -m "feat(embed): embedding-model catalog (EmbeddingGemma-300m) reusing llm downloader"
```

---

### Task 3: EmbedEngine (llama-cpp-2 pooled forward pass)

**Files:**
- Create: `src-tauri/src/embed/engine.rs`
- Modify: `src-tauri/src/embed/mod.rs` (add `pub mod engine;` + `EmbedError`)

- [ ] **Step 1: Add `EmbedError` + module decl to `embed/mod.rs`.** Append to `src-tauri/src/embed/mod.rs`:

```rust
pub mod engine;

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
```

- [ ] **Step 2: Write `EmbedEngine`.** Create `src-tauri/src/embed/engine.rs`. Mirror the `use` imports from `src/llm/engine.rs` for the llama-cpp-2 types; the only addition is `LlamaPoolingType`.

```rust
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
```

> **Implementation note for the worker:** If `embeddings_seq_ith(0)` returns a `NonePoolType`/null error at runtime, the GGUF's pooling metadata is overriding our setting — the EmbeddingGemma GGUF normally carries mean-pooling metadata, so `with_pooling_type(Mean)` is belt-and-suspenders. The Task 4 sanity test is the real proof; if it fails on the embeddings read, that's the line to inspect.

- [ ] **Step 3: Build (no unit test here — needs the model).** Run:

```bash
cd src-tauri && cargo build 2>&1 | tail -25 && cd ..
```

Expected: compiles. Fix any import-path mismatches against `src/llm/engine.rs` (the llama-cpp-2 module paths there are authoritative for this crate version).

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/embed/mod.rs src-tauri/src/embed/engine.rs
git commit -m "feat(embed): EmbedEngine pooled forward pass via llama-cpp-2"
```

---

### Task 4: Embedder orchestrator + EmbedDocs trait

**Files:**
- Modify: `src-tauri/src/embed/mod.rs` (add `Embedder`, `EmbedDocs`)

- [ ] **Step 1: Add the orchestrator + trait.** Append to `src-tauri/src/embed/mod.rs`:

```rust
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
                if let Ok(mut g) = this.engine.try_lock() {
                    if g.is_some() {
                        info!(target: "mem", idle_secs = idle.as_secs(), "[mem] unloading idle embedding engine");
                        *g = None;
                    }
                } else {
                    warn!(target: "mem", "embed engine busy; deferring idle-unload");
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
```

- [ ] **Step 2: Write the gated sanity test.** This needs the real model, so it self-skips when the model isn't downloaded — `cargo test` stays green on machines/CI without it. Append to `src-tauri/src/embed/mod.rs`:

```rust
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
```

- [ ] **Step 3: Build + run the (skipping) unit suite.** Run:

```bash
cd src-tauri && cargo test --lib embed:: 2>&1 | tail -20 && cd ..
```

Expected: PASS (the `#[ignore]` sanity test is skipped; math/catalog tests pass). This proves the orchestrator compiles and integrates.

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/embed/mod.rs
git commit -m "feat(embed): Embedder orchestrator with idle-unload + EmbedDocs seam"
```

> The real sanity test runs at the end of Task 11 once the model can be downloaded.

---

### Task 5: Wire Embedder into AppState + app startup

**Files:**
- Modify: `src-tauri/src/commands.rs` (`AppState` struct, ~line 52-85)
- Modify: `src-tauri/src/lib.rs` (build embedder ~line 415-484; AppState construction ~line 561-579)

- [ ] **Step 1: Add the field to `AppState`.** In `src-tauri/src/commands.rs`, add to the `AppState` struct (next to `pub llm: Arc<Llm>,`):

```rust
    pub embedder: Arc<crate::embed::Embedder>,
```

- [ ] **Step 2: Build the embedder + spawn its unloader.** In `src-tauri/src/lib.rs`, immediately after the LLM unloader spawn block (the block ending around line 439), add:

```rust
    // Embedding model: built once, lazy-loaded on first use, idle-unloaded.
    let embedder = crate::embed::Embedder::new(std::time::Duration::from_secs(180));
    embedder.spawn_unloader();
```

- [ ] **Step 3: Add the embedder to the memory sampler.** In `src-tauri/src/lib.rs`, in the mem-sampler block (~line 453-484), clone the embedder into the task and add two fields to the `"[mem] sample"` log. Change the clones at the top of the block to include:

```rust
        let embed_sampler = Arc::clone(&embedder);
```

and add these two fields to the `info!(target: "mem", ... "[mem] sample")` call:

```rust
                embed_loaded = embed_sampler.is_loaded(),
                embed_idle_s = embed_sampler.idle_for().as_secs(),
```

- [ ] **Step 4: Put the embedder into `AppState`.** In the `AppState { ... }` construction (~line 561-579), add:

```rust
        embedder: Arc::clone(&embedder),
```

- [ ] **Step 5: Build + boot.** Run:

```bash
cd src-tauri && cargo build 2>&1 | tail -25 && cd ..
```

Expected: compiles. (Full app boot is verified at the end of M2.)

- [ ] **Step 6: Commit.**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(embed): wire Embedder into AppState, idle-unloader, and mem sampler"
```

---

# Milestone 2 — Index + Backfill

### Task 6: Migration v19 — embeddings tables

**Files:**
- Modify: `src-tauri/src/db/schema.rs` (append to `MIGRATIONS`)

- [ ] **Step 1: Append the migration.** In `src-tauri/src/db/schema.rs`, add a new tuple to the end of the `MIGRATIONS` array (the current highest version is 18, so this is **19**):

```rust
        (
            19,
            r#"
CREATE TABLE IF NOT EXISTS embeddings (
  id            TEXT PRIMARY KEY,
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  passage_idx   INTEGER NOT NULL,
  passage_text  TEXT NOT NULL,
  vec           BLOB NOT NULL,
  dim           INTEGER NOT NULL,
  model_id      TEXT NOT NULL,
  project_id    TEXT,
  captured_at   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_source   ON embeddings(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_emb_captured ON embeddings(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_emb_project  ON embeddings(project_id);

CREATE TABLE IF NOT EXISTS embedding_index_state (
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  indexed_at    TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
"#,
        ),
```

- [ ] **Step 2: Write the failing test.** Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/db/schema.rs` (or create one if absent):

```rust
    #[test]
    fn migration_v19_creates_embedding_tables() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        super::run_migrations(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('embeddings','embedding_index_state')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }
```

- [ ] **Step 3: Run, expect PASS.** Run:

```bash
cd src-tauri && cargo test --lib schema::tests::migration_v19 2>&1 | tail -20 && cd ..
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/db/schema.rs
git commit -m "feat(db): migration v19 adds embeddings + embedding_index_state tables"
```

---

### Task 7: db::embeddings — storage queries

**Files:**
- Create: `src-tauri/src/db/embeddings.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod embeddings;`)

- [ ] **Step 1: Register the module.** In `src-tauri/src/db/mod.rs`, add next to the other `pub mod` declarations:

```rust
pub mod embeddings;
```

- [ ] **Step 2: Write the module + failing tests.** Create `src-tauri/src/db/embeddings.rs`:

```rust
//! Storage for passage embeddings + per-source index state.

use rusqlite::{params, Connection};

use crate::db::DbError;
use crate::embed::math::{blob_to_vec, vec_to_blob};

#[derive(Debug, Clone)]
pub struct EmbeddingRow {
    pub id: String,
    pub source_kind: String,
    pub source_id: String,
    pub passage_idx: i64,
    pub passage_text: String,
    pub vec: Vec<f32>,
    pub dim: i64,
    pub model_id: String,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub content_hash: String,
    pub created_at: String,
}

/// Replace ALL embeddings for one source in a single transaction (delete then
/// insert), so re-indexing an edited source can't leave stale passages.
pub fn replace_source_embeddings(
    conn: &mut Connection,
    source_kind: &str,
    source_id: &str,
    rows: &[EmbeddingRow],
) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM embeddings WHERE source_kind = ?1 AND source_id = ?2",
        params![source_kind, source_id],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO embeddings
               (id, source_kind, source_id, passage_idx, passage_text, vec, dim,
                model_id, project_id, captured_at, content_hash, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        )?;
        for r in rows {
            stmt.execute(params![
                r.id,
                r.source_kind,
                r.source_id,
                r.passage_idx,
                r.passage_text,
                vec_to_blob(&r.vec),
                r.dim,
                r.model_id,
                r.project_id,
                r.captured_at,
                r.content_hash,
                r.created_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The content hash last successfully indexed for a source, if any.
pub fn get_index_state(
    conn: &Connection,
    source_kind: &str,
    source_id: &str,
) -> Result<Option<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT content_hash FROM embedding_index_state WHERE source_kind = ?1 AND source_id = ?2",
    )?;
    let mut rows = stmt.query(params![source_kind, source_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_index_state(
    conn: &Connection,
    source_kind: &str,
    source_id: &str,
    content_hash: &str,
    model_id: &str,
    indexed_at: &str,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO embedding_index_state (source_kind, source_id, content_hash, model_id, indexed_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(source_kind, source_id)
         DO UPDATE SET content_hash = excluded.content_hash,
                       model_id = excluded.model_id,
                       indexed_at = excluded.indexed_at",
        params![source_kind, source_id, content_hash, model_id, indexed_at],
    )?;
    Ok(())
}

pub fn count_embeddings(conn: &Connection) -> Result<i64, DbError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?)
}

pub fn count_indexed_sources(conn: &Connection) -> Result<i64, DbError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM embedding_index_state", [], |r| r.get(0))?)
}

/// Test/diagnostic helper: fetch a source's passages (vectors decoded).
pub fn fetch_by_source(
    conn: &Connection,
    source_kind: &str,
    source_id: &str,
) -> Result<Vec<EmbeddingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, source_kind, source_id, passage_idx, passage_text, vec, dim,
                model_id, project_id, captured_at, content_hash, created_at
         FROM embeddings WHERE source_kind = ?1 AND source_id = ?2
         ORDER BY passage_idx ASC",
    )?;
    let rows = stmt.query_map(params![source_kind, source_id], |row| {
        let blob: Vec<u8> = row.get(5)?;
        Ok(EmbeddingRow {
            id: row.get(0)?,
            source_kind: row.get(1)?,
            source_id: row.get(2)?,
            passage_idx: row.get(3)?,
            passage_text: row.get(4)?,
            vec: blob_to_vec(&blob),
            dim: row.get(6)?,
            model_id: row.get(7)?,
            project_id: row.get(8)?,
            captured_at: row.get(9)?,
            content_hash: row.get(10)?,
            created_at: row.get(11)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&mut c).unwrap();
        c
    }

    fn row(idx: i64, hash: &str) -> EmbeddingRow {
        EmbeddingRow {
            id: format!("e{idx}"),
            source_kind: "item".into(),
            source_id: "item-1".into(),
            passage_idx: idx,
            passage_text: format!("passage {idx}"),
            vec: vec![0.1, 0.2, 0.3],
            dim: 3,
            model_id: "m".into(),
            project_id: None,
            captured_at: "2026-06-01T00:00:00Z".into(),
            content_hash: hash.into(),
            created_at: "2026-06-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn replace_then_fetch_roundtrips_vectors() {
        let mut c = mem();
        replace_source_embeddings(&mut c, "item", "item-1", &[row(0, "h1"), row(1, "h1")]).unwrap();
        let got = fetch_by_source(&c, "item", "item-1").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].vec, vec![0.1, 0.2, 0.3]);
        assert_eq!(count_embeddings(&c).unwrap(), 2);
    }

    #[test]
    fn replace_deletes_previous_passages() {
        let mut c = mem();
        replace_source_embeddings(&mut c, "item", "item-1", &[row(0, "h1"), row(1, "h1")]).unwrap();
        replace_source_embeddings(&mut c, "item", "item-1", &[row(0, "h2")]).unwrap();
        assert_eq!(count_embeddings(&c).unwrap(), 1);
    }

    #[test]
    fn index_state_upserts() {
        let c = mem();
        assert_eq!(get_index_state(&c, "item", "x").unwrap(), None);
        set_index_state(&c, "item", "x", "h1", "m", "t1").unwrap();
        assert_eq!(get_index_state(&c, "item", "x").unwrap().as_deref(), Some("h1"));
        set_index_state(&c, "item", "x", "h2", "m", "t2").unwrap();
        assert_eq!(get_index_state(&c, "item", "x").unwrap().as_deref(), Some("h2"));
        assert_eq!(count_indexed_sources(&c).unwrap(), 1);
    }
}
```

- [ ] **Step 3: Run, expect PASS.** Run:

```bash
cd src-tauri && cargo test --lib db::embeddings:: 2>&1 | tail -25 && cd ..
```

Expected: PASS (3 tests).

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/embeddings.rs
git commit -m "feat(db): embeddings storage (replace-by-source, index-state, counts)"
```

---

### Task 8: chat_memory::chunk — passage chunker

**Files:**
- Create: `src-tauri/src/chat_memory/mod.rs`
- Create: `src-tauri/src/chat_memory/chunk.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod chat_memory;`)

- [ ] **Step 1: Declare the module.** In `src-tauri/src/lib.rs`, add near the other `mod` declarations:

```rust
pub mod chat_memory;
```

- [ ] **Step 2: Create the module root with the shared type.** Create `src-tauri/src/chat_memory/mod.rs`:

```rust
//! Builds and maintains the embedding index over history items + summaries.

pub mod chunk;
pub mod indexer;
pub mod source;

/// One thing to be embedded: a raw item or a rendered summary.
#[derive(Debug, Clone)]
pub struct SourceDoc {
    /// "item" | "meeting_summary" | "daily_summary"
    pub source_kind: &'static str,
    pub source_id: String,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub text: String,
    /// Max passages to keep (bounds monster meeting transcripts).
    pub max_passages: usize,
}
```

- [ ] **Step 3: Write the chunker + failing tests.** Create `src-tauri/src/chat_memory/chunk.rs`:

```rust
//! Splits text into overlapping passages on paragraph/sentence boundaries,
//! capped at `max_passages`. Character-based (EmbeddingGemma's 2048-token
//! window easily holds a ~900-char passage).

const TARGET_CHARS: usize = 900;
const OVERLAP_CHARS: usize = 120;
const HARD_MAX_CHARS: usize = 1200;

/// Returns trimmed, non-empty passages (at most `max_passages`).
pub fn passages(text: &str, max_passages: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() || max_passages == 0 {
        return Vec::new();
    }

    // Split into atoms on blank lines, then newlines, then sentence enders.
    let mut atoms: Vec<&str> = Vec::new();
    for para in text.split("\n\n") {
        for line in para.split('\n') {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if line.len() <= HARD_MAX_CHARS {
                atoms.push(line);
            } else {
                atoms.extend(split_sentences(line));
            }
        }
    }

    // Greedily pack atoms into ~TARGET_CHARS passages with a little overlap.
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for atom in atoms {
        if !cur.is_empty() && cur.len() + 1 + atom.len() > TARGET_CHARS {
            out.push(cur.clone());
            if out.len() >= max_passages {
                return out;
            }
            // Carry the tail of the previous passage as overlap context.
            cur = tail(&cur, OVERLAP_CHARS);
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(atom);
        // A single huge atom (already <= HARD_MAX) may exceed TARGET; flush it.
        if cur.len() >= HARD_MAX_CHARS {
            out.push(cur.clone());
            if out.len() >= max_passages {
                return out;
            }
            cur.clear();
        }
    }
    if !cur.trim().is_empty() && out.len() < max_passages {
        out.push(cur.trim().to_string());
    }
    out
}

fn split_sentences(line: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = line.as_bytes();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if (b == b'.' || b == b'?' || b == b'!') && i + 1 < bytes.len() && bytes[i + 1] == b' ' {
            let s = line[start..=i].trim();
            if !s.is_empty() {
                parts.push(s);
            }
            start = i + 1;
        }
    }
    let s = line[start..].trim();
    if !s.is_empty() {
        parts.push(s);
    }
    parts
}

/// Last `n` chars of `s` (char-safe), used as overlap.
fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        return s.to_string();
    }
    chars[chars.len() - n..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_passage() {
        let p = passages("just a short note", 40);
        assert_eq!(p, vec!["just a short note".to_string()]);
    }

    #[test]
    fn empty_text_yields_nothing() {
        assert!(passages("   ", 40).is_empty());
        assert!(passages("anything", 0).is_empty());
    }

    #[test]
    fn long_text_splits_into_multiple_passages() {
        let para = "Sentence number ".repeat(200); // ~3200 chars
        let p = passages(&para, 40);
        assert!(p.len() >= 2, "expected multiple passages, got {}", p.len());
        for chunk in &p {
            assert!(chunk.len() <= super::HARD_MAX_CHARS + 1);
        }
    }

    #[test]
    fn respects_max_passages_cap() {
        let para = "word ".repeat(5000); // very long
        let p = passages(&para, 3);
        assert_eq!(p.len(), 3);
    }
}
```

- [ ] **Step 4: Run, expect PASS.** Run:

```bash
cd src-tauri && cargo test --lib chat_memory::chunk:: 2>&1 | tail -25 && cd ..
```

Expected: PASS (4 tests). (`indexer` and `source` modules are referenced by `mod.rs` but created in the next tasks — if the build fails on missing modules, create empty stub files `chat_memory/source.rs` and `chat_memory/indexer.rs` containing only `//! stub` and a temporary `pub fn _stub() {}`, then remove in their tasks. Simpler: do Step 1-3 of Tasks 9 and 10 to create those files before running this. Recommended order: create all three files' skeletons, then fill.)

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/lib.rs src-tauri/src/chat_memory/mod.rs src-tauri/src/chat_memory/chunk.rs
git commit -m "feat(chat_memory): passage chunker with overlap + max-passage cap"
```

---

### Task 9: chat_memory::source — render summaries + collect sources

**Files:**
- Create: `src-tauri/src/chat_memory/source.rs`

- [ ] **Step 1: Write the renderers + collector + failing tests.** Create `src-tauri/src/chat_memory/source.rs`:

```rust
//! Turns DB rows (items, meeting summaries, daily summaries) into SourceDocs.

use rusqlite::Connection;

use crate::db::DbError;
use crate::meeting::synthesizer::StoredSummary;

use super::SourceDoc;

/// Items get up to this many passages (bounds 40k-token meeting transcripts).
const ITEM_MAX_PASSAGES: usize = 40;
const SUMMARY_MAX_PASSAGES: usize = 8;

/// Render a meeting's `summary_json` into plain text for embedding.
/// Returns None if the JSON is missing/unparseable/empty.
pub fn render_meeting_summary(summary_json: &str) -> Option<String> {
    let s: StoredSummary = serde_json::from_str(summary_json).ok()?;
    let mut parts: Vec<String> = Vec::new();
    if !s.suggested_title.trim().is_empty() {
        parts.push(s.suggested_title.trim().to_string());
    }
    for b in &s.summary {
        if !b.trim().is_empty() {
            parts.push(format!("- {}", b.trim()));
        }
    }
    if !s.action_items.is_empty() {
        parts.push("Action items:".to_string());
        for a in &s.action_items {
            if !a.text.trim().is_empty() {
                parts.push(format!("- {} ({})", a.text.trim(), a.owner));
            }
        }
    }
    let text = parts.join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Collect every embeddable source currently in the DB.
pub fn collect_source_docs(conn: &Connection) -> Result<Vec<SourceDoc>, DbError> {
    let mut docs = Vec::new();

    // 1) Raw items (voice notes, log captures, meeting transcript items).
    for it in crate::db::items::list_items_since(conn, None)? {
        if it.content.trim().is_empty() {
            continue;
        }
        docs.push(SourceDoc {
            source_kind: "item",
            source_id: it.id,
            project_id: it.project_id,
            captured_at: it.captured_at,
            text: it.content,
            max_passages: ITEM_MAX_PASSAGES,
        });
    }

    // 2) Meeting summaries (concise overviews of the monster transcripts).
    for m in crate::db::meetings::list_meetings(conn)? {
        if let Some(json) = &m.summary_json {
            if let Some(text) = render_meeting_summary(json) {
                docs.push(SourceDoc {
                    source_kind: "meeting_summary",
                    source_id: m.item_id.clone(),
                    project_id: None,
                    captured_at: m.started_at.clone(),
                    text,
                    max_passages: SUMMARY_MAX_PASSAGES,
                });
            }
        }
    }

    // 3) Daily summaries (the rolling per-day narrative).
    for d in crate::db::daily_summaries::list_recent(conn, u32::MAX)? {
        if d.narrative.trim().is_empty() {
            continue;
        }
        docs.push(SourceDoc {
            source_kind: "daily_summary",
            source_id: d.date.clone(),
            project_id: None,
            captured_at: d.generated_at.clone(),
            text: d.narrative.clone(),
            max_passages: SUMMARY_MAX_PASSAGES,
        });
    }

    Ok(docs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::synthesizer::{ActionItem, StoredSummary};

    #[test]
    fn renders_meeting_summary_with_actions() {
        let s = StoredSummary {
            summary: vec!["Discussed Q3 launch".into()],
            action_items: vec![ActionItem {
                text: "Send pricing deck".into(),
                owner: "you".into(),
                tags: vec![],
                project_name: None,
            }],
            suggested_title: "Q3 Planning".into(),
            raw: None,
            tags: vec![],
            project_name: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        let text = render_meeting_summary(&json).unwrap();
        assert!(text.contains("Q3 Planning"));
        assert!(text.contains("Discussed Q3 launch"));
        assert!(text.contains("Send pricing deck (you)"));
    }

    #[test]
    fn unparseable_summary_returns_none() {
        assert!(render_meeting_summary("not json").is_none());
    }
}
```

- [ ] **Step 2: Run, expect PASS.** Run:

```bash
cd src-tauri && cargo test --lib chat_memory::source:: 2>&1 | tail -25 && cd ..
```

Expected: PASS (2 tests). If `StoredSummary`/`ActionItem` field names differ, align with `src/meeting/synthesizer.rs` (verified fields: `summary: Vec<String>`, `action_items: Vec<ActionItem>`, `suggested_title: String`, `raw: Option<String>`, `tags: Vec<String>`, `project_name: Option<String>`; `ActionItem { text, owner, tags, project_name }`).

- [ ] **Step 3: Commit.**

```bash
git add src-tauri/src/chat_memory/source.rs
git commit -m "feat(chat_memory): render meeting/daily summaries + collect source docs"
```

---

### Task 10: chat_memory::indexer — incremental indexing core

**Files:**
- Create/replace: `src-tauri/src/chat_memory/indexer.rs`

- [ ] **Step 1: Write the indexer + failing tests.** Create `src-tauri/src/chat_memory/indexer.rs` (this task covers `collect`+`index_docs`+`index_pending`; the scheduler is Task 12):

```rust
//! Embeds pending sources into the vector store. Idempotent + incremental via
//! a per-source content hash. Pure DB+embed logic (no Tauri) so it unit-tests
//! with an in-memory connection and a stub embedder.

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::db::embeddings::{self, EmbeddingRow};
use crate::db::{Db, DbError};
use crate::embed::{EmbedDocs, EmbedError, EMBED_DIM};

use super::source::collect_source_docs;
use super::{chunk, SourceDoc};

#[derive(Debug, Default, Clone, Copy)]
pub struct IndexStats {
    pub sources_indexed: usize,
    pub sources_skipped: usize,
    pub passages_written: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Embed(#[from] EmbedError),
}

fn content_hash(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

/// A monotonic-ish timestamp string. `Date::now()` isn't available in this
/// codebase's test helpers, so we accept it as a parameter at call sites.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Index one batch of already-collected docs against an in-memory or live
/// connection. Skips sources whose content hash is unchanged.
pub fn index_docs(
    conn: &mut Connection,
    docs: &[SourceDoc],
    embedder: &dyn EmbedDocs,
    model_id: &str,
) -> Result<IndexStats, IndexError> {
    let mut stats = IndexStats::default();
    for doc in docs {
        let hash = content_hash(&doc.text);
        let prev = embeddings::get_index_state(conn, doc.source_kind, &doc.source_id)?;
        if prev.as_deref() == Some(hash.as_str()) {
            stats.sources_skipped += 1;
            continue;
        }

        let passages = chunk::passages(&doc.text, doc.max_passages);
        if passages.is_empty() {
            stats.sources_skipped += 1;
            continue;
        }

        let vectors = embedder.embed_documents(&passages)?;
        let created = now_iso();
        let rows: Vec<EmbeddingRow> = passages
            .iter()
            .zip(vectors.iter())
            .enumerate()
            .map(|(i, (text, vec))| EmbeddingRow {
                id: format!("{}:{}:{}", doc.source_kind, doc.source_id, i),
                source_kind: doc.source_kind.to_string(),
                source_id: doc.source_id.clone(),
                passage_idx: i as i64,
                passage_text: text.clone(),
                vec: vec.clone(),
                dim: EMBED_DIM as i64,
                model_id: model_id.to_string(),
                project_id: doc.project_id.clone(),
                captured_at: doc.captured_at.clone(),
                content_hash: hash.clone(),
                created_at: created.clone(),
            })
            .collect();

        embeddings::replace_source_embeddings(conn, doc.source_kind, &doc.source_id, &rows)?;
        embeddings::set_index_state(conn, doc.source_kind, &doc.source_id, &hash, model_id, &created)?;
        stats.sources_indexed += 1;
        stats.passages_written += rows.len();
        if stats.sources_indexed % 50 == 0 {
            info!(target: "index", indexed = stats.sources_indexed, passages = stats.passages_written, "indexing progress");
        }
    }
    Ok(stats)
}

/// Live entry point: collect all sources and index the pending ones.
pub fn index_pending(db: &Db, embedder: &dyn EmbedDocs, model_id: &str) -> Result<IndexStats, IndexError> {
    let docs = db.with_conn(|c| collect_source_docs(c))?;
    let stats = db.with_conn_mut(|c| index_docs(c, &docs, embedder, model_id))?;
    if stats.sources_indexed > 0 {
        info!(target: "index", indexed = stats.sources_indexed, skipped = stats.sources_skipped, passages = stats.passages_written, "index pass complete");
    } else if stats.sources_skipped > 0 {
        warn!(target: "index", skipped = stats.sources_skipped, "index pass: nothing new");
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Stub;
    impl EmbedDocs for Stub {
        fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
            Ok(texts.iter().map(|_| vec![0.1_f32; EMBED_DIM]).collect())
        }
    }

    fn mem() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&mut c).unwrap();
        c
    }

    fn insert_item(c: &Connection, id: &str, content: &str) {
        c.execute(
            "INSERT INTO items (id, content, source, visibility, kind, project_id, captured_at, created_at)
             VALUES (?1, ?2, 'voice_at_cursor', 'private', 'note', NULL, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
            rusqlite::params![id, content],
        )
        .unwrap();
    }

    fn docs(c: &Connection) -> Vec<SourceDoc> {
        super::collect_source_docs(c).unwrap()
    }

    #[test]
    fn indexes_items_then_is_idempotent() {
        let mut c = mem();
        insert_item(&c, "i1", "first note about pricing");
        insert_item(&c, "i2", "second note about scheduling");

        let d = docs(&c);
        let s1 = index_docs(&mut c, &d, &Stub, "m").unwrap();
        assert_eq!(s1.sources_indexed, 2);
        assert_eq!(embeddings::count_embeddings(&c).unwrap(), 2);

        // Second pass: nothing changed -> all skipped, no new rows.
        let d2 = docs(&c);
        let s2 = index_docs(&mut c, &d2, &Stub, "m").unwrap();
        assert_eq!(s2.sources_indexed, 0);
        assert_eq!(s2.sources_skipped, 2);
        assert_eq!(embeddings::count_embeddings(&c).unwrap(), 2);
    }

    #[test]
    fn reindexes_when_content_changes() {
        let mut c = mem();
        insert_item(&c, "i1", "original content");
        index_docs(&mut c, &docs(&c), &Stub, "m").unwrap();

        c.execute("UPDATE items SET content = 'edited content' WHERE id = 'i1'", [])
            .unwrap();
        let s = index_docs(&mut c, &docs(&c), &Stub, "m").unwrap();
        assert_eq!(s.sources_indexed, 1);
        assert_eq!(embeddings::count_embeddings(&c).unwrap(), 1);
    }
}
```

- [ ] **Step 2: Confirm `chrono` is available.** `daily_summary/scheduler.rs` uses `Local::now()`, so `chrono` is a dependency. Verify:

```bash
cd src-tauri && grep -n '^chrono' Cargo.toml && cd ..
```

Expected: a `chrono = ...` line. If absent, replace `now_iso()` with the timestamp helper used elsewhere in the codebase (search for `to_rfc3339` / `Utc::now`).

- [ ] **Step 3: Run, expect PASS.** Run:

```bash
cd src-tauri && cargo test --lib chat_memory::indexer:: 2>&1 | tail -25 && cd ..
```

Expected: PASS (2 tests).

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/chat_memory/indexer.rs
git commit -m "feat(chat_memory): incremental, idempotent embedding indexer (hash-gated)"
```

---

### Task 11: Tauri commands — download model + index status + api.ts

**Files:**
- Modify: `src-tauri/src/commands.rs` (two commands + register)
- Modify: `src-tauri/src/lib.rs` (add to `tauri::generate_handler!`)
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the commands.** In `src-tauri/src/commands.rs`, add (near the other `#[tauri::command]` fns; uses `tauri::Emitter` for `app.emit`, already imported in this file since other commands emit):

```rust
#[tauri::command]
pub async fn download_embedding_model(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let entry = crate::embed::catalog::model();
    let dir = crate::llm::downloader::model_dir(entry);
    let app_for_cb = app.clone();
    crate::llm::downloader::download_model(entry, &dir, move |p| {
        let _ = app_for_cb.emit("embed-model-download-progress", p);
    })
    .await
    .map_err(|e| {
        tracing::error!(target: "embed", error = %e, "embedding model download failed");
        "Embedding model download failed. See Settings → Diagnostics → logs for details.".to_string()
    })?;
    tracing::info!(target: "embed", "embedding model downloaded");
    Ok(())
}

#[derive(serde::Serialize)]
pub struct EmbeddingIndexStatus {
    pub model_downloaded: bool,
    pub embeddings: i64,
    pub indexed_sources: i64,
    pub total_sources: i64,
}

#[tauri::command]
pub fn embedding_index_status(
    state: tauri::State<'_, AppState>,
) -> Result<EmbeddingIndexStatus, String> {
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| "database unavailable".to_string())?;
    db.with_conn(|c| {
        let embeddings = crate::db::embeddings::count_embeddings(c)?;
        let indexed_sources = crate::db::embeddings::count_indexed_sources(c)?;
        let docs = crate::chat_memory::source::collect_source_docs(c)?;
        Ok(EmbeddingIndexStatus {
            model_downloaded: crate::embed::catalog::is_downloaded(),
            embeddings,
            indexed_sources,
            total_sources: docs.len() as i64,
        })
    })
    .map_err(|e: crate::db::DbError| {
        tracing::error!(target: "embed", error = %e, "embedding_index_status failed");
        "Could not read index status.".to_string()
    })
}
```

- [ ] **Step 2: Register both commands.** In `src-tauri/src/lib.rs`, find the `tauri::generate_handler![ ... ]` macro invocation and add these two entries to the list (match the existing `commands::...` style):

```rust
            commands::download_embedding_model,
            commands::embedding_index_status,
```

- [ ] **Step 3: Add the frontend bindings.** In `src/lib/api.ts`, add (match the existing `invoke(...)` style used by `chatWithMemory`):

```typescript
export const downloadEmbeddingModel = (): Promise<void> =>
  invoke("download_embedding_model");

export interface EmbeddingIndexStatus {
  model_downloaded: boolean;
  embeddings: number;
  indexed_sources: number;
  total_sources: number;
}

export const getEmbeddingIndexStatus = (): Promise<EmbeddingIndexStatus> =>
  invoke("embedding_index_status");
```

- [ ] **Step 4: Build backend + typecheck frontend.** Run:

```bash
cd src-tauri && cargo build 2>&1 | tail -25 && cd ..
bun run tsc --noEmit 2>&1 | tail -20 || npx tsc --noEmit 2>&1 | tail -20
```

Expected: Rust compiles; TypeScript has no new errors. (If the project has no standalone tsc script, the Vite build during `bun tauri build` will catch type errors later — note and proceed.)

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(embed): download_embedding_model + embedding_index_status commands + api bindings"
```

---

### Task 12: Indexer scheduler + end-to-end verification

**Files:**
- Modify: `src-tauri/src/chat_memory/indexer.rs` (add `spawn`)
- Modify: `src-tauri/src/lib.rs` (spawn the scheduler)

- [ ] **Step 1: Add the scheduler to the indexer.** Append to `src-tauri/src/chat_memory/indexer.rs` (mirrors `daily_summary::scheduler::spawn`):

```rust
use crate::commands::AppState;
use tauri::{AppHandle, Manager};

/// Spawn the background indexing loop. Ticks periodically; when the embedding
/// model is present, indexes any pending sources. Cheap when nothing changed.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Small initial delay so startup isn't competing with model loads.
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;

            let (db, embedder) = {
                let state = app.state::<AppState>();
                (state.db.clone(), std::sync::Arc::clone(&state.embedder))
            };
            let Some(db) = db else { continue };
            if !crate::embed::catalog::is_downloaded() {
                continue; // user hasn't downloaded the embedding model yet
            }

            let model_id = crate::embed::EMBED_MODEL_ID.to_string();
            let res = tokio::task::spawn_blocking(move || {
                index_pending(&db, embedder.as_ref(), &model_id)
            })
            .await;
            match res {
                Ok(Ok(_stats)) => {}
                Ok(Err(e)) => tracing::error!(target: "index", error = %e, "indexer pass failed"),
                Err(e) => tracing::error!(target: "index", error = %e, "indexer task join failed"),
            }
        }
    });
}
```

> Note: `index_pending` takes `&dyn EmbedDocs`; `embedder.as_ref()` is `&Embedder`, which implements it. If the compiler wants an explicit coercion, use `embedder.as_ref() as &dyn crate::embed::EmbedDocs`.

- [ ] **Step 2: Spawn the scheduler at startup.** In `src-tauri/src/lib.rs`, right after the daily-summary scheduler spawn (`crate::daily_summary::scheduler::spawn(app.handle().clone());`, ~line 582), add:

```rust
    crate::chat_memory::indexer::spawn(app.handle().clone());
```

- [ ] **Step 3: Build.** Run:

```bash
cd src-tauri && cargo build 2>&1 | tail -25 && cd ..
```

Expected: compiles.

- [ ] **Step 4: Full unit suite.** Run:

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -25 && cd ..
```

Expected: all tests PASS (the `#[ignore]` embedder sanity test is skipped).

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/chat_memory/indexer.rs src-tauri/src/lib.rs
git commit -m "feat(chat_memory): background indexer scheduler wired into startup"
```

- [ ] **Step 6: Build + install the app (skip TCC — no permission-related changes).** Per `CLAUDE.md`:

```bash
bun tauri build --bundles app
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 7: Trigger the embedding-model download.** Open the app's devtools console (or a temporary dev button) and run:

```js
await window.__TAURI__.core.invoke('download_embedding_model')
```

Watch the daily log (`Settings → Diagnostics → open log folder`) for `target: "embed"` lines. Expected: `embedding model downloaded` after ~318 MB completes. Confirm the file exists:

```bash
ls -la "$HOME/Library/Application Support/EchoScribe/llm-models/embeddinggemma-300m-q8/"
```

Expected: `embeddinggemma-300M-Q8_0.gguf` (~318 MB).

- [ ] **Step 8: Watch the backfill + verify row counts.** Within ~1 minute the indexer tick should begin. Watch the log for `target: "index"` progress lines. Then query the DB directly:

```bash
DB="$HOME/Library/Application Support/EchoScribe/echo.db"
sqlite3 "$DB" "SELECT COUNT(*) AS embeddings, COUNT(DISTINCT source_id) AS sources FROM embeddings;"
sqlite3 "$DB" "SELECT source_kind, COUNT(*) FROM embeddings GROUP BY source_kind;"
sqlite3 "$DB" "SELECT COUNT(*) FROM embedding_index_state;"
sqlite3 "$DB" "SELECT dim, LENGTH(vec) FROM embeddings LIMIT 1;"
```

Expected: thousands of embeddings across `item`, `meeting_summary`, and `daily_summary` kinds; `dim = 256` and `LENGTH(vec) = 1024` (256 × 4 bytes); `embedding_index_state` populated. This is the M2 success criterion: **the vector store is populated and verifiable.**

- [ ] **Step 9: Run the real semantic sanity test (model now present).** Run:

```bash
cd src-tauri && cargo test --lib embed::tests::sanity -- --ignored --nocapture 2>&1 | tail -20 && cd ..
```

Expected: prints `related=… unrelated=…` with related > unrelated, and PASS. **This is the M1 validation gate** — it proves two llama-cpp-2 contexts (generation + embedding) coexist under Metal and that pooled embeddings rank semantically. If it fails on context/Metal, that informs the M3/M4 plan (serialize embed vs generate behind a shared permit).

- [ ] **Step 10: Confirm idle-unload + no idle regression.** Leave the app idle ~4 minutes; in the log confirm `[mem] unloading idle embedding engine` and that `[mem] sample` lines show `embed_loaded=false` afterward, with `rss_mib` returning near the pre-download baseline. Records that the memory discipline holds.

---

## Self-Review

**Spec coverage (against `2026-06-16-chat-memory-retrieval-design.md`, M1+M2 scope):**
- Embedding model on existing llama-cpp-2 runtime → Tasks 2-4. ✓
- 256-dim Matryoshka, L2-normalized → `math::truncate_renormalize` (Task 1), applied in `Embedder` (Task 4). ✓
- EmbeddingGemma prompt prefixes (query vs document) → `document_prompt`/`query_prompt` (Task 2), applied in `Embedder` (Task 4). ✓
- `embeddings` + `embedding_index_state` tables exactly as specced → Task 6. ✓
- Index raw items + meeting summaries + daily summaries → `collect_source_docs` (Task 9). ✓
- 40-passage cap on monster meetings → `ITEM_MAX_PASSAGES` (Task 9) + chunker cap (Task 8). ✓
- Idempotent/incremental via content_hash → `index_docs` (Task 10). ✓
- Background scheduler mirroring daily_summary → Task 12. ✓
- Idle-unload of the embedder + mem sampler integration → Tasks 4, 5, 12 step 10. ✓
- Backfill + verifiable row counts → Task 12 steps 7-8. ✓
- Structured `target:"embed"/"index"` logs + friendly UI errors → commands (Task 11), indexer/embedder logs. ✓
- M1 concurrency validation gate → Task 12 step 9. ✓
- **Deferred to M3/M4 (intentional):** dense+FTS+RRF retrieval, chat rewrite, 16k window/budget bump, ChatView banner + Settings download UI. Bindings (Task 11) exist so M4 wires UI without backend churn.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to". Every code step is complete. The one runtime-dependent value (next migration version) was verified as 19. The download URL was verified live (HTTP 206).

**Type consistency:** `EmbedDocs::embed_documents(&[String]) -> Result<Vec<Vec<f32>>, EmbedError>` used identically in Task 4 (def + impl), Task 10 (consumer + stub). `EmbeddingRow` fields match between Task 7 (def + queries) and Task 10 (construction). `SourceDoc` fields match Task 8 (def) ↔ Task 9 (construction) ↔ Task 10 (consumption). `EMBED_DIM` (Task 2) used in Task 4 + Task 10. Catalog `model()`/`is_downloaded()`/`model_file_path()` (Task 2) used in Tasks 4, 11, 12.

**Known soft spots flagged inline for the worker:** (a) exact llama-cpp-2 `use` paths — mirror `llm/engine.rs`; (b) `embeddings_seq_ith` pooling gotcha — Task 3 note + Task 12 step 9 is the proof; (c) `tsc` script name may vary — Task 11 step 4 notes the fallback; (d) module-creation order for `chat_memory` submodules — Task 8 step 4 note.
