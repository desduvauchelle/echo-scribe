# Chunked RAG Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop chat context overflow by feeding the LLM the most relevant *passages* of retrieved notes (keyword-scored, token-budgeted) instead of whole items.

**Architecture:** New pure-function module `src-tauri/src/llm/rag.rs` splits each FTS-matched item into ≤600-char chunks, scores chunks by query-term overlap, and greedily selects top chunks under a token budget (with a no-match fallback to each item's first chunk). `chat_with_memory` calls it between FTS retrieval and prompt building; FTS layer and engine are unchanged.

**Tech Stack:** Rust, llama-cpp-2, rusqlite (FTS5). Tests via `cargo test --lib`.

---

## File Structure

- **Create:** `src-tauri/src/llm/rag.rs` — chunking, scoring, selection (pure functions + unit tests). One responsibility: turn retrieved items + query terms into a budgeted set of relevant chunks.
- **Modify:** `src-tauri/src/llm/mod.rs` — register `pub mod rag;`.
- **Modify:** `src-tauri/src/commands.rs` — `chat_with_memory` uses `rag` for retrieval, history trim, budget, and `n_ctx`.

Spec: `docs/superpowers/specs/2026-05-22-chunked-rag-retrieval-design.md`.

Run all module tests with: `cd src-tauri && cargo test --lib rag`

---

### Task 1: Create rag.rs — constants, `estimate_tokens`, `query_terms`

**Files:**
- Create: `src-tauri/src/llm/rag.rs`
- Modify: `src-tauri/src/llm/mod.rs` (add `pub mod rag;` near the other `pub mod` lines, ~line 17)

- [ ] **Step 1: Register the module**

In `src-tauri/src/llm/mod.rs`, add alongside the existing `pub mod` declarations (after `pub mod prompt;`):

```rust
pub mod rag;
```

- [ ] **Step 2: Write rag.rs with constants + the two helpers + failing tests**

Create `src-tauri/src/llm/rag.rs`:

```rust
//! Chunked retrieval-augmented generation for chat.
//!
//! FTS5 finds the right *items*; this module picks the right *passages* within
//! them. Whole-item content is never fed to the LLM verbatim — only the
//! highest-scoring chunks, up to a token budget. Keyword-overlap scoring keeps
//! everything local and dependency-free, consistent with the FTS layer.

/// Items pulled from FTS before chunking.
pub const FTS_ITEM_LIMIT: u32 = 12;
/// Hard cap per chunk in characters (~150 tokens).
pub const CHUNK_MAX_CHARS: usize = 600;
/// Total token budget for retrieved chunks.
pub const CONTEXT_BUDGET_TOKENS: usize = 3500;
/// Chat history messages kept (excluding the current turn).
pub const HISTORY_TURNS: usize = 6;
/// Floor so a long history can't starve retrieval entirely.
pub const MIN_CHUNK_BUDGET_TOKENS: usize = 1500;
/// KV-cache context size for the chat generate call.
pub const CHAT_N_CTX: u32 = 8192;

/// Conservative token estimate: chars / 3.5, rounded up.
pub fn estimate_tokens(text: &str) -> usize {
    (text.chars().count() as f64 / 3.5).ceil() as usize
}

/// Extract bare lowercase query terms for chunk scoring. Mirrors
/// `commands::build_rag_query`'s filtering (alphanumeric, len >= 4, max 6) but
/// returns unquoted, de-duplicated, lowercased terms instead of an FTS5
/// expression — so chunk scoring matches what FTS searched for.
pub fn query_terms(message: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for w in message.split_whitespace() {
        let clean: String = w
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        if clean.chars().count() >= 4 && !terms.contains(&clean) {
            terms.push(clean);
        }
        if terms.len() >= 6 {
            break;
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_rounds_up_and_handles_empty() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 2); // 4/3.5 = 1.14 -> 2
        assert!(estimate_tokens(&"x".repeat(700)) >= 200);
    }

    #[test]
    fn query_terms_filters_short_and_dedups_lowercased() {
        let t = query_terms("What did I talk About talk today");
        // "What"->what, "talk"->talk (once), "About"->about, "today"->today;
        // "did"/"I" dropped (< 4 chars).
        assert!(t.contains(&"what".to_string()));
        assert!(t.contains(&"talk".to_string()));
        assert!(t.contains(&"about".to_string()));
        assert!(t.contains(&"today".to_string()));
        assert_eq!(t.iter().filter(|x| *x == "talk").count(), 1);
        assert!(!t.iter().any(|x| x == "did" || x == "i"));
    }

    #[test]
    fn query_terms_caps_at_six() {
        let t = query_terms("alpha bravo charlie delta echo foxtrot golf hotel");
        assert_eq!(t.len(), 6);
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib rag::tests`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/llm/rag.rs src-tauri/src/llm/mod.rs
git commit -m "feat(llm): rag module skeleton — token estimate + query terms"
```

---

### Task 2: `split_into_chunks`

**Files:**
- Modify: `src-tauri/src/llm/rag.rs`

- [ ] **Step 1: Write failing tests**

Add to `rag.rs` `tests` module:

```rust
    #[test]
    fn split_breaks_on_newlines_and_trims() {
        let c = split_into_chunks("first line\n\nsecond line\n  third  ");
        assert_eq!(c, vec!["first line", "second line", "third"]);
    }

    #[test]
    fn split_transcript_one_chunk_per_utterance() {
        let c = split_into_chunks("You: hello there\nThem: hi back\nYou: bye");
        assert_eq!(c.len(), 3);
        assert_eq!(c[0], "You: hello there");
    }

    #[test]
    fn split_oversized_paragraph_breaks_on_sentences() {
        let long = format!("{} {}", "A".repeat(400) + ".", "B".repeat(400) + ".");
        let c = split_into_chunks(&long);
        assert!(c.len() >= 2, "oversized paragraph must split, got {}", c.len());
        assert!(c.iter().all(|x| x.chars().count() <= CHUNK_MAX_CHARS));
    }

    #[test]
    fn split_single_huge_sentence_hard_capped() {
        let huge = "Z".repeat(1500); // no sentence enders
        let c = split_into_chunks(&huge);
        assert!(c.iter().all(|x| x.chars().count() <= CHUNK_MAX_CHARS));
        assert!(c.len() >= 3);
    }

    #[test]
    fn split_empty_input_is_empty() {
        assert!(split_into_chunks("   \n\n  ").is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib rag::tests::split`
Expected: FAIL — `cannot find function split_into_chunks`.

- [ ] **Step 3: Implement**

Add to `rag.rs` (above the `tests` module):

```rust
/// Split one item's content into passages. Splits on newlines (handles
/// transcripts whose utterances are line-per-speaker). Any line over
/// `CHUNK_MAX_CHARS` is hard-split on sentence boundaries, then char-capped.
pub fn split_into_chunks(content: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    for line in content.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.chars().count() <= CHUNK_MAX_CHARS {
            chunks.push(line.to_string());
        } else {
            chunks.extend(split_oversized(line));
        }
    }
    chunks
}

/// Split an over-long line: accumulate whole sentences up to the cap, then
/// hard-split any single sentence that still exceeds it.
fn split_oversized(para: &str) -> Vec<String> {
    let mut sentences: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in para.chars() {
        cur.push(ch);
        if matches!(ch, '.' | '?' | '!') {
            sentences.push(std::mem::take(&mut cur));
        }
    }
    if !cur.trim().is_empty() {
        sentences.push(cur);
    }

    let mut out = Vec::new();
    let mut buf = String::new();
    for s in sentences {
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        if s.chars().count() > CHUNK_MAX_CHARS {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            out.extend(hard_split(s));
        } else if buf.chars().count() + s.chars().count() + 1 > CHUNK_MAX_CHARS {
            if !buf.is_empty() {
                out.push(std::mem::take(&mut buf));
            }
            buf.push_str(s);
        } else {
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.push_str(s);
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf.trim().to_string());
    }
    out
}

/// Char-cap a single string into `CHUNK_MAX_CHARS` slices.
fn hard_split(s: &str) -> Vec<String> {
    s.chars()
        .collect::<Vec<char>>()
        .chunks(CHUNK_MAX_CHARS)
        .map(|c| c.iter().collect::<String>().trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib rag::tests::split`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/rag.rs
git commit -m "feat(llm): rag chunk splitting with sentence + char fallback"
```

---

### Task 3: `score_chunk`

**Files:**
- Modify: `src-tauri/src/llm/rag.rs`

- [ ] **Step 1: Write failing tests**

Add to `tests`:

```rust
    #[test]
    fn score_counts_distinct_terms_and_hits() {
        let terms = vec!["talk".to_string(), "pricing".to_string()];
        // "talk" appears twice, "pricing" once -> distinct 2, hits 3.
        let (d, h) = score_chunk("we talk talk about pricing", &terms);
        assert_eq!(d, 2);
        assert_eq!(h, 3);
    }

    #[test]
    fn score_is_case_insensitive() {
        let terms = vec!["pricing".to_string()];
        let (d, _) = score_chunk("PRICING discussion", &terms);
        assert_eq!(d, 1);
    }

    #[test]
    fn score_no_terms_present_is_zero() {
        let terms = vec!["budget".to_string()];
        let (d, h) = score_chunk("unrelated content here", &terms);
        assert_eq!((d, h), (0, 0));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib rag::tests::score`
Expected: FAIL — `cannot find function score_chunk`.

- [ ] **Step 3: Implement**

Add to `rag.rs`:

```rust
/// Score one chunk by query-term overlap. Returns
/// `(distinct_terms_present, total_term_hits)`. Case-insensitive substring
/// match (terms are already lowercase from `query_terms`).
pub fn score_chunk(chunk: &str, terms: &[String]) -> (usize, usize) {
    let lc = chunk.to_lowercase();
    let mut distinct = 0;
    let mut hits = 0;
    for t in terms {
        let count = lc.matches(t.as_str()).count();
        if count > 0 {
            distinct += 1;
            hits += count;
        }
    }
    (distinct, hits)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib rag::tests::score`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/rag.rs
git commit -m "feat(llm): rag keyword-overlap chunk scoring"
```

---

### Task 4: Types + `build_context_chunks` (scoring path)

**Files:**
- Modify: `src-tauri/src/llm/rag.rs`

- [ ] **Step 1: Write failing tests**

Add to `tests`:

```rust
    fn src(id: &str, date: &str, kind: &str, content: &str) -> ChunkSource {
        ChunkSource {
            item_id: id.to_string(),
            date: date.to_string(),
            kind: kind.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn build_selects_highest_scoring_first() {
        let items = vec![
            src("a", "2026-05-22", "note", "irrelevant filler line"),
            src("b", "2026-05-22", "note", "pricing pricing talk here"),
        ];
        let terms = vec!["pricing".to_string(), "talk".to_string()];
        let chunks = build_context_chunks(&items, &terms, CONTEXT_BUDGET_TOKENS);
        assert_eq!(chunks[0].item_id, "b", "best-scoring chunk must come first");
    }

    #[test]
    fn build_preserves_attribution() {
        let items = vec![src("x", "2026-05-22", "meeting", "talk about roadmap")];
        let terms = vec!["talk".to_string()];
        let chunks = build_context_chunks(&items, &terms, CONTEXT_BUDGET_TOKENS);
        assert_eq!(chunks[0].date, "2026-05-22");
        assert_eq!(chunks[0].kind, "meeting");
        assert_eq!(chunks[0].item_id, "x");
    }

    #[test]
    fn build_stops_at_budget() {
        // Each line ~ 100 chars (~29 tokens). Budget 30 tokens -> 1 chunk.
        let line = "talk ".to_string() + &"y".repeat(95);
        let content = format!("{line}\n{line}\n{line}");
        let items = vec![src("a", "2026-05-22", "note", &content)];
        let terms = vec!["talk".to_string()];
        let chunks = build_context_chunks(&items, &terms, 30);
        assert_eq!(chunks.len(), 1, "budget of 30 tokens fits only one ~29-token chunk");
    }

    #[test]
    fn build_empty_items_is_empty() {
        let chunks = build_context_chunks(&[], &["talk".to_string()], CONTEXT_BUDGET_TOKENS);
        assert!(chunks.is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib rag::tests::build`
Expected: FAIL — `cannot find type ChunkSource` / `function build_context_chunks`.

- [ ] **Step 3: Implement**

Add to `rag.rs` (above `tests`):

```rust
/// An FTS-matched item, ready to be chunked. Built by the caller from
/// `db::items::Item`.
#[derive(Clone, Debug)]
pub struct ChunkSource {
    pub item_id: String,
    pub date: String,
    pub kind: String,
    pub content: String,
}

/// A selected passage with the attribution needed to render it in the prompt
/// and the sources list.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub content: String,
    pub date: String,
    pub kind: String,
    pub item_id: String,
}

struct Candidate {
    chunk: Chunk,
    rank: usize,    // FTS rank of the source item (0 = best)
    distinct: usize,
    hits: usize,
}

/// Greedily add chunks (already ordered best-first) until the token budget is
/// reached. Chunks that don't fit are skipped so smaller later chunks can fill
/// the remaining space.
fn greedy_fill(ordered: &[&Candidate], budget_tokens: usize) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut used = 0usize;
    for c in ordered {
        let t = estimate_tokens(&c.chunk.content);
        if used + t > budget_tokens {
            continue;
        }
        used += t;
        out.push(c.chunk.clone());
    }
    out
}

/// Turn FTS-matched items into a budgeted set of relevant chunks.
///
/// `items` are in FTS rank order (best first). Chunks are scored by query-term
/// overlap and selected highest-first under `budget_tokens`. If no chunk
/// contains any query term, falls back to the first chunk of each item in FTS
/// order (FTS already matched the items, so the model still gets context).
pub fn build_context_chunks(
    items: &[ChunkSource],
    terms: &[String],
    budget_tokens: usize,
) -> Vec<Chunk> {
    let mut cands: Vec<Candidate> = Vec::new();
    for (rank, it) in items.iter().enumerate() {
        for piece in split_into_chunks(&it.content) {
            let (distinct, hits) = score_chunk(&piece, terms);
            cands.push(Candidate {
                chunk: Chunk {
                    content: piece,
                    date: it.date.clone(),
                    kind: it.kind.clone(),
                    item_id: it.item_id.clone(),
                },
                rank,
                distinct,
                hits,
            });
        }
    }

    if cands.is_empty() {
        return Vec::new();
    }

    let any_scored = cands.iter().any(|c| c.distinct > 0);

    if any_scored {
        let mut order: Vec<&Candidate> = cands.iter().collect();
        order.sort_by(|a, b| {
            b.distinct
                .cmp(&a.distinct)
                .then(b.hits.cmp(&a.hits))
                .then(b.chunk.date.cmp(&a.chunk.date)) // newer first
                .then(a.rank.cmp(&b.rank))
        });
        greedy_fill(&order, budget_tokens)
    } else {
        // Fallback handled in Task 5.
        Vec::new()
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib rag::tests::build`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/rag.rs
git commit -m "feat(llm): rag chunk selection with budget + scoring"
```

---

### Task 5: No-match fallback in `build_context_chunks`

**Files:**
- Modify: `src-tauri/src/llm/rag.rs`

- [ ] **Step 1: Write failing test**

Add to `tests`:

```rust
    #[test]
    fn build_falls_back_to_first_chunk_per_item_when_no_terms_match() {
        let items = vec![
            src("a", "2026-05-22", "note", "alpha line\nsecond alpha line"),
            src("b", "2026-05-21", "note", "beta line\nsecond beta line"),
        ];
        // Query term matches nothing in either item.
        let terms = vec!["zzzz".to_string()];
        let chunks = build_context_chunks(&items, &terms, CONTEXT_BUDGET_TOKENS);
        // One chunk per item (the first), in FTS order.
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].item_id, "a");
        assert_eq!(chunks[0].content, "alpha line");
        assert_eq!(chunks[1].item_id, "b");
        assert_eq!(chunks[1].content, "beta line");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib rag::tests::build_falls_back`
Expected: FAIL — returns empty vec (the `else` branch is a stub).

- [ ] **Step 3: Implement the fallback branch**

In `build_context_chunks`, replace the `else { // Fallback handled in Task 5. Vec::new() }` branch with:

```rust
    } else {
        // No keyword hits — give the model the first chunk of each item in FTS
        // order so a phrasing mismatch doesn't produce a false "no notes found".
        let mut seen = std::collections::HashSet::new();
        let mut firsts: Vec<&Candidate> = Vec::new();
        for c in &cands {
            if seen.insert(c.chunk.item_id.clone()) {
                firsts.push(c);
            }
        }
        firsts.sort_by_key(|c| c.rank);
        greedy_fill(&firsts, budget_tokens)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib rag::tests`
Expected: PASS (all rag tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/rag.rs
git commit -m "feat(llm): rag no-match fallback to first chunk per item"
```

---

### Task 6: Wire `chat_with_memory` to use rag

**Files:**
- Modify: `src-tauri/src/commands.rs` (the retrieval/history/req block, currently lines ~1758–1845; import near line 24)

- [ ] **Step 1: Add the import**

In `src-tauri/src/commands.rs`, the existing line 24 is:

```rust
use crate::llm::{self, GenerateRequest, Llm, LlmDownloadProgress, LlmModelEntry};
```

Add a `rag` import right after it:

```rust
use crate::llm::rag;
```

- [ ] **Step 2: Replace the retrieval + history + request block**

Replace everything from the `// FTS5 retrieval with optional temporal window.` comment (line ~1758) down to and including the closing `};` of the `GenerateRequest` (line ~1845) with:

```rust
    // FTS5 retrieval, then chunked re-ranking. FTS finds the right items; rag
    // selects the most relevant passages within them under a token budget.
    let terms = rag::query_terms(&message);
    let date_window = extract_date_window(&message, now_secs);

    // Load history first so retrieval can be budgeted against its token cost.
    let history_msgs = db
        .with_conn(|c| chat::load_messages(c, &session_id, (rag::HISTORY_TURNS + 1) as u32))
        .unwrap_or_default();
    let hist: Vec<(String, String)> = history_msgs
        .into_iter()
        .rev()
        .skip(1) // drop the just-inserted current user message
        .rev()
        .map(|m| (m.role, m.content))
        .collect();
    let history_tokens: usize = hist.iter().map(|(_, c)| rag::estimate_tokens(c)).sum();
    let chunk_budget = rag::CONTEXT_BUDGET_TOKENS
        .saturating_sub(history_tokens)
        .max(rag::MIN_CHUNK_BUDGET_TOKENS);

    let chunks: Vec<rag::Chunk> = {
        let rag_query = build_rag_query(&message);
        if rag_query.is_empty() {
            Vec::new()
        } else {
            let (from, to) = match &date_window {
                Some((f, t)) => (Some(f.as_str()), Some(t.as_str())),
                None => (None, None),
            };
            let raw_items = db
                .with_conn(|c| {
                    db::search::search_items_with_date_window(
                        c,
                        &rag_query,
                        from,
                        to,
                        project_id.as_deref(),
                        rag::FTS_ITEM_LIMIT,
                    )
                })
                .unwrap_or_default();

            let item_sources: Vec<rag::ChunkSource> = raw_items
                .iter()
                .map(|item| {
                    let kind = item
                        .kind
                        .as_ref()
                        .map(|k| k.as_str())
                        .unwrap_or("note")
                        .to_string();
                    let date = item.captured_at[..10.min(item.captured_at.len())].to_string();
                    rag::ChunkSource {
                        item_id: item.id.clone(),
                        date,
                        kind,
                        content: item.content.clone(),
                    }
                })
                .collect();

            rag::build_context_chunks(&item_sources, &terms, chunk_budget)
        }
    };

    // Record which items actually contributed context to this session.
    {
        let mut linked = std::collections::HashSet::new();
        for ch in &chunks {
            if linked.insert(ch.item_id.clone()) {
                let iid = ch.item_id.clone();
                let sid = session_id.clone();
                let _ = db.with_conn(move |c| db::events::link_item_to_session(c, &iid, &sid));
            }
        }
    }

    // One source row per distinct item, joining its selected chunks for display.
    let sources: Vec<ContextSource> = {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for ch in &chunks {
            if seen.insert(ch.item_id.clone()) {
                let joined: Vec<String> = chunks
                    .iter()
                    .filter(|c| c.item_id == ch.item_id)
                    .map(|c| c.content.clone())
                    .collect();
                out.push(ContextSource {
                    date: ch.date.clone(),
                    kind: ch.kind.clone(),
                    content: joined.join("\n…\n"),
                });
            }
        }
        out
    };

    let temporal_note = if date_window.is_some() && sources.is_empty() {
        " No captures were found for the requested time period — do not guess or invent content."
    } else {
        ""
    };

    let system = if sources.is_empty() {
        format!(
            "You are a helpful assistant built into Echo Scribe, a voice note and task capture app. \
             Today is {today_str}. \
             No relevant notes were found for this question.{temporal_note} \
             Do not invent or fabricate any captures or activities. \
             If the user is asking what they did or said, tell them no matching captures were found."
        )
    } else {
        let context_lines: Vec<String> = chunks
            .iter()
            .map(|c| format!("[{}] ({}): {}", c.date, c.kind, c.content))
            .collect();
        format!(
            "You are a helpful assistant built into Echo Scribe. \
             Today is {today_str}. \
             Here are the user's relevant notes and captures:\n\n---\n{}\n---\n\n\
             Answer based only on these notes. \
             Do not invent or add content beyond what is shown above. \
             If the notes don't address the question, say so explicitly.",
            context_lines.join("\n")
        )
    };

    let req = GenerateRequest {
        system: Some(system),
        user: message.clone(),
        history: hist,
        max_tokens: 512,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
        n_ctx: Some(rag::CHAT_N_CTX),
    };
```

NOTE: this replacement removes the old standalone `let sources = { … }`, `let temporal_note = …`, `let system = …`, the old history block, and the old `let req = …`. After it, the next existing line should be `let reply = state.llm.generate(req).await...`. The old history-loading block (the one between the old `system` and old `req`) must be deleted — it is replaced by the `hist` built above. Verify no duplicate `let hist`/`history_msgs` remains.

- [ ] **Step 3: Build to verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles with no errors. (Warnings about unused `llm`/imports are acceptable only if pre-existing.)

- [ ] **Step 4: Run the full lib test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS, including all `rag::tests` and the existing `engine`/`prompt` tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(chat): chunked RAG retrieval — fixes context overflow

chat_with_memory now feeds the LLM the most relevant passages of matched
notes (keyword-scored, 3500-token budget) instead of whole items, trims
history to 6 turns, and sizes n_ctx at 8192. Resolves the 'prompt exceeds
n_ctx' error on broad recall questions like 'what did I talk about today'."
```

---

### Task 7: Manual verification (real app)

**Files:** none (runtime check).

- [ ] **Step 1: Build the release bundle**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bun tauri build --bundles app`
Expected: build succeeds; bundle at `src-tauri/target/release/bundle/macos/Echo Scribe.app`.

- [ ] **Step 2: Reinstall (skip-TCC — no permission code changed)**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 3: Reproduce the original failure**

In the app's AI chat, ask: "what did I talk about today?"
Expected: a real answer grounded in today's captures, with source rows — NOT the `prompt (… tokens) + max_tokens … exceeds requested n_ctx` error.

- [ ] **Step 4: Spot-check a specific recall question**

Ask a pinpoint question about a known recent note (e.g. "what did I say about <topic>?").
Expected: answer cites the relevant passage; sources list shows the matching item(s).

---

## Self-Review

**Spec coverage:**
- Module `rag.rs` with the four pure functions → Tasks 1–5. ✓
- FTS limit 6→12 (`FTS_ITEM_LIMIT`) → Task 6 (passed to `search_items_with_date_window`). ✓
- Chunk split rules (newline, sentence, char cap, ≤600) → Task 2. ✓
- Keyword scoring (distinct terms, tiebreak hits then recency then rank) → Tasks 3–4. ✓
- Greedy budget fill (3500, est chars/3.5) → Task 4. ✓
- No-match fallback → Task 5. ✓
- System prompt format unchanged; sources dedup by item_id → Task 6. ✓
- History 20→6 turns, counted against budget with floor → Task 6. ✓
- `n_ctx` → `CHAT_N_CTX` (8192) → Task 6. ✓
- Engine + FTS layer unchanged (backstop guard remains) → no task touches them. ✓
- Tests for splitting/scoring/selection/fallback/attribution/estimate → Tasks 1–5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The Task 4 `else` stub is intentional and explicitly replaced in Task 5.

**Type consistency:** `ChunkSource{item_id,date,kind,content}`, `Chunk{content,date,kind,item_id}`, `score_chunk -> (usize,usize)`, `build_context_chunks(&[ChunkSource], &[String], usize) -> Vec<Chunk>`, `estimate_tokens(&str)->usize`, `query_terms(&str)->Vec<String>` — used consistently across Tasks 4–6. `limit: u32` matches `search_items_with_date_window`/`load_messages` signatures. `item.kind: Option<ItemKind>` with `.as_str()` matches existing usage.
