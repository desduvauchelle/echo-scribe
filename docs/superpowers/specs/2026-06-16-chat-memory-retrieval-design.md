# Echo Scribe — Chat Memory v2 (Semantic Retrieval) Design

**Date:** 2026-06-16
**Status:** Approved
**Scope:** Replace keyword-only chat retrieval with hybrid semantic + keyword retrieval over a larger context budget; index raw notes *and* existing summaries; add a local embedding model.
**Supersedes / extends:** `2026-05-22-chunked-rag-retrieval-design.md` (the current `llm/rag.rs` keyword chunker), `2026-05-02-chat-sessions-design.md` (chat sessions + temporal parsing — kept, built upon).

---

## Context

The "chat with history" feature (`ChatView.tsx` → `chat_with_memory` command) is reported as **useless because it only considers ~4 items per question**. Investigation shows this is not a single hardcoded limit but three conservative constraints compounding:

- Retrieval is **keyword-only** (`items_fts` FTS5). Differently-worded notes are invisible — no semantic recall.
- Retrieved context is packed into a **3,500-token budget** (`rag::CONTEXT_BUDGET_TOKENS`), chunked at 600 chars.
- The generation call opens an **8,192-token window** (`rag::CHAT_N_CTX`), while the model (Gemma 4 E2B) supports **131,072**.

**Real data profile** (`~/Library/Application Support/EchoScribe/echo.db`, 2026-06-16):

| Metric | Value |
|---|---|
| Items (not deleted) | 2,770 (2,319 voice notes, 435 meetings, 16 captures) |
| Total content | ~785,000 tokens |
| Largest single meeting | ~42,000 tokens |
| Span | 45 days |
| Chat usage to date | 4 sessions / 12 messages |

The full corpus is **~6× the model's maximum window** and the data is bimodal (thousands of tiny voice notes + a few enormous meeting transcripts). "Load everything" is physically impossible. The user's goal is **open-ended chat that feels like it knows their whole history**.

## Decisions (from brainstorming)

1. **Architecture: retrieval-first.** Hybrid semantic + keyword search is the engine. (Not a rolling-summary-hierarchy system — we explicitly do *not* build/maintain new multi-level summaries.)
2. **Index existing summaries alongside raw items.** Meeting `summary_json` and `daily_summaries` are embedded into the same index as raw notes, so broad questions retrieve concise overviews and specific questions retrieve raw passages — without a new summary-maintenance system.
3. **Embedding model: EmbeddingGemma-300m**, used at **256-dim** (Matryoshka truncation) to save storage. Runs on the existing `llama-cpp-2` runtime.
4. **Build the real thing now** (no throwaway stopgap), delivered in independently-shippable milestones.

## Goal

Replace `chat_with_memory`'s retrieval with a hybrid pipeline that:

- Recalls semantically-relevant passages regardless of phrasing.
- Indexes raw items **and** existing meeting/daily summaries.
- Feeds a **~3× larger** retrieval budget into a **16,384-token** window (configurable).
- Stays within the project's memory discipline (models unload on idle; vector cache evicts on idle).
- Degrades gracefully to FTS-only while the embedding backfill is still running.

## Non-goals

- No rolling/hierarchical summary generation system (that was architecture B/C; rejected).
- No ANN / vector index extension (`sqlite-vec`) — brute-force cosine is sufficient at this scale; documented upgrade path only.
- No change to how items/meetings/daily-summaries are *created*; we only *read and embed* them.
- No cloud embeddings or cloud LLM.

---

## Architecture

```
INGEST / BACKFILL                          QUERY TIME
─────────────────                          ──────────
items / meeting summary_json /             user message
daily_summaries                                 │
        │                                  parse temporal window (temporal.rs)
  chat_memory::indexer (background)        + project scope
        │                                  detect intent: broad | specific
  chunk → ~256-tok passages                     │
        │                                  Embedder::embed(query, QUERY prompt)
  Embedder::embed(passages, DOC prompt)         │
        │                                  ┌─────┴───────────────┐
  store {vec(256d), text, hash} in         dense KNN          sparse FTS5
  `embeddings`; mark embedding_index_state (cosine, brute)    (search.rs)
                                           └─────┬───────────────┘
                                            RRF fuse (k=60)
                                                 │
                                            group by source, diversity cap,
                                            (broad ⇒ blend window summaries
                                             + diverse temporal sample)
                                                 │
                                            fill ~11k-token budget
                                                 │
                                            assemble: system + context + history
                                                 │
                                            Llm::generate (n_ctx=16384)
                                                 │
                                            reply + sources[]
```

### Module layout (Rust, `src-tauri/src/`)

| Module | Responsibility | New/Edit |
|---|---|---|
| `llm/embedder.rs` | `Embedder` orchestrator mirroring `Llm`: own model slot (`Arc<Mutex<Option<EmbedEngine>>>`), idle-unloader, batched `embed(texts, mode)` using a context with `ctx_params.embeddings(true)` + mean pooling + L2 normalize. | New |
| `llm/embed_engine.rs` | Thin llama-cpp-2 wrapper that loads the embedding GGUF and returns `n_embd`-dim vectors; applies Matryoshka truncation to 256-d + renormalize. | New |
| `db/embeddings.rs` | `embeddings` + `embedding_index_state` tables; insert/replace by source, delete by source, load candidate vectors (optionally filtered by project/date). | New |
| `chat_memory/mod.rs` | Module root + shared types (`Passage`, `SourceKind`, `RetrievedContext`). | New |
| `chat_memory/indexer.rs` | Backfill + incremental (re)indexing; resumable & idempotent via `content_hash`; scheduler spawned in `lib.rs`. | New |
| `chat_memory/retrieval.rs` | Hybrid dense+sparse retrieval, RRF, grouping/diversity, broad-query summary blending, budget packing. | New |
| `chat_memory/chunk.rs` | Passage chunker (~256-tok target, ~15% overlap, paragraph/sentence boundaries). | New (extracted/extended from `rag.rs`) |
| `llm/rag.rs` | Keep `estimate_tokens`, `query_terms`; bump `CHAT_N_CTX`→16384, `CONTEXT_BUDGET_TOKENS`→~11000; mark legacy keyword chunker deprecated/retained for fallback. | Edit |
| `llm/registry.rs` + `llm-models.json` | Add EmbeddingGemma-300m catalog entry (`kind: "embedding"`). | Edit |
| `commands.rs::chat_with_memory` | Rewrite to use `chat_memory::retrieval` + new window/budget + richer `sources`. | Edit |
| `lib.rs` | Spawn indexer scheduler; build `Embedder`; spawn its unloader; add to mem sampler. | Edit |

### Frontend (`src/`)

| File | Change |
|---|---|
| `lib/api.ts` | `chatWithMemory` unchanged signature; add `getEmbeddingIndexStatus()` + `downloadEmbeddingModel()` (reuse model-download bindings). |
| Settings (model section) | Embedding-model download/progress (reuse `LlmModelPicker`/`SpeechModelPicker` pattern); chat window-size selector (8k/16k/32k). |
| `views/sections/ChatView.tsx` | Sources panel already exists; enrich to show source kind (note / meeting summary / daily summary) + date. Show a subtle "indexing N% — answers improving" banner while backfill runs. |

---

## Data model

Migration adds two tables (follow existing `db/schema.rs` migration pattern; bump schema version).

```sql
-- One row per embedded passage (from a raw item OR a summary).
CREATE TABLE IF NOT EXISTS embeddings (
  id            TEXT PRIMARY KEY,        -- ulid
  source_kind   TEXT NOT NULL,           -- 'item' | 'meeting_summary' | 'daily_summary'
  source_id     TEXT NOT NULL,           -- items.id | meetings.id | daily_summaries key
  passage_idx   INTEGER NOT NULL,        -- 0-based passage within the source
  passage_text  TEXT NOT NULL,           -- the embedded text (for assembly + sources panel)
  vec           BLOB NOT NULL,           -- f32 little-endian, length = dim
  dim           INTEGER NOT NULL,        -- 256
  model_id      TEXT NOT NULL,           -- embedding model id that produced this
  project_id    TEXT,                    -- denormalized for filtering
  captured_at   TEXT NOT NULL,           -- denormalized for temporal filter/sample
  content_hash  TEXT NOT NULL,           -- hash of source content at index time
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_source   ON embeddings(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_emb_captured ON embeddings(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_emb_project  ON embeddings(project_id);

-- Tracks last-indexed state so (re)indexing is O(1) to decide and resumable.
CREATE TABLE IF NOT EXISTS embedding_index_state (
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,           -- hash last successfully indexed
  model_id      TEXT NOT NULL,
  indexed_at    TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
```

**Storage estimate:** ~13k passages today. 256-d × 4 bytes = 1 KB/vec → ~13 MB vectors + ~13 MB `passage_text`. Grows ~1 MB per 1,000 passages. Acceptable.

**Source content for each kind:**
- `item` — `items.content` (voice notes ≈ 1 passage; meeting transcript items chunked, **capped at 40 passages/source** so a 42k-token meeting can't flood the index — drill-down still works, just bounded).
- `meeting_summary` — rendered from `meetings.summary_json` (`StoredSummary`: bullets + action items + title + tags), 1–3 passages.
- `daily_summary` — `daily_summaries` row text, 1–few passages.

`content_hash` = hash of the exact source text used; lets the indexer detect edits/regenerations and re-embed only what changed.

---

## Embedding runtime

- **Model:** EmbeddingGemma-300m GGUF, added to `llm-models.json` with `kind: "embedding"`, `dim: 768`, `use_dim: 256`. Downloaded via existing `llm/downloader.rs` (HF stream + SHA-256 + atomic rename + progress) into `.../EchoScribe/llm-models/<id>/`.
- **Engine:** load with `ctx_params.embeddings(true)`; **mean-pool** token embeddings; **L2-normalize**; **Matryoshka-truncate** 768→256 then renormalize.
- **Prompt prefixes (required by EmbeddingGemma):** documents use the document prompt (`title: none | text: {text}`); queries use the query prompt (`task: search result | query: {text}`). These differ and **must** be applied consistently or recall collapses. Encoded in `embedder.rs`.
- **Concurrency:** a second model loaded under the same global `LlamaBackend` alongside the Gemma generation engine. **Validation item in M1:** confirm two contexts coexist cleanly under llama-cpp-2 + Metal; if not, serialize embed vs generate behind a shared permit. Embedder is small (~200–320 MB) so cost of keeping it briefly resident is low; it unloads on idle like the LLM.

---

## Retrieval algorithm (`chat_memory::retrieval`)

Inputs: `query`, `project_id?`, conversation history, DB handle, `Embedder`, `Llm`.

1. **Scope:** parse temporal window (reuse `temporal.rs`); apply `project_id` filter.
2. **Intent heuristic:** *broad* if query is short/generic or temporal-only ("what did I do last week", "catch me up"); *specific* if it has concrete entities/quoted terms/proper nouns. (Pure heuristic in M3; tune in M5.)
3. **Query embedding:** `Embedder::embed([query], QUERY)`.
4. **Dense:** brute-force cosine over candidate vectors (filtered by project/date when scoped) → top 60. Candidate vectors loaded into an in-memory cache (lazy, evict-on-idle).
5. **Sparse:** `search_items_with_date_window(query_terms, …)` (existing FTS5) → top 60. Extend so FTS can also surface `meeting_summary`/`daily_summary` rows (either index summaries into `items_fts` via a companion virtual table, or fold them in at query time — M3 decides the cleaner of the two).
6. **Fuse:** Reciprocal Rank Fusion (k=60) over dense ∪ sparse → unified ranking.
7. **Broad augmentation:** for *broad* intent, additionally include the window's `daily_summary`/`meeting_summary` passages and a **diverse temporal sample** (spread across the window) so overviews are coherent rather than top-similarity fragments.
8. **Group & diversify:** group passages by `source_id`, dedupe, **cap passages per source** (e.g. ≤3) so one chatty meeting can't dominate; prefer a source's summary passage for overview + its raw passages for detail.
9. **Pack:** greedily fill the **retrieval budget (~11,000 tokens)**; newest-first tie-break; retain `{source_kind, source_id, date, passage_text}` for attribution.

Returns `RetrievedContext { passages, sources }`.

## Context assembly & window

- **`CHAT_N_CTX = 16384`** (default; user-selectable 8192 / 16384 / 32768 in Settings, persisted via store).
- Budget: ~400 system + **~11,000 retrieved** + ~2,000 history (last 6 turns) + ~2,500 generation headroom.
- System prompt unchanged in spirit ("answer from the user's notes below; say so if they don't cover it"); now fed far more, and semantically-relevant, context.
- `sources[]` returned to the UI gains `kind` + `date`.

## Background indexing & lifecycle (`chat_memory::indexer`)

- **Backfill:** on startup, if the embedding model is downloaded and items are unindexed, embed all sources in batches. ~13k passages ≈ **1–4 min** on Metal. Progress exposed via a command + event (reuse download-progress UX). Chat works FTS-only meanwhile; banner communicates "indexing".
- **Incremental:** hook `item:created`, meeting finalize (`finalize_meeting`), and daily-summary generation to enqueue (re)indexing of the changed source. Detect work via `content_hash` vs `embedding_index_state`.
- **Scheduler:** spawn a `chat_memory::indexer::spawn(app_handle)` loop in `lib.rs` next to `daily_summary::scheduler::spawn` — tick (e.g. 60 s) to catch anything missed + drain a small queue.
- **Model change / re-embed:** switching embedding model (or `use_dim`) marks all `embedding_index_state` stale → full re-backfill; old vectors deleted as each source is re-embedded.
- **Memory discipline:** `Embedder` unloads on idle (mirror `Llm::spawn_unloader`); the in-memory candidate-vector cache loads lazily and evicts on idle; both surfaced in the `[mem]` sampler.

## Memory / latency budget (honest)

- Embedder resident ~200–320 MB **only when active**; unloaded on idle.
- Vector cache ~13 MB now (~1 MB / 1k passages); evictable.
- 16k vs 8k window: larger KV cache + ~1–2 s prefill before first token on a full context. Tunable down to 8k.
- **Idle footprint ≈ unchanged** vs today (both models unload, cache evicts).

## Error handling & diagnostics (per project rules)

- Structured logs with `target: "embed" | "index" | "chat"` at every boundary: embed batch sizes + dims, candidate counts (dense/sparse), fused top-k, budget fill, per-stage timings, backfill progress. Never log passage text at `info` (privacy) — log counts/ids/lengths.
- Boundary results logged on success **and** failure (model load, download, embed call, DB upsert).
- Friendly UI messages: if the embedding model isn't downloaded → "Semantic search is off — download the embedding model in Settings"; if embedding fails mid-chat → silently fall back to FTS-only and log the error; backfill failure → toast + log. Never surface raw errors.

## Testing

- **Rust unit:** cosine + RRF math; Matryoshka truncate+renormalize; chunk boundaries/overlap; `content_hash` staleness; budget packing; prompt-prefix application. Extend existing `rag` tests.
- **Integration:** run retrieval against a **copy of the live `echo.db`** (2,770 items) with representative queries — broad ("what did I work on last week"), specific ("pricing discussion"), entity (a real project name) — and assert relevant + numerous sources (≫4). Include a known semantic-but-non-keyword pair to prove dense recall beats the old FTS-only path.
- **Manual:** build app per CLAUDE.md (no TCC reset — no permission-relevant changes), real chat session, confirm source count/quality, measure reply latency + RSS via `[mem]` sampler before/after.

## Build order (milestones — each independently shippable & verifiable)

1. **M1 — Embedding runtime.** Catalog entry + downloader wiring + `Embedder`/`embed_engine` + cosine util. Unit tests + known-pair sanity check. No user-visible behavior change.
2. **M2 — Index + backfill.** `embeddings`/`embedding_index_state` tables + chunker + background indexer + backfill of real data + Settings progress UI. Verify passage counts in DB.
3. **M3 — Hybrid retrieval.** `retrieval.rs`: dense + FTS + RRF + grouping/diversity + broad-blend. Tested against a copy of the real DB.
4. **M4 — Chat rewrite.** Swap `chat_with_memory` to new retrieval + 16k window + budget; richer sources; Settings (window size, embedding model).
5. **M5 — Polish.** Intent-routing tuning, latency + memory pass, friendly error states + structured logs.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Two llama-cpp-2 contexts (gen + embed) conflict under Metal | M1 validation; fall back to a shared permit serializing embed vs generate. |
| Backfill slow / blocks UI | Runs in background batches; chat degrades to FTS-only; progress banner. |
| 16k prefill latency annoys user | Window size configurable down to 8k; intent routing keeps broad-query context tight. |
| Embedding model adds memory pressure (app is memory-sensitive) | Tiny model + idle-unload + evictable vector cache; `[mem]` sampler watches it. |
| EmbeddingGemma prompt-prefix mistakes silently tank recall | Centralized in `embedder.rs`; integration test asserts dense recall on a known pair. |
| Monster meetings flood the index | 40-passage/source cap; summaries always indexed for overview. |
