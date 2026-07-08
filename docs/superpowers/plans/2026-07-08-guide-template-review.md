# Guide Template Post-Meeting Review & Cross-Meeting Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each guide's runtime data with the meeting and, at meeting end, auto-generate a whole-transcript coaching review (scorecard + emergent observations + synthesis) per attached guide, surfaced in a per-meeting review panel and a cross-meeting trend view.

**Architecture:** A new `meeting_guide_runs` table (one row per attached guide per meeting) is created at guide-attach time with `status='pending'`. The live guidance engine accumulates a deduped timeline in memory. At meeting stop, timelines are flushed and a background task per guide runs a new review pass (reusing the synthesizer's chunked map-reduce), writing `review_json` and flipping `status` to `ready`/`failed`. The frontend reads runs via new commands and renders a narrative-first review panel with expandable criteria plus a trend heatmap.

**Tech Stack:** Rust (Tauri v2, `rusqlite`, `tokio`, `tracing`, `serde`), React + TypeScript (Tailwind), `bun:test`, `cargo test`.

## Global Constraints

- Rust DB functions take `&Connection` and return `Result<T, crate::db::DbError>`; callers reach them via `db.with_conn(|c| …)` / `db.with_conn_mut(|c| …)`. Never pass the `Db` handle into the db layer.
- Tauri commands: `#[tauri::command]`, take `state: State<'_, AppState>`, return `Result<T, String>`, map DB errors with `.map_err(|e| e.to_string())`, get the DB via `require_db(&state)?`. Sync for pure-DB; `async` when touching `meeting_manager`/`llm`.
- Frontend api wrappers: `export const fn = (…): Promise<T> => invoke("snake_case_command", { camelCaseArgs })`. Types are `export type X = {…}`. Tauri maps camelCase JS args → snake_case Rust params.
- ULIDs: `ulid::Ulid::new().to_string()`. Timestamps: `chrono::Utc::now().to_rfc3339()` (or the existing `chrono_now_iso()` helper in `commands.rs`).
- Logging: use `tracing` with `target: "guide"` for all guide-review log lines. Never log transcript contents beyond short evidence already destined for storage. Friendly UI messages on failure; raw detail in the log.
- LLM prompt builders return `(Option<String>, String)` = `(system, user)`, assigned to `GenerateRequest.system`/`.user`.
- JSON from the LLM is parsed loosely (fields `#[serde(default)]`, verdict/status as free `String`), mirroring `GuidanceResponse`/`DerivedPoint`.
- Rust tests: `cd src-tauri && cargo test --lib`. Frontend tests: `bun test` (bun:test; there is no npm test script). Frontend typecheck/build: `bun run build`.
- Current schema version is **23**; this plan adds migration **24**. Two existing tests hardcode `assert_eq!(…, "23")` and MUST be bumped to `"24"`.

---

## File Structure

**Create:**
- `src-tauri/src/db/meeting_guide_runs.rs` — `GuideRunRow` struct + CRUD (mirrors `db/guide_templates.rs`).
- `src-tauri/src/meeting/guide_review.rs` — `GuideReview`/`ScorecardItem`/`EmergentItem` types + `generate_review()`.
- `src/lib/guideReview.ts` — pure, unit-tested helpers (parse review/timeline, notes→criteria, trend aggregation).
- `src/components/GuideTrendView.tsx` — cross-meeting trend modal.
- `tests/guideReview.test.ts` — bun:test for the `src/lib/guideReview.ts` helpers.

**Modify:**
- `src-tauri/src/db/schema.rs` — append migration `(24, …)`; bump two `"23"` assertions; add v24 test.
- `src-tauri/src/db/mod.rs` — add `pub mod meeting_guide_runs;`.
- `src-tauri/src/meeting/guidance.rs` — `TimelineEntry` type; `timeline` field on `State`; dedup-append in `run_one_cycle`; `run_id` field + `set_run_id`/`run_id`/`drain_timeline` accessors; make `isolate_json_object` `pub(crate)`.
- `src-tauri/src/meeting/synthesizer.rs` — make `condense_transcript` `pub(crate)`.
- `src-tauri/src/meeting/mod.rs` — declare `pub mod guide_review;`; insert run row in `attach_guide`; flush timelines + spawn review tasks in `stop()`.
- `src-tauri/src/llm/prompt.rs` — add `build_guide_review_prompt`.
- `src-tauri/src/commands.rs` — add `list_guide_runs`, `guide_runs_for_template`, `regenerate_guide_review`.
- `src-tauri/src/lib.rs` — register the three new commands.
- `src/lib/api.ts` — `GuideRun`/`GuideReview`/`ScorecardItem`/`EmergentItem`/`TimelineEntry` types + wrappers.
- `src/components/ActivityPanel.tsx` — `GuideReviewSection` component + insert into `MeetingView`.

**Phase checkpoint:** After **Task 9** the per-meeting feature ships end-to-end. Tasks 10–11 add the trend view.

---

## Task 1: Migration v24 — `meeting_guide_runs` table

**Files:**
- Modify: `src-tauri/src/db/schema.rs` (append tuple before the `];` at ~line 353; bump assertions at ~lines 414 and 568; add a test)

**Interfaces:**
- Produces: table `meeting_guide_runs` with columns `id, meeting_id, template_id, template_name, template_json, slot, started_at, timeline_json, review_json, status, error, generated_at, created_at`; indexes `idx_guide_runs_meeting`, `idx_guide_runs_template`.

- [ ] **Step 1: Bump the two existing version assertions and add the new-table test**

In `src-tauri/src/db/schema.rs`, change the two `assert_eq!(v, "23");` / `assert_eq!(version, "23");` lines (in `migrations_are_idempotent` and `migration_v7_creates_meetings_tables`) to `"24"`. Then add this test inside the `#[cfg(test)] mod tests` block:

```rust
    #[test]
    fn migration_v24_creates_meeting_guide_runs() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'meeting_guide_runs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(meeting_guide_runs)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in [
            "id", "meeting_id", "template_id", "template_name", "template_json",
            "slot", "started_at", "timeline_json", "review_json", "status",
            "error", "generated_at", "created_at",
        ] {
            assert!(cols.iter().any(|c| c == expected), "missing column {expected}; got {cols:?}");
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib migration_v24_creates_meeting_guide_runs migrations_are_idempotent migration_v7_creates_meetings_tables`
Expected: FAIL — new-table test fails (no table); the two bumped tests fail (`"23"` still applied, version mismatch).

- [ ] **Step 3: Append the v24 migration tuple**

In the `MIGRATIONS` slice, immediately before the closing `];` (after the `(23, …)` tuple), add:

```rust
    (
        24,
        r#"
CREATE TABLE meeting_guide_runs (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(item_id) ON DELETE CASCADE,
  template_id   TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_json TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  timeline_json TEXT,
  review_json   TEXT,
  status        TEXT NOT NULL,
  error         TEXT,
  generated_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_guide_runs_meeting  ON meeting_guide_runs(meeting_id);
CREATE INDEX idx_guide_runs_template ON meeting_guide_runs(template_id);
"#,
    ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib migration_v24_creates_meeting_guide_runs migrations_are_idempotent migration_v7_creates_meetings_tables`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/schema.rs
git commit -m "feat(db): migration v24 adds meeting_guide_runs table"
```

---

## Task 2: `db/meeting_guide_runs.rs` CRUD module

**Files:**
- Create: `src-tauri/src/db/meeting_guide_runs.rs`
- Modify: `src-tauri/src/db/mod.rs` (add `pub mod meeting_guide_runs;` to the module block at lines 16-29)

**Interfaces:**
- Produces:
  - `struct GuideRunRow { id, meeting_id, template_id, template_name, template_json: String, slot: i64, started_at: String, timeline_json: Option<String>, review_json: Option<String>, status: String, error: Option<String>, generated_at: Option<String>, created_at: String }`
  - `insert_guide_run(conn, &GuideRunRow) -> Result<(), DbError>`
  - `update_guide_run_timeline(conn, id: &str, timeline_json: Option<&str>) -> Result<(), DbError>`
  - `update_guide_run_review(conn, id: &str, review_json: Option<&str>, status: &str, generated_at: Option<&str>) -> Result<(), DbError>`
  - `set_guide_run_status(conn, id: &str, status: &str, error: Option<&str>) -> Result<(), DbError>`
  - `get_guide_run(conn, id: &str) -> Result<Option<GuideRunRow>, DbError>`
  - `list_guide_runs_for_meeting(conn, meeting_id: &str) -> Result<Vec<GuideRunRow>, DbError>`
  - `list_guide_runs_for_template(conn, template_id: &str, limit: i64) -> Result<Vec<GuideRunRow>, DbError>`

- [ ] **Step 1: Add the module declaration**

In `src-tauri/src/db/mod.rs`, add to the `pub mod …;` block (alphabetical-ish, near `meetings`):

```rust
pub mod meeting_guide_runs;
```

- [ ] **Step 2: Write the module with a failing round-trip test**

Create `src-tauri/src/db/meeting_guide_runs.rs`:

```rust
//! CRUD for `meeting_guide_runs`: one row per guide attached to a meeting.
//! A row is created at guide-attach time (`status = "pending"`), its timeline
//! is flushed at meeting stop, and its review is filled in by a background
//! job (`status` → "ready" | "failed"). Mirrors `db/guide_templates.rs`.

use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GuideRunRow {
    pub id: String,
    pub meeting_id: String,
    pub template_id: String,
    pub template_name: String,
    pub template_json: String,
    pub slot: i64,
    pub started_at: String,
    pub timeline_json: Option<String>,
    pub review_json: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub generated_at: Option<String>,
    pub created_at: String,
}

const COLS: &str = "id, meeting_id, template_id, template_name, template_json, slot, \
started_at, timeline_json, review_json, status, error, generated_at, created_at";

fn row_to_run(row: &Row<'_>) -> rusqlite::Result<GuideRunRow> {
    Ok(GuideRunRow {
        id: row.get("id")?,
        meeting_id: row.get("meeting_id")?,
        template_id: row.get("template_id")?,
        template_name: row.get("template_name")?,
        template_json: row.get("template_json")?,
        slot: row.get("slot")?,
        started_at: row.get("started_at")?,
        timeline_json: row.get("timeline_json")?,
        review_json: row.get("review_json")?,
        status: row.get("status")?,
        error: row.get("error")?,
        generated_at: row.get("generated_at")?,
        created_at: row.get("created_at")?,
    })
}

pub fn insert_guide_run(conn: &Connection, r: &GuideRunRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meeting_guide_runs
            (id, meeting_id, template_id, template_name, template_json, slot,
             started_at, timeline_json, review_json, status, error, generated_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            r.id, r.meeting_id, r.template_id, r.template_name, r.template_json, r.slot,
            r.started_at, r.timeline_json, r.review_json, r.status, r.error, r.generated_at, r.created_at
        ],
    )?;
    Ok(())
}

pub fn update_guide_run_timeline(
    conn: &Connection,
    id: &str,
    timeline_json: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs SET timeline_json = ?1 WHERE id = ?2",
        params![timeline_json, id],
    )?;
    Ok(())
}

pub fn update_guide_run_review(
    conn: &Connection,
    id: &str,
    review_json: Option<&str>,
    status: &str,
    generated_at: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs SET review_json = ?1, status = ?2, generated_at = ?3, error = NULL WHERE id = ?4",
        params![review_json, status, generated_at, id],
    )?;
    Ok(())
}

pub fn set_guide_run_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs SET status = ?1, error = ?2 WHERE id = ?3",
        params![status, error, id],
    )?;
    Ok(())
}

pub fn get_guide_run(conn: &Connection, id: &str) -> Result<Option<GuideRunRow>, DbError> {
    conn.query_row(
        &format!("SELECT {COLS} FROM meeting_guide_runs WHERE id = ?1"),
        [id],
        row_to_run,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn list_guide_runs_for_meeting(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<GuideRunRow>, DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM meeting_guide_runs WHERE meeting_id = ?1 ORDER BY slot ASC"
    ))?;
    let rows = stmt
        .query_map([meeting_id], row_to_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_guide_runs_for_template(
    conn: &Connection,
    template_id: &str,
    limit: i64,
) -> Result<Vec<GuideRunRow>, DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM meeting_guide_runs
         WHERE template_id = ?1 AND status = 'ready'
         ORDER BY started_at DESC LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![template_id, limit], row_to_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        // meeting_guide_runs.meeting_id has a FK to meetings(item_id) with
        // foreign_keys defaulting OFF for in-memory conns, so inserts don't
        // require a parent row here.
        conn
    }

    fn make(id: &str, meeting: &str) -> GuideRunRow {
        GuideRunRow {
            id: id.into(),
            meeting_id: meeting.into(),
            template_id: "builtin-leadership".into(),
            template_name: "Leadership presence".into(),
            template_json: r#"{"goal":"g","notes":"a\nb"}"#.into(),
            slot: 0,
            started_at: "2026-07-08T16:19:08Z".into(),
            timeline_json: None,
            review_json: None,
            status: "pending".into(),
            error: None,
            generated_at: None,
            created_at: "2026-07-08T16:19:08Z".into(),
        }
    }

    #[test]
    fn insert_get_round_trip() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        assert_eq!(get_guide_run(&c, "r1").unwrap().unwrap(), make("r1", "m1"));
    }

    #[test]
    fn update_timeline_then_review_transitions_status() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        update_guide_run_timeline(&c, "r1", Some("[]")).unwrap();
        update_guide_run_review(&c, "r1", Some(r#"{"overall":"mixed"}"#), "ready", Some("2026-07-08T17:00:00Z")).unwrap();
        let got = get_guide_run(&c, "r1").unwrap().unwrap();
        assert_eq!(got.timeline_json.as_deref(), Some("[]"));
        assert_eq!(got.status, "ready");
        assert_eq!(got.review_json.as_deref(), Some(r#"{"overall":"mixed"}"#));
        assert_eq!(got.generated_at.as_deref(), Some("2026-07-08T17:00:00Z"));
    }

    #[test]
    fn set_status_failed_records_error() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        set_guide_run_status(&c, "r1", "failed", Some("boom")).unwrap();
        let got = get_guide_run(&c, "r1").unwrap().unwrap();
        assert_eq!(got.status, "failed");
        assert_eq!(got.error.as_deref(), Some("boom"));
    }

    #[test]
    fn list_for_meeting_orders_by_slot() {
        let c = fresh();
        let mut a = make("r2", "m1");
        a.slot = 1;
        insert_guide_run(&c, &a).unwrap();
        insert_guide_run(&c, &make("r1", "m1")).unwrap(); // slot 0
        let rows = list_guide_runs_for_meeting(&c, "m1").unwrap();
        assert_eq!(rows.iter().map(|r| r.slot).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn list_for_template_only_ready_desc() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap(); // pending — excluded
        let mut ready = make("r2", "m2");
        ready.status = "ready".into();
        ready.started_at = "2026-07-09T00:00:00Z".into();
        insert_guide_run(&c, &ready).unwrap();
        let rows = list_guide_runs_for_template(&c, "builtin-leadership", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r2");
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib meeting_guide_runs`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/meeting_guide_runs.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): meeting_guide_runs CRUD module"
```

---

## Task 3: Guidance timeline capture

**Files:**
- Modify: `src-tauri/src/meeting/guidance.rs`

**Interfaces:**
- Consumes: `DerivedPoint` (existing), `State` (existing 3-field struct), `run_one_cycle`/`emit_update` (existing free fns), `GuidanceEngine` (existing).
- Produces:
  - `pub struct TimelineEntry { at: String, key_points: Vec<DerivedPoint>, suggestions: Vec<String> }` (Serialize/Deserialize/Clone/PartialEq).
  - `fn push_timeline_if_changed(&mut State, now: &str, key_points: &[DerivedPoint], suggestions: &[String])` — dedup-append helper (pure, testable).
  - `fn cap_timeline(all: Vec<TimelineEntry>, meeting_id: &str) -> Vec<TimelineEntry>` — keeps most recent 200, warns on truncation (pure, testable).
  - `GuidanceEngine::drain_timeline(&self) -> Vec<TimelineEntry>` (takes the buffer, applies `cap_timeline`).
  - `GuidanceEngine::set_run_id(&self, id: String)` / `run_id(&self) -> Option<String>`.
  - `pub(crate) fn isolate_json_object` (visibility widened for reuse in guide_review).

- [ ] **Step 1: Write failing tests**

Add to the `#[cfg(test)] mod tests` block in `guidance.rs` (the module already imports `use super::*;` — `State`, `TimelineEntry`, and the two free helpers are all private-but-in-scope for the test module). These test the pure helpers directly, so no `GuidanceEngine`/`Llm`/`AppHandle` fixture is needed:

```rust
    #[test]
    fn timeline_dedups_identical_consecutive_entries() {
        let mut st = State::default();
        let kp = vec![DerivedPoint { id: "a".into(), label: "L".into(), status: "open".into() }];
        // Only push when changed vs the last entry (what run_one_cycle does).
        push_timeline_if_changed(&mut st, "t1", &kp, &["s1".to_string()]);
        push_timeline_if_changed(&mut st, "t2", &kp, &["s1".to_string()]); // identical → skipped
        push_timeline_if_changed(&mut st, "t3", &kp, &["s2".to_string()]); // suggestions changed → pushed
        assert_eq!(st.timeline.len(), 2);
        assert_eq!(st.timeline[0].suggestions, vec!["s1".to_string()]);
        assert_eq!(st.timeline[1].suggestions, vec!["s2".to_string()]);
    }

    #[test]
    fn cap_timeline_keeps_most_recent_200() {
        let all: Vec<TimelineEntry> = (0..250u64)
            .map(|i| TimelineEntry { at: format!("t{i}"), key_points: vec![], suggestions: vec![] })
            .collect();
        let capped = cap_timeline(all, "m");
        assert_eq!(capped.len(), 200);
        assert_eq!(capped[0].at, "t50"); // dropped the oldest 50

        let small: Vec<TimelineEntry> = (0..3u64)
            .map(|i| TimelineEntry { at: format!("t{i}"), key_points: vec![], suggestions: vec![] })
            .collect();
        assert_eq!(cap_timeline(small, "m").len(), 3); // under cap → untouched
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib guidance`
Expected: FAIL — `TimelineEntry`, `push_timeline_if_changed`, `cap_timeline`, `timeline` field don't exist.

- [ ] **Step 3: Add the type, `State` field, helper, and accessors**

Add the type near `DerivedPoint`:

```rust
/// One persisted snapshot of the live guidance, captured when the key points
/// or suggestions changed. Stored (JSON) on the meeting's guide run so the
/// coaching stream can be reviewed after the call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelineEntry {
    /// RFC3339 wall-clock time the entry was captured.
    pub at: String,
    pub key_points: Vec<DerivedPoint>,
    pub suggestions: Vec<String>,
}
```

Add a `timeline` field to `State`:

```rust
#[derive(Default)]
struct State {
    rolling: String,
    prior_points: Vec<DerivedPoint>,
    last_suggestions: Vec<String>,
    /// Deduped live-guidance history, flushed to the DB at meeting stop.
    timeline: Vec<TimelineEntry>,
}
```

Add two free helpers (unit-testable without an LLM/engine):

```rust
/// Max timeline entries kept per guide run (deduped changes over the call).
const TIMELINE_CAP: usize = 200;

/// Append a timeline entry only if the key points or suggestions differ from
/// the last entry. `now` is an RFC3339 timestamp supplied by the caller.
fn push_timeline_if_changed(st: &mut State, now: &str, key_points: &[DerivedPoint], suggestions: &[String]) {
    let changed = st
        .timeline
        .last()
        .map_or(true, |e| e.key_points.as_slice() != key_points || e.suggestions.as_slice() != suggestions);
    if changed {
        st.timeline.push(TimelineEntry {
            at: now.to_string(),
            key_points: key_points.to_vec(),
            suggestions: suggestions.to_vec(),
        });
    }
}

/// Keep the most recent `TIMELINE_CAP` entries; warn (no silent truncation)
/// when the buffer overran. `meeting_id` is only for the log line.
fn cap_timeline(all: Vec<TimelineEntry>, meeting_id: &str) -> Vec<TimelineEntry> {
    if all.len() > TIMELINE_CAP {
        warn!(
            target: "guide",
            meeting = %meeting_id,
            dropped = all.len() - TIMELINE_CAP,
            "[guide] timeline exceeded cap; keeping most recent {TIMELINE_CAP}"
        );
        all[all.len() - TIMELINE_CAP..].to_vec()
    } else {
        all
    }
}
```

Add accessors on `impl GuidanceEngine` (next to `rolling_snapshot`). Add a `run_id: Mutex<Option<String>>` field to `Inner` initialized to `Mutex::new(None)` in `GuidanceEngine::new`:

```rust
    /// The `meeting_guide_runs.id` this engine writes its timeline/review to.
    /// Set by the meeting lifecycle right after the run row is inserted.
    pub fn set_run_id(&self, id: String) {
        *self.inner.run_id.lock().unwrap() = Some(id);
    }

    pub fn run_id(&self) -> Option<String> {
        self.inner.run_id.lock().unwrap().clone()
    }

    /// Take the accumulated timeline, capped at the most recent 200 entries.
    pub fn drain_timeline(&self) -> Vec<TimelineEntry> {
        let all = {
            let mut st = self.inner.state.lock().unwrap();
            std::mem::take(&mut st.timeline)
        };
        cap_timeline(all, &self.inner.meeting_id)
    }
```

- [ ] **Step 4: Wire the append into `run_one_cycle` and widen `isolate_json_object`**

In `run_one_cycle`, in the success arm where `st.prior_points`/`st.last_suggestions` are set (right after `emit_update(inner, &resp);`), add the timeline push inside the same lock scope:

```rust
                emit_update(inner, &resp);
                let now = chrono::Utc::now().to_rfc3339();
                let mut st = inner.state.lock().unwrap();
                push_timeline_if_changed(&mut st, &now, &resp.key_points, &resp.suggestions);
                st.prior_points = resp.key_points.clone();
                st.last_suggestions = resp.suggestions.clone();
```

Change `fn isolate_json_object(s: &str) -> Option<String>` to `pub(crate) fn isolate_json_object(s: &str) -> Option<String>`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib guidance`
Expected: PASS (existing guidance tests + the two new timeline tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/meeting/guidance.rs
git commit -m "feat(guide): capture deduped live-guidance timeline + run-id/drain accessors"
```

---

## Task 4: `build_guide_review_prompt`

**Files:**
- Modify: `src-tauri/src/llm/prompt.rs`

**Interfaces:**
- Produces: `pub fn build_guide_review_prompt(goal: &str, notes: &str, transcript: &str) -> (Option<String>, String)`.

- [ ] **Step 1: Write a failing test**

Add to the test module at the bottom of `prompt.rs` (mirror the file's existing `#[cfg(test)] mod tests`):

```rust
    #[test]
    fn guide_review_prompt_numbers_criteria_and_embeds_goal() {
        let (system, user) = build_guide_review_prompt(
            "Listen more than you speak.",
            "speak last\n\ngive credit by name\n",
            "You: hi\nThem: hello\n",
        );
        let sys = system.unwrap();
        assert!(sys.contains("Listen more than you speak."));
        assert!(sys.contains("1. speak last"));
        assert!(sys.contains("2. give credit by name")); // blank line skipped, renumbered
        assert!(sys.contains("\"scorecard\""));
        assert!(user.contains("You: hi"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib guide_review_prompt_numbers_criteria`
Expected: FAIL — `build_guide_review_prompt` not found.

- [ ] **Step 3: Implement the prompt builder**

Add to `prompt.rs` (near `build_meeting_synthesis_prompt` / `build_guidance_prompt`):

```rust
/// Build the prompt for a whole-transcript guide review: coaching scorecard
/// (one graded criterion per non-empty `notes` line) + 1-2 emergent
/// observations + a synthesis vs the `goal`. Parsed loosely into `GuideReview`.
pub fn build_guide_review_prompt(
    goal: &str,
    notes: &str,
    transcript: &str,
) -> (Option<String>, String) {
    let criteria: Vec<&str> = notes.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let numbered = criteria
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}. {}", i + 1, c))
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!(
        "You are a communication coach reviewing a meeting transcript. The user is the speaker labeled 'You'; the other side is labeled 'Them'. \
Assess how well the USER met the objective, criterion by criterion, using only evidence from the transcript.\n\
Objective: {goal}\n\
Criteria:\n{numbered}\n\n\
Produce a JSON object with exactly these fields:\n\
- overall: one of \"strong\", \"mixed\", \"weak\".\n\
- synthesis: a 2-4 sentence narrative of how the conversation went against the objective.\n\
- scorecard: an array with ONE object per criterion above, in the same order: {{ \"criterion\": the criterion text, \"verdict\": \"met\" | \"partial\" | \"missed\", \"evidence\": a short quote or paraphrase from the transcript, \"why\": a one-line assessment, \"tip\": one concrete thing to try next time (empty string when verdict is \"met\") }}.\n\
- emergent: an array of 1-2 objects {{ \"observation\": something notable NOT covered by the criteria, \"evidence\": a short quote or paraphrase }}.\n\
Output JSON only — no preamble, no commentary, no markdown fences."
    );
    let user = format!("Transcript:\n\n{transcript}\n\nProduce the JSON now.");
    (Some(system), user)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib guide_review_prompt_numbers_criteria`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/prompt.rs
git commit -m "feat(guide): build_guide_review_prompt"
```

---

## Task 5: `meeting/guide_review.rs` — review generation

**Files:**
- Create: `src-tauri/src/meeting/guide_review.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (add `pub mod guide_review;` near the other `pub mod` lines), `src-tauri/src/meeting/synthesizer.rs` (widen `condense_transcript` to `pub(crate)`)

**Interfaces:**
- Consumes: `crate::meeting::synthesizer::{flatten_transcript, condense_transcript}`, `crate::meeting::guidance::isolate_json_object`, `crate::llm::{Llm, GenerateRequest}`, `crate::meeting::Segment`, `crate::db::guide_templates::GuideTemplate`.
- Produces:
  - `pub struct GuideReview { overall: String, synthesis: String, scorecard: Vec<ScorecardItem>, emergent: Vec<EmergentItem> }` (+ `ScorecardItem { criterion, verdict, evidence, why, tip }`, `EmergentItem { observation, evidence }`), all `Serialize/Deserialize/Clone/Default` with `#[serde(default)]` fields.
  - `pub async fn generate_review(llm: Arc<Llm>, template: &GuideTemplate, segments: &[Segment]) -> Result<GuideReview, String>`.

- [ ] **Step 1: Widen `condense_transcript` visibility**

In `synthesizer.rs`, change `async fn condense_transcript(` to `pub(crate) async fn condense_transcript(`.

- [ ] **Step 2: Declare the module and write it with failing tests**

In `meeting/mod.rs` add (near `pub mod synthesizer;`):

```rust
pub mod guide_review;
```

Create `src-tauri/src/meeting/guide_review.rs`:

```rust
//! Whole-transcript guide review, generated once per attached guide after a
//! meeting stops. Produces a coaching scorecard (one graded criterion per
//! template `notes` line), 1-2 emergent observations, and a synthesis vs the
//! template `goal`. Reuses the synthesizer's chunked map-reduce for long
//! transcripts. JSON is parsed loosely, mirroring the live guidance engine.

use crate::db::guide_templates::GuideTemplate;
use crate::llm::{GenerateRequest, Llm};
use crate::meeting::guidance::isolate_json_object;
use crate::meeting::Segment;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

/// Byte budget for the transcript in the review prompt; above this we condense
/// via the synthesizer's map-reduce first. Matches the synthesizer's own budget.
const MAX_REVIEW_BYTES: usize = 18_000;

/// `max_tokens` for the review JSON (scorecard can be long).
const REVIEW_MAX_TOKENS: usize = 1536;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct GuideReview {
    #[serde(default)]
    pub overall: String,
    #[serde(default)]
    pub synthesis: String,
    #[serde(default)]
    pub scorecard: Vec<ScorecardItem>,
    #[serde(default)]
    pub emergent: Vec<EmergentItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ScorecardItem {
    #[serde(default)]
    pub criterion: String,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub tip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct EmergentItem {
    #[serde(default)]
    pub observation: String,
    #[serde(default)]
    pub evidence: String,
}

pub async fn generate_review(
    llm: Arc<Llm>,
    template: &GuideTemplate,
    segments: &[Segment],
) -> Result<GuideReview, String> {
    let flat = crate::meeting::synthesizer::flatten_transcript(segments);
    if flat.trim().is_empty() {
        return Err("empty transcript".into());
    }
    let transcript = if flat.len() <= MAX_REVIEW_BYTES {
        flat
    } else {
        let condensed = crate::meeting::synthesizer::condense_transcript(llm.as_ref(), &flat).await?;
        format!("[Note: transcript condensed due to length]\n\n{condensed}")
    };

    let (system, user) =
        crate::llm::prompt::build_guide_review_prompt(&template.goal, &template.notes, &transcript);

    let mut last_raw = String::new();
    for attempt in 0..2u8 {
        let temperature = if attempt == 0 { 0.3 } else { 0.1 };
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: REVIEW_MAX_TOKENS,
            temperature,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
            n_ctx: Some(16384),
        };
        let raw = match llm.generate(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(target: "guide", ?e, attempt, "[guide-review] generate failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {e}"));
                }
                continue;
            }
        };
        last_raw = raw.clone();
        let isolated = isolate_json_object(&raw).unwrap_or_else(|| raw.clone());
        match serde_json::from_str::<GuideReview>(&isolated) {
            Ok(review) => {
                info!(
                    target: "guide",
                    criteria = review.scorecard.len(),
                    emergent = review.emergent.len(),
                    overall = %review.overall,
                    "[guide-review] parsed ok"
                );
                return Ok(review);
            }
            Err(e) => warn!(target: "guide", ?e, attempt, "[guide-review] JSON parse failed"),
        }
    }
    Err(format!("guide review JSON parse failed after 2 attempts: {last_raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_loose_review_json_with_missing_fields() {
        // Missing `tip`/`emergent`/`why` must default, not error.
        let json = r#"{
            "overall":"mixed",
            "synthesis":"Clear but light on closure.",
            "scorecard":[{"criterion":"owner + date","verdict":"missed","evidence":"no dates"}]
        }"#;
        let r: GuideReview = serde_json::from_str(json).unwrap();
        assert_eq!(r.overall, "mixed");
        assert_eq!(r.scorecard.len(), 1);
        assert_eq!(r.scorecard[0].verdict, "missed");
        assert_eq!(r.scorecard[0].tip, "");
        assert!(r.emergent.is_empty());
    }

    #[test]
    fn review_round_trips_through_serde() {
        let r = GuideReview {
            overall: "strong".into(),
            synthesis: "s".into(),
            scorecard: vec![ScorecardItem {
                criterion: "c".into(),
                verdict: "met".into(),
                evidence: "e".into(),
                why: "w".into(),
                tip: "".into(),
            }],
            emergent: vec![EmergentItem { observation: "o".into(), evidence: "e".into() }],
        };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<GuideReview>(&s).unwrap(), r);
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib guide_review`
Expected: PASS (2 tests). (Compilation also verifies the `flatten_transcript`/`condense_transcript`/`isolate_json_object`/prompt wiring.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/guide_review.rs src-tauri/src/meeting/mod.rs src-tauri/src/meeting/synthesizer.rs
git commit -m "feat(guide): whole-transcript guide review generator"
```

---

## Task 6: Wire persistence into the meeting lifecycle

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs` (`attach_guide` insert; `stop()` flush + spawn)

**Interfaces:**
- Consumes: `crate::db::meeting_guide_runs::{GuideRunRow, insert_guide_run, update_guide_run_timeline, update_guide_run_review, set_guide_run_status}`, `GuidanceEngine::{slot, run_id, set_run_id, drain_timeline, template_snapshot}`, `crate::meeting::guide_review::generate_review`.
- Produces: `meeting_guide_runs` rows created at attach and completed after stop; a `guide-review-updated` Tauri event `{ meetingId, runId }`.

- [ ] **Step 1: Insert the run row in `attach_guide`**

In `attach_guide`, immediately after the existing template-snapshot persistence block (the `match serde_json::to_value(&template) { … }` that writes `guide_template_json`), add:

```rust
        // Create the guide-run row (status = pending). Survives crashes; the
        // timeline + review fill in at stop. Stash the id on the engine so
        // stop() can find the row for this guide.
        {
            let now = chrono::Utc::now().to_rfc3339();
            let run = crate::db::meeting_guide_runs::GuideRunRow {
                id: ulid::Ulid::new().to_string(),
                meeting_id: meeting_id.clone(),
                template_id: template.id.clone(),
                template_name: template.name.clone(),
                template_json: serde_json::to_string(&template).unwrap_or_else(|_| "{}".into()),
                slot: engine.slot() as i64,
                started_at: now.clone(),
                timeline_json: None,
                review_json: None,
                status: "pending".into(),
                error: None,
                generated_at: None,
                created_at: now,
            };
            engine.set_run_id(run.id.clone());
            let db = self.db.clone();
            if let Err(e) =
                db.with_conn(move |c| crate::db::meeting_guide_runs::insert_guide_run(c, &run))
            {
                tracing::warn!(target: "guide", ?e, "insert guide run row failed");
            }
        }
```

- [ ] **Step 2: In `stop()`, flush timelines and spawn review jobs**

In `stop()`, immediately after the Step 7 persistence transaction (`.map_err(|e| MeetingError::Db(e.to_string()))?;` that closes the big `with_conn` block) and before Step 8's `meeting-complete` emit, add:

```rust
        // Step 7.5: Persist each guide's timeline now (fast), then generate its
        // review in the background so meeting completion isn't blocked by a
        // multi-minute LLM pass. Reviews flip status pending → ready/failed.
        {
            let guide_engines: Vec<_> = active.guide_engines.lock().unwrap().clone();
            for engine in &guide_engines {
                let Some(run_id) = engine.run_id() else { continue };
                let timeline = engine.drain_timeline();
                if let Ok(tlj) = serde_json::to_string(&timeline) {
                    let db = self.db.clone();
                    let rid = run_id.clone();
                    if let Err(e) = db.with_conn(move |c| {
                        crate::db::meeting_guide_runs::update_guide_run_timeline(c, &rid, Some(tlj.as_str()))
                    }) {
                        tracing::warn!(target: "guide", ?e, "persist guide timeline failed");
                    }
                }

                let db = self.db.clone();
                let llm = self.llm.clone();
                let app = self.app_handle.clone();
                let template = engine.template_snapshot();
                let segs = segments.clone();
                let mid = id.clone();
                let rid = run_id.clone();
                tokio::spawn(async move {
                    match crate::meeting::guide_review::generate_review(llm, &template, &segs).await {
                        Ok(review) => {
                            let rj = serde_json::to_string(&review).unwrap_or_else(|_| "{}".into());
                            let gen_at = chrono::Utc::now().to_rfc3339();
                            let rid2 = rid.clone();
                            if let Err(e) = db.with_conn(move |c| {
                                crate::db::meeting_guide_runs::update_guide_run_review(
                                    c, &rid2, Some(rj.as_str()), "ready", Some(gen_at.as_str()),
                                )
                            }) {
                                tracing::error!(target: "guide", ?e, run = %rid, "persist guide review failed");
                            } else {
                                tracing::info!(target: "guide", run = %rid, overall = %review.overall, criteria = review.scorecard.len(), "[guide-review] ready");
                            }
                        }
                        Err(e) => {
                            tracing::error!(target: "guide", run = %rid, error = %e, "[guide-review] failed");
                            let rid2 = rid.clone();
                            let err = e.clone();
                            let _ = db.with_conn(move |c| {
                                crate::db::meeting_guide_runs::set_guide_run_status(c, &rid2, "failed", Some(err.as_str()))
                            });
                        }
                    }
                    let _ = app.emit("guide-review-updated", serde_json::json!({ "meetingId": mid, "runId": rid }));
                });
            }
        }
```

> The `emit` call requires `use tauri::Emitter;` — already imported in `mod.rs` (used by the existing `self.app_handle.emit(...)` calls in `stop()`). `Segment` is `Clone`; `segments.clone()` is valid.

- [ ] **Step 3: Verify the crate compiles and all Rust tests pass**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS (whole suite; no runtime meeting needed — this step is a compile + regression gate).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/mod.rs
git commit -m "feat(guide): create run at attach; flush timeline + generate review at stop"
```

---

## Task 7: Tauri commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add three commands), `src-tauri/src/lib.rs` (register them)

**Interfaces:**
- Consumes: `require_db`, `crate::db::meeting_guide_runs::*`, `crate::db::meetings::get_meeting`, `crate::meeting::guide_review::generate_review`, `state.llm`.
- Produces (frontend contract):
  - `list_guide_runs(meeting_id: String) -> Vec<GuideRunRow>`
  - `guide_runs_for_template(template_id: String, limit: i64) -> Vec<GuideRunRow>`
  - `regenerate_guide_review(run_id: String) -> ()` (async)

- [ ] **Step 1: Add the commands**

Append to `commands.rs` (near the guide-template commands):

```rust
#[tauri::command]
pub fn list_guide_runs(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<crate::db::meeting_guide_runs::GuideRunRow>, String> {
    let db = require_db(&state)?;
    db.with_conn(move |c| crate::db::meeting_guide_runs::list_guide_runs_for_meeting(c, &meeting_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn guide_runs_for_template(
    state: State<'_, AppState>,
    template_id: String,
    limit: i64,
) -> Result<Vec<crate::db::meeting_guide_runs::GuideRunRow>, String> {
    let db = require_db(&state)?;
    db.with_conn(move |c| {
        crate::db::meeting_guide_runs::list_guide_runs_for_template(c, &template_id, limit)
    })
    .map_err(|e| e.to_string())
}

/// Envelope for pulling `segments` out of a meeting's stored `transcript_json`.
#[derive(serde::Deserialize)]
struct TranscriptEnvelope {
    #[serde(default)]
    segments: Vec<crate::meeting::Segment>,
}

/// Guide template as stored in the run row's `template_json` snapshot.
#[tauri::command]
pub async fn regenerate_guide_review(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    let db = require_db(&state)?.clone();
    let llm = state.llm.clone();

    // Load the run row → meeting_id + template snapshot.
    let rid = run_id.clone();
    let run = db
        .with_conn(move |c| crate::db::meeting_guide_runs::get_guide_run(c, &rid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("guide run {run_id} not found"))?;
    let template: crate::db::guide_templates::GuideTemplate =
        serde_json::from_str(&run.template_json).map_err(|e| format!("bad template snapshot: {e}"))?;

    // Load the meeting transcript → segments.
    let mid = run.meeting_id.clone();
    let meeting = db
        .with_conn(move |c| crate::db::meetings::get_meeting(c, &mid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "meeting not found".to_string())?;
    let transcript_json = meeting
        .transcript_json
        .ok_or_else(|| "meeting has no transcript".to_string())?;
    let env: TranscriptEnvelope =
        serde_json::from_str(&transcript_json).map_err(|e| format!("bad transcript json: {e}"))?;

    // Mark pending, regenerate, persist.
    let rid = run_id.clone();
    let _ = db.with_conn(move |c| {
        crate::db::meeting_guide_runs::set_guide_run_status(c, &rid, "pending", None)
    });

    match crate::meeting::guide_review::generate_review(llm, &template, &env.segments).await {
        Ok(review) => {
            let rj = serde_json::to_string(&review).unwrap_or_else(|_| "{}".into());
            let gen_at = chrono::Utc::now().to_rfc3339();
            let rid = run_id.clone();
            db.with_conn(move |c| {
                crate::db::meeting_guide_runs::update_guide_run_review(
                    c, &rid, Some(rj.as_str()), "ready", Some(gen_at.as_str()),
                )
            })
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let rid = run_id.clone();
            let err = e.clone();
            let _ = db.with_conn(move |c| {
                crate::db::meeting_guide_runs::set_guide_run_status(c, &rid, "failed", Some(err.as_str()))
            });
            Err(e)
        }
    }
}
```

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![…]` (in the guide block near `commands::attach_guide`), add:

```rust
            commands::list_guide_runs,
            commands::guide_runs_for_template,
            commands::regenerate_guide_review,
```

- [ ] **Step 3: Verify compilation + tests**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS (compile gate — confirms command signatures, `Segment: Deserialize`, and handler registration all typecheck).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(guide): list/regenerate guide-run commands"
```

---

## Task 8: Frontend api types + wrappers, and pure helpers

**Files:**
- Modify: `src/lib/api.ts`
- Create: `src/lib/guideReview.ts`, `tests/guideReview.test.ts`

**Interfaces:**
- Produces (TS):
  - Types `ScorecardItem`, `EmergentItem`, `GuideReview`, `TimelineEntry`, `GuideRun`.
  - Wrappers `listGuideRuns(meetingId)`, `guideRunsForTemplate(templateId, limit)`, `regenerateGuideReview(runId)`.
  - Helpers `parseGuideReview(json)`, `parseTimeline(json)`, `verdictClass(verdict)`.

- [ ] **Step 1: Add types + wrappers to `api.ts`**

Append near the `GuideTemplate` block:

```typescript
export type ScorecardItem = {
  criterion: string;
  verdict: string; // "met" | "partial" | "missed" | "unknown" (kept loose)
  evidence: string;
  why: string;
  tip: string;
};

export type EmergentItem = { observation: string; evidence: string };

export type GuideReview = {
  overall: string; // "strong" | "mixed" | "weak"
  synthesis: string;
  scorecard: ScorecardItem[];
  emergent: EmergentItem[];
};

export type TimelineEntry = {
  at: string;
  key_points: { id: string; label: string; status: string }[];
  suggestions: string[];
};

export type GuideRun = {
  id: string;
  meeting_id: string;
  template_id: string;
  template_name: string;
  template_json: string;
  slot: number;
  started_at: string;
  timeline_json: string | null;
  review_json: string | null;
  status: string; // "pending" | "ready" | "failed"
  error: string | null;
  generated_at: string | null;
  created_at: string;
};

export const listGuideRuns = (meetingId: string): Promise<GuideRun[]> =>
  invoke("list_guide_runs", { meetingId });

export const guideRunsForTemplate = (
  templateId: string,
  limit: number,
): Promise<GuideRun[]> => invoke("guide_runs_for_template", { templateId, limit });

export const regenerateGuideReview = (runId: string): Promise<void> =>
  invoke("regenerate_guide_review", { runId });
```

- [ ] **Step 2: Write failing helper tests**

Create `tests/guideReview.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseGuideReview, parseTimeline, verdictClass } from "../src/lib/guideReview";

describe("guideReview helpers", () => {
  test("parseGuideReview returns null for null/blank/bad json", () => {
    expect(parseGuideReview(null)).toBeNull();
    expect(parseGuideReview("")).toBeNull();
    expect(parseGuideReview("not json")).toBeNull();
  });

  test("parseGuideReview fills missing arrays with empty defaults", () => {
    const r = parseGuideReview('{"overall":"mixed","synthesis":"s"}');
    expect(r).not.toBeNull();
    expect(r!.overall).toBe("mixed");
    expect(r!.scorecard).toEqual([]);
    expect(r!.emergent).toEqual([]);
  });

  test("parseTimeline returns [] for null and parses arrays", () => {
    expect(parseTimeline(null)).toEqual([]);
    const t = parseTimeline('[{"at":"x","key_points":[],"suggestions":["a"]}]');
    expect(t.length).toBe(1);
    expect(t[0].suggestions).toEqual(["a"]);
  });

  test("verdictClass maps verdicts to a stable token", () => {
    expect(verdictClass("met")).toBe("met");
    expect(verdictClass("Partial")).toBe("partial");
    expect(verdictClass("MISSED")).toBe("missed");
    expect(verdictClass("weird")).toBe("unknown");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/guideReview.test.ts`
Expected: FAIL — `../src/lib/guideReview` does not exist.

- [ ] **Step 4: Implement the helpers**

Create `src/lib/guideReview.ts`:

```typescript
import type { GuideReview, TimelineEntry } from "./api";

/** Safe-parse a `review_json` string into a fully-defaulted GuideReview. */
export function parseGuideReview(json: string | null): GuideReview | null {
  if (!json || !json.trim()) return null;
  try {
    const o = JSON.parse(json) as Partial<GuideReview>;
    return {
      overall: typeof o.overall === "string" ? o.overall : "",
      synthesis: typeof o.synthesis === "string" ? o.synthesis : "",
      scorecard: Array.isArray(o.scorecard) ? o.scorecard : [],
      emergent: Array.isArray(o.emergent) ? o.emergent : [],
    };
  } catch {
    return null;
  }
}

/** Safe-parse a `timeline_json` string into an array (never throws). */
export function parseTimeline(json: string | null): TimelineEntry[] {
  if (!json || !json.trim()) return [];
  try {
    const o = JSON.parse(json);
    return Array.isArray(o) ? (o as TimelineEntry[]) : [];
  } catch {
    return [];
  }
}

/** Normalize a loose verdict string to one of met/partial/missed/unknown. */
export function verdictClass(verdict: string): "met" | "partial" | "missed" | "unknown" {
  const v = (verdict || "").toLowerCase();
  if (v === "met") return "met";
  if (v === "partial") return "partial";
  if (v === "missed") return "missed";
  return "unknown";
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/guideReview.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/guideReview.ts tests/guideReview.test.ts
git commit -m "feat(guide): api types/wrappers + guide-review parse helpers"
```

---

## Task 9: Per-meeting `GuideReviewSection` panel  ← shippable checkpoint

**Files:**
- Modify: `src/components/ActivityPanel.tsx`

**Interfaces:**
- Consumes: `listGuideRuns`, `regenerateGuideReview`, `parseGuideReview`, `parseTimeline`, `verdictClass`, `GuideRun`, existing local `SectionLabel`.
- Produces: a `<GuideReviewSection meetingId={meeting.item_id} />` rendered in `MeetingView`.

- [ ] **Step 1: Add imports**

In `ActivityPanel.tsx`, extend the `api` import to include `listGuideRuns`, `regenerateGuideReview`, and type `GuideRun`, and add:

```typescript
import { parseGuideReview, parseTimeline, verdictClass } from "../lib/guideReview";
import { listen } from "@tauri-apps/api/event";
```

- [ ] **Step 2: Add the component**

Add near the other section components (e.g. after `NotesSection`):

```tsx
const VERDICT_STYLES: Record<string, string> = {
  met: "bg-emerald-500/15 text-emerald-400",
  partial: "bg-amber-500/15 text-amber-400",
  missed: "bg-red-500/15 text-red-400",
  unknown: "bg-elevated text-muted",
};
const OVERALL_STYLES: Record<string, string> = {
  strong: "bg-emerald-500/15 text-emerald-400",
  mixed: "bg-amber-500/15 text-amber-400",
  weak: "bg-red-500/15 text-red-400",
};

function GuideReviewSection({ meetingId }: { meetingId: string }) {
  const [runs, setRuns] = useState<GuideRun[]>([]);
  const [openCrit, setOpenCrit] = useState<Record<string, boolean>>({});
  const [showTimeline, setShowTimeline] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const r = await listGuideRuns(meetingId).catch(() => [] as GuideRun[]);
    setRuns(r);
  }, [meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when a background review finishes for this meeting.
  useEffect(() => {
    const un = listen<{ meetingId: string }>("guide-review-updated", (e) => {
      if (e.payload?.meetingId === meetingId) load();
    });
    return () => {
      un.then((f) => f());
    };
  }, [meetingId, load]);

  if (runs.length === 0) return null;

  return (
    <div className="space-y-4">
      {runs.map((run) => {
        const review = parseGuideReview(run.review_json);
        const timeline = parseTimeline(run.timeline_json);
        const overallCls = OVERALL_STYLES[(review?.overall || "").toLowerCase()] ?? "bg-elevated text-muted";
        return (
          <div key={run.id} className="rounded-lg border border-line bg-surface-2">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <span className="text-[13px] font-semibold text-fg">{run.template_name}</span>
              {run.status === "ready" && review?.overall ? (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${overallCls}`}>
                  {review.overall}
                </span>
              ) : null}
              {run.status === "pending" ? (
                <span className="text-[11px] text-muted">Generating review…</span>
              ) : null}
            </div>

            {run.status === "failed" ? (
              <div className="px-3 py-3 text-[12px] text-muted">
                Guide review couldn't be generated. See Settings → Diagnostics → logs.{" "}
                <button
                  className="text-accent hover:underline"
                  onClick={async () => {
                    await regenerateGuideReview(run.id).catch(() => {});
                    load();
                  }}
                >
                  Retry
                </button>
              </div>
            ) : null}

            {run.status === "ready" && review ? (
              <div className="space-y-3 px-3 py-3">
                {review.synthesis ? (
                  <p className="text-[13px] leading-relaxed text-fg">{review.synthesis}</p>
                ) : null}

                {review.scorecard.length > 0 ? (
                  <div className="space-y-1.5">
                    {review.scorecard.map((c, i) => {
                      const key = `${run.id}:${i}`;
                      const vk = verdictClass(c.verdict);
                      const open = !!openCrit[key];
                      return (
                        <div key={key} className="overflow-hidden rounded-md border border-line">
                          <button
                            className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-elevated"
                            onClick={() => setOpenCrit((s) => ({ ...s, [key]: !open }))}
                          >
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${VERDICT_STYLES[vk]}`}>
                              {vk}
                            </span>
                            <span className="flex-1 text-[13px] font-medium text-fg">{c.criterion}</span>
                            <span className="text-[11px] text-faint">{open ? "▾" : "▸"}</span>
                          </button>
                          {open ? (
                            <div className="space-y-1.5 border-t border-line px-2.5 py-2 text-[12px]">
                              {c.evidence ? (
                                <p className="border-l-2 border-line pl-2 italic text-muted">“{c.evidence}”</p>
                              ) : null}
                              {c.why ? <p className="text-fg">{c.why}</p> : null}
                              {c.tip ? (
                                <p className="text-muted">
                                  <span className="font-semibold text-amber-400">Try:</span> {c.tip}
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {review.emergent.length > 0 ? (
                  <div>
                    <SectionLabel>What also stood out</SectionLabel>
                    <ul className="space-y-1 text-[12px] text-fg">
                      {review.emergent.map((e, i) => (
                        <li key={i} className="leading-relaxed">{e.observation}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {timeline.length > 0 ? (
                  <div className="border-t border-line pt-2">
                    <button
                      className="text-[12px] text-muted hover:text-fg"
                      onClick={() => setShowTimeline((s) => ({ ...s, [run.id]: !s[run.id] }))}
                    >
                      {showTimeline[run.id] ? "▾" : "▸"} Live coaching timeline · {timeline.length}
                    </button>
                    {showTimeline[run.id] ? (
                      <div className="mt-1.5 space-y-1">
                        {timeline.map((t, i) => (
                          <div key={i} className="text-[12px] text-muted">
                            {t.suggestions.join(" · ") || "—"}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Insert into `MeetingView`**

In the `MeetingView` return body, add after the action-items block and before `<NotesSection … />`:

```tsx
      <GuideReviewSection meetingId={meeting.item_id} />
```

- [ ] **Step 4: Typecheck / build**

Run: `bun run build`
Expected: build succeeds (no TS errors). Then `bun test` — Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ActivityPanel.tsx
git commit -m "feat(guide): per-meeting guide review panel in ActivityPanel"
```

---

## Task 10: Trend aggregation helper

**Files:**
- Modify: `src/lib/guideReview.ts`
- Modify: `tests/guideReview.test.ts`

**Interfaces:**
- Consumes: `GuideRun`, `parseGuideReview`.
- Produces: `aggregateTrend(runs: GuideRun[]): TrendData` where
  `TrendData = { criteria: string[]; columns: { runId: string; startedAt: string; overall: string; cells: string[] }[]; hits: number[]; gap: string | null; strength: string | null }`.
  - `criteria`: union of scorecard criteria (from the most recent run's order).
  - `columns`: one per run (oldest→newest), `cells[i]` = verdictClass for `criteria[i]` in that run ("unknown" if absent).
  - `hits[i]`: number of runs where `criteria[i]` was "met".
  - `gap`: criterion most often "missed" (or null); `strength`: most often "met" (or null).

- [ ] **Step 1: Add failing test**

Append to `tests/guideReview.test.ts`:

```typescript
import { aggregateTrend } from "../src/lib/guideReview";
import type { GuideRun } from "../src/lib/api";

function run(id: string, startedAt: string, overall: string, sc: [string, string][]): GuideRun {
  return {
    id, meeting_id: "m", template_id: "t", template_name: "T", template_json: "{}",
    slot: 0, started_at: startedAt,
    timeline_json: null,
    review_json: JSON.stringify({ overall, synthesis: "", scorecard: sc.map(([criterion, verdict]) => ({ criterion, verdict, evidence: "", why: "", tip: "" })), emergent: [] }),
    status: "ready", error: null, generated_at: startedAt, created_at: startedAt,
  };
}

describe("aggregateTrend", () => {
  test("orders columns oldest→newest, counts hits, finds gap and strength", () => {
    const runs: GuideRun[] = [
      run("r2", "2026-07-08T00:00:00Z", "mixed", [["Speak last", "partial"], ["Owner + date", "missed"]]),
      run("r1", "2026-07-01T00:00:00Z", "weak", [["Speak last", "met"], ["Owner + date", "missed"]]),
    ];
    const t = aggregateTrend(runs);
    expect(t.columns.map((c) => c.runId)).toEqual(["r1", "r2"]); // oldest first
    expect(t.criteria).toEqual(["Speak last", "Owner + date"]);
    expect(t.hits).toEqual([1, 0]); // Speak last met once; Owner+date never
    expect(t.gap).toBe("Owner + date"); // missed in 2/2
    expect(t.strength).toBe("Speak last"); // most mets
  });

  test("returns empty structure for no runs", () => {
    const t = aggregateTrend([]);
    expect(t.criteria).toEqual([]);
    expect(t.columns).toEqual([]);
    expect(t.gap).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/guideReview.test.ts`
Expected: FAIL — `aggregateTrend` not exported.

- [ ] **Step 3: Implement `aggregateTrend`**

First, amend the top-of-file import in `src/lib/guideReview.ts` to add `GuideRun`:

```typescript
import type { GuideReview, TimelineEntry, GuideRun } from "./api";
```

Then append to `src/lib/guideReview.ts`:

```typescript
export type TrendColumn = { runId: string; startedAt: string; overall: string; cells: string[] };
export type TrendData = {
  criteria: string[];
  columns: TrendColumn[];
  hits: number[];
  gap: string | null;
  strength: string | null;
};

export function aggregateTrend(runs: GuideRun[]): TrendData {
  // Oldest → newest by started_at.
  const sorted = [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const parsed = sorted.map((r) => ({ run: r, review: parseGuideReview(r.review_json) }));

  // Criteria order from the most recent run that has a scorecard.
  let criteria: string[] = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    const sc = parsed[i].review?.scorecard ?? [];
    if (sc.length > 0) {
      criteria = sc.map((c) => c.criterion);
      break;
    }
  }

  const columns: TrendColumn[] = parsed.map(({ run, review }) => {
    const byName = new Map((review?.scorecard ?? []).map((c) => [c.criterion, verdictClass(c.verdict)]));
    return {
      runId: run.id,
      startedAt: run.started_at,
      overall: review?.overall ?? "",
      cells: criteria.map((c) => byName.get(c) ?? "unknown"),
    };
  });

  const hits = criteria.map((_, i) => columns.filter((col) => col.cells[i] === "met").length);
  const misses = criteria.map((_, i) => columns.filter((col) => col.cells[i] === "missed").length);

  const gap =
    criteria.length > 0 && Math.max(...misses) > 0
      ? criteria[misses.indexOf(Math.max(...misses))]
      : null;
  const strength =
    criteria.length > 0 && Math.max(...hits) > 0
      ? criteria[hits.indexOf(Math.max(...hits))]
      : null;

  return { criteria, columns, hits, gap, strength };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/guideReview.test.ts`
Expected: PASS (all guideReview tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/guideReview.ts tests/guideReview.test.ts
git commit -m "feat(guide): cross-meeting trend aggregation helper"
```

---

## Task 11: Trend view UI

**Files:**
- Create: `src/components/GuideTrendView.tsx`
- Modify: `src/components/ActivityPanel.tsx` (a "View trend" button in the review header opens the modal)

**Interfaces:**
- Consumes: `guideRunsForTemplate`, `aggregateTrend`, `GuideRun`.
- Produces: `<GuideTrendView templateId templateName onClose />` modal.

- [ ] **Step 1: Create the trend component**

Create `src/components/GuideTrendView.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { guideRunsForTemplate, type GuideRun } from "../lib/api";
import { aggregateTrend, type TrendData } from "../lib/guideReview";

const CELL: Record<string, string> = {
  met: "bg-emerald-500/70",
  partial: "bg-amber-500/70",
  missed: "bg-red-500/70",
  unknown: "bg-elevated",
};

export default function GuideTrendView({
  templateId,
  templateName,
  onClose,
}: {
  templateId: string;
  templateName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TrendData | null>(null);

  const load = useCallback(async () => {
    const runs: GuideRun[] = await guideRunsForTemplate(templateId, 12).catch(() => []);
    setData(aggregateTrend(runs));
  }, [templateId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-xl border border-line bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-fg">{templateName} — across your calls</h2>
          <button className="text-muted hover:text-fg" onClick={onClose}>✕</button>
        </div>

        {!data || data.columns.length === 0 ? (
          <p className="text-[13px] text-muted">No completed guide reviews for this template yet.</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.gap ? (
                <div className="rounded-lg border border-line border-l-2 border-l-red-500 p-3">
                  <div className="text-[10px] font-bold uppercase text-faint">Recurring gap</div>
                  <div className="mt-1 text-[13px] font-medium text-fg">{data.gap}</div>
                </div>
              ) : null}
              {data.strength ? (
                <div className="rounded-lg border border-line border-l-2 border-l-emerald-500 p-3">
                  <div className="text-[10px] font-bold uppercase text-faint">Strength</div>
                  <div className="mt-1 text-[13px] font-medium text-fg">{data.strength}</div>
                </div>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="border-separate border-spacing-1 text-[12px]">
                <thead>
                  <tr>
                    <th className="text-left font-normal text-faint"></th>
                    {data.columns.map((c) => (
                      <th key={c.runId} className="px-1 font-normal text-faint">
                        {c.startedAt.slice(5, 10)}
                      </th>
                    ))}
                    <th className="px-1 font-normal text-faint">hit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.criteria.map((crit, i) => (
                    <tr key={crit}>
                      <td className="whitespace-nowrap pr-2 font-medium text-fg">{crit}</td>
                      {data.columns.map((c) => (
                        <td key={c.runId} className="p-0">
                          <div className={`mx-auto h-5 w-5 rounded ${CELL[c.cells[i]] ?? CELL.unknown}`} />
                        </td>
                      ))}
                      <td className="px-1 text-center tabular-nums text-muted">
                        {data.hits[i]}/{data.columns.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire a "View trend" button into `GuideReviewSection`**

In `ActivityPanel.tsx`: `import GuideTrendView from "./GuideTrendView";`. Add `const [trendFor, setTrendFor] = useState<{ id: string; name: string } | null>(null);` inside `GuideReviewSection`. In each run's header, next to the overall pill, add:

```tsx
              <button
                className="ml-auto text-[11px] text-accent hover:underline"
                onClick={() => setTrendFor({ id: run.template_id, name: run.template_name })}
              >
                View trend
              </button>
```

And at the end of `GuideReviewSection`'s returned fragment, render the modal:

```tsx
      {trendFor ? (
        <GuideTrendView
          templateId={trendFor.id}
          templateName={trendFor.name}
          onClose={() => setTrendFor(null)}
        />
      ) : null}
```

(Wrap the `runs.map(...)` and this modal in a single parent `<div>` if not already, so both are returned.)

- [ ] **Step 3: Typecheck / build + tests**

Run: `bun run build && bun test`
Expected: build succeeds; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/GuideTrendView.tsx src/components/ActivityPanel.tsx
git commit -m "feat(guide): cross-meeting trend view"
```

---

## Manual verification (after Task 9, and again after Task 11)

Requires a real build + guided meeting (per CLAUDE.md build/reinstall workflow — no permission-related changes here, so skip TCC reset):

1. `bun tauri build --bundles app`, reinstall, launch.
2. Start a meeting, attach a guide (e.g. Leadership presence), talk for a bit, stop.
3. Confirm in `~/Library/Logs/EchoScribe/echo-scribe.log.*`: `[guide-review] ready` with `target: "guide"`.
4. Open the meeting in the detail panel → the **Guide review** panel shows overall pill, expandable criteria, emergent, synthesis, and a live-coaching timeline fold.
5. Click **View trend** → the heatmap modal renders with this call as the newest column.
6. Force a failure (e.g. temporarily unload the LLM model) to confirm the `failed` state + **Retry** path and the friendly message.
