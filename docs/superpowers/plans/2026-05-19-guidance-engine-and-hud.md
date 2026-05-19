# Live Guidance Engine + HUD Overlay — Implementation Plan (Plan B2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a guided meeting session, run a per-chunk LLM loop that produces a small set of derived "key points" (covered/partial/open) + 1–3 next-best suggestions from the active template's goal + notes + a rolling transcript window, and display them in an always-on-top transparent HUD overlay window with Auto/On-demand mode toggle.

**Architecture:** A new `meeting/guidance.rs` module owns a per-meeting `GuidanceEngine`. The existing `meeting::pipeline::Pipeline` gains an optional `on_segment` callback; when a guided session starts, `MeetingManager` installs an observer that forwards each post-stitch `Segment` into the engine. The engine runs one Gemma call per fire (gated by an `AtomicBool` skip-if-busy guard so it never enqueues over itself), parses a small JSON response, and emits a `guide-update` event targeted to a new `guide_overlay` Tauri webview window. The overlay window is built from the existing `recording_overlay` scaffold (transparent, always-on-top, decorations off, drag region in the header). Mode + frame persist in the settings store. Auto = per chunk; On-demand = manual trigger button.

**Tech Stack:** Rust (tokio, serde, tracing), Tauri 2 (`WebviewWindowBuilder`, multi-entry Vite), Gemma 4 via the existing `Llm::generate` API, React/TypeScript, Tailwind.

**Memory constraint (from Phase 0 finding, `docs/superpowers/plans/2026-05-16-unified-pipeline-refactor.md`):** the Gemma LLM is held resident for the entire guided session (the engine invokes it repeatedly), spiking ~700 MiB+ per synthesis-class call. This is the input to the skip-if-busy / cadence design here.

**Out of scope (deferred to a small Plan B3 follow-up):** persisting the final derived-points + suggestion timeline into the meeting record at stop. B2 ships the live behavior end-to-end; persistence of guide artifacts is a clean follow-up that does not block visible value.

---

## File Structure

- `src-tauri/src/meeting/pipeline.rs` — MODIFY: add `on_segment` observer field + `with_observer` builder + fire site in `spawn_drain` success branch.
- `src-tauri/src/meeting/guidance.rs` — CREATE: `GuidanceEngine`, `DerivedPoint`, `GuidanceUpdate`, prompt + JSON glue, skip-if-busy.
- `src-tauri/src/meeting/mod.rs` — MODIFY: extend `MeetingStartContext` with `guide_template`; thread into `ActiveMeeting`; build + wire engine when present; hide overlay on stop; declare `pub mod guidance;`.
- `src-tauri/src/llm/prompt.rs` — MODIFY: add `build_guidance_prompt`.
- `src-tauri/src/commands.rs` — MODIFY: rewire `start_guided_session` to pass template through `MeetingStartContext`; add `guide_set_mode`, `guide_trigger_now`, `guide_end`.
- `src-tauri/src/lib.rs` — MODIFY: register 3 new commands; call `create_guide_overlay` on startup.
- `src-tauri/src/overlay.rs` — MODIFY: add `create_guide_overlay`, `show_guide_overlay`, `hide_guide_overlay`.
- `src-tauri/src/settings.rs` — MODIFY: `GuideOverlayMode` enum + 2 keys (mode, frame) + getters/setters.
- `vite.config.ts` — MODIFY: add `guide` Vite entry.
- `src/guide-overlay/index.html` — CREATE.
- `src/guide-overlay/main.tsx` — CREATE.
- `src/guide-overlay/GuideOverlay.tsx` — CREATE: HUD component (goal, key points with status, suggestions, staleness, mode menu, End).
- `src/guide-overlay/GuideOverlay.css` — CREATE: HUD styles (matches the spec mockup; uses the project's Tailwind tokens where applicable, else plain CSS for the standalone bundle).
- `src/lib/api.ts` — MODIFY: 3 bindings + `GuideUpdate` type.

---

## Phase 1 — Pipeline observer hook

### Task 1: `on_segment` callback in Pipeline

**Files:**
- Modify: `src-tauri/src/meeting/pipeline.rs`

The Plan A `spawn_drain` is a single sequential `while let Some(chunk) = rx.recv().await { ... }` loop. The success branch (after the stitch) does `b.set_last_text(...); b.push(Segment {...})`. Fire the observer immediately after the push, outside the lock.

- [ ] **Step 1: Add the observer type + struct field**

In `src-tauri/src/meeting/pipeline.rs`, add near the top (after the existing `use` block / constants):

```rust
/// Fires once per post-stitch segment that survives the empty-trim. Used by
/// the live guidance engine; never called during plain (non-guided) meetings.
pub type SegmentObserver = std::sync::Arc<dyn Fn(Segment) + Send + Sync>;
```

Add a new field to the `Pipeline` struct (after `tails`):

```rust
    on_segment: Option<SegmentObserver>,
```

In `Pipeline::new`, initialize it to `None`:

```rust
            on_segment: None,
```

Add a builder-style method on `impl Pipeline`:

```rust
    /// Attach a per-segment observer. Must be called BEFORE `spawn_drain`.
    pub fn with_observer(mut self, cb: SegmentObserver) -> Self {
        self.on_segment = Some(cb);
        self
    }
```

- [ ] **Step 2: Fire the observer in `spawn_drain`**

In `spawn_drain`, alongside the existing `let asr = self.asr.clone(); let builder = self.builder.clone(); let failed_dir = self.failed_dir.clone(); let tails = self.tails.clone();` block, add:

```rust
        let on_segment = self.on_segment.clone();
```

In the success branch (the `Ok(raw_text) =>` arm), inside the `if !stitched.trim().is_empty() { ... }` block, AFTER `b.push(Segment { ... })` and BEFORE the closing `}` of that `if`, capture the segment for the observer:

```rust
            if !stitched.trim().is_empty() {
                let mut b = builder.lock().await;
                b.set_last_text(chunk.speaker, &stitched);
                let seg = Segment {
                    speaker: chunk.speaker,
                    start_ms: chunk.start_ms,
                    end_ms: chunk.end_ms,
                    text: stitched,
                };
                b.push(seg.clone());
                drop(b);
                if let Some(cb) = &on_segment {
                    cb(seg);
                }
            }
```

(The change is: bind the segment to `seg`, push a clone, drop the lock, then call the observer with the owned value. This keeps the existing push semantics and avoids holding the mutex guard across the observer call.)

- [ ] **Step 3: Add a unit test**

In the existing `#[cfg(test)] mod tests` in `pipeline.rs`, add:

```rust
    #[test]
    fn with_observer_attaches_callback() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let asr = Arc::new(crate::asr::pipeline::AsrPipeline::default());
        let count = Arc::new(AtomicUsize::new(0));
        let count_for_cb = count.clone();
        let cb: SegmentObserver = Arc::new(move |_seg| {
            count_for_cb.fetch_add(1, Ordering::Relaxed);
        });
        let p = Pipeline::new(asr, std::path::PathBuf::from("/tmp/fail"))
            .with_observer(cb);
        // Calling the observer directly proves it's wired without needing a
        // full async harness; the spawn_drain integration is exercised by
        // real-app verification in Task 12.
        if let Some(cb) = &p.on_segment {
            cb(Segment {
                speaker: Speaker::You,
                start_ms: 0,
                end_ms: 1000,
                text: "hello".into(),
            });
        }
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }
```

- [ ] **Step 4: Build + test**

Run: `cd src-tauri && cargo test --lib meeting::pipeline::`
Expected: all existing pipeline tests + `with_observer_attaches_callback` PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/meeting/pipeline.rs
git commit -m "feat(meeting): per-segment observer hook on Pipeline (B2 plumbing)"
```

---

## Phase 2 — Guidance engine

### Task 2: Guidance prompt builder

**Files:**
- Modify: `src-tauri/src/llm/prompt.rs`

- [ ] **Step 1: Add the builder + tests**

In `src-tauri/src/llm/prompt.rs`, append (after `build_meeting_synthesis_prompt`):

```rust
/// One key point the LLM is asked to track during a guided session.
/// Mirrored in `meeting/guidance.rs` — fields stay aligned with the JSON
/// schema the LLM is asked to emit so deserialization is cheap.
pub const GUIDANCE_JSON_HINT: &str = r#"{
  "key_points": [
    { "id": "<short stable id, lowercase_with_underscores>",
      "label": "<short label shown to the user>",
      "status": "covered" | "partial" | "open" }
  ],
  "suggestions": ["<one short next-best thing to ask or do>"]
}"#;

/// Build the system+user prompt for one live guidance cycle.
///
/// The LLM is given the conversation goal + freeform notes, a bounded recent
/// transcript window, and the prior derived points (for stable IDs and status
/// progression). It must emit a small JSON document. `max_tokens` is sized
/// for this in the engine; the prompt asks for terse output.
pub fn build_guidance_prompt(
    goal: &str,
    notes: &str,
    rolling_transcript: &str,
    prior_points_json: Option<&str>,
) -> (Option<String>, String) {
    let system = format!(
        "You are a real-time meeting facilitator. Track whether the conversation \
         has covered each key point implied by the user's goal and notes. Return \
         ONLY a single JSON object matching this exact schema (no prose, no \
         markdown, no code fences):\n{GUIDANCE_JSON_HINT}\n\n\
         Rules:\n\
         - Reuse the SAME id for a point that already appeared in 'previous \
         points'. Do not invent new ids for the same concept.\n\
         - status: 'covered' if clearly addressed, 'partial' if touched but \
         incomplete, 'open' otherwise.\n\
         - 3-6 key_points total. 1-3 suggestions, each ≤ 12 words, actionable, \
         specific to the most recent transcript, not generic.\n\
         - Output JSON only.",
    );
    let prior = prior_points_json.unwrap_or("[]");
    let user = format!(
        "Goal: {goal}\n\nNotes:\n{notes}\n\nPrevious points (carry ids forward):\n{prior}\n\nRecent transcript:\n{rolling_transcript}\n\nReturn the JSON now."
    );
    (Some(system), user)
}

#[cfg(test)]
mod guidance_prompt_tests {
    use super::*;

    #[test]
    fn embeds_goal_notes_transcript_and_prior() {
        let (sys, user) = build_guidance_prompt(
            "Customer discovery",
            "ask about tools\nask about budget",
            "they said spreadsheets break daily",
            Some(r#"[{"id":"current_tools","label":"Current tools","status":"covered"}]"#),
        );
        assert!(sys.is_some());
        assert!(user.contains("Goal: Customer discovery"));
        assert!(user.contains("ask about tools"));
        assert!(user.contains("spreadsheets break daily"));
        assert!(user.contains("current_tools"));
        assert!(user.contains("Return the JSON now."));
    }

    #[test]
    fn empty_prior_defaults_to_empty_array() {
        let (_sys, user) = build_guidance_prompt("g", "n", "t", None);
        assert!(user.contains("Previous points (carry ids forward):\n[]"));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib llm::prompt::guidance_prompt_tests`
Expected: 2 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/llm/prompt.rs
git commit -m "feat(llm): build_guidance_prompt for live guide cycles"
```

### Task 3: `meeting/guidance.rs` engine

**Files:**
- Create: `src-tauri/src/meeting/guidance.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (declare module + Segment must be public enough — it already is)

- [ ] **Step 1: Register the module**

In `src-tauri/src/meeting/mod.rs`, in the module-declaration block near the top, add (alphabetical position is fine):

```rust
pub mod guidance;
```

- [ ] **Step 2: Create the engine file**

Create `src-tauri/src/meeting/guidance.rs` with EXACTLY:

```rust
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
    pub fn fire_cycle(self: &Self) {
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
```

> Note: the unit tests above DO NOT spawn the engine or call the LLM. They exercise the pure pieces (mode parsing, JSON isolation, deserialization tolerance). Live behavior is verified in Task 12 (real-app run).

- [ ] **Step 3: Build + tests**

Run: `cd src-tauri && cargo test --lib meeting::guidance::`
Expected: 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/guidance.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(meeting): GuidanceEngine — per-chunk LLM cycle + skip-if-busy"
```

---

## Phase 3 — Wire engine into the meeting lifecycle

### Task 4: Thread `guide_template` through `MeetingStartContext` + `ActiveMeeting`; build engine on guided start

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs`
- Modify: `src-tauri/src/commands.rs` (only the `start_guided_session` caller — pass template via context)

- [ ] **Step 1: Extend `MeetingStartContext`**

In `src-tauri/src/meeting/mod.rs`, add a field to `MeetingStartContext` (lines 156–162):

```rust
#[derive(Debug, Clone, Default)]
pub struct MeetingStartContext {
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    pub browser_tab_title: Option<String>,
    pub calendar_match: Option<crate::calendar::CalendarMatch>,
    /// The guide template to attach to this session (None for a normal
    /// auto-detected/manual meeting). When `Some`, `start()` persists the
    /// snapshot atomically and constructs a `GuidanceEngine`.
    pub guide_template: Option<crate::db::guide_templates::GuideTemplate>,
}
```

- [ ] **Step 2: Add engine + template to `ActiveMeeting`**

Add two fields to `ActiveMeeting`:

```rust
    guide_template: Option<crate::db::guide_templates::GuideTemplate>,
    guide_engine: Option<crate::meeting::guidance::GuidanceEngine>,
```

- [ ] **Step 3: Persist snapshot inside `start()` + build the engine + install observer**

In `MeetingManager::start`, replace the `let pipeline = Pipeline::new(self.asr.clone(), dir.join("failed"));` / `let chunk_drain_handle = pipeline.spawn_drain(chunk_rx);` block with:

```rust
        // Build the pipeline. If a guide template is attached, also build
        // the guidance engine and install its segment observer BEFORE the
        // drain task spawns (the observer is captured at spawn time).
        let mut pipeline = Pipeline::new(self.asr.clone(), dir.join("failed"));
        let guide_template = start_context.guide_template.clone();
        let guide_engine = if let Some(template) = guide_template.clone() {
            // Persist the immutable snapshot in the same scope as insert_meeting
            // would have — done as a separate update to keep the prior insert
            // path byte-unchanged for non-guided meetings.
            let id_for_snap = id.clone();
            if let Ok(snap) = serde_json::to_string(&template) {
                if let Err(e) = self.db.with_conn(move |c| {
                    crate::db::meetings::update_guide_template(c, &id_for_snap, Some(snap.as_str()))
                }) {
                    tracing::warn!(?e, "persisting guide template snapshot failed");
                }
            }
            // Initial mode comes from persisted setting (Auto by default).
            let initial_mode = match crate::settings::SettingsStore::load(&self.app_handle)
                .ok()
                .and_then(|s| s.guide_overlay_mode())
            {
                Some(crate::meeting::guidance::Mode::OnDemand) => {
                    crate::meeting::guidance::Mode::OnDemand
                }
                _ => crate::meeting::guidance::Mode::Auto,
            };
            let engine = crate::meeting::guidance::GuidanceEngine::new(
                id.clone(),
                template,
                self.llm.clone(),
                self.app_handle.clone(),
                initial_mode,
            );
            // Wire the per-segment observer: forward into the engine, then
            // fire a cycle if Auto mode says so.
            let engine_obs = engine.clone();
            let cb: crate::meeting::pipeline::SegmentObserver =
                std::sync::Arc::new(move |seg| {
                    let should_fire = engine_obs.ingest_segment(&seg);
                    if should_fire {
                        engine_obs.fire_cycle();
                    }
                });
            pipeline = pipeline.with_observer(cb);
            // Show the HUD now that a guided session is starting.
            crate::overlay::show_guide_overlay(&self.app_handle);
            Some(engine)
        } else {
            None
        };
        let chunk_drain_handle = pipeline.spawn_drain(chunk_rx);
```

> `crate::settings::SettingsStore::guide_overlay_mode()` and `crate::overlay::show_guide_overlay` are added in later tasks (6 and 8). Your compiler will yell until those land; that's expected — Task 8 will compile-gate the whole feature.

- [ ] **Step 4: Stash both new fields on `ActiveMeeting`**

In the `*guard = Some(ActiveMeeting { ... })` literal at the bottom of `start()`, add (matching indentation):

```rust
            guide_template,
            guide_engine,
```

- [ ] **Step 5: Hide the HUD when the meeting stops**

In `MeetingManager::stop()`, immediately after the existing line `crate::overlay::hide_recording_overlay(&self.app_handle);`, add:

```rust
        crate::overlay::hide_guide_overlay(&self.app_handle);
```

- [ ] **Step 6: Add public accessor for the engine (used by the new commands)**

Append to `impl MeetingManager`:

```rust
    /// Returns a clone of the active session's GuidanceEngine handle, if any.
    pub async fn guide_engine(&self) -> Option<crate::meeting::guidance::GuidanceEngine> {
        self.state.lock().await.as_ref().and_then(|a| a.guide_engine.clone())
    }
```

- [ ] **Step 7: Rewire `start_guided_session` to pass template through context**

In `src-tauri/src/commands.rs`, replace the body of `start_guided_session` so the template rides on `MeetingStartContext` and the post-hoc `update_guide_template` call is removed (start() now persists atomically):

```rust
#[tauri::command]
pub async fn start_guided_session(
    state: tauri::State<'_, AppState>,
    template_id: String,
) -> Result<String, String> {
    let db = require_db(&state)?;
    let tid = template_id.clone();
    let template = db
        .with_conn(move |c| crate::db::guide_templates::get_template(c, &tid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("guide template {template_id} not found"))?;

    let mut start_context = capture_meeting_start_context();
    start_context.guide_template = Some(template);

    let id = state
        .meeting_manager
        .clone()
        .start(None, None, start_context)
        .await
        .map_err(|e| e.to_string())?;

    crate::meeting::detector::spawn_end_monitor(state.meeting_manager.clone(), None);
    Ok(id)
}
```

- [ ] **Step 8: Build (compile-only checkpoint — full test pass comes after Task 8)**

Run: `cd src-tauri && cargo check --lib`
Expected: at this point compilation FAILS with "no method `guide_overlay_mode`" / "no fn `show_guide_overlay`" / "no fn `hide_guide_overlay`" — that's correct, those land in Tasks 6 and 8. Capture the error names to confirm only those are missing.

- [ ] **Step 9: Commit (work-in-progress; fully verified at Task 8)**

```bash
git add src-tauri/src/meeting/mod.rs src-tauri/src/commands.rs
git commit -m "feat(meeting): wire GuidanceEngine into start/stop (compile gated on overlay+settings)"
```

---

## Phase 4 — Settings + commands

### Task 5: Settings — guide overlay mode + frame persistence

**Files:**
- Modify: `src-tauri/src/settings.rs`

- [ ] **Step 1: Add key constants + getters/setters**

In `src-tauri/src/settings.rs`, near the other key constants, add:

```rust
const KEY_GUIDE_OVERLAY_MODE: &str = "guide_overlay_mode";
const KEY_GUIDE_OVERLAY_FRAME: &str = "guide_overlay_frame";
```

Append to the `SettingsStore` impl (after the existing getters/setters):

```rust
    pub fn guide_overlay_mode(&self) -> Option<crate::meeting::guidance::Mode> {
        let v = self.store.get(KEY_GUIDE_OVERLAY_MODE)?;
        let s = v.as_str()?;
        crate::meeting::guidance::Mode::parse(s)
    }

    pub fn set_guide_overlay_mode(
        &self,
        mode: crate::meeting::guidance::Mode,
    ) -> Result<(), SettingsError> {
        let v = match mode {
            crate::meeting::guidance::Mode::Auto => "auto",
            crate::meeting::guidance::Mode::OnDemand => "on_demand",
        };
        self.store
            .set(KEY_GUIDE_OVERLAY_MODE, serde_json::Value::String(v.into()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// HUD frame {x, y, width, height, collapsed}. Free-form JSON: the
    /// overlay reads/writes its own keys; backend just persists the blob.
    pub fn guide_overlay_frame(&self) -> Option<serde_json::Value> {
        self.store.get(KEY_GUIDE_OVERLAY_FRAME)
    }

    pub fn set_guide_overlay_frame(&self, v: serde_json::Value) -> Result<(), SettingsError> {
        self.store.set(KEY_GUIDE_OVERLAY_FRAME, v);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }
```

- [ ] **Step 2: Build**

Run: `cd src-tauri && cargo check --lib`
Expected: `settings.rs` compiles. Whole-crate compile still fails on missing `show_guide_overlay` (lands in Task 8) — that's fine for now.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): guide_overlay_mode + guide_overlay_frame persistence"
```

### Task 6: New Tauri commands — set_mode, trigger_now, end

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the 3 commands**

In `src-tauri/src/commands.rs`, append after `start_guided_session`:

```rust
#[tauri::command]
pub async fn guide_set_mode(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    let m = crate::meeting::guidance::Mode::parse(&mode)
        .ok_or_else(|| format!("unknown guide mode: {mode}"))?;
    if let Some(engine) = state.meeting_manager.guide_engine().await {
        engine.set_mode(m);
    }
    // Persist for next session even when no engine is active.
    state.settings.set_guide_overlay_mode(m).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn guide_trigger_now(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(engine) = state.meeting_manager.guide_engine().await {
        engine.fire_cycle();
        Ok(())
    } else {
        Err("no active guided session".into())
    }
}

#[tauri::command]
pub async fn guide_end(state: tauri::State<'_, AppState>) -> Result<String, String> {
    // "End" from the HUD is just a stop for the current meeting. We reuse
    // the standard stop path so transcript + summary still produce.
    state
        .meeting_manager
        .stop()
        .await
        .map_err(|e| e.to_string())
}
```

> `state.settings: SettingsStore` is already on `AppState` (verified in the research). `state.meeting_manager.stop()` is the existing path used by the manual stop button.

- [ ] **Step 2: Register in invoke handler**

In `src-tauri/src/lib.rs`, in `tauri::generate_handler![ ... ]`, after `commands::start_guided_session,`, add:

```rust
            commands::guide_set_mode,
            commands::guide_trigger_now,
            commands::guide_end,
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo check --lib`
Expected: compile still fails on `show_guide_overlay`/`hide_guide_overlay`/`create_guide_overlay` (lands in Task 8). No other errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): guide_set_mode / guide_trigger_now / guide_end"
```

---

## Phase 5 — Overlay window (Rust + frontend)

### Task 7: Vite multi-entry + frontend overlay scaffold

**Files:**
- Modify: `vite.config.ts`
- Create: `src/guide-overlay/index.html`
- Create: `src/guide-overlay/main.tsx`
- Create: `src/guide-overlay/GuideOverlay.tsx`
- Create: `src/guide-overlay/GuideOverlay.css`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the Vite entry**

In `vite.config.ts`, in `build.rollupOptions.input`, add `guide`:

```ts
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
        consent: resolve(__dirname, "src/consent-overlay/index.html"),
        guide: resolve(__dirname, "src/guide-overlay/index.html"),
      },
```

(Place the new line where it slots into the existing block — keep the existing entries unchanged.)

- [ ] **Step 2: Create `src/guide-overlay/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Guide</title>
    <style>
      html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; width: 100%; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
      #root { width: 100%; height: 100%; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/guide-overlay/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import GuideOverlay from "./GuideOverlay";
import "./GuideOverlay.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GuideOverlay />
  </React.StrictMode>,
);
```

- [ ] **Step 4: Create `src/guide-overlay/GuideOverlay.css`**

```css
:root {
  color-scheme: dark;
}

.hud {
  position: relative;
  width: 268px;
  margin: 6px;
  background: rgba(17, 21, 28, 0.93);
  border: 1px solid #2d3340;
  border-radius: 10px;
  color: #cdd3df;
  font-size: 11px;
  line-height: 1.35;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}

.hud header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 4px 10px;
}

.hud .label {
  color: #7c8aff;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.hud .controls button {
  background: transparent;
  border: 0;
  color: #5b6472;
  font: inherit;
  padding: 2px 4px;
  margin-left: 2px;
  cursor: pointer;
}

.hud .controls button:hover { color: #cdd3df; }
.hud .controls .end { color: #e06c75; }

.hud section { padding: 4px 10px; }

.hud .goal { color: #9fb0c9; margin-bottom: 6px; }

.hud .point {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 0;
}

.hud .point.covered { color: #7fd1a0; }
.hud .point.partial { color: #e6c07b; }
.hud .point.open    { color: #6b7589; }

.hud .marker { font-size: 11px; width: 14px; display: inline-block; }

.hud .suggest {
  background: #1a1f29;
  border-radius: 6px;
  padding: 7px 9px;
  margin-top: 4px;
}

.hud .footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid #232a36;
  padding: 7px 10px 8px 10px;
  color: #5b6472;
  font-size: 10px;
  margin-top: 4px;
}

.hud .footer .mode {
  background: transparent;
  border: 0;
  color: #7c8aff;
  font: inherit;
  cursor: pointer;
}

.hud.collapsed section, .hud.collapsed .footer { display: none; }
.hud.collapsed header { padding-bottom: 8px; }
```

- [ ] **Step 5: Create `src/guide-overlay/GuideOverlay.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type KeyPoint = { id: string; label: string; status: "covered" | "partial" | "open" | string };
type GuidePayload = {
  meetingId: string;
  templateName?: string;
  goal?: string;
  mode: "auto" | "on_demand";
  keyPoints: KeyPoint[];
  suggestions: string[];
  updatedAt: string;
};

function statusMarker(s: string): string {
  if (s === "covered") return "✓";
  if (s === "partial") return "…";
  return "○";
}

function relativeAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  return `${m}m ago`;
}

export default function GuideOverlay() {
  const [payload, setPayload] = useState<GuidePayload | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let unlistenUpdate: UnlistenFn | undefined;
    let unlistenStatus: UnlistenFn | undefined;
    listen<GuidePayload>("guide-update", (e) => setPayload(e.payload)).then(
      (u) => (unlistenUpdate = u),
    );
    // Self-close: when the meeting moves past recording, the HUD is no
    // longer meaningful.
    listen<{ id: string; status: string }>("meeting-status", (e) => {
      if (
        e.payload.status === "transcribing" ||
        e.payload.status === "summarizing" ||
        e.payload.status === "complete"
      ) {
        setPayload(null);
      }
    }).then((u) => (unlistenStatus = u));
    return () => {
      unlistenUpdate?.();
      unlistenStatus?.();
    };
  }, []);

  // Tick once a second so the staleness label updates without re-emit.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const onToggleMode = useCallback(async () => {
    if (!payload) return;
    const next = payload.mode === "auto" ? "on_demand" : "auto";
    try {
      await invoke("guide_set_mode", { mode: next });
      setPayload({ ...payload, mode: next });
    } catch {
      /* swallow */
    }
  }, [payload]);

  const onTriggerNow = useCallback(async () => {
    try {
      await invoke("guide_trigger_now");
    } catch {
      /* swallow */
    }
  }, []);

  const onEnd = useCallback(async () => {
    try {
      await invoke("guide_end");
    } catch {
      /* swallow */
    }
  }, []);

  if (!payload) return null;

  return (
    <div className={`hud ${collapsed ? "collapsed" : ""}`}>
      <header data-tauri-drag-region>
        <span className="label" data-tauri-drag-region>
          GUIDE · {payload.templateName ?? "Session"}
        </span>
        <span className="controls">
          <button onClick={() => setCollapsed((c) => !c)} title="Collapse">
            {collapsed ? "▢" : "─"}
          </button>
          <button className="end" onClick={onEnd} title="End session">
            ×
          </button>
        </span>
      </header>
      <section>
        {payload.goal && <div className="goal">{payload.goal}</div>}
        {payload.keyPoints.map((p) => (
          <div key={p.id} className={`point ${p.status}`}>
            <span className="marker">{statusMarker(p.status)}</span>
            <span>{p.label}</span>
          </div>
        ))}
        {payload.suggestions.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 8 }}>SUGGEST NOW</div>
            {payload.suggestions.slice(0, 3).map((s, i) => (
              <div key={i} className="suggest">{s}</div>
            ))}
          </>
        )}
      </section>
      <div className="footer">
        <span>updated {relativeAge(payload.updatedAt, now)}</span>
        {payload.mode === "auto" ? (
          <button className="mode" onClick={onToggleMode}>
            Auto ▾
          </button>
        ) : (
          <span>
            <button className="mode" onClick={onTriggerNow}>Guide me now</button>
            {" · "}
            <button className="mode" onClick={onToggleMode}>On-demand ▾</button>
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add frontend bindings**

In `src/lib/api.ts`, append:

```ts
export const guideSetMode = (mode: "auto" | "on_demand"): Promise<void> =>
  invoke("guide_set_mode", { mode });

export const guideTriggerNow = (): Promise<void> => invoke("guide_trigger_now");

export const guideEnd = (): Promise<string> => invoke("guide_end");

export type GuideKeyPoint = {
  id: string;
  label: string;
  status: "covered" | "partial" | "open" | string;
};

export type GuideUpdate = {
  meetingId: string;
  templateName?: string;
  goal?: string;
  mode: "auto" | "on_demand";
  keyPoints: GuideKeyPoint[];
  suggestions: string[];
  updatedAt: string;
};
```

- [ ] **Step 7: Typecheck**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bunx tsc --noEmit`
Expected: no type errors. (The HUD component compiles even though the backend window isn't yet created — these are just frontend assets at this point.)

- [ ] **Step 8: Commit**

```bash
git add vite.config.ts src/guide-overlay src/lib/api.ts
git commit -m "feat(ui): guide overlay scaffold (HTML, React HUD, CSS, api bindings)"
```

### Task 8: Rust overlay window create/show/hide + lib.rs startup wire

**Files:**
- Modify: `src-tauri/src/overlay.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the 3 functions**

In `src-tauri/src/overlay.rs`, append (after the existing consent-overlay functions):

```rust
const GUIDE_OVERLAY_WIDTH: f64 = 280.0;
const GUIDE_OVERLAY_HEIGHT: f64 = 280.0;
const GUIDE_OVERLAY_RIGHT_MARGIN: f64 = 24.0;
const GUIDE_OVERLAY_TOP_MARGIN: f64 = 24.0;

fn calculate_guide_overlay_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok()??;
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let logical_w = size.width as f64 / scale;
    let x = (logical_w - GUIDE_OVERLAY_WIDTH - GUIDE_OVERLAY_RIGHT_MARGIN).max(0.0);
    let y = GUIDE_OVERLAY_TOP_MARGIN;
    Some((x, y))
}

/// Build the guide-overlay webview window. Idempotent (no-op if already
/// created). Mirrors `create_recording_overlay` flags: transparent,
/// decorations off, always-on-top, never focused/in-taskbar.
pub fn create_guide_overlay(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("guide_overlay").is_some() {
        return;
    }
    let (x, y) = calculate_guide_overlay_position(app_handle).unwrap_or((100.0, 100.0));
    let _ = WebviewWindowBuilder::new(
        app_handle,
        "guide_overlay",
        tauri::WebviewUrl::App("src/guide-overlay/index.html".into()),
    )
    .title("Guide")
    .position(x, y)
    .inner_size(GUIDE_OVERLAY_WIDTH, GUIDE_OVERLAY_HEIGHT)
    .resizable(false)
    .shadow(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .accept_first_mouse(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .focused(false)
    .visible(false)
    .build();
}

pub fn show_guide_overlay(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    } else {
        // Window wasn't pre-created (e.g. dev hot-reload): build then show.
        create_guide_overlay(app_handle);
        if let Some(w) = app_handle.get_webview_window("guide_overlay") {
            let _ = w.show();
            let _ = w.set_always_on_top(true);
        }
    }
}

pub fn hide_guide_overlay(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        let _ = w.hide();
    }
}
```

- [ ] **Step 2: Pre-create the overlay window on startup**

In `src-tauri/src/lib.rs`, locate the block that calls `create_recording_overlay` + `create_consent_overlay` during setup (per the research, around the existing overlay-init lines). Right after `create_consent_overlay(&app.handle().clone());` add:

```rust
            crate::overlay::create_guide_overlay(&app.handle().clone());
```

- [ ] **Step 3: Build + full test suite (compile gate cleared)**

Run: `cd src-tauri && cargo test --lib`
Expected: all tests PASS, including the Phase 1–3 tasks that were compile-gated on these overlay functions.

Run: `cd src-tauri && cargo build --lib` — clean (only the pre-existing `detected_app` warning).

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bunx tsc --noEmit` — no type errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/overlay.rs src-tauri/src/lib.rs
git commit -m "feat(overlay): create/show/hide guide_overlay webview window"
```

---

## Phase 6 — Glue + ship

### Task 9: Settings command for HUD frame persistence (optional, low priority)

> Frame persistence (HUD remembers position/size across sessions) is nice but does not block visible value. **Skip this task for v1 if you want the smallest path to a shipped HUD;** the HUD will simply open at the default position every time. If you choose to skip, mark this task complete with a one-line note in the commit message and move to Task 10.

**Files:** none if skipping; otherwise:
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

(If implementing later, mirror the `daily_recap_settings_*` pattern from `commands.rs` to expose `guide_overlay_frame_get` / `guide_overlay_frame_set` bound to `settings.guide_overlay_frame()` / `set_guide_overlay_frame`. Frontend wires window position to those calls via `getCurrentWebviewWindow()` `onMoved`/`onResized` listeners.)

- [ ] **Step 1: Decide skip vs implement** — record the decision in a one-line commit message.

```bash
git commit --allow-empty -m "chore(guide): skip frame persistence for v1 (HUD opens at default position)"
```

### Task 10: Wire `meeting-complete` so HUD vanishes belt-and-suspenders

**Files:** none — already covered by Task 4 Step 5 (`hide_guide_overlay` in `stop()`) and the GuideOverlay's frontend listener for `meeting-status`. Verify in Task 12.

- [ ] **Step 1: Just confirm both paths exist**

`grep -n "hide_guide_overlay" src-tauri/src/meeting/mod.rs` → expect at least one hit in `stop()`.
`grep -n "meeting-status" src/guide-overlay/GuideOverlay.tsx` → expect a listener.

If either is missing, fix and amend the appropriate previous task's commit (or add a small follow-up commit).

### Task 11: Build + reinstall (no TCC reset per the user's standing preference)

**Files:** none — manual harness step.

- [ ] **Step 1: Build the .app bundle**

Run: `bun tauri build --bundles app`
Expected: exit 0, signed bundle at `src-tauri/target/release/bundle/macos/Echo Scribe.app`.

- [ ] **Step 2: Reinstall WITHOUT tcc reset**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

### Task 12: Real-app verification (manual)

**Files:** none — manual verification.

- [ ] **Step 1: Confirm template UI still works**

Settings → Meetings → Guide templates → create or pick an existing one → confirm Save persists.

- [ ] **Step 2: Start a guided session**

Meetings view → **Start guided session** → pick template. The HUD overlay window must appear (top-right, always-on-top, transparent), showing the template name + goal. As you talk, after ~20–30 s a `[guide]` log line should fire and the HUD's key-points / suggestions should populate. Pauses → silence-aware chunk closes earlier → guide ticks faster.

- [ ] **Step 3: Test Auto/On-demand toggle**

Click the mode button in the HUD footer. In On-demand: the HUD stays static between manual triggers; the "Guide me now" button forces a cycle. Switch back to Auto.

- [ ] **Step 4: Test End**

Click the HUD's × (End) button. The meeting should stop (status transitions visible in the main app); the HUD should hide; transcript + summary should still produce.

- [ ] **Step 5: Record findings**

Append a "B2 verification" section to this plan file with: did the HUD appear? did `guide-update` events fire? Auto/On-demand behaved as described? End hid the HUD AND produced a normal saved meeting? Note any visible glitches. Commit:

```bash
git add docs/superpowers/plans/2026-05-19-guidance-engine-and-hud.md
git commit -m "docs: record B2 visible verification findings"
```

---

## Self-Review

**Spec coverage (`2026-05-16-meeting-guide-design.md` §3):**
- Hooks the existing per-chunk drain event → Task 1 (Pipeline observer) + Task 4 (engine wired to the observer). ✓
- Prompt = system role + `goal` + `notes` + bounded rolling transcript + prior derived points → Task 2 + Task 3 (`build_guidance_prompt` + engine's `ROLLING_BYTES = 4_000`). ✓
- One-shot Gemma → JSON `{key_points:[{id,label,status}], suggestions:[…]}` → Task 3 (`GuidanceResponse` shape + 2-attempt parse + brace-counting JSON isolator). ✓
- Stable IDs + prior-points feedback → engine state's `prior_points` carried into each prompt (Task 3). ✓
- Contention policy → engine-local `AtomicBool` skip-if-busy gate (Task 3 `fire_cycle`); voice-at-cursor + final synthesis still FIFO-serialize at the LLM lock (no preemption needed by spec). ✓
- In-call modes Auto / On-demand → mode field + `set_mode` + `guide_set_mode` command + HUD footer toggle (Tasks 3, 6, 7). ✓
- HUD always-on-top, transparent, draggable, collapsible — reusing existing overlay precedent → Task 7 (`data-tauri-drag-region`, CSS collapsed class) + Task 8 (`always_on_top + transparent + decorations(false) + skip_taskbar + focused(false)`). ✓
- HUD content: goal, derived key-points w/ covered·partial·open, 1–3 suggestions, staleness label, mode menu, End → all in `GuideOverlay.tsx` (Task 7 Step 5). ✓
- New event `guide-update` + commands → Task 3 (emit), Task 6 (commands). ✓
- HUD self-close on `meeting-status` (transcribing/summarizing/complete) + backend `hide_guide_overlay` in stop() → Task 4 Step 5 + Task 7 Step 5. ✓
- Out of scope (correctly absent in B2): persisting derived points + suggestion timeline into the meeting record (Plan B3 follow-up; documented above). ✓

**Memory-source acknowledgement (Phase 0 finding):** the engine's skip-if-busy gate explicitly prevents the guidance loop from piling on itself, which is the only way it could keep Gemma sustained beyond one in-flight call at a time. With Gemma resident throughout the call (the unavoidable B2 cost), one in-flight guidance call = ~700 MiB transient over the 1.1 GiB baseline. Voice-at-cursor and final synthesis still funnel through the LLM lock and are at most delayed by one in-flight guidance call (≤ a few seconds).

**Placeholder scan:** No TBD/TODO/"similar to". Every code step has complete code. Task 9 is explicitly framed as a skip/implement decision (frame persistence is a known v1-deferral, not a placeholder for unspecified work). Task 10 is a verification-only task. Tasks 11–12 are manual harness steps with concrete commands and acceptance criteria.

**Type consistency:** `GuideTemplate` field names (id/name/description/goal/notes/created_at/updated_at) reused unchanged. `Mode` parsed via `Mode::parse("auto"|"on_demand")` consistently across `Mode::parse` (Task 3), `guide_set_mode` command (Task 6), settings getter (Task 5), and frontend payload (`"auto"|"on_demand"` in `GuideOverlay.tsx` and `api.ts` `GuideUpdate.mode`). `DerivedPoint { id, label, status }` matches the LLM JSON schema (`Task 2 GUIDANCE_JSON_HINT`) and the frontend `GuideKeyPoint` type (Task 7 Step 6). `SegmentObserver` type alias defined Task 1, consumed in Task 4. `guide_overlay` window label is consistent across Tasks 3 (emit target), 7 (URL/Vite entry), and 8 (`WebviewWindowBuilder::new` label). The `guide-update` event name + payload shape are byte-identical between `emit_update` (Task 3) and `GuidePayload` (Task 7).

**Compile-gating note:** Tasks 4, 5, and 6 are intentionally not standalone-compilable — they reference `show_guide_overlay`/`hide_guide_overlay`/`create_guide_overlay` and the new `Mode`/settings fns from Tasks 3 and 8. The plan calls `cargo check --lib` after each gated task with the expectation that the only failures are the named missing symbols. **Task 8 Step 3 is the gate that brings the whole crate green** — do not declare any of Tasks 4–6 "done" until Task 8 lands and the full `cargo test --lib` passes.
