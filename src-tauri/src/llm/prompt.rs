//! Chat-message helpers.
//!
//! Provides both the [`LlamaChatMessage`] path (used when `apply_chat_template`
//! succeeds) and a manual Gemma 4 prompt builder that bypasses llama.cpp's
//! template engine entirely.
//!
//! ## Why the manual builder?
//!
//! Gemma 4 uses `<|turn>role\n{content}<turn|>` as its turn format, but
//! llama.cpp's built-in named templates only know the Gemma 1–3 format
//! (`<start_of_turn>/<end_of_turn>`). Gemma 4 GGUFs embed a Jinja2 template
//! that llama.cpp cannot parse (returns ffi error -1). The manual builder
//! produces a correctly structured prompt without any template machinery.

use llama_cpp_2::model::LlamaChatMessage;
use llama_cpp_2::NewLlamaChatMessageError;

/// Build a multi-turn chat message vector.
///
/// `history` is `(role, content)` pairs — alternating "user" / "assistant"
/// from oldest to most recent, NOT including the current turn.
pub fn build_chat_messages(
    system: Option<&str>,
    history: &[(String, String)],
    user: &str,
) -> Result<Vec<LlamaChatMessage>, NewLlamaChatMessageError> {
    let mut msgs = Vec::new();
    if let Some(sys) = system {
        if !sys.is_empty() {
            msgs.push(LlamaChatMessage::new("system".to_string(), sys.to_string())?);
        }
    }
    for (role, content) in history {
        msgs.push(LlamaChatMessage::new(role.clone(), content.clone())?);
    }
    msgs.push(LlamaChatMessage::new("user".to_string(), user.to_string())?);
    Ok(msgs)
}

/// Build the chat-message vector for a prompt with optional system message.
///
/// Note: [`LlamaChatMessage::new`] only fails if the role/content contains a
/// nul byte; we surface that via the returned `Result` rather than panicking,
/// since the user's prompt may be arbitrary text.
pub fn build_messages(
    system: Option<&str>,
    user: &str,
) -> Result<Vec<LlamaChatMessage>, NewLlamaChatMessageError> {
    build_chat_messages(system, &[], user)
}

/// Strip any of `stops` from the trailing edge of `text`, then trim
/// whitespace. Used after generation to clean up output that ran into a stop
/// string (we don't always detect stops mid-token).
/// Build a raw prompt string in Gemma 4's native turn format.
///
/// Gemma 4 format (per Google AI docs):
/// ```text
/// <|turn>system
/// {system}<turn|>
/// <|turn>user
/// {user_message}<turn|>
/// <|turn>model
/// {assistant_reply}<turn|>
/// ...
/// <|turn>user
/// {current_message}<turn|>
/// <|turn>model
/// ```
/// The prompt ends with `<|turn>model\n` (no closing `<turn|>`) to signal
/// the model should start generating. BOS must be prepended by the tokenizer
/// (`AddBos::Add`), NOT included in this string.
///
/// `history` is `(role, content)` pairs — "user" or "assistant", oldest first,
/// NOT including the current turn. The role "assistant" is mapped to "model"
/// as required by Gemma.
pub fn build_gemma4_prompt(
    system: Option<&str>,
    history: &[(String, String)],
    user: &str,
) -> String {
    let mut out = String::new();

    if let Some(sys) = system {
        if !sys.is_empty() {
            out.push_str("<|turn>system\n");
            out.push_str(sys.trim());
            out.push_str("<turn|>\n");
        }
    }

    for (role, content) in history {
        let gemma_role = if role == "assistant" { "model" } else { role.as_str() };
        out.push_str("<|turn>");
        out.push_str(gemma_role);
        out.push('\n');
        out.push_str(content.trim());
        out.push_str("<turn|>\n");
    }

    out.push_str("<|turn>user\n");
    out.push_str(user.trim());
    out.push_str("<turn|>\n");
    out.push_str("<|turn>model\n");

    out
}

pub fn strip_trailing_stops(text: &str, stops: &[String]) -> String {
    let mut out = text.to_string();
    loop {
        let trimmed_len = out.trim_end().len();
        let trimmed = &out[..trimmed_len];
        let mut found_any = false;
        for s in stops {
            if !s.is_empty() && trimmed.ends_with(s.as_str()) {
                out = trimmed[..trimmed.len() - s.len()].to_string();
                found_any = true;
                break;
            }
        }
        if !found_any {
            break;
        }
    }
    out.trim().to_string()
}

/// Build the prompt for meeting transcript → summary + action items + suggested title.
/// Output must conform to MEETING_SYNTHESIS_GBNF.
pub fn build_meeting_synthesis_prompt(
    flattened_transcript: &str,
    detected_app_name: Option<&str>,
    duration_minutes: u64,
    existing_project_names: &[String],
) -> (Option<String>, String) {
    let app = detected_app_name.unwrap_or("a meeting");

    let project_hint = if existing_project_names.is_empty() {
        "If the meeting clearly relates to a specific project or initiative, set \"project_name\" to a short name for it. \
Otherwise set it to null.".to_string()
    } else {
        let names = existing_project_names.join("\", \"");
        format!(
            "The user has these existing projects: [\"{names}\"]. \
If the meeting clearly relates to one of them, set \"project_name\" to that exact name. \
If it relates to a new project not in the list, set \"project_name\" to a short name for it. \
Otherwise set it to null."
        )
    };

    let system = format!(
        "You are an expert meeting note-taker. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. \
The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side). \
Produce a JSON object with exactly these fields:\n\
- summary: array of 3 to 5 bullet strings. Each bullet covers one decision, key topic, or outcome. \
Bullets must be self-contained sentences, no leading dashes.\n\
- action_items: array (possibly empty) of objects {{ \"text\": string, \"owner\": \"you\" | \"them\" | \"unspecified\", \
\"tags\": array of short keyword strings (1-3 tags), \"project_name\": string or null }}. \
Only include items the speakers explicitly committed to or were explicitly asked to do. Do not invent action items. \
Each action item's tags and project_name describe that specific task.\n\
- suggested_title: short string (max 60 characters) capturing the meeting's purpose.\n\
- tags: array of 1-3 short keyword strings that categorize the overall meeting topic (e.g. \"design\", \"planning\", \"bugfix\").\n\
- project_name: string or null. {project_hint}\n\
Output JSON only — no preamble, no commentary, no markdown fences."
    );
    let user = format!("Transcript:\n\n{flattened_transcript}\n\nProduce the JSON now.");
    (Some(system), user)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_messages_includes_system_when_set() {
        let msgs = build_messages(Some("be helpful"), "hello").unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn build_messages_omits_empty_system() {
        let msgs = build_messages(None, "hi").unwrap();
        assert_eq!(msgs.len(), 1);
        let msgs = build_messages(Some(""), "hi").unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn strip_trailing_stops_removes_known_stops_and_whitespace() {
        let stops = vec!["</s>".to_string(), "<end>".to_string()];
        assert_eq!(strip_trailing_stops("hello world</s>", &stops), "hello world");
        assert_eq!(
            strip_trailing_stops("hello   <end>  \n", &stops),
            "hello"
        );
        // Stack of stops.
        assert_eq!(
            strip_trailing_stops("answer<end></s>", &stops),
            "answer"
        );
        // Untouched if no stop matches.
        assert_eq!(strip_trailing_stops("plain text", &stops), "plain text");
    }

    #[test]
    fn strip_trailing_stops_handles_empty_stops() {
        assert_eq!(strip_trailing_stops("hi  ", &[]), "hi");
    }

    #[test]
    fn build_chat_messages_includes_history() {
        let history = vec![
            ("user".to_string(), "hello".to_string()),
            ("assistant".to_string(), "hi there".to_string()),
        ];
        let msgs = build_chat_messages(Some("be helpful"), &history, "follow up").unwrap();
        // system + 2 history turns + user = 4
        assert_eq!(msgs.len(), 4);
    }

    #[test]
    fn build_chat_messages_empty_history_matches_build_messages() {
        let a = build_messages(Some("sys"), "user msg").unwrap();
        let b = build_chat_messages(Some("sys"), &[], "user msg").unwrap();
        assert_eq!(a.len(), b.len());
    }

    // ── build_gemma4_prompt ───────────────────────────────────────────────

    #[test]
    fn gemma4_prompt_no_system_no_history() {
        let p = build_gemma4_prompt(None, &[], "hello");
        assert_eq!(p, "<|turn>user\nhello<turn|>\n<|turn>model\n");
    }

    #[test]
    fn gemma4_prompt_with_system() {
        let p = build_gemma4_prompt(Some("be helpful"), &[], "hi");
        assert!(p.starts_with("<|turn>system\nbe helpful<turn|>\n"), "got: {p}");
        assert!(p.ends_with("<|turn>model\n"), "got: {p}");
        assert!(p.contains("<|turn>user\nhi<turn|>\n"), "got: {p}");
    }

    #[test]
    fn gemma4_prompt_empty_system_omitted() {
        let p = build_gemma4_prompt(Some(""), &[], "hi");
        assert!(!p.contains("<|turn>system"), "empty system should be omitted");
        assert!(p.starts_with("<|turn>user\n"), "got: {p}");
    }

    #[test]
    fn gemma4_prompt_with_history() {
        let history = vec![
            ("user".to_string(), "hello".to_string()),
            ("assistant".to_string(), "hi there".to_string()),
        ];
        let p = build_gemma4_prompt(None, &history, "how are you?");
        // assistant role must be mapped to "model"
        assert!(p.contains("<|turn>model\nhi there<turn|>\n"), "got: {p}");
        assert!(p.contains("<|turn>user\nhello<turn|>\n"), "got: {p}");
        assert!(p.ends_with("<|turn>model\n"), "prompt must end with model turn opener");
    }

    #[test]
    fn gemma4_prompt_ends_with_model_opener() {
        // The prompt must end with <|turn>model\n (no closing <turn|>)
        // so the model generates starting from that position.
        let p = build_gemma4_prompt(Some("sys"), &[], "question");
        assert!(
            p.ends_with("<|turn>model\n"),
            "prompt must end with model turn opener, got: {p}"
        );
        assert!(
            !p.ends_with("<turn|>\n<|turn>model\n") || p.ends_with("<|turn>model\n"),
            "got: {p}"
        );
    }

    #[test]
    fn gemma4_prompt_no_bos_token() {
        // BOS is prepended by the tokenizer (AddBos::Add), not baked in.
        let p = build_gemma4_prompt(Some("sys"), &[], "q");
        assert!(!p.starts_with("<bos>"), "prompt must not include <bos>: {p}");
    }
}
