//! Bounded, source-labelled observations used by both immediate and deferred tagging.
//! These are evidence, never instructions, and never imply an app's entire sidebar
//! is the active project.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    Heading,
    SelectedItem,
    Document,
    Workspace,
    Conversation,
    Project,
    Subject,
    Recipient,
    Sender,
    MailHeader,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextSignal {
    pub kind: ContextKind,
    pub value: String,
    pub source: String,
}

pub const MAX_SIGNALS: usize = 12;
pub const MAX_VALUE_CHARS: usize = 240;

pub fn push_signal(signals: &mut Vec<ContextSignal>, kind: ContextKind, value: &str, source: &str) {
    let value: String = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_VALUE_CHARS)
        .collect();
    if value.is_empty() || signals.iter().any(|s| s.kind == kind && s.value == value) {
        return;
    }
    if signals.len() >= MAX_SIGNALS {
        if matches!(
            kind,
            ContextKind::Workspace
                | ContextKind::Project
                | ContextKind::Conversation
                | ContextKind::Subject
                | ContextKind::Recipient
                | ContextKind::Sender
        ) {
            if let Some(index) = signals
                .iter()
                .rposition(|s| matches!(s.kind, ContextKind::Heading | ContextKind::SelectedItem))
            {
                signals.remove(index);
            } else {
                return;
            }
        } else {
            return;
        }
    }
    signals.push(ContextSignal {
        kind,
        value,
        source: source.into(),
    });
}

/// URL identities are useful even when a page's accessibility title is generic.
/// Never infer project membership from a conversation ID alone.
pub fn url_signals(raw: &str, signals: &mut Vec<ContextSignal>) {
    let Ok(url) = url::Url::parse(raw) else {
        return;
    };
    let host = url.host_str().unwrap_or("");
    let parts: Vec<_> = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
    if matches!(host, "chatgpt.com" | "chat.openai.com" | "claude.ai") {
        for pair in parts.windows(2) {
            match pair[0] {
                "c" | "chat" | "epitaxy" => {
                    push_signal(signals, ContextKind::Conversation, pair[1], "page_url")
                }
                "project" => push_signal(
                    signals,
                    ContextKind::Project,
                    pair[1],
                    "page_url_identifier",
                ),
                _ => {}
            }
        }
    }
    if url.scheme() == "file" {
        if let Ok(path) = url.to_file_path() {
            push_signal(
                signals,
                ContextKind::Document,
                &path.to_string_lossy(),
                "document_url",
            );
            // Explicit folder conventions only; arbitrary filenames are not repositories.
            let parts: Vec<_> = path.iter().filter_map(|p| p.to_str()).collect();
            for pair in parts.windows(2) {
                if matches!(
                    pair[0],
                    "code" | "repos" | "projects" | "github" | "workspace" | "workspaces"
                ) {
                    push_signal(
                        signals,
                        ContextKind::Workspace,
                        pair[1],
                        "document_path_hint",
                    );
                }
            }
        }
    }
}

/// JSON-encoded fields prevent newlines in observed UI text from masquerading as
/// prompt structure. Bound old/imported context too, not only fresh captures.
pub fn signal_prompt(signals: &[ContextSignal]) -> String {
    let bounded: Vec<_> = signals
        .iter()
        .take(MAX_SIGNALS)
        .map(|s| ContextSignal {
            kind: s.kind.clone(),
            value: s.value.chars().take(MAX_VALUE_CHARS).collect(),
            source: s.source.chars().take(60).collect(),
        })
        .collect();
    serde_json::to_string(&bounded).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_ids_do_not_invent_project_membership() {
        let mut signals = vec![];
        url_signals("https://claude.ai/chat/chat-123", &mut signals);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].kind, ContextKind::Conversation);
        assert_eq!(signals[0].value, "chat-123");
    }

    #[test]
    fn document_path_preserves_workspace_and_document() {
        let mut signals = vec![];
        url_signals("file:///Users/test/code/livecase/src/app.ts", &mut signals);
        assert!(signals
            .iter()
            .any(|s| s.kind == ContextKind::Workspace && s.value == "livecase"));
        assert!(signals
            .iter()
            .any(|s| s.kind == ContextKind::Document && s.value.ends_with("app.ts")));
    }

    #[test]
    fn observations_are_deduplicated_and_bounded() {
        let mut signals = vec![];
        for _ in 0..30 {
            push_signal(&mut signals, ContextKind::Heading, "a title", "ax_heading");
        }
        assert_eq!(signals.len(), 1);
        for i in 0..30 {
            push_signal(
                &mut signals,
                ContextKind::Heading,
                &format!("{i}{}", "x".repeat(500)),
                "ax_heading",
            );
        }
        assert_eq!(signals.len(), MAX_SIGNALS);
        assert!(signals
            .iter()
            .all(|s| s.value.chars().count() <= MAX_VALUE_CHARS));
    }
}
