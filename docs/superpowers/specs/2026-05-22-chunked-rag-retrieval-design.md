# Chunked RAG Retrieval for Chat — Design

**Date:** 2026-05-22
**Status:** Approved (pending spec review)

## Problem

`chat_with_memory` ([src-tauri/src/commands.rs](../../../src-tauri/src/commands.rs)) builds the
LLM prompt with no token budgeting. It embeds up to 6 full RAG notes plus the last
20 chat messages into the system prompt, then calls the engine with `n_ctx: None`
(defaults to 4096). When the user asks a broad recall question ("what did I talk
about today?"), FTS returns full meeting transcripts — each many thousands of
tokens. The prompt overflows and the engine's overflow guard rejects it:

```
Error: engine error: invalid request: prompt (15179 tokens) + max_tokens (512)
exceeds requested n_ctx (4096); shorten input or reduce max_tokens
```

The guard correctly prevents a `ggml_abort()` SIGABRT, but the caller surfaces the
raw error and the user gets no answer.

## Root cause

The model has a hard context ceiling (16384 for the loaded Gemma — see
[src-tauri/src/llm/mod.rs](../../../src-tauri/src/llm/mod.rs) `DEFAULT_N_CTX`). You
cannot feed more than that. The fix is not "stuff more in" — it is to retrieve the
*relevant passages* instead of whole items, and bound what goes into the prompt.

## Approach: chunked retrieval (keyword-scored)

FTS5 already finds the right *items*. We add a layer that picks the right
*passages* within those items, scored by keyword overlap (no embeddings, no new
deps, fully local — consistent with the existing FTS approach). Whole-item content
is never fed to the LLM verbatim; only the highest-scoring chunks, up to a token
budget.

### Module boundaries

New module **`src-tauri/src/llm/rag.rs`** — pure functions, no DB or LLM
dependencies, fully unit-testable:

- `split_into_chunks(content: &str) -> Vec<String>` — split one item's content
  into passages.
- `score_chunk(chunk: &str, query_terms: &[String]) -> ChunkScore` — keyword
  overlap score for one chunk.
- `select_chunks(candidates: Vec<ScoredChunk>, budget_tokens: usize) -> Vec<ScoredChunk>`
  — greedy top-N selection under a token budget.
- `estimate_tokens(text: &str) -> usize` — `chars / 3.5`, conservative.

`chat_with_memory` orchestrates: FTS retrieval → build candidate chunks (carrying
each chunk's source date+kind) → score → select → build system prompt → trim
history → generate.

The FTS layer ([src-tauri/src/db/search.rs](../../../src-tauri/src/db/search.rs))
is unchanged except the caller passes a wider `limit` (see below).

### Data types (in rag.rs)

```rust
/// A passage carved from one item, with the attribution needed to render it
/// in the prompt and the sources list.
pub struct Chunk {
    pub content: String,
    pub date: String,   // item.captured_at[..10]
    pub kind: String,   // "note" | "meeting" | ...
    pub item_id: String,
}

pub struct ScoredChunk {
    pub chunk: Chunk,
    pub distinct_terms: usize, // # of distinct query terms present
    pub term_hits: usize,      // total query-term occurrences (tiebreak)
}
```

### Flow in `chat_with_memory`

1. **Retrieve.** Same FTS call (`search_items_with_date_window`) with date window
   + project scope, but `limit` widened **6 → 12**. More candidate items; we trim
   down by chunk, so prompt cost stays bounded.
2. **Chunk.** For each returned item, `split_into_chunks(item.content)`; wrap each
   resulting passage in a `Chunk` carrying the item's `date`, `kind`, `item_id`.
3. **Score.** `score_chunk` against the `build_rag_query` terms (case-insensitive).
   Score = count of *distinct* query terms present. Tiebreak: total term hits, then
   item recency (newer date first).
4. **Select.** `select_chunks` sorts by score desc and greedily adds chunks until
   the running `estimate_tokens` sum would exceed **CONTEXT_BUDGET_TOKENS (3500)**.
5. **No-match fallback.** If every chunk scores 0 distinct terms (keyword scoring
   found nothing, but FTS did match the items), select the *first* chunk of each
   FTS-returned item in rank order until the budget fills. Avoids a false "no
   notes found" when notes exist but phrasing differs.
6. **Build system prompt.** Same `[date] (kind): content` line format as today,
   one line per selected chunk. `sources` list = distinct items
   (by `item_id`) that contributed ≥1 selected chunk.
7. **Trim history.** Last **6 turns** instead of 20, also counted toward the
   budget (history `estimate_tokens` subtracts from the 3500 before chunk
   selection — i.e. effective chunk budget = 3500 − history_tokens, floored at a
   minimum so a long history can't starve retrieval entirely).
8. **Generate.** `n_ctx: Some(8192)` — ample now that input is bounded, lower RAM
   than 16384. Engine overflow guard stays as the final backstop (should never
   trigger).

### Chunk splitting rules (`split_into_chunks`)

- Split on blank lines / newlines into paragraphs (handles transcripts whose
  utterances are line-per-speaker, e.g. `You:` / `Them:`).
- Any single paragraph over **CHUNK_MAX_CHARS (600)** is hard-split: first on
  sentence boundaries (`. ` / `? ` / `! `), then char-capped at 600 if a single
  sentence still exceeds it.
- Trim whitespace; drop empty chunks.

### Constants (top of rag.rs)

| Const | Value | Meaning |
|-------|-------|---------|
| `FTS_ITEM_LIMIT` | 12 | items pulled from FTS before chunking |
| `CHUNK_MAX_CHARS` | 600 | hard cap per chunk (~150 tok) |
| `CONTEXT_BUDGET_TOKENS` | 3500 | total token budget for retrieved chunks |
| `HISTORY_TURNS` | 6 | chat turns kept |
| `MIN_CHUNK_BUDGET_TOKENS` | 1500 | floor so long history can't starve retrieval |
| `CHAT_N_CTX` | 8192 | KV cache size for the chat generate call |

## Error handling

- Empty `rag_query` → no chunks, same "no relevant notes" system prompt as today.
- Zero-scoring chunks → no-match fallback (step 5).
- Token estimate is conservative (chars/3.5) so the real prompt is smaller than
  estimated; the engine guard remains as a hard backstop.

## Testing (unit tests in rag.rs)

- **Splitting:** paragraph split on blank lines; oversized paragraph hard-split on
  sentences then chars; transcript line-format (`You:`/`Them:`) splits per
  utterance; empty/whitespace input → empty vec.
- **Scoring:** distinct-term count correct; tiebreak by term frequency; chunk with
  no query terms scores 0.
- **Selection:** stops at budget; picks highest-scoring first; empty candidates →
  empty result.
- **Fallback:** all-zero scores → first chunk of each item selected up to budget.
- **Attribution:** selected chunk retains its source date/kind/item_id; `sources`
  dedups by item_id.
- **Token estimate:** chars/3.5 monotonic, handles empty string.

## Out of scope (YAGNI)

- Embeddings / semantic search (chosen against — keyword overlap is enough now).
- Index-time chunking / schema migration (retrieval-time chunking needs none).
- Re-ranking models.
- Layer-2 daily-summary map-reduce path (broad "summarize my day" recall — separate
  future spec; this spec covers pinpoint recall via chunk retrieval).
