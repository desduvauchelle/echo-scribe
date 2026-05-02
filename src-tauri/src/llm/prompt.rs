//! Tiny chat-message helpers.
//!
//! We rely on llama-cpp-2's `apply_chat_template` to do the heavy lifting,
//! which uses the chat template baked into the model's GGUF. This module just
//! builds the [`LlamaChatMessage`] vector from a [`super::engine::GenerateRequest`].

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
}
