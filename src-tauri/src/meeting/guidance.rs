//! Per-meeting live guidance engine. When a guided session has an attached
//! template, this engine runs one Gemma call per chunk-drained segment,
//! parses a small JSON response, and emits a `guide-update` event to the
//! guide overlay webview.
//!
//! Skip-if-busy: a single guidance call can be in flight at any time. If a
//! new segment arrives while one is running, that chunk is skipped (the
//! HUD's staleness label tells the user). Voice-at-cursor and end-of-call
//! synthesis are *not* preempted — they FIFO-serialize at the LLM engine's
//! own lock; the guard here only prevents the guidance loop piling jobs
//! onto itself, which would otherwise sustain Gemma resident under load.

use crate::db::guide_templates::GuideTemplate;
use crate::llm::engine::GenerateRequest;
use crate::llm::Llm;
use crate::meeting::Segment;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracing::{debug, info, warn};

/// Mode the engine runs in. Controlled by the HUD's Auto/On-demand toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Auto,
    OnDemand,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "on_demand" | "ondemand" => Some(Self::OnDemand),
            _ => None,
        }
    }
}

/// One LLM-derived key point. `id` is a short stable token used to update
/// status across cycles without flicker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DerivedPoint {
    pub id: String,
    pub label: String,
    /// "covered" | "partial" | "open" — kept loose so the LLM can emit any
    /// of those without a strict enum trip.
    pub status: String,
}

/// One LLM response, mirrored exactly to the JSON schema we ask for.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GuidanceResponse {
    #[serde(default)]
    pub key_points: Vec<DerivedPoint>,
    #[serde(default)]
    pub suggestions: Vec<String>,
}

/// Token budget for the rolling transcript window passed to the LLM. Chosen
/// well below the synthesizer's 18 KB so the guidance prompt stays compact
/// and each cycle stays fast.
const ROLLING_BYTES: usize = 4_000;

/// `max_tokens` for one guidance cycle — small JSON only.
const GUIDANCE_MAX_TOKENS: usize = 384;

/// The engine owned by an active `ActiveMeeting`. Cheap to clone; internal
/// state is shared via `Arc<Mutex<...>>`.
#[derive(Clone)]
pub struct GuidanceEngine {
    inner: Arc<Inner>,
}

struct Inner {
    meeting_id: String,
    template: GuideTemplate,
    llm: Arc<Llm>,
    app: AppHandle<Wry>,
    mode: Mutex<Mode>,
    /// `true` while a guidance LLM call is running. Forms the skip-if-busy
    /// gate so the loop can't enqueue over itself.
    in_flight: AtomicBool,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Rolling transcript window (most recent text, byte-bounded). Older text
    /// is dropped from the *prompt*; the meeting record still keeps the full
    /// transcript.
    rolling: String,
    /// Last successfully-parsed key points, fed back so the LLM keeps ids
    /// stable across cycles.
    prior_points: Vec<DerivedPoint>,
    /// Last emitted suggestions (used for stale-but-display semantics).
    last_suggestions: Vec<String>,
}

impl GuidanceEngine {
    pub fn new(
        meeting_id: String,
        template: GuideTemplate,
        llm: Arc<Llm>,
        app: AppHandle<Wry>,
        initial_mode: Mode,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                meeting_id,
                template,
                llm,
                app,
                mode: Mutex::new(initial_mode),
                in_flight: AtomicBool::new(false),
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn meeting_id(&self) -> &str {
        &self.inner.meeting_id
    }

    /// Clone of the attached guide template — used by the meeting lifecycle
    /// to populate the HUD's initial shell before the first LLM cycle.
    pub fn template_snapshot(&self) -> GuideTemplate {
        self.inner.template.clone()
    }

    pub fn mode(&self) -> Mode {
        *self.inner.mode.lock().unwrap()
    }

    pub fn set_mode(&self, m: Mode) {
        *self.inner.mode.lock().unwrap() = m;
    }

    /// Add a freshly-stitched segment to the rolling window. Returns whether
    /// the engine should run a cycle right now under the current mode.
    pub fn ingest_segment(&self, seg: &Segment) -> bool {
        {
            let mut st = self.inner.state.lock().unwrap();
            // Append a speaker tag so the LLM can attribute lines.
            let tag = match seg.speaker {
                crate::meeting::Speaker::You => "you",
                crate::meeting::Speaker::Them => "them",
            };
            st.rolling.push_str(tag);
            st.rolling.push_str(": ");
            st.rolling.push_str(seg.text.trim());
            st.rolling.push('\n');
            // Trim from the front so we keep the most recent ROLLING_BYTES.
            while st.rolling.len() > ROLLING_BYTES {
                match st.rolling.find('\n') {
                    Some(i) => st.rolling.drain(..=i).for_each(drop),
                    None => {
                        // No newline yet — hard drop from front.
                        let drop_n = st.rolling.len() - ROLLING_BYTES;
                        st.rolling.drain(..drop_n).for_each(drop);
                        break;
                    }
                }
            }
        }
        matches!(self.mode(), Mode::Auto)
    }

    /// Snapshot of the rolling window (test + UI inspection).
    pub fn rolling_snapshot(&self) -> String {
        self.inner.state.lock().unwrap().rolling.clone()
    }

    /// Run one cycle. Returns immediately if a cycle is already in flight
    /// (skip-if-busy). Spawns a background task — fire and forget.
    pub fn fire_cycle(&self) {
        // CAS the in-flight gate.
        if self
            .inner
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            debug!(meeting = %self.inner.meeting_id, "[guide] skip — cycle already in flight");
            return;
        }
        let inner = self.inner.clone();
        tokio::spawn(async move {
            // Always clear the gate, even on panic.
            struct Guard<'a>(&'a AtomicBool);
            impl<'a> Drop for Guard<'a> {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _g = Guard(&inner.in_flight);
            if let Err(e) = run_one_cycle(&inner).await {
                warn!(meeting = %inner.meeting_id, error = %e, "[guide] cycle failed");
            }
        });
    }
}

async fn run_one_cycle(inner: &Inner) -> Result<(), String> {
    let (rolling, prior_json) = {
        let st = inner.state.lock().unwrap();
        let prior = serde_json::to_string(&st.prior_points).unwrap_or_else(|_| "[]".into());
        (st.rolling.clone(), prior)
    };
    if rolling.trim().is_empty() {
        debug!(meeting = %inner.meeting_id, "[guide] empty rolling; skipping cycle");
        return Ok(());
    }

    let (system, user) = crate::llm::prompt::build_guidance_prompt(
        &inner.template.goal,
        &inner.template.notes,
        &rolling,
        Some(&prior_json),
    );

    // 2-attempt JSON-parse loop matching the synthesizer's robustness pattern.
    let mut last_raw = String::new();
    for attempt in 0..2u8 {
        let temperature = if attempt == 0 { 0.3 } else { 0.1 };
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: GUIDANCE_MAX_TOKENS,
            temperature,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(4096),
        };
        let raw = match inner.llm.generate(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(?e, attempt, "[guide] generate failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {e}"));
                }
                continue;
            }
        };
        last_raw = raw.clone();
        // Some models prefix prose or fence the JSON; isolate the first {...} object.
        let trimmed = isolate_json_object(&raw).unwrap_or_else(|| raw.clone());
        match serde_json::from_str::<GuidanceResponse>(&trimmed) {
            Ok(resp) => {
                emit_update(inner, &resp);
                let mut st = inner.state.lock().unwrap();
                st.prior_points = resp.key_points.clone();
                st.last_suggestions = resp.suggestions.clone();
                info!(
                    meeting = %inner.meeting_id,
                    points = resp.key_points.len(),
                    suggestions = resp.suggestions.len(),
                    "[guide] cycle ok"
                );
                return Ok(());
            }
            Err(e) => {
                warn!(?e, attempt, "[guide] JSON parse failed");
            }
        }
    }
    Err(format!("guidance JSON parse failed after 2 attempts: {last_raw}"))
}

/// Crude {...} isolator that handles a leading prose preamble or a markdown
/// code fence by returning the substring from the first `{` to the matching
/// closing `}` (counting nesting). Returns `None` if no balanced object.
fn isolate_json_object(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn emit_update(inner: &Inner, resp: &GuidanceResponse) {
    let payload = serde_json::json!({
        "meetingId": inner.meeting_id,
        "templateName": inner.template.name,
        "goal": inner.template.goal,
        "mode": match *inner.mode.lock().unwrap() {
            Mode::Auto => "auto",
            Mode::OnDemand => "on_demand",
        },
        "keyPoints": resp.key_points,
        "suggestions": resp.suggestions,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });
    if let Some(w) = inner.app.get_webview_window("guide_overlay") {
        let _ = w.emit("guide-update", payload);
    } else {
        // Fall back to app-wide emit so a missing window doesn't silently
        // black-hole every update during dev.
        let _ = inner.app.emit("guide-update", payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_template() -> GuideTemplate {
        GuideTemplate {
            id: "t1".into(),
            name: "Discovery".into(),
            description: "".into(),
            goal: "Surface their pains and tools.".into(),
            notes: "ask about current tools\nask about bottlenecks".into(),
            created_at: "2026-05-19T00:00:00Z".into(),
            updated_at: "2026-05-19T00:00:00Z".into(),
        }
    }

    #[test]
    fn mode_parse_round_trip() {
        assert_eq!(Mode::parse("auto"), Some(Mode::Auto));
        assert_eq!(Mode::parse("on_demand"), Some(Mode::OnDemand));
        assert_eq!(Mode::parse("ondemand"), Some(Mode::OnDemand));
        assert_eq!(Mode::parse("bogus"), None);
    }

    #[test]
    fn isolate_json_object_handles_prose_preamble() {
        let s = "Sure, here is the JSON:\n```json\n{\"key_points\":[],\"suggestions\":[\"ask budget\"]}\n```";
        let out = isolate_json_object(s).unwrap();
        assert_eq!(out, "{\"key_points\":[],\"suggestions\":[\"ask budget\"]}");
    }

    #[test]
    fn isolate_json_object_respects_string_braces() {
        let s = "before {\"label\":\"if {x}\",\"status\":\"open\"} after";
        let out = isolate_json_object(s).unwrap();
        assert_eq!(out, "{\"label\":\"if {x}\",\"status\":\"open\"}");
    }

    #[test]
    fn isolate_json_object_returns_none_on_unbalanced() {
        assert!(isolate_json_object("nope").is_none());
        assert!(isolate_json_object("{ unbalanced").is_none());
    }

    #[test]
    fn parsing_guidance_response_is_tolerant_of_missing_fields() {
        // Only key_points present.
        let r: GuidanceResponse =
            serde_json::from_str(r#"{"key_points":[{"id":"a","label":"A","status":"open"}]}"#).unwrap();
        assert_eq!(r.key_points.len(), 1);
        assert!(r.suggestions.is_empty());
        // Only suggestions present.
        let r: GuidanceResponse =
            serde_json::from_str(r#"{"suggestions":["x"]}"#).unwrap();
        assert_eq!(r.suggestions, vec!["x".to_string()]);
        assert!(r.key_points.is_empty());
    }
}
