//! LLM-driven classifier for the LogCapture pipeline.
//!
//! Given a transcript + light context (the user's existing projects + a few
//! recent items), produces a [`Classification`]:
//!  - kind: `note` | `task`
//!  - project routing (existing project id OR proposed new project name)
//!  - tag suggestions
//!  - deadline (only meaningful for tasks)
//!  - confidence
//!
//! Output is constrained to a JSON schema via a GBNF grammar passed through
//! to llama.cpp. If grammar enforcement fails (parse error, missing fields),
//! we retry once with stricter wording. After that we surface
//! [`ClassifierError::Parse`] so the coordinator can show "couldn't classify"
//! in the overlay and let the user pick fields manually.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, warn};

use crate::db::items::{Item, ItemKind};
use crate::db::projects::Project;
use crate::llm::{GenerateRequest, LlmError, LlmGenerator};

#[derive(Debug, Error)]
pub enum ClassifierError {
    #[error("llm: {0}")]
    Llm(#[from] LlmError),
    #[error("failed to parse classifier output: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Classification {
    pub kind: ItemKind,
    pub project_id: Option<String>,
    pub new_project_name: Option<String>,
    pub tags: Vec<String>,
    pub deadline_iso: Option<String>,
    pub confidence: f32,
}

/// Raw shape we ask the model to emit. Deliberately permissive so we can
/// validate post-hoc rather than letting serde reject borderline cases.
#[derive(Debug, Deserialize)]
struct RawClassification {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    project_id: Option<serde_json::Value>,
    #[serde(default)]
    new_project_name: Option<serde_json::Value>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    deadline_iso: Option<serde_json::Value>,
    #[serde(default)]
    confidence: Option<f32>,
}

/// GBNF grammar constraining output to the JSON schema. Order matters: the
/// `root` production must be reachable from the start; helpers come below.
pub const CLASSIFICATION_GBNF: &str = r#"
root ::= "{" ws "\"kind\":" ws kind ws "," ws "\"project_id\":" ws maybeStr ws "," ws "\"new_project_name\":" ws maybeStr ws "," ws "\"tags\":" ws tags ws "," ws "\"deadline_iso\":" ws maybeStr ws "," ws "\"confidence\":" ws number ws "}"
kind ::= "\"note\"" | "\"task\""
maybeStr ::= "null" | string
tags ::= "[" ws "]" | "[" ws string (ws "," ws string)* ws "]"
string ::= "\"" stringchar* "\""
stringchar ::= [^"\\] | "\\" ["\\/bfnrt]
number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)?
ws ::= [ \t\n]*
"#;

const SYSTEM_PROMPT_BASE: &str = "You are Echo Scribe's classifier. \
Given the user's spoken transcript, decide whether it is a 'note' (an idea, \
observation, or piece of context) or a 'task' (something to do). \
Output a single JSON object EXACTLY matching this schema with no additional \
keys, prose, or markdown:\n\
{\n  \"kind\": \"note\" | \"task\",\n  \"project_id\": <existing project id from the list below or null>,\n  \"new_project_name\": <a short name for a NEW project if none of the existing ones fit, else null>,\n  \"tags\": [<lowercase short topical tags>],\n  \"deadline_iso\": <ISO 8601 datetime if a task has a deadline, else null>,\n  \"confidence\": <number between 0 and 1>\n}\n\nRules:\n- Pick exactly one of project_id OR new_project_name (or both null). Never both.\n- For notes (kind == \"note\"), deadline_iso MUST be null.\n- Resolve relative deadlines (\"tomorrow\", \"next Friday\") against the current time below.\n- Tags: 0-5 short lowercase topical tags (e.g. \"meeting\", \"bug\", \"idea\").\n- Output ONLY the JSON object, no surrounding text.";

/// Classify the transcript into a [`Classification`].
pub async fn classify<L: LlmGenerator + ?Sized>(
    llm: &L,
    transcript: &str,
    existing_projects: &[Project],
    recent_items: &[Item],
    now_iso: &str,
    now_dow: &str,
    focus: Option<&crate::input::focus::FocusContext>,
) -> Result<Classification, ClassifierError> {
    let system = build_system_prompt(existing_projects, recent_items, now_iso, now_dow, focus);
    // We deliberately do NOT use grammar-constrained generation here. The
    // GBNF sampler in llama-cpp-2 0.1.146 has a path where every candidate
    // token gets rejected and the C++ side calls `ggml_abort`, killing the
    // whole process. Since we can't catch a C++ abort from Rust, the only
    // safe option is to ask the model to produce JSON in the prompt and
    // parse it ourselves — with one retry on parse failure.
    let req = GenerateRequest {
        system: Some(system),
        user: transcript.to_string(),
        history: Vec::new(),
        max_tokens: 256,
        temperature: 0.2,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };

    let raw = llm.generate(req.clone()).await?;
    debug!(raw = %raw, "classifier raw output");

    let parsed = match parse_raw(&raw) {
        Ok(p) => p,
        Err(e) => {
            warn!(?e, "classifier first-pass parse failed; retrying with stricter prompt");
            // Re-prompt with the parser's complaint appended. Same model,
            // same temperature — usually the model recovers and produces
            // valid JSON on the second attempt.
            let mut req2 = req;
            req2.user = format!(
                "{transcript}\n\n(Your previous response failed to parse: {e}. \
                 Respond ONLY with a single JSON object matching the schema. \
                 No prose, no code fences.)"
            );
            let raw2 = llm.generate(req2).await?;
            parse_raw(&raw2).map_err(|e2| {
                ClassifierError::Parse(format!("primary: {e}; retry: {e2}"))
            })?
        }
    };

    Ok(validate(parsed, existing_projects))
}

fn parse_raw(raw: &str) -> Result<RawClassification, String> {
    // The model occasionally emits a leading code-fence or trailing whitespace.
    // Find the first '{' and the last '}' to be tolerant.
    let start = raw.find('{').ok_or_else(|| "no '{' in output".to_string())?;
    let end = raw.rfind('}').ok_or_else(|| "no '}' in output".to_string())?;
    if end <= start {
        return Err(format!("malformed braces: start={start} end={end}"));
    }
    let slice = &raw[start..=end];
    serde_json::from_str::<RawClassification>(slice).map_err(|e| e.to_string())
}

fn validate(raw: RawClassification, existing_projects: &[Project]) -> Classification {
    let kind = raw
        .kind
        .as_deref()
        .and_then(ItemKind::parse)
        .unwrap_or(ItemKind::Note);

    let project_id = raw.project_id.and_then(value_to_opt_string);
    let project_id = match project_id {
        Some(id) if existing_projects.iter().any(|p| p.id == id) => Some(id),
        _ => None,
    };

    let mut new_project_name = raw.new_project_name.and_then(value_to_opt_string);
    if let Some(n) = &new_project_name {
        if n.trim().is_empty() {
            new_project_name = None;
        }
    }
    // project_id wins over new_project_name (mutual exclusion).
    if project_id.is_some() {
        new_project_name = None;
    }

    let tags = raw
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let mut deadline_iso = raw.deadline_iso.and_then(value_to_opt_string);
    if matches!(kind, ItemKind::Note) {
        deadline_iso = None;
    }
    if let Some(d) = &deadline_iso {
        if d.trim().is_empty() {
            deadline_iso = None;
        }
    }

    let confidence = raw.confidence.unwrap_or(0.0).clamp(0.0, 1.0);

    Classification {
        kind,
        project_id,
        new_project_name,
        tags,
        deadline_iso,
        confidence,
    }
}

fn value_to_opt_string(v: serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s),
        // Defensive: the grammar forbids non-string/non-null here, but if a
        // future fallback path delivers e.g. a number we coerce it.
        other => Some(other.to_string()),
    }
}

fn build_system_prompt(
    existing_projects: &[Project],
    recent_items: &[Item],
    now_iso: &str,
    now_dow: &str,
    focus: Option<&crate::input::focus::FocusContext>,
) -> String {
    let mut s = String::with_capacity(1024);
    s.push_str(SYSTEM_PROMPT_BASE);
    s.push_str("\n\nCurrent local time: ");
    s.push_str(now_iso);
    s.push_str(" (");
    s.push_str(now_dow);
    s.push_str(").\n\nExisting projects:\n");
    if existing_projects.is_empty() {
        s.push_str("(none yet)\n");
    } else {
        for p in existing_projects.iter().take(20) {
            s.push_str("- id=");
            s.push_str(&p.id);
            s.push_str(" name=\"");
            s.push_str(&p.name);
            s.push_str("\"\n");
        }
    }
    s.push_str("\nRecent captures (most recent first):\n");
    if recent_items.is_empty() {
        s.push_str("(none)\n");
    } else {
        for it in recent_items.iter().take(5) {
            let preview: String = it.content.chars().take(140).collect();
            s.push_str("- ");
            s.push_str(&preview);
            s.push('\n');
        }
    }
    if let Some(ctx) = focus {
        s.push_str("\nCapture context (where the user was when they started dictating):\n");
        if let Some(ref name) = ctx.app_name {
            s.push_str("- App: ");
            s.push_str(name);
            s.push('\n');
        }
        if let Some(ref title) = ctx.window_title {
            s.push_str("- Window: ");
            s.push_str(title);
            s.push('\n');
        }
        if let Some(ref url) = ctx.browser_url {
            s.push_str("- URL: ");
            s.push_str(url);
            s.push('\n');
        }
    }
    s
}

/// Day-of-week abbreviation for an ISO-8601 date string `YYYY-MM-DD...`.
/// Useful for the classifier prompt so it can resolve "next Friday" etc.
/// Returns "?" if parsing fails.
pub fn dow_from_iso(iso: &str) -> &'static str {
    if iso.len() < 10 {
        return "?";
    }
    let bytes = iso.as_bytes();
    let parse2 = |i: usize| -> Option<i64> {
        std::str::from_utf8(&bytes[i..i + 2])
            .ok()
            .and_then(|s| s.parse().ok())
    };
    let parse4 = |i: usize| -> Option<i64> {
        std::str::from_utf8(&bytes[i..i + 4])
            .ok()
            .and_then(|s| s.parse().ok())
    };
    let (y, m, d) = match (parse4(0), parse2(5), parse2(8)) {
        (Some(y), Some(m), Some(d)) => (y, m, d),
        _ => return "?",
    };
    // Zeller's congruence (Gregorian).
    let (y, m) = if m < 3 { (y - 1, m + 12) } else { (y, m) };
    let k = y % 100;
    let j = y / 100;
    let h = (d + (13 * (m + 1)) / 5 + k + k / 4 + j / 4 + 5 * j).rem_euclid(7);
    // h: 0=Saturday, 1=Sunday, 2=Monday, …
    match h {
        0 => "Saturday",
        1 => "Sunday",
        2 => "Monday",
        3 => "Tuesday",
        4 => "Wednesday",
        5 => "Thursday",
        6 => "Friday",
        _ => "?",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::{Item, ItemSource, Visibility};

    struct StubLlm {
        response: std::sync::Mutex<Vec<String>>,
    }

    impl StubLlm {
        fn new(responses: Vec<&str>) -> Self {
            Self {
                response: std::sync::Mutex::new(
                    responses.into_iter().map(|s| s.to_string()).collect(),
                ),
            }
        }
    }

    impl LlmGenerator for StubLlm {
        fn generate<'a>(&'a self, _req: GenerateRequest) -> crate::llm::GenerateFuture<'a> {
            let mut g = self.response.lock().unwrap();
            let out = if g.is_empty() {
                String::new()
            } else {
                g.remove(0)
            };
            Box::pin(async move { Ok(out) })
        }
    }

    fn proj(id: &str, name: &str) -> Project {
        Project {
            id: id.to_string(),
            name: name.to_string(),
            created_at: "2026-05-01T00:00:00Z".into(),
            archived_at: None,
        }
    }

    fn item(content: &str) -> Item {
        Item {
            id: "x".into(),
            content: content.into(),
            source: ItemSource::LogCapture,
            visibility: Visibility::Visible,
            kind: None,
            project_id: None,
            captured_at: "2026-05-01T00:00:00Z".into(),
            created_at: "2026-05-01T00:00:00Z".into(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context: None,
        }
    }

    #[tokio::test]
    async fn classify_validates_project_id_against_existing() {
        let stub = StubLlm::new(vec![
            r#"{"kind":"task","project_id":"bogus","new_project_name":null,"tags":[],"deadline_iso":null,"confidence":0.8}"#,
        ]);
        let projects = vec![proj("p1", "Echo")];
        let c = classify(&stub, "do the thing", &projects, &[], "2026-05-01T10:00:00Z", "Friday", None)
            .await
            .unwrap();
        assert_eq!(c.project_id, None);
        assert_eq!(c.new_project_name, None);
    }

    #[tokio::test]
    async fn classify_drops_empty_new_project_name() {
        let stub = StubLlm::new(vec![
            r#"{"kind":"task","project_id":null,"new_project_name":"   ","tags":[],"deadline_iso":null,"confidence":0.5}"#,
        ]);
        let c = classify(&stub, "x", &[], &[], "2026-05-01T10:00:00Z", "Friday", None).await.unwrap();
        assert_eq!(c.new_project_name, None);
    }

    #[tokio::test]
    async fn classify_dedups_lowercase_tags() {
        let stub = StubLlm::new(vec![
            r#"{"kind":"note","project_id":null,"new_project_name":null,"tags":["Bug","bug","  IDEA  ","idea"],"deadline_iso":null,"confidence":0.9}"#,
        ]);
        let c = classify(&stub, "x", &[], &[], "2026-05-01T10:00:00Z", "Friday", None).await.unwrap();
        assert_eq!(c.tags, vec!["bug".to_string(), "idea".to_string()]);
    }

    #[tokio::test]
    async fn classify_clamps_confidence() {
        let stub = StubLlm::new(vec![
            r#"{"kind":"note","project_id":null,"new_project_name":null,"tags":[],"deadline_iso":null,"confidence":2.5}"#,
        ]);
        let c = classify(&stub, "x", &[], &[], "2026-05-01T10:00:00Z", "Friday", None).await.unwrap();
        assert!((c.confidence - 1.0).abs() < f32::EPSILON);

        let stub2 = StubLlm::new(vec![
            r#"{"kind":"note","project_id":null,"new_project_name":null,"tags":[],"deadline_iso":null,"confidence":-0.3}"#,
        ]);
        let c2 = classify(&stub2, "x", &[], &[], "2026-05-01T10:00:00Z", "Friday", None).await.unwrap();
        assert!(c2.confidence >= 0.0 && c2.confidence < f32::EPSILON);
    }

    #[tokio::test]
    async fn classify_drops_deadline_for_notes() {
        let stub = StubLlm::new(vec![
            r#"{"kind":"note","project_id":null,"new_project_name":null,"tags":[],"deadline_iso":"2026-05-10T00:00:00Z","confidence":0.5}"#,
        ]);
        let c = classify(&stub, "x", &[], &[], "2026-05-01T10:00:00Z", "Friday", None).await.unwrap();
        assert_eq!(c.deadline_iso, None);
    }

    #[tokio::test]
    async fn classify_passes_project_recent_items_into_prompt() {
        // Smoke: the function shouldn't blow up with non-empty context.
        let stub = StubLlm::new(vec![
            r#"{"kind":"task","project_id":"p1","new_project_name":null,"tags":["x"],"deadline_iso":"2026-05-02T10:00:00Z","confidence":0.7}"#,
        ]);
        let c = classify(
            &stub,
            "fix the bug",
            &[proj("p1", "Echo")],
            &[item("earlier note")],
            "2026-05-01T10:00:00Z",
            "Friday",
            None,
        )
        .await
        .unwrap();
        assert_eq!(c.project_id.as_deref(), Some("p1"));
        assert_eq!(c.deadline_iso.as_deref(), Some("2026-05-02T10:00:00Z"));
    }

    #[test]
    fn dow_from_iso_is_correct() {
        assert_eq!(dow_from_iso("2026-05-01T00:00:00Z"), "Friday");
        assert_eq!(dow_from_iso("2024-02-29T12:00:00Z"), "Thursday");
        assert_eq!(dow_from_iso("bad"), "?");
    }

    #[test]
    fn build_system_prompt_includes_focus_context() {
        use crate::input::focus::FocusContext;
        let ctx = FocusContext {
            pid: 1234,
            bundle_id: Some("com.google.Chrome".into()),
            app_name: Some("Google Chrome".into()),
            window_title: Some("Inbox — Gmail".into()),
            browser_url: Some("https://mail.google.com/".into()),
        };
        let prompt = build_system_prompt(&[], &[], "2026-05-03T10:00:00Z", "Sunday", Some(&ctx));
        assert!(prompt.contains("Google Chrome"), "app_name missing from prompt");
        assert!(prompt.contains("Inbox — Gmail"), "window_title missing from prompt");
        assert!(prompt.contains("https://mail.google.com/"), "browser_url missing from prompt");
    }

    #[test]
    fn build_system_prompt_handles_no_context() {
        let prompt = build_system_prompt(&[], &[], "2026-05-03T10:00:00Z", "Sunday", None);
        assert!(!prompt.is_empty());
    }
}
