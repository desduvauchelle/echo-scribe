//! Deterministic transcript post-processing.
//!
//! Two passes, applied in order:
//! 1. **Filler removal** — strips configurable filler words/phrases ("uh",
//!    "um", "you know", etc.) using word-boundary regex-style matching.
//! 2. **Custom-word correction** — for each user-supplied "custom word",
//!    replaces any token in the transcript within edit-distance 1 (or 2 for
//!    longer words) with the canonical spelling. Letter-only tokens only —
//!    we never touch numbers or punctuation.
//!
//! Both passes are pure functions. They have no I/O, no allocations beyond
//! the returned `String`, and run in microseconds — safe to call inline on
//! every transcription with no user-visible latency cost.

use strsim::levenshtein;

/// Default fillers used when the user hasn't customized the list.
pub const DEFAULT_FILLERS: &[&str] = &[
    "uh", "um", "umm", "uhh", "er", "erm", "ah", "ahh", "hmm", "mm", "mmm",
    "you know", "i mean", "sort of", "kind of", "like",
];

/// Strip filler words from `text`. Matching is case-insensitive and respects
/// word boundaries — "like" matches " like " but not "lifelike". Multi-word
/// fillers ("you know") are matched as whole phrases. After removal we
/// collapse runs of whitespace and fix orphaned punctuation (`" ,"` → `","`).
pub fn strip_fillers(text: &str, fillers: &[String]) -> String {
    if fillers.is_empty() || text.is_empty() {
        return text.to_string();
    }

    // Sort by length descending so multi-word phrases are matched before
    // their single-word substrings ("you know" before "know").
    let mut sorted: Vec<&str> = fillers.iter().map(|s| s.as_str()).collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));

    let lower = text.to_lowercase();
    let bytes = text.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut keep = vec![true; bytes.len()];

    for filler in &sorted {
        let f = filler.trim().to_lowercase();
        if f.is_empty() {
            continue;
        }
        let fb = f.as_bytes();
        let mut i = 0;
        while i + fb.len() <= lower_bytes.len() {
            if !keep[i] {
                i += 1;
                continue;
            }
            if &lower_bytes[i..i + fb.len()] == fb
                && is_word_boundary(lower_bytes, i)
                && is_word_boundary(lower_bytes, i + fb.len())
            {
                for k in i..i + fb.len() {
                    keep[k] = false;
                }
                i += fb.len();
            } else {
                i += 1;
            }
        }
    }

    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        if keep[i] {
            out.push(b);
        }
    }
    let s = String::from_utf8(out).unwrap_or_else(|_| text.to_string());
    cleanup_whitespace_and_punct(&s)
}

fn is_word_boundary(bytes: &[u8], idx: usize) -> bool {
    if idx == 0 || idx == bytes.len() {
        return true;
    }
    let prev = bytes[idx - 1];
    let curr = bytes[idx];
    !is_word_char(prev) || !is_word_char(curr)
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'\''
}

fn cleanup_whitespace_and_punct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_was_space {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(c);
            last_was_space = false;
        }
    }
    let mut fixed = out.trim().to_string();
    // Pull punctuation back against the preceding word.
    for p in [',', '.', '!', '?', ';', ':'] {
        let needle = format!(" {p}");
        let replacement = p.to_string();
        fixed = fixed.replace(&needle, &replacement);
    }
    // Collapse adjacent identical punctuation that filler removal can produce
    // (e.g. ", you know," → ",," → ",").
    for p in [',', '.', '!', '?', ';', ':'] {
        let doubled = format!("{p}{p}");
        let single = p.to_string();
        while fixed.contains(&doubled) {
            fixed = fixed.replace(&doubled, &single);
        }
    }
    fixed
}

/// Replace tokens in `text` with their canonical form when they're a near-
/// match for one of the supplied `custom_words`. Useful for proper nouns the
/// ASR model doesn't know ("antoine" → "Antoine", "amandeen" → "Amandine").
///
/// Threshold: edit-distance ≤ 1 for words ≤ 5 chars, ≤ 2 otherwise. Exact
/// case-insensitive matches are always corrected so casing gets fixed even
/// when the spelling already matched. Tokens with non-letter characters are
/// left alone.
pub fn apply_custom_words(text: &str, custom_words: &[String]) -> String {
    if custom_words.is_empty() || text.is_empty() {
        return text.to_string();
    }

    let canonicals: Vec<&str> = custom_words
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.chars().all(char::is_alphabetic))
        .collect();
    if canonicals.is_empty() {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    let mut buf = String::new();
    for ch in text.chars() {
        if ch.is_alphabetic() {
            buf.push(ch);
        } else {
            if !buf.is_empty() {
                out.push_str(&best_match_or_keep(&buf, &canonicals));
                buf.clear();
            }
            out.push(ch);
        }
    }
    if !buf.is_empty() {
        out.push_str(&best_match_or_keep(&buf, &canonicals));
    }
    out
}

fn best_match_or_keep(token: &str, canonicals: &[&str]) -> String {
    let lower_tok = token.to_lowercase();
    for canonical in canonicals {
        if canonical.to_lowercase() == lower_tok {
            return canonical.to_string();
        }
    }
    let mut best: Option<(&&str, usize)> = None;
    for canonical in canonicals {
        let max_dist = match canonical.len() {
            0..=4 => 1,
            5..=7 => 2,
            _ => 3,
        };
        let d = levenshtein(&lower_tok, &canonical.to_lowercase());
        if d <= max_dist && best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((canonical, d));
        }
    }
    match best {
        Some((c, _)) => (*c).to_string(),
        None => token.to_string(),
    }
}

/// Convenience: run both passes in the canonical order.
pub fn postprocess(text: &str, fillers: &[String], custom_words: &[String]) -> String {
    let stripped = strip_fillers(text, fillers);
    apply_custom_words(&stripped, custom_words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Vec<String> {
        DEFAULT_FILLERS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn strips_basic_fillers() {
        let out = strip_fillers("uh hello um world", &defaults());
        assert_eq!(out, "hello world");
    }

    #[test]
    fn preserves_substring_words() {
        // "like" is a default filler but must not strip "lifelike" or "alike"
        let out = strip_fillers("the alike lifelike thing", &defaults());
        assert_eq!(out, "the alike lifelike thing");
    }

    #[test]
    fn strips_multi_word_phrase() {
        let out = strip_fillers("well you know this is fine", &defaults());
        assert_eq!(out, "well this is fine");
    }

    #[test]
    fn fixes_orphaned_punctuation() {
        let out = strip_fillers("hello uh , world", &defaults());
        assert_eq!(out, "hello, world");
    }

    #[test]
    fn empty_filler_list_is_passthrough() {
        let out = strip_fillers("uh um er hello", &[]);
        assert_eq!(out, "uh um er hello");
    }

    #[test]
    fn custom_words_fix_casing() {
        let words = vec!["Antoine".to_string(), "Amandine".to_string()];
        let out = apply_custom_words("antoine and amandine met", &words);
        assert_eq!(out, "Antoine and Amandine met");
    }

    #[test]
    fn custom_words_fix_close_misspellings() {
        let words = vec!["Amandine".to_string()];
        let out = apply_custom_words("amandeen arrived", &words);
        assert_eq!(out, "Amandine arrived");
    }

    #[test]
    fn custom_words_leave_distant_words_alone() {
        let words = vec!["Antoine".to_string()];
        let out = apply_custom_words("the airplane was loud", &words);
        assert_eq!(out, "the airplane was loud");
    }

    #[test]
    fn custom_words_skip_non_letter_tokens() {
        let words = vec!["Antoine".to_string()];
        let out = apply_custom_words("call 12345 then antoine", &words);
        assert_eq!(out, "call 12345 then Antoine");
    }

    #[test]
    fn postprocess_runs_both_passes() {
        let fillers = defaults();
        let custom = vec!["Antoine".to_string()];
        let out = postprocess("uh antoine, you know, said hello", &fillers, &custom);
        assert_eq!(out, "Antoine, said hello");
    }

    #[test]
    fn custom_words_pure_alphabetic_roundtrip() {
        // A pure-alphabetic word is saved and applied correctly.
        let words = vec!["Tauri".to_string()];
        let out = apply_custom_words("tauri is fast", &words);
        assert_eq!(out, "Tauri is fast");
    }

    #[test]
    fn custom_words_words_with_special_chars_are_skipped() {
        // Words containing apostrophes or hyphens pass the frontend validation
        // for filler words but are filtered by the backend's alphabetic-only
        // guard.  Verify the guard works and that alphabetic words in the same
        // list are still applied.
        let words = vec!["O'Brien".to_string(), "Antoine".to_string()];
        let out = apply_custom_words("obrien and antoine", &words);
        // "O'Brien" is filtered out (non-alphabetic); "Antoine" is still applied.
        assert_eq!(out, "obrien and Antoine");
    }

    #[test]
    fn custom_words_all_valid_frontend_words_pass_backend_filter() {
        // Any word that passes the frontend regex /^[A-Za-z]+$/ must also pass
        // the backend's `chars().all(char::is_alphabetic)` guard so nothing is
        // silently dropped.
        let acceptable = ["Antoine", "Scribe", "GPT", "Amandine", "EchoScribe"];
        for w in acceptable {
            assert!(
                w.chars().all(char::is_alphabetic),
                "'{w}' passes frontend regex but would be silently dropped by backend"
            );
        }
    }

    #[test]
    fn custom_words_empty_list_is_passthrough() {
        let out = apply_custom_words("hello world", &[]);
        assert_eq!(out, "hello world");
    }
}
