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
    start_context: &crate::meeting::MeetingStartContext,
) -> (Option<String>, String) {
    let app = detected_app_name.unwrap_or("a meeting");

    // Compose a short context block from window title / URL / tab title. The
    // LLM uses this to seed the meeting topic and (for Meet/Zoom titles)
    // sometimes the participant list, even before reading the transcript.
    let context_block = build_start_context_block(start_context);

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
    let user = if context_block.is_empty() {
        format!("Transcript:\n\n{flattened_transcript}\n\nProduce the JSON now.")
    } else {
        format!(
            "Context at meeting start:\n{context_block}\nTranscript:\n\n{flattened_transcript}\n\nProduce the JSON now."
        )
    };
    (Some(system), user)
}

/// Render the optional start-of-meeting context (window title, URL, tab title)
/// as a bullet list. Returns an empty string when no fields are set.
fn build_start_context_block(ctx: &crate::meeting::MeetingStartContext) -> String {
    let mut out = String::new();
    if let Some(t) = ctx.window_title.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("- Window title: ");
        out.push_str(t.trim());
        out.push('\n');
    }
    if let Some(t) = ctx
        .browser_tab_title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        // Skip when the tab title equals the window title (Safari often
        // duplicates them — no value in repeating).
        let same_as_window = ctx
            .window_title
            .as_deref()
            .map(|w| w.trim() == t.trim())
            .unwrap_or(false);
        if !same_as_window {
            out.push_str("- Tab title: ");
            out.push_str(t.trim());
            out.push('\n');
        }
    }
    if let Some(u) = ctx.browser_url.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("- URL: ");
        out.push_str(u.trim());
        out.push('\n');
    }
    if let Some(cm) = ctx.calendar_match.as_ref() {
        out.push_str(&render_calendar_match_block(cm));
    }
    out
}

/// Render a `CalendarMatch` snapshot as a labeled block the LLM can read.
/// Output is multi-line, starts with a header line so the LLM treats it as
/// a structured fact set rather than free-form metadata.
fn render_calendar_match_block(cm: &crate::calendar::CalendarMatch) -> String {
    let mut out = String::new();
    let label = if cm.match_score >= crate::calendar::HIGH_CONFIDENCE_SCORE {
        format!("Calendar match (confidence {:.2}):", cm.match_score)
    } else {
        format!(
            "Calendar match (low confidence {:.2} — treat as hint):",
            cm.match_score
        )
    };
    out.push_str("- ");
    out.push_str(&label);
    out.push('\n');
    if let Some(t) = cm.title.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("  - Title: ");
        out.push_str(t.trim());
        out.push('\n');
    }
    if let Some(org) = cm.organizer.as_ref() {
        out.push_str("  - Organizer: ");
        out.push_str(&render_attendee(org));
        out.push('\n');
    }
    if !cm.attendees.is_empty() {
        out.push_str("  - Attendees: ");
        let rendered: Vec<String> = cm.attendees.iter().map(render_attendee).collect();
        out.push_str(&rendered.join(", "));
        out.push('\n');
    }
    if let Some(notes) = cm.notes.as_deref().filter(|s| !s.trim().is_empty()) {
        // Cap notes — calendar invites occasionally embed huge agendas.
        let trimmed = notes.trim();
        let snippet: String = trimmed.chars().take(500).collect();
        out.push_str("  - Notes: ");
        out.push_str(&snippet);
        if trimmed.len() > snippet.len() {
            out.push_str(" …");
        }
        out.push('\n');
    }
    out
}

fn render_attendee(a: &crate::calendar::Attendee) -> String {
    let name = a.name.clone().filter(|s| !s.trim().is_empty());
    let email = a.email.clone().filter(|s| !s.trim().is_empty());
    let base = match (name, email) {
        (Some(n), Some(e)) => format!("{n} <{e}>"),
        (Some(n), None) => n,
        (None, Some(e)) => e,
        (None, None) => "unknown".to_string(),
    };
    if a.self_ {
        format!("{base} (you)")
    } else {
        base
    }
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

    // ── meeting synthesis start-context tests ────────────────────────────

    #[test]
    fn meeting_synthesis_omits_context_block_when_empty() {
        let ctx = crate::meeting::MeetingStartContext::default();
        let (_sys, user) =
            build_meeting_synthesis_prompt("You: hi\nThem: hello\n", Some("Zoom"), 5, &[], &ctx);
        assert!(
            !user.contains("Context at meeting start"),
            "empty context must not produce a context block, got: {user}"
        );
    }

    #[test]
    fn meeting_synthesis_includes_window_title_and_url() {
        let ctx = crate::meeting::MeetingStartContext {
            window_title: Some("Weekly Standup - Zoom Meeting".into()),
            browser_url: Some("https://meet.google.com/abc-defg-hij".into()),
            browser_tab_title: Some("Meeting – Alice, Bob".into()),
            calendar_match: None,
        };
        let (_sys, user) =
            build_meeting_synthesis_prompt("You: hi\n", Some("Zoom"), 30, &[], &ctx);
        assert!(user.contains("Context at meeting start"));
        assert!(user.contains("Weekly Standup - Zoom Meeting"));
        assert!(user.contains("https://meet.google.com/abc-defg-hij"));
        assert!(user.contains("Meeting – Alice, Bob"));
    }

    #[test]
    fn meeting_synthesis_includes_calendar_match_block() {
        use crate::calendar::{Attendee, CalendarMatch};
        let cm = CalendarMatch {
            title: Some("Weekly Standup".into()),
            organizer: Some(Attendee {
                name: Some("Alice".into()),
                email: Some("alice@acme.com".into()),
                self_: false,
                role: Some("chair".into()),
            }),
            attendees: vec![
                Attendee {
                    name: Some("Bob".into()),
                    email: Some("bob@acme.com".into()),
                    self_: false,
                    role: None,
                },
                Attendee {
                    name: Some("Me".into()),
                    email: Some("me@acme.com".into()),
                    self_: true,
                    role: None,
                },
            ],
            starts_at: "2026-05-15T16:00:00Z".into(),
            ends_at: "2026-05-15T16:30:00Z".into(),
            notes: Some("Standing agenda".into()),
            calendar_name: Some("Work".into()),
            conferencing_url: Some("https://zoom.us/j/1".into()),
            match_score: 0.92,
            match_reason: "overlap+conf_url".into(),
        };
        let ctx = crate::meeting::MeetingStartContext {
            calendar_match: Some(cm),
            ..Default::default()
        };
        let (_sys, user) =
            build_meeting_synthesis_prompt("You: hi\n", Some("Zoom"), 30, &[], &ctx);
        assert!(user.contains("Calendar match (confidence 0.92)"), "{user}");
        assert!(user.contains("Weekly Standup"));
        assert!(user.contains("Alice <alice@acme.com>"));
        assert!(user.contains("Me <me@acme.com> (you)"));
        assert!(user.contains("Standing agenda"));
    }

    #[test]
    fn meeting_synthesis_calendar_match_low_confidence_prefix() {
        use crate::calendar::CalendarMatch;
        let cm = CalendarMatch {
            title: Some("Maybe meeting".into()),
            organizer: None,
            attendees: vec![],
            starts_at: "2026-05-15T16:00:00Z".into(),
            ends_at: "2026-05-15T16:30:00Z".into(),
            notes: None,
            calendar_name: None,
            conferencing_url: None,
            match_score: 0.45,
            match_reason: "overlap".into(),
        };
        let ctx = crate::meeting::MeetingStartContext {
            calendar_match: Some(cm),
            ..Default::default()
        };
        let (_sys, user) =
            build_meeting_synthesis_prompt("You: hi\n", None, 5, &[], &ctx);
        assert!(
            user.contains("low confidence 0.45 — treat as hint"),
            "missing low-confidence prefix: {user}"
        );
    }

    #[test]
    fn meeting_synthesis_drops_redundant_tab_title() {
        // Safari often returns the same string for window title and tab title;
        // the renderer should not repeat it.
        let ctx = crate::meeting::MeetingStartContext {
            window_title: Some("Echo Scribe — pricing".into()),
            browser_url: None,
            browser_tab_title: Some("Echo Scribe — pricing".into()),
            calendar_match: None,
        };
        let (_sys, user) =
            build_meeting_synthesis_prompt("You: hi\n", None, 1, &[], &ctx);
        let occurrences = user.matches("Echo Scribe — pricing").count();
        assert_eq!(
            occurrences, 1,
            "redundant tab title should not be repeated; got {occurrences} occurrences in: {user}"
        );
    }
}
