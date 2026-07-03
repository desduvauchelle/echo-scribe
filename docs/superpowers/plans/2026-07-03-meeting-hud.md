# Meeting HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live transcript + mid-meeting guide attachment (up to 2 concurrent) in one resizable Meeting HUD window, launched from the meeting pill, with 5 seeded default templates.

**Architecture:** The meeting pipeline's single segment observer becomes always-installed and fans out to (a) an in-memory transcript history + `meeting-segment` events, and (b) a mutable list of `GuidanceEngine`s (cap 2) that can be attached/detached mid-meeting. The `guide_overlay` window (label kept — avoids capabilities/TCC churn) is rebuilt as a resizable Meeting HUD hosting per-guide checklists, a merged newest-first card feed, and a live transcript pane.

**Tech Stack:** Rust (Tauri v2, rusqlite, tokio, tracing), React + TypeScript (Vite multi-entry), existing Gemma LLM engine.

**Spec:** `docs/superpowers/specs/2026-07-03-meeting-hud-design.md`

## Global Constraints

- Window label stays `guide_overlay` (capabilities/default.json untouched → skip-TCC reinstall applies).
- Guide cap is exactly **2**; exceeding it returns the friendly error `"Two guides are already running. Close one to add another."`
- All new logs use `target: "guide"` or `target: "hud"`; UI shows friendly messages only, raw detail goes to the log (project CLAUDE.md).
- `guide_template_json` is written as a JSON **array**; readers must tolerate the legacy single-object form.
- Rust tests: `cd src-tauri && cargo test --lib`. Frontend check: `bun run build` (runs `tsc`).
- Commit after each task with the message given in the task.

---

### Task 1: GuidanceEngine session identity + rolling-window seeding

**Files:**
- Modify: `src-tauri/src/meeting/guidance.rs`
- Modify: `src-tauri/src/meeting/mod.rs:337-343` (constructor call site — minimal fix to keep compiling; fully reworked in Task 4)

**Interfaces:**
- Produces: `GuidanceEngine::new(session_id: String, slot: u8, meeting_id: String, template: GuideTemplate, llm: Arc<Llm>, app: AppHandle<Wry>, initial_mode: Mode)`, `fn session_id(&self) -> &str`, `fn slot(&self) -> u8`, `fn seed_rolling(&self, text: String)`, `pub fn tail_bytes(s: &str, max: usize) -> &str`, `pub fn seed_text_from_history(history: &[Segment], max_bytes: usize) -> String`, `pub fn next_free_slot(used: &[u8]) -> u8`, `pub(crate) const ROLLING_BYTES`. `guide-update` payloads now include `sessionId` and `slot`.

- [ ] **Step 1: Write failing tests** — append to the `tests` module in `guidance.rs`:

```rust
    #[test]
    fn tail_bytes_returns_whole_string_when_small() {
        assert_eq!(tail_bytes("abc", 10), "abc");
    }

    #[test]
    fn tail_bytes_truncates_to_line_boundary() {
        let s = "one\ntwo\nthree\n";
        // max 9 bytes → suffix "wo\nthree\n" → skip to after first newline → "three\n"
        assert_eq!(tail_bytes(s, 9), "three\n");
    }

    #[test]
    fn tail_bytes_is_char_boundary_safe() {
        let s = "aaaa日本語テキスト";
        let out = tail_bytes(s, 7);
        assert!(out.len() <= 7);
        assert!(s.ends_with(out));
    }

    #[test]
    fn seed_text_builds_speaker_tagged_lines() {
        let history = vec![
            crate::meeting::Segment { speaker: crate::meeting::Speaker::You, start_ms: 0, end_ms: 1, text: " hello ".into() },
            crate::meeting::Segment { speaker: crate::meeting::Speaker::Them, start_ms: 1, end_ms: 2, text: "hi".into() },
        ];
        assert_eq!(seed_text_from_history(&history, 4000), "you: hello\nthem: hi\n");
    }

    #[test]
    fn next_free_slot_picks_lowest() {
        assert_eq!(next_free_slot(&[]), 0);
        assert_eq!(next_free_slot(&[0]), 1);
        assert_eq!(next_free_slot(&[1]), 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib meeting::guidance`
Expected: compile errors — `tail_bytes`, `seed_text_from_history`, `next_free_slot` not found.

- [ ] **Step 3: Implement.** In `guidance.rs`:

Change `const ROLLING_BYTES` to `pub(crate) const ROLLING_BYTES`. Add above `GuidanceEngine`:

```rust
/// Suffix of `s` at most `max` bytes long, aligned to a char boundary and —
/// when possible — to the start of a line so seeded context never opens
/// mid-sentence.
pub fn tail_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    match s[start..].find('\n') {
        Some(i) if start + i + 1 < s.len() => &s[start + i + 1..],
        _ => &s[start..],
    }
}

/// Flatten transcript history into the same "speaker: text" line format the
/// live ingest path uses, bounded to the most recent `max_bytes`.
pub fn seed_text_from_history(history: &[crate::meeting::Segment], max_bytes: usize) -> String {
    let mut out = String::new();
    for seg in history {
        let tag = match seg.speaker {
            crate::meeting::Speaker::You => "you",
            crate::meeting::Speaker::Them => "them",
        };
        out.push_str(tag);
        out.push_str(": ");
        out.push_str(seg.text.trim());
        out.push('\n');
    }
    tail_bytes(&out, max_bytes).to_string()
}

/// Lowest color-slot (0 or 1) not taken by an active guide.
pub fn next_free_slot(used: &[u8]) -> u8 {
    if used.contains(&0) { 1 } else { 0 }
}
```

Add fields to `Inner`: `session_id: String,` and `slot: u8,` (above `meeting_id`). Update the constructor:

```rust
    pub fn new(
        session_id: String,
        slot: u8,
        meeting_id: String,
        template: GuideTemplate,
        llm: Arc<Llm>,
        app: AppHandle<Wry>,
        initial_mode: Mode,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                session_id,
                slot,
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

    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub fn slot(&self) -> u8 {
        self.inner.slot
    }

    /// Replace the rolling window wholesale — used to seed a guide attached
    /// mid-meeting with the recent transcript so its first cycle has context.
    pub fn seed_rolling(&self, text: String) {
        self.inner.state.lock().unwrap().rolling = text;
    }
```

In `emit_update`, add to the `json!` payload (before `"meetingId"`):

```rust
        "sessionId": inner.session_id,
        "slot": inner.slot,
```

- [ ] **Step 4: Fix the call site** in `meeting/mod.rs` (the `GuidanceEngine::new(` call around line 337) — prepend two args so it compiles; Task 4 deletes this whole block:

```rust
            let engine = crate::meeting::guidance::GuidanceEngine::new(
                uuid::Uuid::new_v4().to_string(),
                0,
                id.clone(),
                template,
                self.llm.clone(),
                self.app_handle.clone(),
                initial_mode,
            );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib meeting::guidance`
Expected: all pass (existing 5 + new 5).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/meeting/guidance.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(guide): session identity, slot, and rolling-window seeding for guidance engine"
```

---

### Task 2: DB — append guide template snapshots as a JSON array

**Files:**
- Modify: `src-tauri/src/db/meetings.rs`

**Interfaces:**
- Produces: `pub fn append_guide_template_snapshot(conn: &Connection, item_id: &str, snapshot: &serde_json::Value) -> Result<(), DbError>` — appends to `meetings.guide_template_json`, converting legacy single-object values to arrays.
- Consumes: existing `insert_meeting` / `MeetingRow` / `get_meeting` in the same file (mirror an existing test's row construction for the test fixture).

- [ ] **Step 1: Write failing tests** — in the `tests` module of `db/meetings.rs`, using that module's existing helper for inserting a meeting row (there are existing tests inserting a `MeetingRow`; copy that fixture pattern, with `guide_template_json: None`):

```rust
    #[test]
    fn append_snapshot_starts_array() {
        let c = fresh(); // reuse the module's in-memory-db helper name
        insert_test_meeting(&c, "m1"); // reuse/extract the module's row fixture
        append_guide_template_snapshot(&c, "m1", &serde_json::json!({"id": "t1"})).unwrap();
        let row = get_meeting(&c, "m1").unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&row.guide_template_json.unwrap()).unwrap();
        assert_eq!(v, serde_json::json!([{"id": "t1"}]));
    }

    #[test]
    fn append_snapshot_upgrades_legacy_object() {
        let c = fresh();
        insert_test_meeting(&c, "m1");
        update_guide_template(&c, "m1", Some(r#"{"id":"legacy"}"#)).unwrap();
        append_guide_template_snapshot(&c, "m1", &serde_json::json!({"id": "t2"})).unwrap();
        let row = get_meeting(&c, "m1").unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&row.guide_template_json.unwrap()).unwrap();
        assert_eq!(v, serde_json::json!([{"id": "legacy"}, {"id": "t2"}]));
    }

    #[test]
    fn append_snapshot_appends_to_existing_array() {
        let c = fresh();
        insert_test_meeting(&c, "m1");
        append_guide_template_snapshot(&c, "m1", &serde_json::json!({"id": "a"})).unwrap();
        append_guide_template_snapshot(&c, "m1", &serde_json::json!({"id": "b"})).unwrap();
        let row = get_meeting(&c, "m1").unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&row.guide_template_json.unwrap()).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
    }
```

If the module lacks a reusable meeting fixture, add `fn insert_test_meeting(conn: &Connection, id: &str)` that inserts an `items` row (`kind='meeting'`) then `insert_meeting` with a minimal `MeetingRow` (all optionals `None`, `status: "recording"`, `failed_chunk_count: 0`, `mic_only: false`) — copy field-for-field from an existing test in the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib db::meetings`
Expected: compile error — `append_guide_template_snapshot` not found.

- [ ] **Step 3: Implement** — add below `update_guide_template`:

```rust
/// Append one guide-template snapshot to the meeting's `guide_template_json`.
/// The column stores a JSON array; a legacy single-object value (pre-HUD
/// meetings) is upgraded to a one-element array before appending. Unparseable
/// existing content is discarded rather than propagated.
pub fn append_guide_template_snapshot(
    conn: &Connection,
    item_id: &str,
    snapshot: &serde_json::Value,
) -> Result<(), DbError> {
    let current: Option<String> = conn
        .query_row(
            "SELECT guide_template_json FROM meetings WHERE item_id = ?1",
            [item_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let mut arr = match current.as_deref().map(serde_json::from_str::<serde_json::Value>) {
        Some(Ok(serde_json::Value::Array(a))) => a,
        Some(Ok(v @ serde_json::Value::Object(_))) => vec![v],
        _ => Vec::new(),
    };
    arr.push(snapshot.clone());
    conn.execute(
        "UPDATE meetings SET guide_template_json = ?1 WHERE item_id = ?2",
        params![serde_json::Value::Array(arr).to_string(), item_id],
    )?;
    Ok(())
}
```

(`query_row(...).optional()?` yields `Option<Option<String>>` because the column is nullable — hence `.flatten()`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib db::meetings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/meetings.rs
git commit -m "feat(guide): guide_template_json stores an array; append helper with legacy-object upgrade"
```

---

### Task 3: Built-in default templates, seeded once

**Files:**
- Modify: `src-tauri/src/db/guide_templates.rs`
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs` (setup, right after `create_guide_overlay` call ~line 637 — anywhere after `db` and settings are available)

**Interfaces:**
- Produces: `pub fn seed_builtin_templates(conn: &Connection, now_iso: &str) -> Result<usize, DbError>`; `SettingsStore::builtin_templates_seeded() -> bool` / `set_builtin_templates_seeded(bool)`.

- [ ] **Step 1: Write failing tests** in `db/guide_templates.rs`:

```rust
    #[test]
    fn seed_builtins_inserts_five_then_zero() {
        let c = fresh();
        assert_eq!(seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap(), 5);
        assert_eq!(seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap(), 0);
        assert_eq!(list_templates(&c).unwrap().len(), 5);
    }

    #[test]
    fn seed_builtins_does_not_clobber_user_edits() {
        let c = fresh();
        seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap();
        update_template(&c, "builtin-sales", "My sales", "d", "g", "n", "2026-07-04T00:00:00Z").unwrap();
        seed_builtin_templates(&c, "2026-07-03T00:00:00Z").unwrap();
        assert_eq!(get_template(&c, "builtin-sales").unwrap().unwrap().name, "My sales");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib db::guide_templates`
Expected: compile error — `seed_builtin_templates` not found.

- [ ] **Step 3: Implement** — add to `db/guide_templates.rs`:

```rust
/// Built-in starter templates. Seeded once at startup (guarded by a settings
/// flag so user deletions stick); afterwards they behave exactly like
/// user-authored templates — editable, deletable.
pub struct BuiltinTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub goal: &'static str,
    pub notes: &'static str,
}

pub const BUILTIN_TEMPLATES: &[BuiltinTemplate] = &[
    BuiltinTemplate {
        id: "builtin-sales",
        name: "Sales conversation",
        description: "Guide a sales call toward a clear next step.",
        goal: "Understand their problem, budget, timeline, and decision process; agree on a concrete next step before the call ends.",
        notes: "ask what prompted them to take this call\nget specific about the problem: frequency, cost, who feels it\nask what they've tried already and why it fell short\nidentify who else is involved in the decision\nask about timeline and budget range\ndon't pitch until the problem is confirmed\nclose with a concrete next step: date, owner, deliverable",
    },
    BuiltinTemplate {
        id: "builtin-discovery",
        name: "Customer discovery",
        description: "Validate the problem before the solution.",
        goal: "Learn their current workflow, pains, and workarounds without pitching; validate whether the problem is real and painful.",
        notes: "ask them to walk through their current workflow step by step\ndig into the last time the problem actually happened\nask what workarounds they use today\nask how much time or money the problem costs\navoid pitching or leading the witness\nask who else has this problem\nask what would make them switch from their current approach",
    },
    BuiltinTemplate {
        id: "builtin-communication",
        name: "Clear communication",
        description: "Keep the conversation crisp and mutual.",
        goal: "Keep statements short and concrete, check understanding often, and close every loop explicitly.",
        notes: "one idea per statement; pause after key points\nreplace abstractions with concrete examples\ncheck understanding: 'does that match how you see it?'\nlet them finish; don't interrupt\nsummarize agreements out loud before moving on\nflag open questions explicitly instead of letting them drop",
    },
    BuiltinTemplate {
        id: "builtin-deescalate",
        name: "De-escalate / avoid arguments",
        description: "Lower the temperature and find the shared goal.",
        goal: "Acknowledge before countering, name emotions, slow the pace, and steer toward the shared goal instead of winning the point.",
        notes: "acknowledge their point before responding to it\nname the emotion you hear: 'sounds like this has been frustrating'\nslow down and lower your volume when tension rises\nask questions instead of stating counterpoints\nfind and restate the shared goal\nif it keeps heating up, suggest a pause or a follow-up",
    },
    BuiltinTemplate {
        id: "builtin-leadership",
        name: "Leadership presence",
        description: "Lead the room by listening and committing clearly.",
        goal: "Listen more than you speak, ask before telling, give specific credit, and end with clear owners and dates.",
        notes: "speak last: gather everyone's view first\nask 'what do you think?' before giving your answer\ngive credit by name for specific contributions\nstate decisions and the reasoning plainly\nevery action item gets an owner and a date\nadmit uncertainty openly; it builds trust",
    },
];

/// Insert any missing builtin templates. `INSERT OR IGNORE` keyed on the
/// fixed ids means user edits and deletions are never overwritten here —
/// the caller's settings flag is what prevents deleted builtins from
/// reappearing on later launches.
pub fn seed_builtin_templates(conn: &Connection, now_iso: &str) -> Result<usize, DbError> {
    let mut inserted = 0;
    for b in BUILTIN_TEMPLATES {
        inserted += conn.execute(
            "INSERT OR IGNORE INTO guide_templates
                (id, name, description, goal, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![b.id, b.name, b.description, b.goal, b.notes, now_iso],
        )?;
    }
    Ok(inserted)
}
```

- [ ] **Step 4: Settings flag** — in `settings.rs`, add to the key constants block:

```rust
const KEY_BUILTIN_TEMPLATES_SEEDED: &str = "builtin_templates_seeded_v1";
```

and next to `onboarding_completed` (line ~411), following the exact same pattern:

```rust
    pub fn builtin_templates_seeded(&self) -> bool {
        self.store
            .get(KEY_BUILTIN_TEMPLATES_SEEDED)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    pub fn set_builtin_templates_seeded(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_BUILTIN_TEMPLATES_SEEDED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }
```

- [ ] **Step 5: Wire into startup** — in `lib.rs` setup, after the `create_guide_overlay` call (line ~637). The setup closure has `app` in scope; load settings and db the same way neighboring code does (there is an `AppState` managed with `db: Option<Db>` and a `settings` field — mirror how nearby setup code obtains them; if only `AppState` is available use `app.state::<AppState>()`):

```rust
            // Seed builtin guide templates exactly once. The settings flag —
            // not INSERT OR IGNORE — is what lets a user's deletion of a
            // builtin stick across launches.
            {
                let st = app.state::<AppState>();
                if let (Some(db), settings) = (st.db.clone(), st.settings.clone()) {
                    if !settings.builtin_templates_seeded() {
                        let now = chrono::Utc::now().to_rfc3339();
                        match db.with_conn(move |c| {
                            crate::db::guide_templates::seed_builtin_templates(c, &now)
                        }) {
                            Ok(n) => {
                                tracing::info!(target: "guide", inserted = n, "seeded builtin guide templates");
                                if let Err(e) = settings.set_builtin_templates_seeded(true) {
                                    tracing::warn!(target: "guide", ?e, "failed to persist builtin-seed flag");
                                }
                            }
                            Err(e) => {
                                tracing::warn!(target: "guide", ?e, "builtin template seeding failed");
                            }
                        }
                    }
                }
            }
```

Adjust field access to the actual `AppState` shape (check how `commands.rs` reads `state.db` / `state.settings` and mirror it; `settings` may not be `Clone` — if not, call methods on the borrow instead of cloning).

- [ ] **Step 6: Run tests + build**

Run: `cd src-tauri && cargo test --lib db::guide_templates && cargo check`
Expected: tests PASS, check clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/guide_templates.rs src-tauri/src/settings.rs src-tauri/src/lib.rs
git commit -m "feat(guide): seed five builtin guide templates once at startup"
```

---

### Task 4: MeetingManager — always-on segment fan-out, attach/detach mid-meeting

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs`
- Modify: `src-tauri/src/commands.rs` (only the `MeetingStartContext` literal at ~line 2582 and `start_guided_session`; the other guide commands change in Task 5)

**Interfaces:**
- Consumes: Task 1's `GuidanceEngine::new(session_id, slot, ...)`, `seed_text_from_history`, `next_free_slot`, `ROLLING_BYTES`; Task 2's `append_guide_template_snapshot`.
- Produces: `MeetingManager::attach_guide(&self, template: GuideTemplate) -> Result<String, String>`, `detach_guide(&self, session_id: &str) -> Result<(), String>`, `guide_engine_by_id(&self, session_id: &str) -> Option<GuidanceEngine>`, `transcript_snapshot(&self) -> Vec<Segment>`. Emits `meeting-segment` (`{meetingId, segment}`) and `guide-detached` (`{sessionId}`) events. Removes `MeetingStartContext.guide_template` and `MeetingManager::guide_engine()`.
- Note: `crate::overlay::show_meeting_hud` / `emit_guide_init` don't exist until Task 6 — **this task calls the existing `crate::overlay::show_guide_overlay(&app, name, goal, mode)`** for HUD display and emits `guide-init` itself via `app.emit`; Task 6 swaps these two lines.

- [ ] **Step 1: ActiveMeeting fields** — in `meeting/mod.rs`, replace (lines ~154-155):

```rust
    guide_template: Option<crate::db::guide_templates::GuideTemplate>,
    guide_engine: Option<crate::meeting::guidance::GuidanceEngine>,
```

with:

```rust
    /// Guide engines attached to this meeting (0..=2). Mutated by
    /// attach_guide/detach_guide while the segment observer reads it — the
    /// observer clones the Vec under the lock, then dispatches lock-free.
    guide_engines: Arc<std::sync::Mutex<Vec<crate::meeting::guidance::GuidanceEngine>>>,
    /// Full transcript so far, in stitch order. Backs the HUD's live
    /// transcript backlog (`get_live_transcript`) and guide seeding.
    transcript: Arc<std::sync::Mutex<Vec<Segment>>>,
```

- [ ] **Step 2: Remove `guide_template` from `MeetingStartContext`** (lines ~166-169) and delete the `pub async fn guide_engine(...)` accessor (lines ~210-213). Add in its place:

```rust
    /// Engine lookup by guide session id (HUD commands).
    pub async fn guide_engine_by_id(
        &self,
        session_id: &str,
    ) -> Option<crate::meeting::guidance::GuidanceEngine> {
        self.state.lock().await.as_ref().and_then(|a| {
            a.guide_engines
                .lock()
                .unwrap()
                .iter()
                .find(|e| e.session_id() == session_id)
                .cloned()
        })
    }

    /// Snapshot of the live transcript (empty when no meeting is active).
    pub async fn transcript_snapshot(&self) -> Vec<Segment> {
        self.state
            .lock()
            .await
            .as_ref()
            .map(|a| a.transcript.lock().unwrap().clone())
            .unwrap_or_default()
    }
```

- [ ] **Step 3: Rework `start()`** — replace the whole guided-branch block (lines ~310-371, from `let mut pipeline = Pipeline::new(...)` through the `} else { None };`) with an always-installed observer:

```rust
        // Build the pipeline with an always-installed segment observer. It
        // feeds (a) the transcript history + live `meeting-segment` events
        // and (b) whatever guide engines are attached at dispatch time —
        // which is what lets guides attach/detach mid-meeting even though
        // the observer itself is captured once at spawn_drain time.
        let mut pipeline = Pipeline::new(self.asr.clone(), dir.join("failed"));
        let guide_engines: Arc<std::sync::Mutex<Vec<crate::meeting::guidance::GuidanceEngine>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let transcript: Arc<std::sync::Mutex<Vec<Segment>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let engines_obs = guide_engines.clone();
            let transcript_obs = transcript.clone();
            let app_obs = self.app_handle.clone();
            let id_obs = id.clone();
            let cb: crate::meeting::pipeline::SegmentObserver = std::sync::Arc::new(move |seg| {
                transcript_obs.lock().unwrap().push(seg.clone());
                if let Err(e) = app_obs.emit(
                    "meeting-segment",
                    serde_json::json!({ "meetingId": id_obs, "segment": seg }),
                ) {
                    tracing::warn!(target: "hud", ?e, "meeting-segment emit failed");
                }
                let engines: Vec<_> = engines_obs.lock().unwrap().clone();
                for engine in engines {
                    if engine.ingest_segment(&seg) {
                        engine.fire_cycle();
                    }
                }
            });
            pipeline = pipeline.with_observer(cb);
        }
```

Then update the `ActiveMeeting { ... }` construction (lines ~482-483): replace `guide_template,` / `guide_engine,` with `guide_engines,` / `transcript,`.

- [ ] **Step 4: Add `attach_guide` / `detach_guide`** to `impl MeetingManager` (after `transcript_snapshot`):

```rust
    /// Attach a guide template to the active meeting. Caps at two concurrent
    /// guides. Seeds the new engine with the recent transcript, persists the
    /// template snapshot on the meeting row, shows the HUD, and (in Auto
    /// mode) fires an immediate first cycle.
    pub async fn attach_guide(
        &self,
        template: crate::db::guide_templates::GuideTemplate,
    ) -> Result<String, String> {
        let (meeting_id, engines_arc, transcript_arc) = {
            let guard = self.state.lock().await;
            let active = guard.as_ref().ok_or("No meeting is recording")?;
            (
                active.item_id.clone(),
                active.guide_engines.clone(),
                active.transcript.clone(),
            )
        };

        let initial_mode = match crate::settings::SettingsStore::load(&self.app_handle)
            .ok()
            .and_then(|s| s.guide_overlay_mode())
        {
            Some(crate::meeting::guidance::Mode::OnDemand) => {
                crate::meeting::guidance::Mode::OnDemand
            }
            _ => crate::meeting::guidance::Mode::Auto,
        };
        let session_id = uuid::Uuid::new_v4().to_string();

        let engine = {
            let mut engines = engines_arc.lock().unwrap();
            if engines.len() >= 2 {
                tracing::info!(target: "guide", template = %template.name, "attach rejected: cap reached");
                return Err("Two guides are already running. Close one to add another.".into());
            }
            let slot = crate::meeting::guidance::next_free_slot(
                &engines.iter().map(|e| e.slot()).collect::<Vec<_>>(),
            );
            let engine = crate::meeting::guidance::GuidanceEngine::new(
                session_id.clone(),
                slot,
                meeting_id.clone(),
                template.clone(),
                self.llm.clone(),
                self.app_handle.clone(),
                initial_mode,
            );
            let seed = crate::meeting::guidance::seed_text_from_history(
                &transcript_arc.lock().unwrap(),
                crate::meeting::guidance::ROLLING_BYTES,
            );
            if !seed.is_empty() {
                engine.seed_rolling(seed);
            }
            engines.push(engine.clone());
            engine
        };

        match serde_json::to_value(&template) {
            Ok(snap) => {
                let mid = meeting_id.clone();
                if let Err(e) = self.db.with_conn(move |c| {
                    crate::db::meetings::append_guide_template_snapshot(c, &mid, &snap)
                }) {
                    tracing::warn!(target: "guide", ?e, "persisting guide template snapshot failed");
                }
            }
            Err(e) => tracing::warn!(target: "guide", ?e, "template snapshot serialize failed"),
        }

        let mode_str = match initial_mode {
            crate::meeting::guidance::Mode::Auto => "auto",
            crate::meeting::guidance::Mode::OnDemand => "on_demand",
        };
        // Task 6 swaps these two lines for show_meeting_hud + emit_guide_init.
        crate::overlay::show_guide_overlay(&self.app_handle, &template.name, &template.goal, mode_str);
        let _ = self.app_handle.emit(
            "guide-init",
            serde_json::json!({
                "sessionId": session_id,
                "slot": engine.slot(),
                "templateName": template.name,
                "goal": template.goal,
                "mode": mode_str,
            }),
        );
        if matches!(initial_mode, crate::meeting::guidance::Mode::Auto) {
            // Harmless when the seed was empty: the cycle no-ops on an
            // empty rolling window.
            engine.fire_cycle();
        }
        tracing::info!(
            target: "guide",
            session = %session_id,
            template = %template.name,
            slot = engine.slot(),
            "guide attached"
        );
        Ok(session_id)
    }

    /// Detach one guide session. The meeting keeps recording.
    pub async fn detach_guide(&self, session_id: &str) -> Result<(), String> {
        let guard = self.state.lock().await;
        let active = guard.as_ref().ok_or("No meeting is recording")?;
        let removed = {
            let mut engines = active.guide_engines.lock().unwrap();
            let before = engines.len();
            engines.retain(|e| e.session_id() != session_id);
            before != engines.len()
        };
        if !removed {
            return Err("Guide session not found".into());
        }
        let _ = self
            .app_handle
            .emit("guide-detached", serde_json::json!({ "sessionId": session_id }));
        tracing::info!(target: "guide", session = %session_id, "guide detached");
        Ok(())
    }
```

- [ ] **Step 5: Update `start_guided_session`** in `commands.rs` (~line 2591): delete the `start_context.guide_template = Some(template);` line, keep the rest of the context building, and after the `start(...)` call returns `id`, attach:

```rust
    let id = state
        .meeting_manager
        .clone()
        .start(None, None, start_context)
        .await
        .map_err(|e| e.to_string())?;
    state.meeting_manager.attach_guide(template).await?;
    Ok(id)
```

(Match the actual argument list of the existing `start(...)` call in that function — only the template handling changes.) Also delete the `guide_template: None,` field from the `MeetingStartContext` literal at ~line 2582, and any other `MeetingStartContext` literals the compiler flags (detector/tests use `..Default::default()` and won't need changes).

- [ ] **Step 6: Compile + full test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: everything passes (414+ tests). The compiler is the safety net for missed `guide_template` field uses — fix any residual references it reports (there should be none outside the sites listed).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/meeting/mod.rs src-tauri/src/commands.rs
git commit -m "feat(guide): always-on segment fan-out; attach/detach guides mid-meeting (cap 2)"
```

---

### Task 5: Tauri commands — attach/detach/transcript/HUD, per-session mode/trigger

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (invoke_handler list, lines ~307-314)

**Interfaces:**
- Consumes: Task 4's manager methods.
- Produces (commands): `attach_guide(template_id: String) -> String`, `detach_guide(session_id: String)`, `get_live_transcript() -> Vec<Segment>`, `show_meeting_hud(focus: Option<String>)`, `save_hud_frame(x, y, w, h: f64)`, `guide_set_mode(session_id: String, mode: String)`, `guide_trigger_now(session_id: String)`. Removes `guide_end`.
- Note: `show_meeting_hud` calls `crate::overlay::show_guide_overlay(&app, "", "", "auto")` as a placeholder until Task 6 lands the real function — **implement Task 6 immediately after** (or, if executing sequentially in one session, you may land Tasks 5+6 as one commit; keep the test steps of both).

- [ ] **Step 1: Rewrite the per-session commands** — replace the existing `guide_set_mode`, `guide_trigger_now`, and `guide_end` (delete it) at lines ~2617-2649:

```rust
#[tauri::command]
pub async fn attach_guide(
    state: tauri::State<'_, AppState>,
    template_id: String,
) -> Result<String, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let tid = template_id.clone();
    let template = db
        .with_conn(move |c| crate::db::guide_templates::get_template(c, &tid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("guide template {template_id} not found"))?;
    state.meeting_manager.attach_guide(template).await
}

#[tauri::command]
pub async fn detach_guide(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.meeting_manager.detach_guide(&session_id).await
}

#[tauri::command]
pub async fn get_live_transcript(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::meeting::Segment>, String> {
    Ok(state.meeting_manager.transcript_snapshot().await)
}

#[tauri::command]
pub fn show_meeting_hud(app: tauri::AppHandle, focus: Option<String>) {
    crate::overlay::show_meeting_hud(&app, focus.as_deref());
}

/// Persist the HUD's logical frame so the next show restores the user's
/// size/position instead of snapping back to the default slot.
#[tauri::command]
pub fn save_hud_frame(
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    state
        .settings
        .set_guide_overlay_frame(serde_json::json!({ "x": x, "y": y, "w": w, "h": h }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn guide_set_mode(
    state: tauri::State<'_, AppState>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    let m = crate::meeting::guidance::Mode::parse(&mode)
        .ok_or_else(|| format!("unknown guide mode: {mode}"))?;
    if let Some(engine) = state.meeting_manager.guide_engine_by_id(&session_id).await {
        engine.set_mode(m);
    }
    // Persist as the default for future sessions even if the engine is gone.
    state
        .settings
        .set_guide_overlay_mode(m)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn guide_trigger_now(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    match state.meeting_manager.guide_engine_by_id(&session_id).await {
        Some(engine) => {
            engine.fire_cycle();
            Ok(())
        }
        None => Err("no active guide session".into()),
    }
}
```

(If `state.settings` is not how existing commands access settings — the current `guide_set_mode` at line ~2570 shows the working pattern; mirror it exactly.)

- [ ] **Step 2: Register** in `lib.rs` — in the `invoke_handler` list replace `commands::guide_end,` with:

```rust
            commands::attach_guide,
            commands::detach_guide,
            commands::get_live_transcript,
            commands::show_meeting_hud,
            commands::save_hud_frame,
```

- [ ] **Step 3: Compile** — `cd src-tauri && cargo check`. Expected: one error — `crate::overlay::show_meeting_hud` missing (delivered by Task 6). Proceed to Task 6 and compile both together; if you must keep this task independently green, temporarily point `show_meeting_hud` at `crate::overlay::show_guide_overlay(&app, "", "", "auto");` and remove the shim in Task 6.

- [ ] **Step 4: Commit** (may be combined with Task 6's commit if the shim was skipped)

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(guide): attach/detach/transcript/HUD commands; per-session mode + trigger"
```

---

### Task 6: overlay.rs — resizable Meeting HUD window + wider meeting pill

**Files:**
- Modify: `src-tauri/src/overlay.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (the `hide_guide_overlay` call in `stop()` ~line 733; the two `show_guide_overlay`/`guide-init` lines in `attach_guide` from Task 4)
- Modify: `src-tauri/src/lib.rs` (`create_guide_overlay` call ~line 637)

**Interfaces:**
- Produces: `create_meeting_hud(app)`, `show_meeting_hud(app, focus: Option<&str>)` (emits `hud-focus {focus}`), `hide_meeting_hud(app)`, `emit_guide_init(app, payload: serde_json::Value)`. Window label remains `"guide_overlay"`; content URL becomes `src/meeting-hud/index.html`. Meeting-mode pill widens to 236 px.

- [ ] **Step 1: Replace the guide-overlay section** of `overlay.rs` (constants at lines ~268-272 and the three functions `calculate_guide_overlay_position` / `create_guide_overlay` / `show_guide_overlay` / `hide_guide_overlay`, lines ~268-384) with:

```rust
const HUD_MIN_WIDTH: f64 = 300.0;
const HUD_MIN_HEIGHT: f64 = 240.0;
const HUD_DEFAULT_WIDTH: f64 = 340.0;
const HUD_DEFAULT_HEIGHT: f64 = 440.0;
/// Vertical gap (logical px) between the recording pill's top edge and the
/// HUD's bottom edge in the default position.
const HUD_GAP_ABOVE_RECORDING: f64 = 12.0;

/// Default slot: bottom-center, just above the recording pill.
fn calculate_hud_default_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let x = ((logical_w - HUD_DEFAULT_WIDTH) / 2.0).max(0.0);
    let recording_top = logical_h - OVERLAY_HEIGHT - OVERLAY_BOTTOM_OFFSET;
    let y = (recording_top - HUD_GAP_ABOVE_RECORDING - HUD_DEFAULT_HEIGHT).max(0.0);
    Some((x, y))
}

/// The user's persisted HUD frame, if it's still (mostly) on the primary
/// monitor. A stale frame from an unplugged display must not strand the
/// HUD off-screen — in that case fall back to the default slot.
fn restored_hud_frame(app_handle: &AppHandle<Wry>) -> Option<(f64, f64, f64, f64)> {
    let settings = crate::settings::SettingsStore::load(app_handle).ok()?;
    let v = settings.guide_overlay_frame()?;
    let x = v.get("x")?.as_f64()?;
    let y = v.get("y")?.as_f64()?;
    let w = v.get("w")?.as_f64()?.max(HUD_MIN_WIDTH);
    let h = v.get("h")?.as_f64()?.max(HUD_MIN_HEIGHT);
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let mw = monitor.size().width as f64 / scale;
    let mh = monitor.size().height as f64 / scale;
    let on_screen = x > -w + 40.0 && x < mw - 40.0 && y >= 0.0 && y < mh - 40.0;
    if !on_screen {
        tracing::info!(target: "hud", x, y, "persisted HUD frame off-screen; using default position");
        return None;
    }
    Some((x, y, w, h))
}

/// Build the Meeting HUD webview window (hidden). Keeps the historical
/// window label "guide_overlay" so capabilities/default.json (and therefore
/// TCC state) is untouched. Idempotent.
pub fn create_meeting_hud(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("guide_overlay").is_some() {
        tracing::info!(target: "hud", "meeting HUD already exists; skipping create");
        return;
    }
    let (x, y, w, h) = restored_hud_frame(app_handle)
        .or_else(|| {
            calculate_hud_default_position(app_handle)
                .map(|(x, y)| (x, y, HUD_DEFAULT_WIDTH, HUD_DEFAULT_HEIGHT))
        })
        .unwrap_or((200.0, 200.0, HUD_DEFAULT_WIDTH, HUD_DEFAULT_HEIGHT));
    match WebviewWindowBuilder::new(
        app_handle,
        "guide_overlay",
        tauri::WebviewUrl::App("src/meeting-hud/index.html".into()),
    )
    .title("Meeting HUD")
    .position(x, y)
    .inner_size(w, h)
    .min_inner_size(HUD_MIN_WIDTH, HUD_MIN_HEIGHT)
    .resizable(true)
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
    .build()
    {
        Ok(_) => tracing::info!(target: "hud", "meeting HUD window created (hidden)"),
        Err(e) => tracing::error!(target: "hud", ?e, "failed to create meeting HUD window"),
    }
}

/// Show the Meeting HUD, restoring the user's last frame (or the default
/// above-pill slot), and tell the frontend which section to focus
/// ("transcript" | "guides").
pub fn show_meeting_hud(app_handle: &AppHandle<Wry>, focus: Option<&str>) {
    if app_handle.get_webview_window("guide_overlay").is_none() {
        tracing::warn!(target: "hud", "show_meeting_hud: window missing — building now");
        create_meeting_hud(app_handle);
    }
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        if let Some((x, y, wd, ht)) = restored_hud_frame(app_handle) {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize { width: wd, height: ht }));
        } else if let Some((x, y)) = calculate_hud_default_position(app_handle) {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        if let Err(e) = w.show() {
            tracing::error!(target: "hud", ?e, "meeting HUD show failed");
        }
        // Never let the HUD become key (same rationale as recording_overlay).
        let _ = w.set_always_on_top(true);
        if let Some(f) = focus {
            if let Err(e) = w.emit("hud-focus", serde_json::json!({ "focus": f })) {
                tracing::warn!(target: "hud", ?e, "hud-focus emit failed");
            }
        }
    }
}

pub fn hide_meeting_hud(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        let _ = w.hide();
    }
}

/// Emit `guide-init` to the HUD so a newly-attached guide renders its shell
/// before the first LLM cycle completes.
pub fn emit_guide_init(app_handle: &AppHandle<Wry>, payload: serde_json::Value) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        if let Err(e) = w.emit("guide-init", payload) {
            tracing::error!(target: "hud", ?e, "guide-init emit failed");
        }
    } else {
        let _ = app_handle.emit("guide-init", payload);
    }
}
```

- [ ] **Step 2: Widen the pill in meeting mode.** In `overlay.rs`: add `const MEETING_OVERLAY_WIDTH: f64 = 236.0;` under `OVERLAY_WIDTH`; change `calculate_overlay_position` to take a width: `fn calculate_overlay_position(app_handle: &AppHandle<Wry>, width: f64) -> Option<(f64, f64)>` using `width` instead of `OVERLAY_WIDTH` (update its two internal uses). Update every caller: `create_recording_overlay` and `show_overlay_state`/`show_processing_overlay` pass `OVERLAY_WIDTH` **and** reset size, `show_meeting_overlay` passes `MEETING_OVERLAY_WIDTH` and sets size. In `show_overlay_state` and `show_processing_overlay`, after the `set_position` call add:

```rust
        let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }));
```

and in `show_meeting_overlay`:

```rust
        let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: MEETING_OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }));
```

- [ ] **Step 3: Update callers.**
  - `lib.rs` ~line 637: `crate::overlay::create_guide_overlay(...)` → `crate::overlay::create_meeting_hud(...)`.
  - `meeting/mod.rs` `stop()` ~line 733: `hide_guide_overlay` → `hide_meeting_hud`.
  - `meeting/mod.rs` `attach_guide` (from Task 4): replace the `show_guide_overlay(...)` line with `crate::overlay::show_meeting_hud(&self.app_handle, Some("guides"));` and replace `self.app_handle.emit("guide-init", ...)` with `crate::overlay::emit_guide_init(&self.app_handle, serde_json::json!({...}))` (same payload).
  - Remove the Task 5 shim in `commands::show_meeting_hud` if one was added.

- [ ] **Step 4: Compile + tests**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS; no remaining references to `create_guide_overlay` / `show_guide_overlay` / `hide_guide_overlay` (`grep -rn "guide_overlay" src-tauri/src --include="*.rs"` should show only the window-label strings and settings keys).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/overlay.rs src-tauri/src/meeting/mod.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(hud): resizable meeting HUD window with frame persistence; wider meeting pill"
```

---

### Task 7: Frontend API wrappers

**Files:**
- Modify: `src/lib/api.ts` (guide section, lines ~987-1040)

**Interfaces:**
- Produces: `attachGuide`, `detachGuide`, `getLiveTranscript`, `showMeetingHud`, `saveHudFrame`, updated `guideSetMode(sessionId, mode)` / `guideTriggerNow(sessionId)`; types `TranscriptSegment`, `GuideInit`, updated `GuideUpdate` (+`sessionId`, `slot`). Removes `guideEnd`.

- [ ] **Step 1: Apply the edits.** Replace `guideSetMode` / `guideTriggerNow` / `guideEnd` (lines ~1025-1030) with:

```ts
export const attachGuide = (templateId: string): Promise<string> =>
  invoke("attach_guide", { templateId });

export const detachGuide = (sessionId: string): Promise<void> =>
  invoke("detach_guide", { sessionId });

export const guideSetMode = (
  sessionId: string,
  mode: "auto" | "on_demand",
): Promise<void> => invoke("guide_set_mode", { sessionId, mode });

export const guideTriggerNow = (sessionId: string): Promise<void> =>
  invoke("guide_trigger_now", { sessionId });

export type TranscriptSegment = {
  speaker: "you" | "them";
  start_ms: number;
  end_ms: number;
  text: string;
};

export const getLiveTranscript = (): Promise<TranscriptSegment[]> =>
  invoke("get_live_transcript");

export const showMeetingHud = (
  focus?: "transcript" | "guides",
): Promise<void> => invoke("show_meeting_hud", { focus: focus ?? null });

export const saveHudFrame = (
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> => invoke("save_hud_frame", { x, y, w, h });
```

Update `GuideUpdate` (line ~1032) and add `GuideInit`:

```ts
export type GuideInit = {
  sessionId: string;
  slot: number;
  templateName: string;
  goal: string;
  mode: "auto" | "on_demand";
};

export type GuideUpdate = {
  sessionId: string;
  slot: number;
  meetingId: string;
  templateName?: string;
  goal?: string;
  mode: "auto" | "on_demand";
  keyPoints: GuideKeyPoint[];
  suggestions: string[];
  updatedAt: string;
};
```

- [ ] **Step 2: Type-check** — `bun run build`. Expected: fails only in `src/guide-overlay/GuideOverlay.tsx` (stale `guide_end` usage) — that file is deleted in Task 8; everything else clean. If other files reference `guideEnd`, fix them now.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(hud): frontend API for attach/detach guides, live transcript, HUD control"
```

---

### Task 8: Meeting HUD frontend (new window app)

**Files:**
- Create: `src/meeting-hud/index.html`, `src/meeting-hud/main.tsx`, `src/meeting-hud/MeetingHud.tsx`, `src/meeting-hud/MeetingHud.css`
- Delete: `src/guide-overlay/` (all four files)
- Modify: `vite.config.ts` (rollup input: replace `guide` entry)

**Interfaces:**
- Consumes: api.ts wrappers from Task 7; events `guide-init` (`GuideInit`), `guide-update` (`GuideUpdate`), `guide-detached` (`{sessionId}`), `meeting-segment` (`{meetingId, segment: TranscriptSegment}`), `meeting-status` (`{id, status}`), `meeting-started`, `hud-focus` (`{focus}`).

- [ ] **Step 1: vite.config.ts** — in `build.rollupOptions.input` replace

```ts
        guide: resolve(__dirname, "src/guide-overlay/index.html"),
```

with

```ts
        "meeting-hud": resolve(__dirname, "src/meeting-hud/index.html"),
```

- [ ] **Step 2: `src/meeting-hud/index.html`** (mirrors the old guide-overlay shell, but scrollable root):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Meeting HUD</title>
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

- [ ] **Step 3: `src/meeting-hud/main.tsx`**:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import MeetingHud from "./MeetingHud";
import "./MeetingHud.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MeetingHud />
  </React.StrictMode>,
);
```

- [ ] **Step 4: `src/meeting-hud/MeetingHud.tsx`** — the full component:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  attachGuide,
  detachGuide,
  getLiveTranscript,
  guideSetMode,
  guideTriggerNow,
  listGuideTemplates,
  saveHudFrame,
  type GuideInit,
  type GuideKeyPoint,
  type GuideTemplate,
  type GuideUpdate,
  type TranscriptSegment,
} from "../lib/api";

type GuideSession = {
  sessionId: string;
  slot: number;
  templateName: string;
  goal: string;
  mode: "auto" | "on_demand";
  keyPoints: GuideKeyPoint[];
  updatedAt?: string;
  collapsed: boolean;
};

type Card = {
  key: string;
  sessionId: string;
  slot: number;
  templateName: string;
  suggestions: string[];
  at: number;
};

const MAX_CARDS = 50;

function statusMarker(s: string): string {
  if (s === "covered") return "✓";
  if (s === "partial") return "…";
  return "○";
}

function relativeAge(t: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

export default function MeetingHud() {
  const [sessions, setSessions] = useState<Record<string, GuideSession>>({});
  const [cards, setCards] = useState<Card[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [showTranscript, setShowTranscript] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templates, setTemplates] = useState<GuideTemplate[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const cardSeq = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const backfillTranscript = useCallback(() => {
    getLiveTranscript()
      .then(setSegments)
      .catch(() => {/* no active meeting — leave empty */});
  }, []);

  // Event wiring.
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<GuideInit>("guide-init", (e) => {
        setSessions((prev) => ({
          ...prev,
          [e.payload.sessionId]: {
            sessionId: e.payload.sessionId,
            slot: e.payload.slot,
            templateName: e.payload.templateName,
            goal: e.payload.goal,
            mode: e.payload.mode,
            keyPoints: [],
            collapsed: false,
          },
        }));
      }),
      listen<GuideUpdate>("guide-update", (e) => {
        const p = e.payload;
        setSessions((prev) => {
          const existing = prev[p.sessionId];
          return {
            ...prev,
            [p.sessionId]: {
              sessionId: p.sessionId,
              slot: p.slot,
              templateName: p.templateName ?? existing?.templateName ?? "Guide",
              goal: p.goal ?? existing?.goal ?? "",
              mode: p.mode,
              keyPoints: p.keyPoints,
              updatedAt: p.updatedAt,
              collapsed: existing?.collapsed ?? false,
            },
          };
        });
        if (p.suggestions.length > 0) {
          setCards((prev) =>
            [
              {
                key: `c${cardSeq.current++}`,
                sessionId: p.sessionId,
                slot: p.slot,
                templateName: p.templateName ?? "Guide",
                suggestions: p.suggestions,
                at: Date.now(),
              },
              ...prev,
            ].slice(0, MAX_CARDS),
          );
        }
      }),
      listen<{ sessionId: string }>("guide-detached", (e) => {
        setSessions((prev) => {
          const next = { ...prev };
          delete next[e.payload.sessionId];
          return next;
        });
      }),
      listen<{ meetingId: string; segment: TranscriptSegment }>("meeting-segment", (e) => {
        setSegments((prev) => [...prev, e.payload.segment]);
      }),
      listen<{ focus: string }>("hud-focus", (e) => {
        if (e.payload.focus === "transcript") {
          setShowTranscript(true);
          backfillTranscript();
        } else if (e.payload.focus === "guides") {
          setPickerOpen(true);
          listGuideTemplates().then(setTemplates).catch(() => setTemplates([]));
        }
      }),
      listen("meeting-started", () => {
        setSessions({});
        setCards([]);
        setSegments([]);
        setPickerOpen(false);
      }),
      // Meeting moved past recording → HUD no longer meaningful; backend
      // hides the window, we clear the state for the next meeting.
      listen<{ id: string; status: string }>("meeting-status", (e) => {
        if (["transcribing", "summarizing", "complete"].includes(e.payload.status)) {
          setSessions({});
          setPickerOpen(false);
        }
      }),
    ];
    backfillTranscript();
    return () => {
      unlisteners.forEach((p) => p.then((u) => u()));
    };
  }, [backfillTranscript]);

  // Persist the window frame (debounced) whenever the user moves/resizes.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queueSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const sf = await win.scaleFactor();
          const pos = await win.outerPosition();
          const size = await win.innerSize();
          await saveHudFrame(pos.x / sf, pos.y / sf, size.width / sf, size.height / sf);
        } catch {
          /* window closing — ignore */
        }
      }, 500);
    };
    const unlisteners = [win.onMoved(queueSave), win.onResized(queueSave)];
    return () => {
      unlisteners.forEach((p) => p.then((u) => u()));
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Staleness tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Transcript stick-to-bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [segments, showTranscript]);

  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const sessionList = Object.values(sessions).sort((a, b) => a.slot - b.slot);
  const atCap = sessionList.length >= 2;

  const onAttach = useCallback(
    async (templateId: string) => {
      try {
        await attachGuide(templateId);
        setPickerOpen(false);
      } catch (err) {
        showToast(String(err));
      }
    },
    [showToast],
  );

  const onDetach = useCallback(async (sessionId: string) => {
    try {
      await detachGuide(sessionId);
    } catch {
      /* already gone */
    }
  }, []);

  const onToggleMode = useCallback(async (s: GuideSession) => {
    const next = s.mode === "auto" ? "on_demand" : "auto";
    try {
      await guideSetMode(s.sessionId, next);
      setSessions((prev) => ({ ...prev, [s.sessionId]: { ...s, mode: next } }));
    } catch {
      /* swallow */
    }
  }, []);

  const onOpenPicker = useCallback(() => {
    setPickerOpen((open) => !open);
    listGuideTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  return (
    <div className="hud">
      <header data-tauri-drag-region>
        <span className="label" data-tauri-drag-region>MEETING HUD</span>
        <span className="controls">
          <button
            className={showTranscript ? "active" : ""}
            onClick={() => {
              setShowTranscript((v) => !v);
              if (!showTranscript) backfillTranscript();
            }}
            title="Toggle live transcript"
          >
            ☰
          </button>
          <button onClick={() => getCurrentWindow().hide()} title="Hide (meeting keeps recording)">
            ─
          </button>
        </span>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <div className="body">
        <section className="guides">
          {sessionList.map((s) => (
            <div key={s.sessionId} className={`guide slot${s.slot}`}>
              <div className="guide-head">
                <button
                  className="chip"
                  onClick={() =>
                    setSessions((prev) => ({
                      ...prev,
                      [s.sessionId]: { ...s, collapsed: !s.collapsed },
                    }))
                  }
                  title={s.collapsed ? "Expand" : "Collapse"}
                >
                  {s.templateName}
                </button>
                <span className="guide-controls">
                  {s.mode === "auto" ? (
                    <button className="mode" onClick={() => onToggleMode(s)}>Auto</button>
                  ) : (
                    <>
                      <button className="mode" onClick={() => guideTriggerNow(s.sessionId).catch(() => {})}>
                        Guide me now
                      </button>
                      <button className="mode" onClick={() => onToggleMode(s)}>On-demand</button>
                    </>
                  )}
                  <button className="end" onClick={() => onDetach(s.sessionId)} title="End this guide">
                    ×
                  </button>
                </span>
              </div>
              {!s.collapsed && (
                <>
                  {s.goal && <div className="goal">{s.goal}</div>}
                  {s.keyPoints.length === 0 ? (
                    <div className="waiting">
                      <span className="spinner" aria-hidden="true" />
                      <span>Listening… first guidance arrives after ~20–30s of speech.</span>
                    </div>
                  ) : (
                    s.keyPoints.map((p) => (
                      <div key={p.id} className={`point ${p.status}`}>
                        <span className="marker">{statusMarker(p.status)}</span>
                        <span>{p.label}</span>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          ))}

          <div className="add-guide">
            <button className="add" onClick={onOpenPicker} disabled={atCap}>
              + Add guide
            </button>
            {atCap && <span className="cap-note">two guides max — close one to add another</span>}
            {pickerOpen && !atCap && (
              <div className="picker">
                {templates.length === 0 && <div className="empty">No templates yet.</div>}
                {templates.map((t) => (
                  <button key={t.id} className="picker-item" onClick={() => onAttach(t.id)}>
                    <span className="picker-name">{t.name}</span>
                    {t.description && <span className="picker-desc">{t.description}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="feed">
          {cards.length === 0 ? (
            <div className="empty">Guidance cards appear here — newest on top.</div>
          ) : (
            cards.map((c) => (
              <div key={c.key} className={`card slot${c.slot}`}>
                <div className="card-head">
                  <span className="chip">{c.templateName}</span>
                  <span className="age">{relativeAge(c.at, now)}</span>
                </div>
                {c.suggestions.map((s, i) => (
                  <div key={i} className="suggest">{s}</div>
                ))}
              </div>
            ))
          )}
        </section>

        {showTranscript && (
          <section className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
            {segments.length === 0 ? (
              <div className="empty">Transcript appears here as speech is transcribed.</div>
            ) : (
              segments.map((seg, i) => (
                <div key={i} className={`line ${seg.speaker}`}>
                  <span className="speaker">{seg.speaker === "you" ? "You" : "Them"}</span>
                  <span>{seg.text}</span>
                </div>
              ))
            )}
          </section>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: `src/meeting-hud/MeetingHud.css`** — same palette as the old GuideOverlay.css, extended:

```css
:root {
  color-scheme: dark;
}

.hud {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 12px);
  margin: 6px;
  background: rgba(17, 21, 28, 0.93);
  border: 1px solid #2d3340;
  border-radius: 10px;
  color: #cdd3df;
  font-size: 11px;
  line-height: 1.35;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  box-sizing: border-box;
}

.hud header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 6px 10px;
  flex-shrink: 0;
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
.hud .controls button.active { color: #7c8aff; }

.toast {
  margin: 0 10px 4px 10px;
  padding: 6px 9px;
  background: #3a2430;
  border: 1px solid #5c3644;
  border-radius: 6px;
  color: #e8b4c4;
  flex-shrink: 0;
}

.body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* -- guides ---------------------------------------------------------- */
.guides {
  padding: 0 10px;
  flex-shrink: 0;
  max-height: 45%;
  overflow-y: auto;
}

.guide { padding: 4px 0; border-bottom: 1px solid #232a36; }

.guide-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.chip {
  border: 0;
  border-radius: 5px;
  padding: 2px 7px;
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.03em;
  cursor: pointer;
  color: #11151c;
  font-weight: 600;
}
.slot0 .chip, .card.slot0 .chip { background: #7c8aff; }
.slot1 .chip, .card.slot1 .chip { background: #e6a06b; }

.guide-controls { display: flex; align-items: center; gap: 4px; }
.guide-controls .mode {
  background: transparent;
  border: 0;
  color: #7c8aff;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.guide-controls .end {
  background: transparent;
  border: 0;
  color: #e06c75;
  font: inherit;
  cursor: pointer;
  padding: 0 3px;
}

.goal { color: #9fb0c9; margin: 3px 0 4px 0; }

.point { display: flex; align-items: baseline; gap: 6px; padding: 1px 0; }
.point.covered { color: #7fd1a0; }
.point.partial { color: #e6c07b; }
.point.open    { color: #6b7589; }
.marker { font-size: 11px; width: 14px; display: inline-block; }

.waiting { display: flex; align-items: center; gap: 8px; padding: 4px 0; color: #9fb0c9; }
.spinner {
  width: 10px; height: 10px;
  border: 1.5px solid #2d3340;
  border-top-color: #7c8aff;
  border-radius: 50%;
  animation: hud-spin 0.9s linear infinite;
}
@keyframes hud-spin { to { transform: rotate(360deg); } }

.add-guide { padding: 6px 0; position: relative; }
.add-guide .add {
  background: #1a1f29;
  border: 1px dashed #2d3340;
  border-radius: 6px;
  color: #7c8aff;
  font: inherit;
  padding: 4px 10px;
  cursor: pointer;
  width: 100%;
}
.add-guide .add:disabled { color: #5b6472; cursor: default; }
.cap-note { display: block; color: #5b6472; font-size: 10px; padding-top: 2px; }

.picker {
  margin-top: 4px;
  background: #1a1f29;
  border: 1px solid #2d3340;
  border-radius: 6px;
  max-height: 160px;
  overflow-y: auto;
}
.picker-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid #232a36;
  color: #cdd3df;
  font: inherit;
  padding: 6px 9px;
  cursor: pointer;
}
.picker-item:hover { background: #232a36; }
.picker-item:last-child { border-bottom: 0; }
.picker-name { display: block; font-weight: 600; }
.picker-desc { display: block; color: #6b7589; font-size: 10px; }

/* -- card feed ------------------------------------------------------- */
.feed {
  flex: 1;
  min-height: 60px;
  overflow-y: auto;
  padding: 6px 10px;
}

.card {
  background: #1a1f29;
  border: 1px solid #232a36;
  border-radius: 8px;
  padding: 7px 9px;
  margin-bottom: 6px;
}
.card.slot0 { border-left: 3px solid #7c8aff; }
.card.slot1 { border-left: 3px solid #e6a06b; }

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.card-head .chip { cursor: default; }
.age { color: #5b6472; font-size: 10px; }
.suggest { padding: 2px 0; }

/* -- transcript ------------------------------------------------------ */
.transcript {
  flex-shrink: 0;
  height: 35%;
  min-height: 80px;
  overflow-y: auto;
  border-top: 1px solid #232a36;
  padding: 6px 10px;
  background: rgba(10, 13, 18, 0.5);
}
.line { display: flex; gap: 6px; padding: 1px 0; }
.line .speaker { flex-shrink: 0; width: 34px; font-weight: 600; }
.line.you .speaker { color: #7c8aff; }
.line.them .speaker { color: #e6a06b; }

.empty { color: #5b6472; padding: 8px 0; }
```

- [ ] **Step 6: Delete `src/guide-overlay/`**:

```bash
rm -rf src/guide-overlay
```

- [ ] **Step 7: Type-check + build**

Run: `bun run build`
Expected: clean (`tsc` + vite build with the new `meeting-hud` entry).

- [ ] **Step 8: Commit**

```bash
git add -A src/meeting-hud vite.config.ts
git add -u src/guide-overlay
git commit -m "feat(hud): meeting HUD frontend — guides, merged card feed, live transcript"
```

---

### Task 9: Meeting pill buttons

**Files:**
- Modify: `src/overlay/RecordingOverlay.tsx`
- Modify: `src/overlay/RecordingOverlay.css`

**Interfaces:**
- Consumes: `show_meeting_hud` command (invoked dynamically, matching the file's existing import style).

- [ ] **Step 1: Add icons + buttons.** In `RecordingOverlay.tsx`, add two icon components next to `CancelIcon`:

```tsx
const TranscriptIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M2 2.5h8M2 5h8M2 7.5h5"
      stroke="#d4eeff"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

const GuideIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M6 1.5l1.2 2.8L10 5.5 7.2 6.7 6 9.5 4.8 6.7 2 5.5l2.8-1.2L6 1.5Z"
      fill="#ffe5ee"
    />
  </svg>
);
```

Replace the `{isMeeting && (` block in `overlay-right` (the single stop button) with:

```tsx
        {isMeeting && (
          <>
            <button
              className="hud-button"
              onClick={() => {
                import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("show_meeting_hud", { focus: "transcript" }).catch(() => {}),
                );
              }}
              title="Live transcript"
            >
              <TranscriptIcon />
            </button>
            <button
              className="hud-button"
              onClick={() => {
                import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("show_meeting_hud", { focus: "guides" }).catch(() => {}),
                );
              }}
              title="Guided templates"
            >
              <GuideIcon />
            </button>
            <button
              className="cancel-button"
              onClick={() => {
                import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("stop_meeting").catch(() => {}),
                );
              }}
              title="Stop meeting"
            >
              <CancelIcon />
            </button>
          </>
        )}
```

- [ ] **Step 2: CSS.** In `RecordingOverlay.css`: the pill's width is hardcoded; make it fill the window instead so the Rust-side resize (172 ↔ 236) drives it. Change `.recording-overlay`'s `width: 172px;` to `width: 100vw;` and add:

```css
.hud-button {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 150ms ease-out, transform 100ms ease-out;
  flex-shrink: 0;
}
.hud-button:hover { background: #ffffff22; transform: scale(1.05); }
.hud-button:active { transform: scale(0.95); }
```

- [ ] **Step 3: Type-check** — `bun run build`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/overlay/RecordingOverlay.tsx src/overlay/RecordingOverlay.css
git commit -m "feat(hud): transcript + guide buttons on the meeting pill"
```

---

### Task 10: Full verification + install

- [ ] **Step 1: Full Rust suite** — `cd src-tauri && cargo test --lib`. Expected: all pass.
- [ ] **Step 2: Frontend** — `bun run build`. Expected: clean.
- [ ] **Step 3: Release build** — `bun tauri build --bundles app`. Expected: `src-tauri/target/release/bundle/macos/Echo Scribe.app` produced.
- [ ] **Step 4: Skip-TCC reinstall** (no permission-related changes were made):

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 5: Manual QA checklist** (hardware required — hand to Denis):
  1. Start a meeting (auto-detect or manual). Pill shows Transcript + Guide buttons and is wider.
  2. Click Transcript → HUD opens with transcript pane; speak → lines appear, sticks to bottom; scroll up → stops sticking.
  3. Click Guide → picker opens listing the 5 builtins + user templates. Attach one mid-meeting → shell renders, first card arrives after ~20-30s of speech; card appears on top.
  4. Attach a second guide → second checklist + interleaved tagged cards. Try a third → friendly cap message.
  5. Resize + move the HUD; hide it; reopen from pill → frame restored.
  6. "×" one guide → other guide + meeting keep running.
  7. Stop meeting from pill → HUD hides; transcript + summary produce as before; meeting row's `guide_template_json` holds an array of 2 snapshots.
  8. Check `echo-scribe.log` for `target="guide"` attach/detach lines and no unexpected `error!`.
- [ ] **Step 6: Merge to main** (per Denis's branch workflow: merge completed+verified work straight to main, delete branch) — after QA passes.
