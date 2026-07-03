//! Selection-edit LLM pass: apply a spoken instruction to selected text and
//! sanitize the model output so a low-quality rewrite never lands in the
//! user's document. See docs/superpowers/specs/2026-07-02-voice-edit-selection-design.md.

use crate::llm::{GenerateRequest, LlmError, LlmGenerator};

/// Upper bound on how much selected text we will edit in one pass (~1000 words).
pub const MAX_SELECTION_CHARS: usize = 4000;

pub fn within_length_limit(text: &str) -> bool {
    text.chars().count() <= MAX_SELECTION_CHARS
}

const EDIT_SYSTEM_PROMPT: &str = "\
You are a precise text editor. The user selected some text and spoke an instruction \
describing how to change it. Apply the instruction to the text and output ONLY the \
revised text. Do not add explanations, commentary, preamble, quotation marks, or code \
fences. Do not answer questions or add anything the instruction did not ask for. If the \
instruction is a translation or rewrite, return only the transformed text. Preserve the \
original meaning unless the instruction says otherwise.";

/// Run the local LLM edit pass. Returns the RAW model output; the caller must
/// pass it through [`sanitize_edit_output`] before applying it.
pub async fn run<L: LlmGenerator + ?Sized>(
    llm: &L,
    instruction: &str,
    selected_text: &str,
) -> Result<String, LlmError> {
    let req = GenerateRequest {
        system: Some(EDIT_SYSTEM_PROMPT.to_string()),
        user: format!("Instruction: {instruction}\n\nText to edit:\n{selected_text}"),
        history: Vec::new(),
        max_tokens: 2048,
        temperature: 0.3,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
        n_ctx: Some(4096),
    };
    llm.generate(req).await
}

/// Clean the model output; return `None` (abort, leave text untouched) when the
/// output is empty, a refusal, or a no-op echo of the original.
pub fn sanitize_edit_output(raw: &str, original: &str) -> Option<String> {
    let mut s = raw.trim();
    if let Some(inner) = strip_code_fence(s) {
        s = inner.trim();
    }
    s = strip_wrapping_quotes(s);
    let s = strip_leading_preamble(s).trim();

    if s.is_empty() {
        return None;
    }
    let lower = s.to_lowercase();
    const REFUSALS: &[&str] = &[
        "i can't", "i cannot", "i'm sorry", "i am sorry",
        "as an ai", "i'm unable", "i am unable", "i won't",
    ];
    if REFUSALS.iter().any(|r| lower.starts_with(r)) {
        return None;
    }
    if s == original.trim() {
        return None;
    }
    Some(s.to_string())
}

/// Strip a single wrapping ```fence``` block, returning its inner body.
fn strip_code_fence(s: &str) -> Option<&str> {
    let s = s.trim();
    if !s.starts_with("```") {
        return None;
    }
    let after_open = s.find('\n')? + 1;
    let close = s.rfind("```")?;
    if close <= after_open {
        return None;
    }
    Some(&s[after_open..close])
}

/// Strip a single matching pair of ASCII wrapping quotes/backticks.
fn strip_wrapping_quotes(s: &str) -> &str {
    let mut chars = s.chars();
    if let (Some(first), Some(last)) = (chars.next(), chars.next_back()) {
        if first == last
            && matches!(first, '"' | '\'' | '`')
            && s.len() > first.len_utf8()
        {
            return &s[first.len_utf8()..s.len() - last.len_utf8()];
        }
    }
    s
}

/// Drop a leading conversational preamble line like "Sure, here is the revised text:".
fn strip_leading_preamble(s: &str) -> &str {
    if let Some(nl) = s.find('\n') {
        let (first, rest) = s.split_at(nl);
        let f = first.trim().to_lowercase();
        let looks_like_preamble = f.ends_with(':')
            && f.chars().count() <= 60
            && ["sure", "here", "here's", "certainly", "okay", "ok", "revised", "result", "output"]
                .iter()
                .any(|w| f.starts_with(w));
        if looks_like_preamble {
            return rest.trim_start_matches('\n');
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_clean_rewrite() {
        let out = sanitize_edit_output("The meeting is at 3pm.", "the meeting is at 2pm actually 3pm");
        assert_eq!(out.as_deref(), Some("The meeting is at 3pm."));
    }

    #[test]
    fn strips_conversational_preamble() {
        let raw = "Sure, here is the revised text:\nThe report is ready.";
        assert_eq!(sanitize_edit_output(raw, "report done").as_deref(), Some("The report is ready."));
    }

    #[test]
    fn strips_wrapping_quotes_and_code_fence() {
        assert_eq!(sanitize_edit_output("\"Hello there\"", "hi").as_deref(), Some("Hello there"));
        assert_eq!(sanitize_edit_output("```\nfn main() {}\n```", "x").as_deref(), Some("fn main() {}"));
    }

    #[test]
    fn rejects_empty_output() {
        assert_eq!(sanitize_edit_output("   \n  ", "something"), None);
    }

    #[test]
    fn rejects_refusal() {
        assert_eq!(sanitize_edit_output("I can't help with that.", "text"), None);
        assert_eq!(sanitize_edit_output("As an AI language model, I cannot rewrite this.", "text"), None);
    }

    #[test]
    fn rejects_noop_echo_of_original() {
        assert_eq!(sanitize_edit_output("same text", "same text"), None);
        assert_eq!(sanitize_edit_output("  same text  ", "same text"), None);
    }

    #[test]
    fn length_limit_boundary() {
        let ok = "a".repeat(MAX_SELECTION_CHARS);
        let too_long = "a".repeat(MAX_SELECTION_CHARS + 1);
        assert!(within_length_limit(&ok));
        assert!(!within_length_limit(&too_long));
    }

    struct MockLlm(&'static str);
    impl LlmGenerator for MockLlm {
        fn generate<'a>(&'a self, _req: GenerateRequest) -> crate::llm::GenerateFuture<'a> {
            let out = self.0.to_string();
            Box::pin(async move { Ok(out) })
        }
    }

    #[tokio::test]
    async fn run_returns_raw_model_text() {
        let llm = MockLlm("Revised.");
        let raw = run(&llm, "make it shorter", "This is a long sentence.").await.unwrap();
        assert_eq!(raw, "Revised.");
    }

    #[test]
    fn sanitizer_is_utf8_safe_on_multibyte_content() {
        // ASCII quotes wrapping a multibyte body → quotes stripped, body intact.
        assert_eq!(
            sanitize_edit_output("\"café résumé\"", "cafe").as_deref(),
            Some("café résumé")
        );
        // Multibyte first/last char (not a quote) → passes through untouched, no panic.
        assert_eq!(sanitize_edit_output("café", "x").as_deref(), Some("café"));
    }
}
