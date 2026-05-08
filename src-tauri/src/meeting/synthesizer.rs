//! Calls the LLM with a meeting transcript and parses the structured JSON response.

use crate::llm::{GenerateRequest, Llm};
use crate::meeting::Segment;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    pub owner: String, // "you" | "them" | "unspecified"
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSynthesis {
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub suggested_title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSummary {
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub suggested_title: String,
    pub raw: Option<String>, // populated when JSON parse fails after retry
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}

pub fn flatten_transcript(segments: &[Segment]) -> String {
    let mut out = String::new();
    for seg in segments {
        let speaker = match seg.speaker {
            crate::meeting::Speaker::You => "You",
            crate::meeting::Speaker::Them => "Them",
        };
        out.push_str(speaker);
        out.push_str(": ");
        out.push_str(seg.text.trim());
        out.push('\n');
    }
    out
}

/// Conservative byte budget for the transcript portion of the synthesis prompt.
/// At ~3.5 chars/token, this keeps the transcript ≤ ~5000 tokens, leaving room
/// for prompt scaffolding (~500 tokens) and the model's response (~2000 tokens)
/// inside the typical 8192-token context window.
const MAX_TRANSCRIPT_BYTES: usize = 18_000;

pub async fn synthesize(
    llm: Arc<Llm>,
    segments: &[Segment],
    detected_app_name: Option<&str>,
    duration_ms: u64,
    existing_project_names: &[String],
) -> Result<StoredSummary, String> {
    let flattened = truncate_transcript(flatten_transcript(segments));
    let duration_minutes = duration_ms / 60_000;
    let (system, user) = crate::llm::prompt::build_meeting_synthesis_prompt(
        &flattened,
        detected_app_name,
        duration_minutes,
        existing_project_names,
    );

    for attempt in 0..2u8 {
        let temperature = if attempt == 0 { 0.3 } else { 0.1 };
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: 2048,
            temperature,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
        };
        let raw = match llm.generate(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(?e, attempt, "synthesis generation failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {e}"));
                }
                continue;
            }
        };
        match serde_json::from_str::<MeetingSynthesis>(&raw) {
            Ok(s) => {
                info!(
                    summary_bullets = s.summary.len(),
                    actions = s.action_items.len(),
                    project = ?s.project_name,
                    tags = ?s.tags,
                    "synthesis ok"
                );
                return Ok(StoredSummary {
                    summary: s.summary,
                    action_items: s.action_items,
                    suggested_title: s.suggested_title,
                    raw: None,
                    tags: s.tags,
                    project_name: s.project_name,
                });
            }
            Err(e) => {
                warn!(?e, attempt, "synthesis JSON parse failed");
                if attempt == 1 {
                    return Ok(StoredSummary {
                        summary: vec![],
                        action_items: vec![],
                        suggested_title: String::new(),
                        raw: Some(raw),
                        tags: vec![],
                        project_name: None,
                    });
                }
            }
        }
    }
    unreachable!()
}

/// Trim a flattened transcript to fit the synthesis prompt's context budget.
/// Keeps the head and tail (where intros and action items typically live) and
/// drops the middle when the transcript exceeds [`MAX_TRANSCRIPT_BYTES`].
fn truncate_transcript(text: String) -> String {
    if text.len() <= MAX_TRANSCRIPT_BYTES {
        return text;
    }
    let head_budget = MAX_TRANSCRIPT_BYTES * 2 / 3;
    let tail_budget = MAX_TRANSCRIPT_BYTES - head_budget;

    let mut head_end = head_budget.min(text.len());
    while head_end > 0 && !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = text.len().saturating_sub(tail_budget);
    while tail_start < text.len() && !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    if tail_start <= head_end {
        return text;
    }
    let head = &text[..head_end];
    let tail = &text[tail_start..];
    format!("{head}\n[... transcript truncated for length ...]\n{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::Speaker;

    #[test]
    fn flatten_produces_speaker_labeled_lines() {
        let segs = vec![
            Segment { speaker: Speaker::You, start_ms: 0, end_ms: 1000, text: "hello".into() },
            Segment { speaker: Speaker::Them, start_ms: 0, end_ms: 1000, text: "hi".into() },
        ];
        let out = flatten_transcript(&segs);
        assert_eq!(out, "You: hello\nThem: hi\n");
    }

    #[test]
    fn truncate_transcript_passthrough_when_short() {
        let s = "short transcript".to_string();
        assert_eq!(truncate_transcript(s.clone()), s);
    }

    #[test]
    fn truncate_transcript_keeps_head_and_tail_when_long() {
        let big = "a".repeat(MAX_TRANSCRIPT_BYTES * 2);
        let out = truncate_transcript(big);
        assert!(out.contains("[... transcript truncated for length ...]"));
        assert!(out.len() < MAX_TRANSCRIPT_BYTES * 2);
    }

    #[test]
    fn synthesis_json_with_tags_and_project() {
        let json = r#"{
            "summary": ["Discussed roadmap"],
            "action_items": [
                {"text": "Write spec", "owner": "you", "tags": ["design"], "project_name": "Alpha"}
            ],
            "suggested_title": "Roadmap sync",
            "tags": ["planning", "roadmap"],
            "project_name": "Alpha"
        }"#;
        let s: MeetingSynthesis = serde_json::from_str(json).unwrap();
        assert_eq!(s.tags, vec!["planning", "roadmap"]);
        assert_eq!(s.project_name.as_deref(), Some("Alpha"));
        assert_eq!(s.action_items[0].tags, vec!["design"]);
        assert_eq!(s.action_items[0].project_name.as_deref(), Some("Alpha"));
    }

    #[test]
    fn synthesis_json_without_tags_and_project_defaults() {
        let json = r#"{
            "summary": ["Quick chat"],
            "action_items": [{"text": "Follow up", "owner": "them"}],
            "suggested_title": "Quick chat"
        }"#;
        let s: MeetingSynthesis = serde_json::from_str(json).unwrap();
        assert!(s.tags.is_empty());
        assert!(s.project_name.is_none());
        assert!(s.action_items[0].tags.is_empty());
        assert!(s.action_items[0].project_name.is_none());
    }

    #[test]
    fn stored_summary_roundtrip_with_tags() {
        let summary = StoredSummary {
            summary: vec!["bullet".into()],
            action_items: vec![ActionItem {
                text: "do thing".into(),
                owner: "you".into(),
                tags: vec!["urgent".into()],
                project_name: Some("Beta".into()),
            }],
            suggested_title: "Test".into(),
            raw: None,
            tags: vec!["meeting".into()],
            project_name: Some("Beta".into()),
        };
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: StoredSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tags, vec!["meeting"]);
        assert_eq!(parsed.project_name.as_deref(), Some("Beta"));
        assert_eq!(parsed.action_items[0].tags, vec!["urgent"]);
    }
}
