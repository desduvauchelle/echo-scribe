//! Prompt assembly + JSON parsing for the daily recap.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::daily_summary::collector::DailySummaryInput;

/// Per-section bullet emitted by the LLM. `source_id` may be missing — the
/// renderer degrades to a non-clickable bullet in that case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectionItem {
    pub text: String,
    #[serde(default)]
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Sections {
    #[serde(default)]
    pub meetings: Vec<SectionItem>,
    #[serde(default)]
    pub focus_work: Vec<SectionItem>,
    #[serde(default)]
    pub notes: Vec<SectionItem>,
    #[serde(default)]
    pub things_that_came_up: Vec<SectionItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DailySummaryOutput {
    pub narrative: String,
    #[serde(default)]
    pub sections: Sections,
}

/// Cap on per-app dictations sent to the model. Beyond this, we emit a
/// "+N more dictations into <app>" trailer line.
const DICTATIONS_PER_APP_CAP: usize = 20;

/// Build the system + user prompt strings for a given input.
pub fn build_prompt(input: &DailySummaryInput) -> (String, String) {
    let system = SYSTEM_PROMPT.to_string();
    let mut user = String::new();
    user.push_str(&format!("Date: {}\n\n", input.date));

    if !input.meetings.is_empty() {
        user.push_str("# Meetings\n");
        for (i, m) in input.meetings.iter().enumerate() {
            let id = format!("m{}", i + 1);
            let title = m.suggested_title.as_deref().unwrap_or("(untitled)");
            user.push_str(&format!("- [{id}] {title} (started {})\n", m.started_at));
            if let Some(s) = &m.summary_json {
                user.push_str(&format!("  summary: {s}\n"));
            }
        }
        user.push('\n');
    }

    if !input.notes.is_empty() {
        user.push_str("# Notes\n");
        for (i, n) in input.notes.iter().enumerate() {
            let id = format!("n{}", i + 1);
            user.push_str(&format!("- [{id}] ({}) {}\n", n.captured_at, n.content));
        }
        user.push('\n');
    }

    if !input.dictations_by_app.is_empty() {
        user.push_str("# Dictations grouped by app\n");
        let mut dictation_counter = 0;
        for (app, items) in &input.dictations_by_app {
            user.push_str(&format!("## {app} ({} total)\n", items.len()));
            for item in items.iter().take(DICTATIONS_PER_APP_CAP) {
                dictation_counter += 1;
                user.push_str(&format!("- [d{dictation_counter}] {}\n", item.content));
            }
            if items.len() > DICTATIONS_PER_APP_CAP {
                user.push_str(&format!(
                    "- ...and {} more dictations into {app}\n",
                    items.len() - DICTATIONS_PER_APP_CAP
                ));
            }
            user.push('\n');
        }
    }

    user.push_str(STYLE_GUIDANCE);
    (system, user)
}

const SYSTEM_PROMPT: &str =
    "You are summarizing one day of one person's work. Be honest about the shape of the day. Do not inflate. Omit any section that has no real content. Respond with strict JSON matching the provided schema.";

const STYLE_GUIDANCE: &str = r#"
Produce JSON with this shape:
{
  "narrative": "2-3 sentence opener describing the shape of the day",
  "sections": {
    "meetings":            [{ "text": "...", "source_id": "m1" }],
    "focus_work":          [{ "text": "...", "source_id": "d12" }],
    "notes":               [{ "text": "...", "source_id": "n3"  }],
    "things_that_came_up": [{ "text": "...", "source_id": "m1"  }]
  }
}

Rules:
- Each section is an array. If a section has no real content, return an empty array.
- For each bullet, set `source_id` to the [m#]/[n#]/[d#] tag from the input that the bullet draws from. If the bullet draws from multiple sources or you are unsure, omit `source_id`.
- "things_that_came_up" must list commitments the person made, open questions they raised, and things they said they'd follow up on. Quote concise phrases when useful. Return [] if there are none.
- Do not include any text outside the JSON object.
"#;

/// GBNF grammar that forces the model to emit JSON matching the schema.
///
/// Loose-typed (strings/arrays only), permissive about whitespace. The model
/// can still produce empty arrays, missing optional fields, etc.
pub const OUTPUT_GRAMMAR: &str = r##"
root        ::= ws "{" ws "\"narrative\"" ws ":" ws string ws "," ws "\"sections\"" ws ":" ws sections ws "}" ws
sections    ::= "{" ws section-entry ("," ws section-entry)* ws "}"
section-entry ::= section-key ws ":" ws section-arr
section-key ::= "\"meetings\"" | "\"focus_work\"" | "\"notes\"" | "\"things_that_came_up\""
section-arr ::= "[" ws ( item ( ws "," ws item )* )? ws "]"
item        ::= "{" ws "\"text\"" ws ":" ws string ( ws "," ws "\"source_id\"" ws ":" ws ( string | "null" ) )? ws "}"
string      ::= "\"" char* "\""
char        ::= [^"\\] | "\\" ["\\/bfnrt]
ws          ::= [ \t\n\r]*
"##;

/// Stable short hash of the prompt so we can identify the prompt version
/// alongside the LLM model id in `daily_summaries.model_version`.
pub fn prompt_version() -> String {
    let mut h = Sha256::new();
    h.update(SYSTEM_PROMPT.as_bytes());
    h.update(STYLE_GUIDANCE.as_bytes());
    h.update(OUTPUT_GRAMMAR.as_bytes());
    let digest = h.finalize();
    digest[..4].iter().map(|b| format!("{:02x}", b)).collect()
}

use crate::llm::{GenerateRequest, Llm, LlmError};

/// Generate a daily summary by prompting the local LLM with the input
/// bundle. Awaits the async `Llm::generate` (which internally wraps the
/// CPU/Metal-bound work in `spawn_blocking`).
pub async fn generate(llm: &Llm, input: &DailySummaryInput) -> Result<DailySummaryOutput, GenerateError> {
    let (system, user) = build_prompt(input);
    let raw = llm
        .generate(GenerateRequest {
            system: Some(system),
            user,
            history: Vec::new(),
            max_tokens: 1024,
            temperature: 0.3,
            stop_strings: Vec::new(),
            grammar_gbnf: Some(OUTPUT_GRAMMAR.to_string()),
        })
        .await
        .map_err(GenerateError::Llm)?;
    parse_response(&raw).map_err(GenerateError::Parse)
}

#[derive(Debug, thiserror::Error)]
pub enum GenerateError {
    #[error("llm failure: {0}")]
    Llm(LlmError),
    #[error("parse failure: {0}")]
    Parse(ParseError),
}

/// Parse the LLM response into a typed output, returning a descriptive error
/// for bad JSON or schema mismatch.
pub fn parse_response(raw: &str) -> Result<DailySummaryOutput, ParseError> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| ParseError::Json(e.to_string()))?;
    let out: DailySummaryOutput =
        serde_json::from_value(v).map_err(|e| ParseError::Schema(e.to_string()))?;
    if out.narrative.trim().is_empty() {
        return Err(ParseError::Schema("narrative is empty".into()));
    }
    Ok(out)
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("invalid JSON: {0}")]
    Json(String),
    #[error("schema mismatch: {0}")]
    Schema(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daily_summary::collector::{ItemForSummary, MeetingForSummary};

    fn empty_input(date: &str) -> DailySummaryInput {
        DailySummaryInput {
            date: date.into(),
            meetings: vec![],
            notes: vec![],
            dictations_by_app: vec![],
        }
    }

    #[test]
    fn prompt_includes_date_and_schema() {
        let (system, user) = build_prompt(&empty_input("2026-05-12"));
        assert!(system.contains("Respond with strict JSON"));
        assert!(user.contains("Date: 2026-05-12"));
        assert!(user.contains("\"narrative\""));
        assert!(user.contains("\"things_that_came_up\""));
    }

    #[test]
    fn prompt_includes_meetings_with_short_ids() {
        let mut input = empty_input("2026-05-12");
        input.meetings.push(MeetingForSummary {
            id: "long-uuid-1".into(),
            started_at: "2026-05-12T09:00:00Z".into(),
            ended_at: None,
            suggested_title: Some("Roadmap sync".into()),
            summary_json: Some(r#"{"summary":["Discussed Q3"]}"#.into()),
        });
        let (_, user) = build_prompt(&input);
        assert!(user.contains("[m1] Roadmap sync"));
        assert!(user.contains("Discussed Q3"));
    }

    #[test]
    fn prompt_caps_dictations_per_app() {
        let mut input = empty_input("2026-05-12");
        let items: Vec<ItemForSummary> = (0..25)
            .map(|i| ItemForSummary {
                id: format!("uuid-{i}"),
                content: format!("dict {i}"),
                captured_at: "2026-05-12T10:00:00Z".into(),
                capture_context: Some("VS Code".into()),
            })
            .collect();
        input.dictations_by_app.push(("VS Code".into(), items));
        let (_, user) = build_prompt(&input);
        assert!(user.contains("...and 5 more dictations into VS Code"));
        assert!(user.contains("[d20]"));
        assert!(!user.contains("[d21]"));
    }

    #[test]
    fn parse_valid_output() {
        let raw = r#"{
            "narrative": "Quiet day, mostly focused work.",
            "sections": {
                "meetings": [],
                "focus_work": [{"text": "Heavy VS Code activity", "source_id": "d5"}],
                "notes": [],
                "things_that_came_up": []
            }
        }"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "Quiet day, mostly focused work.");
        assert_eq!(out.sections.focus_work.len(), 1);
        assert_eq!(out.sections.focus_work[0].source_id.as_deref(), Some("d5"));
    }

    #[test]
    fn parse_rejects_bad_json() {
        assert!(matches!(
            parse_response("{not json"),
            Err(ParseError::Json(_))
        ));
    }

    #[test]
    fn parse_rejects_empty_narrative() {
        let raw = r#"{"narrative": "", "sections": {}}"#;
        assert!(matches!(parse_response(raw), Err(ParseError::Schema(_))));
    }

    #[test]
    fn parse_handles_missing_source_id() {
        let raw = r#"{"narrative":"x","sections":{"notes":[{"text":"y"}]}}"#;
        let out = parse_response(raw).unwrap();
        assert!(out.sections.notes[0].source_id.is_none());
    }

    #[test]
    fn prompt_version_is_stable() {
        let a = prompt_version();
        let b = prompt_version();
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
    }
}
