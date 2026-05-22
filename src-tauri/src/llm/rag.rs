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
    rank: usize, // FTS rank of the source item (0 = best)
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

    #[test]
    fn score_counts_distinct_terms_and_hits() {
        let terms = vec!["talk".to_string(), "pricing".to_string()];
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

    #[test]
    fn build_falls_back_to_first_chunk_per_item_when_no_terms_match() {
        let items = vec![
            src("a", "2026-05-22", "note", "alpha line\nsecond alpha line"),
            src("b", "2026-05-21", "note", "beta line\nsecond beta line"),
        ];
        let terms = vec!["zzzz".to_string()];
        let chunks = build_context_chunks(&items, &terms, CONTEXT_BUDGET_TOKENS);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].item_id, "a");
        assert_eq!(chunks[0].content, "alpha line");
        assert_eq!(chunks[1].item_id, "b");
        assert_eq!(chunks[1].content, "beta line");
    }
}
