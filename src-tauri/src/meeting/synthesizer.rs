//! Calls the LLM with a meeting transcript and parses the structured JSON response.

use crate::llm::{GenerateRequest, Llm};
use crate::meeting::grammar::MEETING_SYNTHESIS_GBNF;
use crate::meeting::Segment;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    pub owner: String, // "you" | "them" | "unspecified"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSynthesis {
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub suggested_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSummary {
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub suggested_title: String,
    pub raw: Option<String>, // populated when JSON parse fails after retry
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

pub async fn synthesize(
    llm: Arc<Llm>,
    segments: &[Segment],
    detected_app_name: Option<&str>,
    duration_ms: u64,
) -> Result<StoredSummary, String> {
    let flattened = flatten_transcript(segments);
    let duration_minutes = duration_ms / 60_000;
    let (system, user) = crate::llm::prompt::build_meeting_synthesis_prompt(
        &flattened,
        detected_app_name,
        duration_minutes,
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
            grammar_gbnf: Some(MEETING_SYNTHESIS_GBNF.to_string()),
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
                    "synthesis ok"
                );
                return Ok(StoredSummary {
                    summary: s.summary,
                    action_items: s.action_items,
                    suggested_title: s.suggested_title,
                    raw: None,
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
                    });
                }
            }
        }
    }
    unreachable!()
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
}
