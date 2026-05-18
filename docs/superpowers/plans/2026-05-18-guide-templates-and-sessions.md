# Guide Templates + Guided Sessions — Implementation Plan (Plan B1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user create/edit/delete reusable guide templates (name, description, goal, notes) and start a manually-triggered "guided session" — a normal meeting recording with the chosen template snapshot persisted into the meeting record.

**Architecture:** A new `guide_templates` SQLite table (migration v10) + a `db/guide_templates.rs` CRUD module modeled on `db/projects.rs`. The `meetings` row gains a `guide_template_json` column (immutable snapshot, mirrors `calendar_match_json`). Tauri commands expose template CRUD and a `start_guided_session(template_id)` that calls the existing `MeetingManager::start` then persists the snapshot via a new `update_guide_template`. Frontend: a `GuideTemplateManager` settings component (modeled on `ProjectManager.tsx`) and a "Start guided session" picker in `MeetingsView`.

**Tech Stack:** Rust, rusqlite, tauri, serde, React/TypeScript, Tailwind.

This is **Plan B1** of the Guide feature. The live guidance engine + always-on-top HUD overlay is **Plan B2**, authored after B1 lands (it binds to the meeting/chunk interfaces and is gated on the Task 9 RSS finding per the design spec `docs/superpowers/specs/2026-05-16-meeting-guide-design.md`). A guided session run during Task 9 (Task 9 below) doubles as the real-meeting RSS capture for Plan A Phase 0.

---

## File Structure

- `src-tauri/src/db/schema.rs` — MODIFY: append migration `(10, ...)`; bump version assertions; add v10 test.
- `src-tauri/src/db/guide_templates.rs` — CREATE: `GuideTemplate` struct + CRUD + tests.
- `src-tauri/src/db/mod.rs` — MODIFY: `pub mod guide_templates;`.
- `src-tauri/src/db/meetings.rs` — MODIFY: add `guide_template_json` to `MeetingRow` + CRUD plumbing + `update_guide_template` + fixture.
- `src-tauri/src/meeting/mod.rs` — MODIFY: fix `insert_test_meeting` test fixture for the new column.
- `src-tauri/src/commands.rs` — MODIFY: 5 new commands.
- `src-tauri/src/lib.rs` — MODIFY: register 5 commands in `generate_handler!`.
- `src/lib/api.ts` — MODIFY: `GuideTemplate` type + 5 bindings.
- `src/components/GuideTemplateManager.tsx` — CREATE: settings CRUD component.
- `src/views/Settings.tsx` — MODIFY: render `<GuideTemplateManager />` in `MeetingsTab`.
- `src/views/sections/MeetingsView.tsx` — MODIFY: "Start guided session" picker.

---

## Phase 1 — DB layer

### Task 1: Migration v10 — guide_templates table + meetings column

**Files:**
- Modify: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: Append the v10 migration**

In `src-tauri/src/db/schema.rs`, the `MIGRATIONS` array currently ends:
```rust
    (
        9,
        r#"
ALTER TABLE meetings ADD COLUMN calendar_match_json TEXT;
"#,
    ),
];
```
Insert a new tuple before the closing `];`:
```rust
    (
        9,
        r#"
ALTER TABLE meetings ADD COLUMN calendar_match_json TEXT;
"#,
    ),
    (
        10,
        r#"
CREATE TABLE IF NOT EXISTS guide_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

ALTER TABLE meetings ADD COLUMN guide_template_json TEXT;
"#,
    ),
];
```

- [ ] **Step 2: Bump the two version assertions**

In `src-tauri/src/db/schema.rs`:
- Line ~249, in `migrations_are_idempotent`: change `assert_eq!(v, "9");` to `assert_eq!(v, "10");`
- Line ~339, in `migration_v7_creates_meetings_tables`: change `assert_eq!(version, "9");` to `assert_eq!(version, "10");`

- [ ] **Step 3: Add the v10 migration test**

Immediately after the `migration_v9_adds_calendar_match_json_column` test (ends ~line 268) add:
```rust
    #[test]
    fn migration_v10_creates_guide_templates_and_meetings_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();

        let tcols: Vec<String> = conn
            .prepare("PRAGMA table_info(guide_templates)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["id", "name", "description", "goal", "notes", "created_at", "updated_at"] {
            assert!(
                tcols.iter().any(|c| c == expected),
                "guide_templates missing column {expected}; got {tcols:?}"
            );
        }

        let mcols: Vec<String> = conn
            .prepare("PRAGMA table_info(meetings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            mcols.iter().any(|c| c == "guide_template_json"),
            "meetings missing guide_template_json column; got {mcols:?}"
        );
    }
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib db::schema::`
Expected: all schema tests PASS, including `migrations_are_idempotent` (now "10"), `migration_v7_creates_meetings_tables` (now "10"), and `migration_v10_creates_guide_templates_and_meetings_column`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/schema.rs
git commit -m "feat(db): migration v10 — guide_templates table + meetings.guide_template_json"
```

### Task 2: guide_templates CRUD module

**Files:**
- Create: `src-tauri/src/db/guide_templates.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: Register the module**

In `src-tauri/src/db/mod.rs`, in the `pub mod ...;` block (after `pub mod daily_summaries;`), add:
```rust
pub mod guide_templates;
```

- [ ] **Step 2: Write the module with tests (TDD: tests included, implement to green)**

Create `src-tauri/src/db/guide_templates.rs`:
```rust
//! CRUD for user-authored guide templates. A template is reusable context
//! (goal + freeform notes) the user attaches to a guided meeting session.

use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuideTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub goal: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_template(row: &Row<'_>) -> rusqlite::Result<GuideTemplate> {
    Ok(GuideTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        goal: row.get("goal")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_template(conn: &Connection, t: &GuideTemplate) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO guide_templates
            (id, name, description, goal, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![t.id, t.name, t.description, t.goal, t.notes, t.created_at, t.updated_at],
    )?;
    Ok(())
}

pub fn list_templates(conn: &Connection) -> Result<Vec<GuideTemplate>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, goal, notes, created_at, updated_at
         FROM guide_templates ORDER BY name COLLATE NOCASE ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_template)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_template(conn: &Connection, id: &str) -> Result<Option<GuideTemplate>, DbError> {
    conn.query_row(
        "SELECT id, name, description, goal, notes, created_at, updated_at
         FROM guide_templates WHERE id = ?1",
        [id],
        row_to_template,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn update_template(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    goal: &str,
    notes: &str,
    updated_at: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE guide_templates
         SET name = ?1, description = ?2, goal = ?3, notes = ?4, updated_at = ?5
         WHERE id = ?6",
        params![name, description, goal, notes, updated_at, id],
    )?;
    Ok(())
}

pub fn delete_template(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM guide_templates WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make(id: &str, name: &str) -> GuideTemplate {
        GuideTemplate {
            id: id.into(),
            name: name.into(),
            description: "desc".into(),
            goal: "the goal".into(),
            notes: "ask about tools\nask about bottlenecks".into(),
            created_at: "2026-05-18T00:00:00Z".into(),
            updated_at: "2026-05-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn insert_get_round_trip() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        let got = get_template(&c, "t1").unwrap().unwrap();
        assert_eq!(got, make("t1", "Discovery"));
    }

    #[test]
    fn get_missing_is_none() {
        let c = fresh();
        assert!(get_template(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn list_sorted_by_name_nocase() {
        let c = fresh();
        insert_template(&c, &make("t1", "zebra")).unwrap();
        insert_template(&c, &make("t2", "Alpha")).unwrap();
        let names: Vec<String> = list_templates(&c).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["Alpha".to_string(), "zebra".to_string()]);
    }

    #[test]
    fn update_changes_fields_and_timestamp() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        update_template(&c, "t1", "Renamed", "d2", "g2", "n2", "2026-05-19T00:00:00Z").unwrap();
        let got = get_template(&c, "t1").unwrap().unwrap();
        assert_eq!(got.name, "Renamed");
        assert_eq!(got.description, "d2");
        assert_eq!(got.goal, "g2");
        assert_eq!(got.notes, "n2");
        assert_eq!(got.updated_at, "2026-05-19T00:00:00Z");
        assert_eq!(got.created_at, "2026-05-18T00:00:00Z");
    }

    #[test]
    fn delete_removes_row() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        delete_template(&c, "t1").unwrap();
        assert!(get_template(&c, "t1").unwrap().is_none());
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib db::guide_templates::`
Expected: 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/guide_templates.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): guide_templates CRUD module"
```

### Task 3: Persist guide-template snapshot on meetings

**Files:**
- Modify: `src-tauri/src/db/meetings.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (test fixture only)

- [ ] **Step 1: Add the field to `MeetingRow`**

In `src-tauri/src/db/meetings.rs`, after the `calendar_match_json` field (line ~25), add inside the struct:
```rust
    /// Immutable snapshot of the guide template attached to this meeting at
    /// start time (a `crate::db::guide_templates::GuideTemplate` serialized as
    /// JSON). `None` for non-guided meetings. Frozen — later edits to the
    /// template must not rewrite history.
    #[serde(default)]
    pub guide_template_json: Option<String>,
```

- [ ] **Step 2: Update INSERT (cols + placeholders + params)**

Replace the `insert_meeting` SQL + params with:
```rust
pub fn insert_meeting(conn: &Connection, m: &MeetingRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meetings (
            item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
            status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only,
            calendar_match_json, guide_template_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            m.item_id,
            m.started_at,
            m.ended_at,
            m.duration_ms,
            m.detected_app,
            m.detected_app_name,
            m.status,
            m.transcript_json,
            m.summary_json,
            m.user_notes,
            m.failed_chunk_count,
            m.mic_only as i64,
            m.calendar_match_json,
            m.guide_template_json,
        ],
    )?;
    Ok(())
}
```

- [ ] **Step 3: Update both SELECT column lists**

In `get_meeting` and `list_meetings`, change the SELECT column list from ending `... mic_only,\n                calendar_match_json` to also include `guide_template_json`:

`get_meeting` SQL becomes:
```rust
        "SELECT item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
                status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only,
                calendar_match_json, guide_template_json
         FROM meetings WHERE item_id = ?1",
```
`list_meetings` SQL becomes:
```rust
        "SELECT item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
                status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only,
                calendar_match_json, guide_template_json
         FROM meetings ORDER BY started_at DESC",
```

- [ ] **Step 4: Update `row_to_meeting`**

Add the trailing field (column index 13) to `row_to_meeting`:
```rust
fn row_to_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRow> {
    Ok(MeetingRow {
        item_id: row.get(0)?,
        started_at: row.get(1)?,
        ended_at: row.get(2)?,
        duration_ms: row.get(3)?,
        detected_app: row.get(4)?,
        detected_app_name: row.get(5)?,
        status: row.get(6)?,
        transcript_json: row.get(7)?,
        summary_json: row.get(8)?,
        user_notes: row.get(9)?,
        failed_chunk_count: row.get(10)?,
        mic_only: row.get::<_, i64>(11)? != 0,
        calendar_match_json: row.get(12)?,
        guide_template_json: row.get(13)?,
    })
}
```

- [ ] **Step 5: Add `update_guide_template`**

After `update_calendar_match` (line ~93) add:
```rust
/// Persist the immutable guide-template snapshot on a meeting row. Called
/// once right after a guided session starts. Mirrors `update_calendar_match`.
pub fn update_guide_template(
    conn: &Connection,
    item_id: &str,
    guide_template_json: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET guide_template_json = ?1 WHERE item_id = ?2",
        params![guide_template_json, item_id],
    )?;
    Ok(())
}
```

- [ ] **Step 6: Fix the `sample()` test fixture**

In the `tests` module `sample()` (line ~183), add the new field after `calendar_match_json: None,`:
```rust
            calendar_match_json: None,
            guide_template_json: None,
```

- [ ] **Step 7: Add a round-trip test**

After `calendar_match_round_trip` add:
```rust
    #[test]
    fn guide_template_round_trip() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        let snap = r#"{"id":"t1","name":"Discovery","goal":"g","notes":"n"}"#;
        update_guide_template(&conn, "m-1", Some(snap)).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.guide_template_json.as_deref(), Some(snap));

        update_guide_template(&conn, "m-1", None).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert!(got.guide_template_json.is_none());
    }
```

- [ ] **Step 8: Fix the other `MeetingRow` literal in `meeting/mod.rs`**

In `src-tauri/src/meeting/mod.rs`, the production `MeetingRow { ... }` in `start()` (the `insert_meeting` call, ~line 252) and the test helper `insert_test_meeting` (~line 1029) both construct `MeetingRow` with explicit fields ending `calendar_match_json: None,`. In BOTH, add directly after that line:
```rust
                calendar_match_json: None,
                guide_template_json: None,
```
(Match the existing indentation at each site.)

- [ ] **Step 9: Build + test**

Run: `cd src-tauri && cargo test --lib db::meetings:: meeting::`
Expected: all PASS including `guide_template_round_trip`. Then `cd src-tauri && cargo build --lib` — compiles (pre-existing `detected_app` warning only).

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/meetings.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(db): persist immutable guide-template snapshot on meetings"
```

---

## Phase 2 — Backend commands

### Task 4: Guide template CRUD commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, append (near the other DB-state commands; the file already imports `ulid`, `State`, `AppState`, `require_db`, and `chrono_now_iso` — verify with a quick grep, they are used by `create_project`):
```rust
// ============================================================================
// Guide templates
// ============================================================================

#[tauri::command]
pub fn list_guide_templates(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::guide_templates::GuideTemplate>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| crate::db::guide_templates::list_templates(c))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_guide_template(
    state: State<'_, AppState>,
    name: String,
    description: String,
    goal: String,
    notes: String,
) -> Result<crate::db::guide_templates::GuideTemplate, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("template name cannot be empty".into());
    }
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    let t = crate::db::guide_templates::GuideTemplate {
        id: ulid::Ulid::new().to_string(),
        name: trimmed,
        description,
        goal,
        notes,
        created_at: now.clone(),
        updated_at: now,
    };
    let t2 = t.clone();
    db.with_conn(move |c| crate::db::guide_templates::insert_template(c, &t2))
        .map_err(|e| e.to_string())?;
    Ok(t)
}

#[tauri::command]
pub fn update_guide_template(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    goal: String,
    notes: String,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("template name cannot be empty".into());
    }
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    db.with_conn(move |c| {
        crate::db::guide_templates::update_template(
            c, &id, &trimmed, &description, &goal, &notes, &now,
        )
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_guide_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(move |c| crate::db::guide_templates::delete_template(c, &id))
        .map_err(|e| e.to_string())
}
```

> If `require_db` / `chrono_now_iso` / `ulid` / `State` are not already in scope in `commands.rs`, they are — `create_project` (same file) uses all four. Do not add imports.

- [ ] **Step 2: Register in the invoke handler**

In `src-tauri/src/lib.rs`, in the `tauri::generate_handler![ ... ]` list, immediately before the closing `])` (after `commands::daily_recap_notification_permission_status,`), add:
```rust
            commands::list_guide_templates,
            commands::create_guide_template,
            commands::update_guide_template,
            commands::delete_guide_template,
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles (pre-existing `detected_app` warning only). A successful build proves the `#[tauri::command]` signatures + handler registration are consistent.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): guide template CRUD commands"
```

### Task 5: start_guided_session command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command**

In `src-tauri/src/commands.rs`, directly after `start_meeting_manual` (and its `capture_meeting_start_context` helper, ~line 1879), add:
```rust
/// Start a manually-triggered guided session: a normal meeting recording
/// with an immutable snapshot of the chosen guide template frozen onto the
/// meeting row. The live HUD/guidance loop is Plan B2 — this only attaches
/// the template so the session is reviewable later.
#[tauri::command]
pub async fn start_guided_session(
    state: tauri::State<'_, AppState>,
    template_id: String,
) -> Result<String, String> {
    // Load + snapshot the template BEFORE starting so a missing template
    // fails fast without leaving a dangling recording.
    let db = require_db(&state)?;
    let tid = template_id.clone();
    let template = db
        .with_conn(move |c| crate::db::guide_templates::get_template(c, &tid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("guide template {template_id} not found"))?;
    let snapshot = serde_json::to_string(&template).map_err(|e| e.to_string())?;

    let start_context = capture_meeting_start_context();
    let id = state
        .meeting_manager
        .clone()
        .start(None, None, start_context)
        .await
        .map_err(|e| e.to_string())?;

    // Persist the immutable snapshot onto the freshly-created meeting row.
    let id_for_db = id.clone();
    db.with_conn(move |c| {
        crate::db::meetings::update_guide_template(c, &id_for_db, Some(snapshot.as_str()))
    })
    .map_err(|e| e.to_string())?;

    crate::meeting::detector::spawn_end_monitor(state.meeting_manager.clone(), None);
    Ok(id)
}
```

- [ ] **Step 2: Register in the invoke handler**

In `src-tauri/src/lib.rs`, in `generate_handler![ ... ]`, add after the four template CRUD commands from Task 4:
```rust
            commands::start_guided_session,
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles cleanly (pre-existing `detected_app` warning only).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): start_guided_session attaches template snapshot to meeting"
```

---

## Phase 3 — Frontend

### Task 6: API bindings

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the type + bindings**

At the END of `src/lib/api.ts` append:
```ts
// ===================== Guide templates =====================

export type GuideTemplate = {
  id: string;
  name: string;
  description: string;
  goal: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

export const listGuideTemplates = (): Promise<GuideTemplate[]> =>
  invoke("list_guide_templates");

export const createGuideTemplate = (
  name: string,
  description: string,
  goal: string,
  notes: string,
): Promise<GuideTemplate> =>
  invoke("create_guide_template", { name, description, goal, notes });

export const updateGuideTemplate = (
  id: string,
  name: string,
  description: string,
  goal: string,
  notes: string,
): Promise<void> =>
  invoke("update_guide_template", { id, name, description, goal, notes });

export const deleteGuideTemplate = (id: string): Promise<void> =>
  invoke("delete_guide_template", { id });

export const startGuidedSession = (templateId: string): Promise<string> =>
  invoke("start_guided_session", { templateId });
```

> Arg keys are camelCase to match Tauri's snake_case→camelCase conversion (`template_id` → `templateId`); the other params are already single-word so they map 1:1.

- [ ] **Step 2: Typecheck**

Run: `bun run build` (or `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bunx tsc --noEmit`)
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): guide template + guided-session bindings"
```

### Task 7: GuideTemplateManager settings component

**Files:**
- Create: `src/components/GuideTemplateManager.tsx`
- Modify: `src/views/Settings.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/GuideTemplateManager.tsx` (modeled on `src/components/ProjectManager.tsx` — same `useToasts`, Tailwind vocabulary, list+form pattern):
```tsx
import { useCallback, useEffect, useState } from "react";
import {
  listGuideTemplates,
  createGuideTemplate,
  updateGuideTemplate,
  deleteGuideTemplate,
  type GuideTemplate,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

type Draft = { name: string; description: string; goal: string; notes: string };

const EMPTY: Draft = { name: "", description: "", goal: "", notes: "" };

export default function GuideTemplateManager() {
  const toasts = useToasts();
  const [items, setItems] = useState<GuideTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    listGuideTemplates()
      .then(setItems)
      .catch((e) =>
        toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, [toasts]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraft(EMPTY);
  };

  const startEdit = (t: GuideTemplate) => {
    setCreating(false);
    setEditingId(t.id);
    setDraft({ name: t.name, description: t.description, goal: t.goal, notes: t.notes });
  };

  const cancel = () => {
    setCreating(false);
    setEditingId(null);
    setDraft(EMPTY);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toasts.push({ tone: "error", message: "Template name is required." });
      return;
    }
    try {
      if (creating) {
        await createGuideTemplate(draft.name, draft.description, draft.goal, draft.notes);
      } else if (editingId) {
        await updateGuideTemplate(
          editingId,
          draft.name,
          draft.description,
          draft.goal,
          draft.notes,
        );
      }
      cancel();
      refresh();
    } catch (e) {
      toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteGuideTemplate(id);
      refresh();
    } catch (e) {
      toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const editor = (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3">
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-[13px]"
        placeholder="Name (e.g. Customer discovery)"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-[13px]"
        placeholder="Short description"
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <textarea
        className="min-h-[48px] rounded-md border border-line bg-canvas px-2 py-1 text-[13px]"
        placeholder="Goal — what should this conversation achieve?"
        value={draft.goal}
        onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
      />
      <textarea
        className="min-h-[96px] rounded-md border border-line bg-canvas px-2 py-1 text-[13px]"
        placeholder="Notes — questions to ask, talking points, context"
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          className="rounded-md bg-accent px-3 py-1 text-[13px] text-canvas hover:bg-accent-hover"
          onClick={save}
        >
          Save
        </button>
        <button
          className="rounded-md border border-line px-3 py-1 text-[13px] text-muted"
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 && !creating && (
        <p className="text-[12px] text-faint">No guide templates yet.</p>
      )}
      {items.map((t) =>
        editingId === t.id ? (
          <div key={t.id}>{editor}</div>
        ) : (
          <div
            key={t.id}
            className="flex items-start justify-between rounded-md border border-line bg-canvas p-3"
          >
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg">{t.name}</div>
              {t.description && (
                <div className="text-[12px] text-muted">{t.description}</div>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                className="text-[12px] text-muted hover:text-fg"
                onClick={() => startEdit(t)}
              >
                Edit
              </button>
              <button
                className="text-[12px] text-muted hover:text-fg"
                onClick={() => remove(t.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ),
      )}
      {creating ? (
        editor
      ) : (
        <button
          className="self-start rounded-md border border-line px-3 py-1 text-[13px] text-muted hover:text-fg"
          onClick={startCreate}
        >
          + New template
        </button>
      )}
    </div>
  );
}
```

> The Tailwind tokens (`border-line`, `bg-canvas`, `bg-accent`, `text-canvas`, `text-muted`, `text-faint`, `text-fg`, `accent-hover`) are copied from `ProjectManager.tsx`/Settings — verify against that file and adjust any token that differs in this codebase before finishing.

- [ ] **Step 2: Render it in the Meetings settings tab**

In `src/views/Settings.tsx`:
- Add the import near the other component imports (e.g. by `import ProjectManager from "../components/ProjectManager";`):
```tsx
import GuideTemplateManager from "../components/GuideTemplateManager";
```
- In the `MeetingsTab` function, inside its returned `<div className="flex flex-col gap-8">`, add a new section (after the existing sections, before the closing `</div>`):
```tsx
      <Section
        title="Guide templates"
        subtitle="Reusable goals + notes you can attach to a guided meeting session."
      >
        <GuideTemplateManager />
      </Section>
```

- [ ] **Step 3: Typecheck + build**

Run: `bun run build`
Expected: no TypeScript errors; Vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/GuideTemplateManager.tsx src/views/Settings.tsx
git commit -m "feat(ui): Guide Templates settings section (CRUD)"
```

### Task 8: "Start guided session" entrypoint in MeetingsView

**Files:**
- Modify: `src/views/sections/MeetingsView.tsx`

- [ ] **Step 1: Add picker state + handler**

In `src/views/sections/MeetingsView.tsx`:
- Extend the api import (it currently imports `isMeetingActive, listMeetings, startMeetingManual, stopMeeting`) to also import:
```tsx
  listGuideTemplates,
  startGuidedSession,
  type GuideTemplate,
```
- Add state near the existing `busy`/`active` state:
```tsx
  const [templates, setTemplates] = useState<GuideTemplate[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
```
- Add an effect to load templates once (near the existing effects):
```tsx
  useEffect(() => {
    listGuideTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);
```
- Add a handler (next to `onToggle`):
```tsx
  const onStartGuided = useCallback(
    async (templateId: string) => {
      if (busy) return;
      setBusy(true);
      setPickerOpen(false);
      try {
        await startGuidedSession(templateId);
        await refreshActive();
      } catch (e) {
        toasts.push({
          tone: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshActive, toasts],
  );
```

- [ ] **Step 2: Add the button + picker to the header**

In the header JSX (where `{toggleButton}` is rendered next to the `<h2>`), add — only when not active and templates exist — a guided-start control beside it:
```tsx
        {!active && templates.length > 0 && (
          <div className="relative">
            <button
              className="rounded-md border border-line px-3 py-1 text-[13px] text-muted hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={() => setPickerOpen((o) => !o)}
            >
              Start guided session
            </button>
            {pickerOpen && (
              <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-line bg-canvas p-1 shadow-lg">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-fg hover:bg-line"
                    onClick={() => onStartGuided(t.id)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
```
Place this immediately before or after `{toggleButton}` inside the header's flex container so both controls sit together.

- [ ] **Step 3: Typecheck + build**

Run: `bun run build`
Expected: no TypeScript errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/views/sections/MeetingsView.tsx
git commit -m "feat(ui): Start guided session picker in Meetings view"
```

---

## Phase 4 — Build, verify, and capture Task 9 RSS finding

### Task 9: Real-app verification + Plan A Phase 0 RSS capture

**Files:** none (manual verification — also satisfies Plan A Task 9)

- [ ] **Step 1: Full Rust test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: all pass (Plan A's 295 + the new guide_templates/meetings/schema tests).

- [ ] **Step 2: Build + reinstall per CLAUDE.md**

Run `bun tauri build --bundles app`, then the full TCC reset + reinstall sequence from `CLAUDE.md` (quit, `tccutil reset` Microphone/Accessibility/ScreenCapture, replace `/Applications/Echo Scribe.app`, relaunch). Re-grant permissions when prompted.

- [ ] **Step 3: Create a template + run a guided session (this IS Plan A Task 9)**

In the app: Settings → Meetings → Guide templates → create one (name "Customer discovery", goal + notes filled). Then Meetings → "Start guided session" → pick it. Talk with natural pauses for **~8–10 minutes** (solo is fine). Stop. Wait for transcribing → summarizing → complete.

- [ ] **Step 4: Capture findings**

- Verify the guided session produced a normal saved meeting (transcript + summary) AND `guide_template_json` is populated:
  `sqlite3 "$HOME/Library/Application Support/EchoScribe/<db-file>" "SELECT substr(guide_template_json,1,80) FROM meetings ORDER BY started_at DESC LIMIT 1;"` (find the db path via Settings → Diagnostics or the data dir).
- Read the `[mem]` RSS trace captured at `/tmp/echo-task9-mem.log` (the background capture armed earlier; if the tail died, `grep -h "\[mem\]" ~/Library/Logs/EchoScribe/echo-scribe.log.$(date +%F)`). Determine: does RSS stay flat across `after chunk transcribe` lines (bounded — good) or climb per chunk (drain leak) or jump only at `after synthesize` (LLM-side)?
- Eyeball the saved transcript for dropped/duplicated words at chunk seams.

- [ ] **Step 5: Record the finding**

Append a "Phase 0 finding" section to `docs/superpowers/plans/2026-05-16-unified-pipeline-refactor.md` with the RSS numbers + the localized label, and a "B1 verification" note here (guided session saved + snapshot persisted: yes/no). Commit:
```bash
git add docs/superpowers/plans/2026-05-16-unified-pipeline-refactor.md docs/superpowers/plans/2026-05-18-guide-templates-and-sessions.md
git commit -m "docs: record Task 9 RSS finding + B1 verification"
```

> The RSS finding gates Plan B2 (live guidance engine + HUD): if synthesis is the 2 GiB source, B2's contention policy and the engine cadence design may need revisiting before implementation.

---

## Self-Review

**Spec coverage (`2026-05-16-meeting-guide-design.md` §2, the B1 slice):**
- `guide_templates` table (id, name, description, goal, notes, timestamps) → Task 1–2. ✓
- Template CRUD UI ("Guide Templates" settings section, list + add/edit/delete) → Tasks 6–7. ✓
- Manual "Start guided session" → template picker → starts a normal meeting → Tasks 5, 8. ✓
- A guided session **is** a meeting (full recorder/ASR/synthesis reused) → Task 5 calls existing `MeetingManager::start`, no recording fork. ✓
- Guide artifact saved into the meeting record = **frozen template snapshot** (`guide_template_json`, immutable, later template edits don't rewrite history) → Tasks 3, 5. ✓
- Auto-detected meetings with no guided session unchanged → no change to detector/auto path; `guide_template_json` defaults `None`. ✓
- Out of B1 scope (correctly deferred to Plan B2): live HUD overlay, guidance LLM loop, in-call mode toggle, derived key-points, suggestion timeline. The spec's "timeline of suggestions / final derived points" artifacts are B2 (they don't exist until the engine does); B1 persists only the template snapshot, which is the part needed now.

**Placeholder scan:** No TBD/TODO. Every code step has complete code. Tasks 7–9 frontend/manual steps use exact code + `bun run build` / real-app verification (no test infra exists for the React layer; build+typecheck is the gate, real-meeting is the functional check — and doubles as the required Plan A Task 9).

**Type consistency:** `GuideTemplate` fields (id/name/description/goal/notes/created_at/updated_at) identical across `db/guide_templates.rs` (Task 2), commands (Task 4), `api.ts` type (Task 6), and the TS component (Task 7). `update_guide_template` (db/meetings.rs, Task 3) vs `update_template` (db/guide_templates.rs, Task 2) are distinct names for distinct tables — intentional, not a collision. Command arg `template_id` ↔ `api.ts` `templateId` ↔ `start_guided_session` param — consistent. `MeetingRow.guide_template_json` added in Task 3 and consumed in Task 5's `update_guide_template` call.

**Migration ordering:** v10 single batch creates `guide_templates` AND adds `meetings.guide_template_json` (Task 1); Task 3's `MeetingRow`/SQL changes depend on that column existing — Task 1 precedes Task 3. The two version assertions (`"9"`→`"10"`) are bumped in Task 1 Step 2 so the suite stays green from that commit onward.
