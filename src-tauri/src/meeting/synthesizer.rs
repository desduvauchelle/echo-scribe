//! Calls the LLM with a meeting transcript and produces the stored summary.
//!
//! Two-stage flow: stage 1 writes free-form markdown notes following the
//! user's summary template (no structured output — a template change can
//! never break parsing), stage 2 extracts a small metadata JSON object
//! (title / tags / project) from those notes, with a heuristic fallback so
//! a parse failure still yields a usable summary.

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

/// Metadata extracted from the markdown notes in a second, small LLM call.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SummaryMetadata {
    #[serde(default)]
    pub suggested_title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}

/// The persisted summary. `markdown` is the primary body for new summaries;
/// the `summary` bullets / `action_items` / `evidence` fields remain so
/// meetings synthesized before the markdown rework stay readable. Every field
/// defaults so any historical or partial JSON still parses.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredSummary {
    #[serde(default)]
    pub markdown: Option<String>,
    #[serde(default)]
    pub summary: Vec<String>,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
    #[serde(default)]
    pub suggested_title: String,
    #[serde(default)]
    pub raw: Option<String>, // legacy: populated when JSON parse failed after retry
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub evidence: Vec<SummaryEvidence>,
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

fn detected_output_language(text: &str) -> Option<&'static str> {
    let info = whatlang::detect(text)?;
    // Meeting transcripts are long, so a reliable result should be decisive.
    // If detection is uncertain, retain the existing model-inference fallback
    // instead of confidently pinning the wrong language.
    info.is_reliable().then(|| info.lang().eng_name())
}

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

async fn condense_pass(
    llm: &impl crate::llm::LlmGenerator,
    text: &str,
    output_language: Option<&str>,
) -> Result<String, String> {
    let chunks = split_for_condensing(text);
    let mut summaries = Vec::new();
    let num_chunks = chunks.len();
    for (i, chunk) in chunks.iter().enumerate() {
        // The condensed text is fed straight back into the notes prompt, so an
        // English condensation would force English notes for a non-English
        // meeting no matter what stage 1 is told.
        let language_rule = output_language
            .map(crate::llm::prompt::pinned_language_rule)
            .unwrap_or_else(|| crate::llm::prompt::language_rule("the meeting segment"));
        let system_prompt = format!(
            "You are a precise meeting assistant. Summarize the following meeting segment \
             chronologically. Highlight key points, decisions, and action items discussed \
             during this part of the meeting. Keep it concise but detailed enough for a \
             final synthesizer. {}",
            language_rule
        );
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
    let output_language = detected_output_language(text);
    let mut current = text.to_string();
    loop {
        let condensed = condense_pass(llm, &current, output_language).await?;
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

/// Strip a ```json / ``` fence the model may wrap its JSON in.
fn strip_code_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(inner) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let inner = inner.strip_prefix("json").unwrap_or(inner);
    inner.strip_suffix("```").unwrap_or(inner).trim()
}

/// Heuristic title when metadata extraction fails: the first markdown heading,
/// else the first non-empty line, clipped to 60 chars.
fn fallback_title(markdown: &str) -> String {
    let line = markdown
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let line = line
        .trim_start_matches('#')
        .trim_start_matches(['-', '*', ' '])
        .trim();
    line.chars().take(60).collect()
}

/// Stage 2: extract title / tags / project from the markdown notes. Never
/// fails the overall synthesis — falls back to a heuristic title on error.
async fn extract_metadata(
    llm: &impl crate::llm::LlmGenerator,
    markdown: &str,
    existing_projects: &[crate::db::projects::Project],
) -> SummaryMetadata {
    let (system, user) =
        crate::llm::prompt::build_meeting_metadata_prompt(markdown, existing_projects);
    for attempt in 0..2u8 {
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: 256,
            temperature: if attempt == 0 { 0.2 } else { 0.0 },
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(8192),
        };
        let raw = match llm.generate(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(?e, attempt, "metadata generation failed");
                continue;
            }
        };
        match serde_json::from_str::<SummaryMetadata>(strip_code_fence(&raw)) {
            Ok(mut meta) => {
                meta.suggested_title = meta.suggested_title.trim().chars().take(60).collect();
                if meta.suggested_title.is_empty() {
                    meta.suggested_title = fallback_title(markdown);
                }
                meta.tags.truncate(3);
                return meta;
            }
            Err(e) => warn!(?e, attempt, "metadata JSON parse failed"),
        }
    }
    warn!("metadata extraction failed after retries; using fallback title");
    SummaryMetadata {
        suggested_title: fallback_title(markdown),
        ..Default::default()
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
    let output_language = detected_output_language(&flattened_raw);
    let flattened = if flattened_raw.len() <= MAX_TRANSCRIPT_BYTES {
        flattened_raw
    } else {
        let condensed = condense_transcript(llm.as_ref(), &flattened_raw).await?;
        format!(
            "[Note: The following transcript has been condensed chronologically due to its length]\n\n{condensed}"
        )
    };
    let duration_minutes = duration_ms / 60_000;

    // Stage 1: free-form markdown notes. Plain text out — nothing to parse,
    // so a custom or reworded template can't break this stage.
    let (system, user) = crate::llm::prompt::build_meeting_notes_prompt_with_language(
        &flattened,
        detected_app_name,
        duration_minutes,
        start_context,
        custom_prompt,
        user_notes,
        summary_template,
        output_language,
    );
    let mut markdown = String::new();
    for attempt in 0..2u8 {
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: 2048,
            temperature: if attempt == 0 { 0.3 } else { 0.1 },
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(16384),
        };
        match llm.generate(req).await {
            Ok(raw) => {
                let cleaned = raw.trim();
                // A markdown fence around the whole answer is the only
                // "formatting failure" possible — unwrap it.
                let cleaned = cleaned
                    .strip_prefix("```markdown")
                    .or_else(|| cleaned.strip_prefix("```md"))
                    .map(|rest| rest.strip_suffix("```").unwrap_or(rest))
                    .unwrap_or(cleaned)
                    .trim();
                if !cleaned.is_empty() {
                    markdown = cleaned.to_string();
                    break;
                }
                warn!(attempt, "notes generation returned empty output");
            }
            Err(e) => {
                warn!(?e, attempt, "notes generation failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {e}"));
                }
            }
        }
    }
    if markdown.is_empty() {
        return Err("notes generation returned empty output".into());
    }

    // Stage 2: small metadata extraction over the notes (never fatal).
    let meta = extract_metadata(llm.as_ref(), &markdown, existing_projects).await;
    info!(
        notes_bytes = markdown.len(),
        title = %meta.suggested_title,
        project = ?meta.project_name,
        tags = ?meta.tags,
        "synthesis ok (markdown)"
    );
    Ok(StoredSummary {
        markdown: Some(markdown),
        suggested_title: meta.suggested_title,
        tags: meta.tags,
        project_name: meta.project_name,
        ..Default::default()
    })
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

    #[derive(Default)]
    struct CapturingLlm {
        systems: std::sync::Mutex<Vec<Option<String>>>,
    }

    impl crate::llm::LlmGenerator for CapturingLlm {
        fn generate<'a>(&'a self, req: GenerateRequest) -> crate::llm::GenerateFuture<'a> {
            self.systems.lock().unwrap().push(req.system.clone());
            Box::pin(async move { Ok("condensed".to_string()) })
        }
    }

    #[tokio::test]
    async fn condense_pass_keeps_the_segment_language() {
        // The condensation feeds straight back into the notes prompt, so an
        // English condensation would force English notes for a German meeting.
        let llm = CapturingLlm::default();
        condense_pass(&llm, "Them: Guten Tag, wie geht es Ihnen?\n", None)
            .await
            .unwrap();
        let systems = llm.systems.lock().unwrap();
        let sys = systems[0]
            .as_deref()
            .expect("condense pass sets a system prompt");
        assert!(
            sys.contains(&crate::llm::prompt::language_rule("the meeting segment")),
            "got: {sys}"
        );
    }

    #[tokio::test]
    async fn english_condensation_is_pinned_to_english_instead_of_model_inference() {
        let llm = CapturingLlm::default();
        condense_pass(
            &llm,
            "Them: We reviewed the website strategy and agreed on the next steps.\n",
            detected_output_language(
                "Them: We reviewed the website strategy and agreed on the next steps.\n",
            ),
        )
        .await
        .unwrap();
        let systems = llm.systems.lock().unwrap();
        let sys = systems[0]
            .as_deref()
            .expect("condense pass sets a system prompt");
        assert!(
            sys.contains("Output language: English"),
            "an English meeting must not leave the output language for the model to infer: {sys}"
        );
    }

    #[test]
    fn detects_dominant_meeting_language_before_synthesis() {
        assert_eq!(
            detected_output_language(
                "You: We reviewed the website strategy and agreed on the next steps.\n\
                 Them: The dashboard metrics are ready, and we should update the copy today.\n"
            ),
            Some("English")
        );
        assert_eq!(
            detected_output_language(
                "You: Wir haben die Website-Strategie besprochen und die nächsten Schritte vereinbart.\n\
                 Them: Die Kennzahlen sind fertig und wir aktualisieren den Text heute.\n"
            ),
            Some("German")
        );
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
    fn legacy_stored_summary_json_still_parses() {
        // Pre-markdown rows: bullets + action items, no `markdown` field.
        let json = r#"{
            "summary": ["Discussed roadmap"],
            "action_items": [
                {"text": "Write spec", "owner": "you", "tags": ["design"], "project_name": "Alpha"}
            ],
            "suggested_title": "Roadmap sync",
            "raw": null,
            "tags": ["planning"],
            "project_name": "Alpha"
        }"#;
        let s: StoredSummary = serde_json::from_str(json).unwrap();
        assert!(s.markdown.is_none());
        assert_eq!(s.summary, vec!["Discussed roadmap"]);
        assert_eq!(s.action_items[0].text, "Write spec");
        assert_eq!(s.suggested_title, "Roadmap sync");
    }

    #[test]
    fn markdown_stored_summary_roundtrip() {
        let summary = StoredSummary {
            markdown: Some("## Summary\n- Shipped the thing".into()),
            suggested_title: "Ship review".into(),
            tags: vec!["shipping".into()],
            project_name: Some("Beta".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: StoredSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed.markdown.as_deref(),
            Some("## Summary\n- Shipped the thing")
        );
        assert_eq!(parsed.suggested_title, "Ship review");
        assert_eq!(parsed.project_name.as_deref(), Some("Beta"));
        assert!(parsed.action_items.is_empty());
    }

    #[test]
    fn fallback_title_prefers_first_heading() {
        assert_eq!(fallback_title("# Kickoff notes\n\n- a"), "Kickoff notes");
        assert_eq!(
            fallback_title("\n\n- First point made\n- Second"),
            "First point made"
        );
        assert_eq!(fallback_title(""), "");
        let long = format!("# {}", "x".repeat(100));
        assert_eq!(fallback_title(&long).chars().count(), 60);
    }

    #[test]
    fn strip_code_fence_unwraps_json_fences() {
        assert_eq!(strip_code_fence("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_code_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fence("```\n{\"a\":1}\n```"), "{\"a\":1}");
    }

    #[tokio::test]
    async fn extract_metadata_parses_json_and_clips() {
        let mock = MockLlm {
            generated_responses: std::sync::Mutex::new(vec![
                r#"{"suggested_title": "Roadmap sync", "tags": ["a", "b", "c", "d"], "project_name": "Alpha"}"#.to_string(),
            ]),
        };
        let meta = extract_metadata(&mock, "## Notes\n- point", &[]).await;
        assert_eq!(meta.suggested_title, "Roadmap sync");
        assert_eq!(meta.tags.len(), 3, "tags clipped to 3");
        assert_eq!(meta.project_name.as_deref(), Some("Alpha"));
    }

    #[tokio::test]
    async fn extract_metadata_falls_back_to_heading_on_bad_json() {
        let mock = MockLlm {
            generated_responses: std::sync::Mutex::new(vec![
                "not json".to_string(),
                "still not json".to_string(),
            ]),
        };
        let meta = extract_metadata(&mock, "# Standup notes\n- point", &[]).await;
        assert_eq!(meta.suggested_title, "Standup notes");
        assert!(meta.tags.is_empty());
        assert!(meta.project_name.is_none());
    }
}
