//! Calls the LLM with a meeting transcript and parses the structured JSON response.

use crate::llm::{GenerateRequest, Llm};
use crate::meeting::{MeetingStartContext, Segment};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidenceRef {
    pub segment_index: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SummaryEvidence {
    pub summary_index: usize,
    #[serde(flatten)]
    pub source: EvidenceRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    pub owner: String, // "you" | "them" | "unspecified"
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
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
    #[serde(default)]
    pub evidence: Vec<SummaryEvidence>,
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
    #[serde(default)]
    pub evidence: Vec<SummaryEvidence>,
}

fn validated_evidence(mut synthesis: MeetingSynthesis, segments: &[Segment]) -> MeetingSynthesis {
    let valid = |e: &EvidenceRef| {
        segments.get(e.segment_index).is_some_and(|segment| {
            segment.start_ms == e.start_ms
                && segment.end_ms == e.end_ms
                && !e.quote.trim().is_empty()
                && segment
                    .text
                    .to_lowercase()
                    .contains(&e.quote.trim().to_lowercase())
        })
    };
    synthesis
        .evidence
        .retain(|e| e.summary_index < synthesis.summary.len() && valid(&e.source));
    for action in &mut synthesis.action_items {
        action.evidence.retain(valid);
    }
    synthesis
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
const CONDENSE_CHUNK_BYTES: usize = 15_000;

fn split_for_condensing(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current_chunk = String::new();

    for line in text.split_inclusive('\n') {
        if line.len() > CONDENSE_CHUNK_BYTES {
            if !current_chunk.is_empty() {
                chunks.push(std::mem::take(&mut current_chunk));
            }
            let mut start = 0;
            while start < line.len() {
                let mut end = (start + CONDENSE_CHUNK_BYTES).min(line.len());
                while end > start && !line.is_char_boundary(end) {
                    end -= 1;
                }
                chunks.push(line[start..end].to_string());
                start = end;
            }
            continue;
        }
        if current_chunk.len() + line.len() > CONDENSE_CHUNK_BYTES && !current_chunk.is_empty() {
            chunks.push(std::mem::take(&mut current_chunk));
        }
        current_chunk.push_str(line);
    }
    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }

    chunks
}

async fn condense_pass(llm: &impl crate::llm::LlmGenerator, text: &str) -> Result<String, String> {
    let chunks = split_for_condensing(text);
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

        let chunk_summary = llm
            .generate(req)
            .await
            .map_err(|e| format!("Error condensing segment {}: {}", i + 1, e))?;

        summaries.push(format!(
            "--- Chronological Segment {}/{} ---\n{}",
            i + 1,
            num_chunks,
            chunk_summary.trim()
        ));
    }

    Ok(summaries.join("\n\n"))
}

/// Hierarchically condense an arbitrarily long transcript until the final
/// synthesis prompt is within its byte budget. Each pass preserves chronology
/// while reducing fixed-size groups, so multi-hour meetings never feed an
/// unbounded map-stage result into the model's finite context window.
pub(crate) async fn condense_transcript(
    llm: &impl crate::llm::LlmGenerator,
    text: &str,
) -> Result<String, String> {
    let mut current = text.to_string();
    loop {
        let condensed = condense_pass(llm, &current).await?;
        if condensed.len() <= MAX_TRANSCRIPT_BYTES {
            return Ok(condensed);
        }
        if condensed.len() >= current.len() {
            return Err(format!(
                "meeting transcript condensation did not reduce input ({} -> {} bytes)",
                current.len(),
                condensed.len()
            ));
        }
        current = condensed;
    }
}

pub async fn synthesize(
    llm: Arc<Llm>,
    segments: &[Segment],
    detected_app_name: Option<&str>,
    duration_ms: u64,
    existing_projects: &[crate::db::projects::Project],
    start_context: &MeetingStartContext,
    custom_prompt: Option<&str>,
    user_notes: Option<&str>,
    summary_template: Option<&crate::db::meeting_intelligence::SummaryTemplate>,
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
        existing_projects,
        start_context,
        custom_prompt,
        user_notes,
        summary_template,
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
                let s = validated_evidence(s, segments);
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
                    evidence: s.evidence,
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
                        evidence: vec![],
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

    struct FixedSummaryLlm {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl crate::llm::LlmGenerator for FixedSummaryLlm {
        fn generate<'a>(&'a self, _req: GenerateRequest) -> crate::llm::GenerateFuture<'a> {
            Box::pin(async move {
                self.calls
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok("s".repeat(3_000))
            })
        }
    }

    #[tokio::test]
    async fn hierarchical_condensation_reduces_multi_hour_sized_transcript_to_budget() {
        let mock = FixedSummaryLlm {
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        let text = (0..1_600)
            .map(|i| format!("You: segment {i} {}\n", "a".repeat(90)))
            .collect::<String>();
        assert!(text.len() > MAX_TRANSCRIPT_BYTES * 8);

        let result = condense_transcript(&mock, &text).await.unwrap();

        assert!(result.len() <= MAX_TRANSCRIPT_BYTES);
        assert!(
            mock.calls.load(std::sync::atomic::Ordering::Relaxed) > 10,
            "expected more than one condensation pass"
        );
    }

    #[test]
    fn condensation_chunks_never_exceed_budget_even_for_one_long_line() {
        let chunks = split_for_condensing(&"é".repeat(CONDENSE_CHUNK_BYTES));
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= CONDENSE_CHUNK_BYTES));
    }

    #[test]
    fn flatten_produces_speaker_labeled_lines() {
        let segs = vec![
            Segment {
                speaker: Speaker::You,
                start_ms: 0,
                end_ms: 1000,
                text: "hello".into(),
            },
            Segment {
                speaker: Speaker::Them,
                start_ms: 0,
                end_ms: 1000,
                text: "hi".into(),
            },
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
                evidence: vec![],
            }],
            suggested_title: "Test".into(),
            raw: None,
            tags: vec!["meeting".into()],
            project_name: Some("Beta".into()),
            evidence: vec![],
        };
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: StoredSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tags, vec!["meeting"]);
        assert_eq!(parsed.project_name.as_deref(), Some("Beta"));
        assert_eq!(parsed.action_items[0].tags, vec!["urgent"]);
    }

    #[test]
    fn evidence_must_match_the_indexed_transcript_exactly() {
        let segments = vec![Segment {
            speaker: Speaker::Them,
            start_ms: 1_000,
            end_ms: 2_500,
            text: "We will send the proposal on Friday.".into(),
        }];
        let valid = EvidenceRef {
            segment_index: 0,
            start_ms: 1_000,
            end_ms: 2_500,
            quote: "send the proposal".into(),
        };
        let invalid = EvidenceRef {
            segment_index: 0,
            start_ms: 999,
            end_ms: 2_500,
            quote: "send the proposal".into(),
        };
        let synthesis = MeetingSynthesis {
            summary: vec!["Proposal due Friday".into()],
            action_items: vec![ActionItem {
                text: "Send proposal".into(),
                owner: "them".into(),
                tags: vec![],
                project_name: None,
                evidence: vec![valid.clone(), invalid.clone()],
            }],
            suggested_title: "Proposal".into(),
            tags: vec![],
            project_name: None,
            evidence: vec![
                SummaryEvidence {
                    summary_index: 0,
                    source: valid.clone(),
                },
                SummaryEvidence {
                    summary_index: 2,
                    source: valid.clone(),
                },
                SummaryEvidence {
                    summary_index: 0,
                    source: invalid,
                },
            ],
        };

        let validated = validated_evidence(synthesis, &segments);

        assert_eq!(validated.evidence.len(), 1);
        assert_eq!(validated.evidence[0].source, valid);
        assert_eq!(validated.action_items[0].evidence.len(), 1);
    }
}
