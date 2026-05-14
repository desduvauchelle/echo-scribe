//! Prompt assembly + JSON parsing for the daily recap.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::daily_summary::collector::DailySummaryInput;

/// Per-section bullet emitted by the LLM. `source_id` may be missing — the
/// renderer degrades to a non-clickable bullet in that case.
///
/// Tolerant deserialization: accepts either the structured form
/// `{"text": "...", "source_id": "..."}` or a bare string. Models without
/// GBNF enforcement sometimes emit `["foo", "bar"]` instead of
/// `[{"text":"foo"}, {"text":"bar"}]`, especially for shorter sections.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SectionItem {
    pub text: String,
    #[serde(default)]
    pub source_id: Option<String>,
}

impl<'de> Deserialize<'de> for SectionItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Untagged enum trick: try object form first, fall back to bare string.
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Object {
                text: String,
                #[serde(default)]
                source_id: Option<String>,
            },
            String(String),
        }
        Ok(match Either::deserialize(deserializer)? {
            Either::Object { text, source_id } => SectionItem { text, source_id },
            Either::String(s) => SectionItem {
                text: s,
                source_id: None,
            },
        })
    }
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

/// Cap on per-app dictations sent to the model in the first-pass prompt.
/// When exceeded, the overflow becomes a "+N more dictations" trailer.
/// On busy days the map-reduce fallback (see [`generate`]) replaces full
/// dictation lists with LLM-generated condensations.
const DICTATIONS_PER_APP_CAP: usize = 15;

/// Per-item character caps. Tokens are roughly chars/4 for English-ish
/// content; these caps keep the per-item contribution bounded.
///
/// `MEETING_TITLE_CAP_CHARS` is small because the `items.content` field for
/// meetings actually stores transcript text (up to ~90 KB on long calls).
/// 200 chars is enough for a real title without dragging in transcripts.
const MEETING_TITLE_CAP_CHARS: usize = 200;
const MEETING_SUMMARY_CAP_CHARS: usize = 800;
const NOTE_CAP_CHARS: usize = 600;
const DICTATION_CAP_CHARS: usize = 400;

/// Soft budget for the assembled user-prompt string. Targets ~12K tokens
/// (rule of thumb 4 chars/token), leaving ~4K of headroom inside the
/// runtime's 16K n_ctx for the system prompt + response (max_tokens = 768).
/// When exceeded, the map-reduce path in [`generate`] kicks in to condense
/// dictation groups via secondary LLM calls before retrying.
const MAX_USER_PROMPT_CHARS: usize = 48_000;

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Build the system + user prompt strings for a given input. Enforces both
/// per-item character caps and a total prompt budget so the model never
/// sees more input than its context window can hold.
pub fn build_prompt(input: &DailySummaryInput) -> (String, String) {
    let system = SYSTEM_PROMPT.to_string();
    let mut user = build_user_prompt(input, DICTATIONS_PER_APP_CAP);

    // If we're still over budget, shrink the per-app dictation cap until the
    // prompt fits or we run out of room to shrink.
    let mut cap = DICTATIONS_PER_APP_CAP;
    while user.len() > MAX_USER_PROMPT_CHARS && cap > 0 {
        cap = cap.saturating_sub(2);
        user = build_user_prompt(input, cap);
    }

    (system, user)
}

fn build_user_prompt(input: &DailySummaryInput, dictation_cap: usize) -> String {
    let mut user = String::new();
    user.push_str(&format!("Date: {}\n\n", input.date));

    if !input.meetings.is_empty() {
        user.push_str("# Meetings\n");
        for (i, m) in input.meetings.iter().enumerate() {
            let id = format!("m{}", i + 1);
            let raw_title = m.suggested_title.as_deref().unwrap_or("(untitled)");
            let title = truncate(raw_title, MEETING_TITLE_CAP_CHARS);
            user.push_str(&format!("- [{id}] {title} (started {})\n", m.started_at));
            if let Some(s) = &m.summary_json {
                let s = truncate(s, MEETING_SUMMARY_CAP_CHARS);
                user.push_str(&format!("  summary: {s}\n"));
            }
        }
        user.push('\n');
    }

    if !input.notes.is_empty() {
        user.push_str("# Notes\n");
        for (i, n) in input.notes.iter().enumerate() {
            let id = format!("n{}", i + 1);
            let content = truncate(&n.content, NOTE_CAP_CHARS);
            user.push_str(&format!("- [{id}] ({}) {}\n", n.captured_at, content));
        }
        user.push('\n');
    }

    if !input.dictations_by_app.is_empty() && dictation_cap > 0 {
        user.push_str("# Dictations grouped by app\n");
        let mut dictation_counter = 0;
        for (app, items) in &input.dictations_by_app {
            user.push_str(&format!("## {app} ({} total)\n", items.len()));
            for item in items.iter().take(dictation_cap) {
                dictation_counter += 1;
                let content = truncate(&item.content, DICTATION_CAP_CHARS);
                user.push_str(&format!("- [d{dictation_counter}] {}\n", content));
            }
            if items.len() > dictation_cap {
                user.push_str(&format!(
                    "- ...and {} more dictations into {app}\n",
                    items.len() - dictation_cap
                ));
            }
            user.push('\n');
        }
    }

    user.push_str(STYLE_GUIDANCE);
    user
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

use tracing::{info, warn};

use crate::daily_summary::collector::ItemForSummary;
use crate::llm::{GenerateRequest, Llm, LlmError};

/// Per-sub-call char budget when condensing a single app's dictations.
/// Anything beyond this gets dropped from the condense input — but the count
/// "N total" is still surfaced in the synthetic line that replaces the group.
const CONDENSE_SUB_PROMPT_CHARS: usize = 8_000;

/// Generate a daily summary by prompting the local LLM with the input
/// bundle. Awaits the async `Llm::generate` (which internally wraps the
/// CPU/Metal-bound work in `spawn_blocking`).
///
/// **Map-reduce fallback:** if the assembled prompt exceeds
/// `MAX_USER_PROMPT_CHARS`, we condense each app's dictations into a
/// 1–3 sentence summary via a secondary LLM call per app, then rebuild
/// the daily-summary prompt against the condensed input. This preserves
/// signal from every dictation instead of truncating tail items away.
pub async fn generate(
    llm: &Llm,
    input: &DailySummaryInput,
) -> Result<DailySummaryOutput, GenerateError> {
    let (system, user) = build_prompt(input);
    if user.len() <= MAX_USER_PROMPT_CHARS {
        return call(llm, system, user).await;
    }

    info!(
        prompt_chars = user.len(),
        budget = MAX_USER_PROMPT_CHARS,
        dictation_apps = input.dictations_by_app.len(),
        "daily_summary: prompt exceeds budget, condensing dictation groups via map-reduce"
    );

    let condensed = condense_dictation_groups(llm, input).await;
    let (system, user) = build_prompt(&condensed);
    if user.len() > MAX_USER_PROMPT_CHARS {
        warn!(
            prompt_chars = user.len(),
            budget = MAX_USER_PROMPT_CHARS,
            "daily_summary: still over budget after condensing; build_prompt's shrink loop will have trimmed further"
        );
    } else {
        info!(
            prompt_chars = user.len(),
            "daily_summary: condensed prompt fits within budget"
        );
    }
    call(llm, system, user).await
}

async fn call(
    llm: &Llm,
    system: String,
    user: String,
) -> Result<DailySummaryOutput, GenerateError> {
    // GBNF intentionally not used: llama.cpp's grammar sampler aborts the
    // entire process via `ggml_abort` when no candidate token matches the
    // grammar at a given step, which is unrecoverable from Rust. We rely
    // instead on prompt-based JSON instruction (see STYLE_GUIDANCE) plus
    // the lenient `parse_response`; malformed output becomes a `failed`
    // row, not a SIGABRT.
    let raw = llm
        .generate(GenerateRequest {
            system: Some(system),
            user,
            history: Vec::new(),
            // 1536 tokens of output room. A full recap with 4 sections of
            // ~5 bullets each + a narrative comes in around 800-1200
            // tokens; the extra slack covers heavy days. n_ctx = 16384,
            // so input can still be ~14K tokens.
            max_tokens: 1536,
            temperature: 0.3,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
        })
        .await
        .map_err(GenerateError::Llm)?;
    parse_response(&raw).map_err(|e| {
        // Log a generous prefix of the raw output so future parse failures
        // are diagnosable without re-running. Truncated to keep one line.
        let preview: String = raw.chars().take(800).collect();
        warn!(
            error = %e,
            raw_len = raw.len(),
            raw_preview = %preview,
            "daily_summary: parse failure"
        );
        GenerateError::Parse(e)
    })
}

/// Replace each dictation-app group with a single synthetic "condensed"
/// entry whose content is an LLM-generated 1–3 sentence summary of that
/// app's dictations. Tiny groups (≤3 items) are passed through unchanged.
/// If condensing any one group fails, that group keeps its original items
/// (best-effort degradation rather than aborting the whole recap).
async fn condense_dictation_groups(llm: &Llm, input: &DailySummaryInput) -> DailySummaryInput {
    let mut condensed = input.clone();
    let mut new_groups = Vec::with_capacity(condensed.dictations_by_app.len());
    for (app, items) in condensed.dictations_by_app.drain(..) {
        let total = items.len();
        if total <= 3 {
            new_groups.push((app, items));
            continue;
        }
        match summarize_dictation_group(llm, &app, &items).await {
            Ok(summary) => {
                let synthetic = ItemForSummary {
                    id: format!("condensed-{app}"),
                    content: format!("[Condensed from {total} dictations] {summary}"),
                    captured_at: items
                        .first()
                        .map(|i| i.captured_at.clone())
                        .unwrap_or_default(),
                    capture_context: Some(app.clone()),
                };
                new_groups.push((app, vec![synthetic]));
            }
            Err(e) => {
                warn!(
                    app = %app,
                    items = total,
                    error = %e,
                    "daily_summary: failed to condense dictation group, keeping original"
                );
                new_groups.push((app, items));
            }
        }
    }
    condensed.dictations_by_app = new_groups;
    condensed
}

async fn summarize_dictation_group(
    llm: &Llm,
    app: &str,
    items: &[ItemForSummary],
) -> Result<String, GenerateError> {
    let mut content = String::new();
    let mut remaining = CONDENSE_SUB_PROMPT_CHARS;
    for item in items {
        let line = format!("- {}\n", item.content.trim());
        if line.len() > remaining {
            break;
        }
        remaining -= line.len();
        content.push_str(&line);
    }
    let req = GenerateRequest {
        system: Some(
            "You are summarizing what a person was doing in one app today based on short dictations they spoke aloud. Be brief (1-3 sentences). Capture themes and notable items. Use prose, not bullets. Do not invent details that are not in the input.".into(),
        ),
        user: format!("App: {app}\nDictations:\n{content}"),
        history: Vec::new(),
        max_tokens: 200,
        temperature: 0.3,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };
    let raw = llm.generate(req).await.map_err(GenerateError::Llm)?;
    Ok(raw.trim().to_string())
}

#[derive(Debug, thiserror::Error)]
pub enum GenerateError {
    #[error("llm failure: {0}")]
    Llm(LlmError),
    #[error("parse failure: {0}")]
    Parse(ParseError),
}

/// Parse the LLM response into a typed output. Tolerates code fences,
/// leading/trailing prose, and other slop the model emits when not
/// constrained by a grammar — we extract the first balanced `{...}` object
/// from the raw text and parse that.
pub fn parse_response(raw: &str) -> Result<DailySummaryOutput, ParseError> {
    let json_slice = extract_first_json_object(raw)
        .ok_or_else(|| ParseError::Json("no balanced JSON object found in response".into()))?;
    let v: serde_json::Value =
        serde_json::from_str(json_slice).map_err(|e| ParseError::Json(e.to_string()))?;
    let out: DailySummaryOutput =
        serde_json::from_value(v).map_err(|e| ParseError::Schema(e.to_string()))?;
    if out.narrative.trim().is_empty() {
        return Err(ParseError::Schema("narrative is empty".into()));
    }
    Ok(out)
}

/// Scan `raw` for the first balanced `{...}` JSON object, respecting strings
/// and escapes so that braces inside string literals don't count toward
/// depth. Returns a slice into `raw` or `None` if no balanced object is
/// found. This is good-enough JSON extraction — it doesn't validate the
/// JSON, just finds the slice boundaries; full validation happens at the
/// `serde_json::from_str` step.
fn extract_first_json_object(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&raw[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
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
    fn prompt_truncates_long_meeting_title() {
        // The items.content column for meetings can hold transcript text
        // up to ~90 KB. The prompt must cap that or the whole budget is
        // blown by a single meeting.
        let mut input = empty_input("2026-05-12");
        let huge_title = "x".repeat(10_000);
        input.meetings.push(MeetingForSummary {
            id: "m-1".into(),
            started_at: "2026-05-12T09:00:00Z".into(),
            ended_at: None,
            suggested_title: Some(huge_title),
            summary_json: None,
        });
        let (_, user) = build_prompt(&input);
        assert!(
            user.len() < 2_000,
            "expected prompt to be short with title capped, got {} chars",
            user.len()
        );
        assert!(user.contains('…'), "expected ellipsis marker on truncated title");
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
        assert!(
            user.contains("...and 10 more dictations into VS Code"),
            "expected overflow line for 10 extras with default cap of {DICTATIONS_PER_APP_CAP}"
        );
        assert!(user.contains("[d15]"));
        assert!(!user.contains("[d16]"));
    }

    #[test]
    fn prompt_enforces_total_char_budget() {
        // 12 apps × 10 dictations × ~300-char content each ≈ 36k chars before
        // the budget kicks in. The shrink loop should drop dictations until
        // the assembled prompt fits within MAX_USER_PROMPT_CHARS.
        let mut input = empty_input("2026-05-12");
        let long_content = "x".repeat(300);
        for app_n in 0..12 {
            let items: Vec<ItemForSummary> = (0..10)
                .map(|i| ItemForSummary {
                    id: format!("uuid-{app_n}-{i}"),
                    content: long_content.clone(),
                    captured_at: "2026-05-12T10:00:00Z".into(),
                    capture_context: Some(format!("App{app_n}")),
                })
                .collect();
            input
                .dictations_by_app
                .push((format!("App{app_n}"), items));
        }
        let (_, user) = build_prompt(&input);
        assert!(
            user.len() <= MAX_USER_PROMPT_CHARS,
            "prompt should fit in budget, got {} chars (cap {})",
            user.len(),
            MAX_USER_PROMPT_CHARS
        );
    }

    #[test]
    fn parse_handles_leading_prose() {
        let raw = r#"Sure! Here's your recap:
{"narrative":"x","sections":{"notes":[{"text":"y"}]}}"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "x");
    }

    #[test]
    fn parse_handles_code_fences() {
        let raw = "```json\n{\"narrative\":\"x\",\"sections\":{}}\n```";
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "x");
    }

    #[test]
    fn parse_handles_trailing_prose() {
        let raw = r#"{"narrative":"x","sections":{}} -- generated by AI"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "x");
    }

    #[test]
    fn parse_accepts_bare_string_section_items() {
        // The model sometimes emits ["foo", "bar"] instead of
        // [{"text":"foo"},{"text":"bar"}] without GBNF enforcement.
        let raw = r#"{
            "narrative": "x",
            "sections": {
                "things_that_came_up": [
                    "Gonzalo to conduct a 30-minute discovery call.",
                    "Follow up on Q3 hiring."
                ]
            }
        }"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.sections.things_that_came_up.len(), 2);
        assert_eq!(
            out.sections.things_that_came_up[0].text,
            "Gonzalo to conduct a 30-minute discovery call."
        );
        assert_eq!(out.sections.things_that_came_up[0].source_id, None);
    }

    #[test]
    fn parse_accepts_mixed_string_and_object_section_items() {
        let raw = r#"{
            "narrative": "x",
            "sections": {
                "notes": [
                    {"text": "Structured note", "source_id": "n1"},
                    "Bare string note"
                ]
            }
        }"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.sections.notes.len(), 2);
        assert_eq!(out.sections.notes[0].source_id.as_deref(), Some("n1"));
        assert_eq!(out.sections.notes[1].text, "Bare string note");
        assert_eq!(out.sections.notes[1].source_id, None);
    }

    #[test]
    fn parse_ignores_braces_inside_strings() {
        let raw = r#"{"narrative":"my { brace } content","sections":{}}"#;
        let out = parse_response(raw).unwrap();
        assert_eq!(out.narrative, "my { brace } content");
    }

    #[test]
    fn parse_returns_error_when_no_json_object() {
        assert!(matches!(
            parse_response("just plain text, no json"),
            Err(ParseError::Json(_))
        ));
    }

    #[test]
    fn truncate_respects_unicode_boundaries() {
        // 4 code points; max=2 → 2 chars + ellipsis.
        let out = truncate("café", 2);
        assert_eq!(out.chars().count(), 3); // 2 chars + ellipsis
        assert!(out.ends_with('…'));
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
