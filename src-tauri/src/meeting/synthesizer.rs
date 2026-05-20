//! Calls the LLM with a meeting transcript and parses the structured JSON response.

use crate::llm::{GenerateRequest, Llm};
use crate::meeting::{MeetingStartContext, Segment};
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

async fn condense_transcript(llm: &impl crate::llm::LlmGenerator, text: &str) -> Result<String, String> {
    let mut chunks = Vec::new();
    let mut current_chunk = String::new();
    
    for line in text.lines() {
        if current_chunk.len() + line.len() + 1 > 15000 && !current_chunk.is_empty() {
            chunks.push(std::mem::take(&mut current_chunk));
        }
        current_chunk.push_str(line);
        current_chunk.push('\n');
    }
    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }
    
    let mut summaries = Vec::new();
    let num_chunks = chunks.len();
    for (i, chunk) in chunks.iter().enumerate() {
        let system_prompt = "You are a precise meeting assistant. Summarize the following meeting segment chronologically. Highlight key points, decisions, and action items discussed during this part of the meeting. Keep it concise but detailed enough for a final synthesizer.".to_string();
        let user_prompt = format!("Meeting Segment {}/{}:\n\n{}", i + 1, num_chunks, chunk);
        
        let req = GenerateRequest {
            system: Some(system_prompt),
            user: user_prompt,
            history: Vec::new(),
            max_tokens: 1024,
            temperature: 0.3,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(8192),
        };
        
        let chunk_summary = llm.generate(req).await
            .map_err(|e| format!("Error condensing segment {}: {}", i + 1, e))?;
            
        summaries.push(format!("--- Chronological Segment {}/{} ---\n{}", i + 1, num_chunks, chunk_summary.trim()));
    }
    
    Ok(summaries.join("\n\n"))
}

pub async fn synthesize(
    llm: Arc<Llm>,
    segments: &[Segment],
    detected_app_name: Option<&str>,
    duration_ms: u64,
    existing_project_names: &[String],
    start_context: &MeetingStartContext,
    custom_prompt: Option<&str>,
) -> Result<StoredSummary, String> {
    let flattened_raw = flatten_transcript(segments);
    let flattened = if flattened_raw.len() <= MAX_TRANSCRIPT_BYTES {
        flattened_raw
    } else {
        let condensed = condense_transcript(llm.as_ref(), &flattened_raw).await?;
        format!(
            "[Note: The following transcript has been condensed chronologically due to its length]\n\n{condensed}"
        )
    };
    let duration_minutes = duration_ms / 60_000;
    let (system, user) = crate::llm::prompt::build_meeting_synthesis_prompt(
        &flattened,
        detected_app_name,
        duration_minutes,
        existing_project_names,
        start_context,
        custom_prompt,
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
            n_ctx: Some(16384),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::Speaker;

    struct MockLlm {
        generated_responses: std::sync::Mutex<Vec<String>>,
    }

    impl crate::llm::LlmGenerator for MockLlm {
        fn generate<'a>(&'a self, _req: GenerateRequest) -> crate::llm::GenerateFuture<'a> {
            Box::pin(async move {
                let mut guard = self.generated_responses.lock().unwrap();
                if guard.is_empty() {
                    Ok("mock summary".to_string())
                } else {
                    Ok(guard.remove(0))
                }
            })
        }
    }

    #[tokio::test]
    async fn test_condense_transcript_splits_chronologically() {
        let mock = MockLlm {
            generated_responses: std::sync::Mutex::new(vec![
                "Summary 1".to_string(),
                "Summary 2".to_string(),
            ]),
        };
        // Create a long input text that exceeds 15,000 bytes.
        // Each line is 100 bytes, 160 lines is 16,000 bytes.
        let mut text = String::new();
        for i in 0..160 {
            text.push_str(&format!("Line {}: {}\n", i, "a".repeat(90)));
        }

        let result = condense_transcript(&mock, &text).await.unwrap();
        assert!(result.contains("--- Chronological Segment 1/2 ---"));
        assert!(result.contains("Summary 1"));
        assert!(result.contains("--- Chronological Segment 2/2 ---"));
        assert!(result.contains("Summary 2"));
    }

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
