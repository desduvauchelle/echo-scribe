//! Removes the duplicated leading words a chunk's transcript contains because
//! its audio was prefixed with an overlap tail from the previous chunk.
//!
//! Strategy: normalize to lowercase alphanumeric word tokens. Find the
//! longest K (capped) such that the last K normalized words of `prev_tail`
//! equal the first K normalized words of `new_text`. Drop those K words from
//! the front of `new_text` (operating on the original, un-normalized words so
//! casing/punctuation of the kept remainder is preserved).

/// Max words of overlap we will look for. 5 s of speech ≈ ~15 words; cap
/// generously so a long stable phrase still aligns, but bound the search.
const MAX_OVERLAP_WORDS: usize = 40;

fn norm(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Returns `new_text` with any leading words that duplicate the tail of
/// `prev_text` removed. If there is no overlap, returns `new_text` trimmed.
pub fn strip_overlap(prev_text: &str, new_text: &str) -> String {
    let new_words: Vec<&str> = new_text.split_whitespace().collect();
    if new_words.is_empty() {
        return String::new();
    }
    let prev_words: Vec<&str> = prev_text.split_whitespace().collect();
    if prev_words.is_empty() {
        return new_words.join(" ");
    }

    let prev_norm: Vec<String> = prev_words.iter().map(|w| norm(w)).collect();
    let new_norm: Vec<String> = new_words.iter().map(|w| norm(w)).collect();

    let max_k = MAX_OVERLAP_WORDS
        .min(prev_norm.len())
        .min(new_norm.len());

    let mut best_k = 0;
    for k in 1..=max_k {
        let prev_suffix = &prev_norm[prev_norm.len() - k..];
        let new_prefix = &new_norm[..k];
        if prev_suffix == new_prefix {
            best_k = k;
        }
    }
    new_words[best_k..].join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_overlap_returns_new_text() {
        assert_eq!(
            strip_overlap("the cat sat", "on the mat today"),
            "on the mat today"
        );
    }

    #[test]
    fn exact_word_overlap_is_removed() {
        let out = strip_overlap(
            "so in summary we should ship it",
            "we should ship it by friday for sure",
        );
        assert_eq!(out, "by friday for sure");
    }

    #[test]
    fn overlap_ignores_case_and_punctuation() {
        let out = strip_overlap(
            "... let's circle back on Budget.",
            "Budget — and timeline are the blockers",
        );
        assert_eq!(out, "— and timeline are the blockers");
    }

    #[test]
    fn empty_prev_returns_new() {
        assert_eq!(strip_overlap("", "hello there"), "hello there");
    }

    #[test]
    fn empty_new_returns_empty() {
        assert_eq!(strip_overlap("anything", "   "), "");
    }

    #[test]
    fn full_duplicate_returns_empty() {
        assert_eq!(strip_overlap("alpha beta gamma", "beta gamma"), "");
    }

    #[test]
    fn filler_false_positive_is_known_lossy() {
        // Speaker genuinely said "you know" twice (filler), no acoustic
        // overlap — exact-match stitch drops it. Documented lossy tradeoff.
        let out = strip_overlap(
            "so the migration is risky and that is the whole thing you know",
            "you know we also have the rollback path to consider",
        );
        assert_eq!(out, "we also have the rollback path to consider");
    }

    #[test]
    fn asr_variance_leaks_duplicate() {
        // A single differing token in the re-transcribed overlap defeats the
        // exact match — duplication leaks. Documented lossy tradeoff.
        let out = strip_overlap(
            "okay so to wrap up we should ship it by friday",
            "we shouldship it by friday and tell the team",
        );
        assert_eq!(out, "we shouldship it by friday and tell the team");
    }

    #[test]
    fn punct_only_leading_token_dropped_but_no_words_lost() {
        let out = strip_overlap("the plan is set ...", "... the budget needs review");
        assert_eq!(out, "the budget needs review");
    }

    #[test]
    fn repeated_word_run_greedy_longest_match() {
        let out = strip_overlap("i think the the the", "the the the cat");
        assert_eq!(out, "cat");
    }

    #[test]
    fn whitespace_only_prev_returns_new() {
        assert_eq!(strip_overlap("   \t ", "hello world"), "hello world");
    }
}
