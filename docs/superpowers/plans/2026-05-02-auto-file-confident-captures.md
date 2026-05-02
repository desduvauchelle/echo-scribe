# Auto-File Confident Captures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a log_capture is classified with high confidence into an *existing* project, persist it silently and notify the user via in-app toast (window visible) or OS notification (window hidden). When confidence is low or the LLM proposes a new project, fall through to the existing review overlay.

**Architecture:** The classifier already produces a `confidence: f32` score. Today the coordinator unconditionally emits `log_capture:classification_ready` for the overlay. We introduce a branch in the coordinator that calls `persist_log_capture` directly when:
- `settings.auto_file_enabled` is true (default `true`), AND
- `cls.confidence >= settings.auto_file_threshold` (default `0.75`), AND
- `cls.project_id` is `Some` (matched an existing project), AND
- `cls.new_project_name` is `None`.

On auto-file, the coordinator emits a new `log_capture:auto_filed` event (frontend renders an in-app toast with Undo) and, if the main window isn't visible, also fires a system notification via `tauri-plugin-notification`. We persist `confidence` and `classified_by` columns on `items` so we can audit AI vs. user classifications later. Undo soft-deletes the item.

**Tech Stack:** Rust (Tauri 2, rusqlite), TypeScript (React 18), `tauri-plugin-notification`, existing `ToastProvider`.

---

## File Structure

**Backend (Rust):**
- Modify `src-tauri/Cargo.toml` — add `tauri-plugin-notification = "2"`.
- Modify `src-tauri/capabilities/default.json` — grant `notification:default` permission.
- Modify `src-tauri/src/db/schema.rs` — add migration #2 for `confidence`, `classified_by` columns on `items`.
- Modify `src-tauri/src/db/items.rs` — extend `Item` struct + row reader + insert.
- Modify `src-tauri/src/settings.rs` — `auto_file_enabled` and `auto_file_threshold` accessors.
- Modify `src-tauri/src/coordinator.rs` — branch in `Action::LogCapture`, extend `persist_log_capture` signature.
- Modify `src-tauri/src/commands.rs` — `undo_log_capture`, `get/set_auto_file_enabled`, `get/set_auto_file_threshold`.
- Modify `src-tauri/src/lib.rs` — register notification plugin + new commands.

**Frontend (TS):**
- Modify `src/lib/api.ts` — types + bindings for new commands and `LogCaptureAutoFiled` event.
- Modify `src/App.tsx` — listen for `log_capture:auto_filed`, push toast with Undo.
- Modify `src/views/LogCaptureOverlay.tsx` — show low-confidence warning banner when `confidence < threshold`.
- Modify `src/views/Settings.tsx` — toggle + threshold slider.

---

### Task 1: DB migration for `confidence` + `classified_by`

**Files:**
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/db/items.rs`
- Test: existing `src-tauri/src/db/items.rs` test module + new test in `schema.rs`

- [ ] **Step 1: Write failing test for migration #2 idempotency**

In `src-tauri/src/db/schema.rs`, append to the existing `#[cfg(test)] mod tests { ... }` block:

```rust
#[test]
fn migration_v2_adds_confidence_and_classified_by() {
    use rusqlite::Connection;
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    // Running again must be a no-op.
    run_migrations(&mut conn).unwrap();

    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(items)")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(cols.iter().any(|c| c == "confidence"), "missing confidence column; got {:?}", cols);
    assert!(cols.iter().any(|c| c == "classified_by"), "missing classified_by column; got {:?}", cols);
}
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd src-tauri && cargo test --lib db::schema::tests::migration_v2_adds_confidence_and_classified_by`
Expected: FAIL — column does not exist.

- [ ] **Step 3: Add migration #2 to the `MIGRATIONS` array**

In `src-tauri/src/db/schema.rs`, change the `MIGRATIONS` constant:

```rust
const MIGRATIONS: &[(u32, &str)] = &[
    (
        1,
        r#"
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  visibility TEXT NOT NULL,
  kind TEXT,
  project_id TEXT REFERENCES projects(id),
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_captured_at ON items(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_visibility ON items(visibility);
CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE IF NOT EXISTS tasks (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  deadline TEXT,
  completed_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  content, content='items', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO items_fts(rowid, content) VALUES (new.rowid, new.content);
END;
"#,
    ),
    (
        2,
        r#"
ALTER TABLE items ADD COLUMN confidence REAL;
ALTER TABLE items ADD COLUMN classified_by TEXT;
"#,
    ),
];
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd src-tauri && cargo test --lib db::schema::tests::migration_v2_adds_confidence_and_classified_by`
Expected: PASS.

- [ ] **Step 5: Extend `Item` struct + row reader + insert**

In `src-tauri/src/db/items.rs`, replace the `Item` struct with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: String,
    pub content: String,
    pub source: ItemSource,
    pub visibility: Visibility,
    pub kind: Option<ItemKind>,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub confidence: Option<f32>,
    pub classified_by: Option<String>,
}
```

(Note: this changes `PartialEq, Eq` to just `PartialEq` because `f32` is not `Eq`. Search the file for `Eq` on the Item derive and downgrade.)

In the same file, find the `row_to_item` function and append the two new fields before the closing brace:

```rust
fn row_to_item(row: &Row<'_>) -> rusqlite::Result<Item> {
    let source_s: String = row.get("source")?;
    let visibility_s: String = row.get("visibility")?;
    let kind_s: Option<String> = row.get("kind")?;
    Ok(Item {
        id: row.get("id")?,
        content: row.get("content")?,
        source: ItemSource::parse(&source_s).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("invalid source: {source_s}").into(),
            )
        })?,
        visibility: Visibility::parse(&visibility_s).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("invalid visibility: {visibility_s}").into(),
            )
        })?,
        kind: kind_s.and_then(|s| ItemKind::parse(&s)),
        project_id: row.get("project_id")?,
        captured_at: row.get("captured_at")?,
        created_at: row.get("created_at")?,
        deleted_at: row.get("deleted_at")?,
        confidence: row.get::<_, Option<f64>>("confidence")?.map(|v| v as f32),
        classified_by: row.get("classified_by")?,
    })
}
```

Find the `insert_item` function and update its SQL + bindings to include the new columns. The current insert looks roughly like:

```rust
pub fn insert_item(conn: &Connection, item: &Item) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO items(id, content, source, visibility, kind, project_id, captured_at, created_at, deleted_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            item.id, item.content, item.source.as_str(), item.visibility.as_str(),
            item.kind.map(|k| k.as_str()), item.project_id, item.captured_at,
            item.created_at, item.deleted_at,
        ],
    )?;
    Ok(())
}
```

Change to:

```rust
pub fn insert_item(conn: &Connection, item: &Item) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO items(id, content, source, visibility, kind, project_id, captured_at, created_at, deleted_at, confidence, classified_by)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            item.id, item.content, item.source.as_str(), item.visibility.as_str(),
            item.kind.map(|k| k.as_str()), item.project_id, item.captured_at,
            item.created_at, item.deleted_at,
            item.confidence.map(|f| f as f64), item.classified_by,
        ],
    )?;
    Ok(())
}
```

(Open `src-tauri/src/db/items.rs` and verify the exact form of `insert_item` matches before editing — the schema-bind list above is the target.)

- [ ] **Step 6: Update every `Item { ... }` literal in the codebase**

Run: `cd src-tauri && grep -rn "Item {" src/`

For every literal that builds an `Item`, add `confidence: None, classified_by: None,` before the closing brace. Known locations (from the investigation):

- `src-tauri/src/coordinator.rs` `persist_capture` (`VoiceAtCursor` path) — set both to `None`.
- `src-tauri/src/coordinator.rs` `persist_log_capture` — these will be parameterized in Task 4; for now set both to `None` to keep the build green.
- `src-tauri/src/classifier.rs` `tests::item` helper.
- Any other test-only literals.

- [ ] **Step 7: Run the full unit test suite to confirm no regressions**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS for every previously-passing test plus the new `migration_v2_*` test.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/schema.rs src-tauri/src/db/items.rs src-tauri/src/coordinator.rs src-tauri/src/classifier.rs
git commit -m "db: add confidence + classified_by columns to items"
```

---

### Task 2: Settings — auto_file_enabled + auto_file_threshold

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Test: same file's existing `#[cfg(test)] mod tests`

- [ ] **Step 1: Write failing tests for the new accessors**

Append to `src-tauri/src/settings.rs` inside the existing test module (or create a fresh `auto_file_tests` mod if more readable):

```rust
#[cfg(test)]
mod auto_file_tests {
    use super::*;

    #[test]
    fn auto_file_constants_are_correct() {
        assert_eq!(KEY_AUTO_FILE_ENABLED, "auto_file_enabled");
        assert_eq!(KEY_AUTO_FILE_THRESHOLD, "auto_file_threshold");
        assert!((DEFAULT_AUTO_FILE_THRESHOLD - 0.75).abs() < f32::EPSILON);
    }
}
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd src-tauri && cargo test --lib settings::auto_file_tests`
Expected: FAIL — symbols not found.

- [ ] **Step 3: Add the constants and accessor methods**

In `src-tauri/src/settings.rs`, add new constants near the existing `KEY_*` block:

```rust
const KEY_AUTO_FILE_ENABLED: &str = "auto_file_enabled";
const KEY_AUTO_FILE_THRESHOLD: &str = "auto_file_threshold";

/// Default threshold above which a high-confidence classification is auto-filed
/// without showing the review overlay.
pub const DEFAULT_AUTO_FILE_THRESHOLD: f32 = 0.75;
```

Then add accessors inside `impl SettingsStore`:

```rust
/// Whether log captures with `confidence >= threshold` are filed silently
/// (with a toast / notification) instead of opening the review overlay.
/// Defaults to `true`. New-project proposals always open the overlay
/// regardless of this flag.
pub fn auto_file_enabled(&self) -> bool {
    self.store
        .get(KEY_AUTO_FILE_ENABLED)
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

pub fn set_auto_file_enabled(&self, on: bool) -> Result<(), SettingsError> {
    self.store
        .set(KEY_AUTO_FILE_ENABLED, serde_json::Value::Bool(on));
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))?;
    Ok(())
}

/// Threshold (0.0–1.0) for auto-filing. Defaults to
/// [`DEFAULT_AUTO_FILE_THRESHOLD`]. Out-of-range stored values are clamped.
pub fn auto_file_threshold(&self) -> f32 {
    let raw = self
        .store
        .get(KEY_AUTO_FILE_THRESHOLD)
        .and_then(|v| v.as_f64())
        .map(|f| f as f32)
        .unwrap_or(DEFAULT_AUTO_FILE_THRESHOLD);
    raw.clamp(0.0, 1.0)
}

pub fn set_auto_file_threshold(&self, t: f32) -> Result<(), SettingsError> {
    let clamped = t.clamp(0.0, 1.0) as f64;
    self.store.set(
        KEY_AUTO_FILE_THRESHOLD,
        serde_json::Value::from(clamped),
    );
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))?;
    Ok(())
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd src-tauri && cargo test --lib settings::auto_file_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "settings: add auto_file_enabled + auto_file_threshold (default 0.75)"
```

---

### Task 3: Wire `tauri-plugin-notification`

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Grant the capability**

In `src-tauri/capabilities/default.json`, extend `permissions`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window and overlay",
  "windows": ["main", "recording_overlay"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "shell:default",
    "autostart:default",
    "notification:default"
  ]
}
```

- [ ] **Step 3: Register the plugin**

In `src-tauri/src/lib.rs`, find the chain of `.plugin(...)` calls (around line 121):

```rust
.plugin(tauri_plugin_shell::init())
.plugin(tauri_plugin_store::Builder::default().build())
.plugin(tauri_plugin_autostart::init(
```

Insert before `tauri_plugin_autostart`:

```rust
.plugin(tauri_plugin_notification::init())
```

- [ ] **Step 4: Build to confirm wiring**

Run: `cd src-tauri && cargo build`
Expected: build succeeds (a long first compile is normal — this pulls a new crate).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/capabilities/default.json src-tauri/src/lib.rs
git commit -m "deps: add tauri-plugin-notification for OS notifications"
```

---

### Task 4: Coordinator — auto-file branch + persist confidence/classified_by

**Files:**
- Modify: `src-tauri/src/coordinator.rs`
- Test: `src-tauri/src/coordinator.rs` (existing test module if any) or new `#[cfg(test)] mod auto_file_tests`

- [ ] **Step 1: Extend `persist_log_capture` signature**

In `src-tauri/src/coordinator.rs`, change `persist_log_capture` to accept `confidence` and `classified_by`. Replace its current signature + implementation header (around line 511) with:

```rust
#[allow(clippy::too_many_arguments)]
fn persist_log_capture(
    content: &str,
    kind: crate::db::items::ItemKind,
    project_id: Option<String>,
    new_project_name: Option<String>,
    tags: Vec<String>,
    deadline_iso: Option<String>,
    confidence: Option<f32>,
    classified_by: Option<&str>,
    db: Option<&Db>,
    event_log_root: Option<&std::path::Path>,
) -> Result<String, String> {
```

Inside the function, find the `let item = Item { ... }` literal and add the two new fields:

```rust
let item = Item {
    id: id.clone(),
    content: content.to_string(),
    source: ItemSource::LogCapture,
    visibility: Visibility::Visible,
    kind: Some(kind),
    project_id: final_project_id.clone(),
    captured_at: now.clone(),
    created_at: now.clone(),
    deleted_at: None,
    confidence,
    classified_by: classified_by.map(|s| s.to_string()),
};
```

- [ ] **Step 2: Update the existing `ConfirmLogCapture` call site**

In the same file, find the `CoordinatorMsg::ConfirmLogCapture` arm (around line 319) and pass `None, Some("user")` for the two new args (the user reviewed via overlay → they own this classification):

```rust
CoordinatorMsg::ConfirmLogCapture {
    content,
    kind,
    project_id,
    new_project_name,
    tags,
    deadline_iso,
    reply,
} => {
    let res = persist_log_capture(
        &content,
        kind,
        project_id,
        new_project_name,
        tags,
        deadline_iso,
        None,
        Some("user"),
        db.as_ref(),
        event_log_root.as_deref(),
    );
    // … unchanged below …
}
```

- [ ] **Step 3: Add a helper to decide whether to auto-file**

In `src-tauri/src/coordinator.rs`, just below `run_classifier`, add:

```rust
/// Returns true when the classification meets the user's auto-file criteria:
/// auto-file enabled, confidence ≥ threshold, an existing project matched,
/// and the LLM did NOT propose a new project. New-project proposals always
/// require the review overlay, regardless of confidence.
fn should_auto_file(
    cls: &Classification,
    enabled: bool,
    threshold: f32,
) -> bool {
    enabled
        && cls.project_id.is_some()
        && cls.new_project_name.is_none()
        && cls.confidence >= threshold
}

#[cfg(test)]
mod auto_file_tests {
    use super::*;
    use crate::db::items::ItemKind;

    fn cls(confidence: f32, project_id: Option<&str>, new_name: Option<&str>) -> Classification {
        Classification {
            kind: ItemKind::Note,
            project_id: project_id.map(|s| s.to_string()),
            new_project_name: new_name.map(|s| s.to_string()),
            tags: vec![],
            deadline_iso: None,
            confidence,
        }
    }

    #[test]
    fn auto_files_when_confident_and_existing_project() {
        assert!(should_auto_file(&cls(0.9, Some("p1"), None), true, 0.75));
    }

    #[test]
    fn refuses_when_disabled() {
        assert!(!should_auto_file(&cls(0.9, Some("p1"), None), false, 0.75));
    }

    #[test]
    fn refuses_below_threshold() {
        assert!(!should_auto_file(&cls(0.7, Some("p1"), None), true, 0.75));
    }

    #[test]
    fn refuses_when_no_project() {
        assert!(!should_auto_file(&cls(0.95, None, None), true, 0.75));
    }

    #[test]
    fn refuses_when_new_project_proposed() {
        assert!(!should_auto_file(
            &cls(0.95, None, Some("New Project")),
            true,
            0.75
        ));
    }

    #[test]
    fn boundary_at_threshold_is_inclusive() {
        assert!(should_auto_file(&cls(0.75, Some("p1"), None), true, 0.75));
    }
}
```

- [ ] **Step 4: Run the unit tests for the helper**

Run: `cd src-tauri && cargo test --lib coordinator::auto_file_tests`
Expected: PASS for all six tests.

- [ ] **Step 5: Branch the coordinator on auto-file**

In `src-tauri/src/coordinator.rs`, replace the body of the `Action::LogCapture` arm (currently lines 250–277). Today it always emits `classification_ready`. New behavior:

```rust
Action::LogCapture => {
    let cls = run_classifier(&llm, &text, db.as_ref()).await;
    feedback::play(Sfx::Ready);
    crate::overlay::hide_recording_overlay(&app);

    // Decide whether to auto-file or open the review overlay.
    let auto_file_settings = match app.try_state::<crate::commands::AppState>() {
        Some(s) => Some((
            s.settings.auto_file_enabled(),
            s.settings.auto_file_threshold(),
        )),
        None => None,
    };

    let auto_filed = match (&cls, auto_file_settings) {
        (Ok(c), Some((enabled, threshold)))
            if should_auto_file(c, enabled, threshold) =>
        {
            // Resolve the project name for the toast/notification before
            // we move `c.tags` into persist.
            let project_name = db
                .as_ref()
                .and_then(|db| {
                    db.with_conn(|conn| {
                        crate::db::projects::list_projects(conn, false)
                    })
                    .ok()
                })
                .and_then(|projs| {
                    let pid = c.project_id.as_deref()?;
                    projs.into_iter().find(|p| p.id == pid).map(|p| p.name)
                })
                .unwrap_or_else(|| "Unknown".to_string());

            let kind = c.kind;
            let project_id = c.project_id.clone();
            let tags = c.tags.clone();
            let deadline = c.deadline_iso.clone();
            let confidence = c.confidence;
            let res = persist_log_capture(
                &text,
                kind,
                project_id,
                None, // new_project_name — guaranteed None by should_auto_file
                tags,
                deadline,
                Some(confidence),
                Some("ai"),
                db.as_ref(),
                event_log_root.as_deref(),
            );
            match res {
                Ok(item_id) => {
                    let _ = app.emit("item:created", ());
                    notify_auto_filed(&app, &item_id, &project_name, kind, &text, confidence);
                    true
                }
                Err(e) => {
                    error!(?e, "auto-file persistence failed; falling back to overlay");
                    false
                }
            }
        }
        _ => false,
    };

    if !auto_filed {
        let payload = match &cls {
            Ok(c) => serde_json::json!({
                "transcript": text,
                "classification": c,
            }),
            Err(e) => {
                warn!(?e, "classifier failed; emitting null classification");
                serde_json::json!({
                    "transcript": text,
                    "classification": null,
                    "error": e.to_string(),
                })
            }
        };
        let _ = app.emit("log_capture:classification_ready", payload);
        force_state(&state, PipelineState::AwaitingConfirmation);
        on_state_change(TrayPipelineState::Processing);
    } else {
        force_state(&state, PipelineState::Idle);
        on_state_change(TrayPipelineState::Idle);
    }
    let _ = text;
}
```

- [ ] **Step 6: Add the `notify_auto_filed` helper**

In the same file, just above `persist_log_capture`, add:

```rust
/// Emit the in-app toast event AND, when the main window is not visible,
/// fire an OS notification so the user sees what was filed.
fn notify_auto_filed(
    app: &AppHandle<Wry>,
    item_id: &str,
    project_name: &str,
    kind: crate::db::items::ItemKind,
    content: &str,
    confidence: f32,
) {
    let preview = preview_first_chars(content, 120);
    let payload = serde_json::json!({
        "item_id": item_id,
        "project_name": project_name,
        "kind": kind.as_str(),
        "preview": preview,
        "confidence": confidence,
    });
    let _ = app.emit("log_capture:auto_filed", payload);

    // If the main window isn't visible, the user won't see the in-app toast.
    // Fall back to an OS notification (no Undo button — the user can open
    // the app to find/edit/delete the item).
    let main_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !main_visible {
        use tauri_plugin_notification::NotificationExt;
        let kind_label = match kind {
            crate::db::items::ItemKind::Task => "Task",
            crate::db::items::ItemKind::Note => "Note",
        };
        let title = format!("Filed to {project_name}");
        let body = format!("{kind_label}: {preview}");
        if let Err(e) = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            warn!(?e, "failed to show OS notification for auto-file");
        }
    }
}
```

- [ ] **Step 7: Run the full Rust test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS (including all auto_file_tests + every prior test).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/coordinator.rs
git commit -m "coordinator: auto-file high-confidence captures into existing projects"
```

---

### Task 5: `undo_log_capture` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register command)
- Test: `src-tauri/src/db/items.rs` (verify soft-delete helper exists; if not, add it)

- [ ] **Step 1: Confirm or add `soft_delete_item` in items.rs**

Run: `grep -n "soft_delete\|deleted_at\s*=" src-tauri/src/db/items.rs`

If a `soft_delete_item(conn, id)` function exists, use it as-is. If not, add at the end of `src-tauri/src/db/items.rs`:

```rust
/// Soft-delete an item by setting `deleted_at` to the current ISO timestamp.
/// Returns `Ok(false)` if no row matched.
pub fn soft_delete_item(
    conn: &Connection,
    id: &str,
    now_iso: &str,
) -> Result<bool, DbError> {
    let n = conn.execute(
        "UPDATE items SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now_iso],
    )?;
    Ok(n > 0)
}
```

Plus a quick test in the same file's `#[cfg(test)] mod tests`:

```rust
#[test]
fn soft_delete_marks_item_deleted() {
    use crate::db::schema::run_migrations;
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();

    let item = Item {
        id: "i1".into(),
        content: "hi".into(),
        source: ItemSource::LogCapture,
        visibility: Visibility::Visible,
        kind: Some(ItemKind::Note),
        project_id: None,
        captured_at: "2026-05-02T00:00:00Z".into(),
        created_at: "2026-05-02T00:00:00Z".into(),
        deleted_at: None,
        confidence: Some(0.9),
        classified_by: Some("ai".into()),
    };
    insert_item(&conn, &item).unwrap();

    let ok = soft_delete_item(&conn, "i1", "2026-05-02T00:01:00Z").unwrap();
    assert!(ok);
    let again = soft_delete_item(&conn, "i1", "2026-05-02T00:02:00Z").unwrap();
    assert!(!again, "second soft-delete should be a no-op");
}
```

(If a similar test already exists in the file, skip and reuse.)

- [ ] **Step 2: Run the test**

Run: `cd src-tauri && cargo test --lib db::items::tests::soft_delete`
Expected: PASS.

- [ ] **Step 3: Add the `undo_log_capture` Tauri command**

In `src-tauri/src/commands.rs`, append:

```rust
#[tauri::command]
pub fn undo_log_capture(
    item_id: String,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let now = crate::coordinator::chrono_now_iso();
    let db = state.db.as_ref().ok_or("database not available")?;
    let id_for_db = item_id.clone();
    db.with_conn(move |c| crate::db::items::soft_delete_item(c, &id_for_db, &now).map(|_| ()))
        .map_err(|e| e.to_string())?;
    let _ = app.emit("item:deleted", item_id);
    Ok(())
}
```

(Verify `chrono_now_iso` is exported from `coordinator.rs`. If it's private, expose it as `pub(crate) fn chrono_now_iso() -> String` in `coordinator.rs`. Same with `state.db` — confirm `AppState.db` is `Option<Db>` by reading the struct definition near the top of `commands.rs`.)

- [ ] **Step 4: Add commands for the new settings**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn get_auto_file_enabled(state: tauri::State<AppState>) -> bool {
    state.settings.auto_file_enabled()
}

#[tauri::command]
pub fn set_auto_file_enabled(
    enabled: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state
        .settings
        .set_auto_file_enabled(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_file_threshold(state: tauri::State<AppState>) -> f32 {
    state.settings.auto_file_threshold()
}

#[tauri::command]
pub fn set_auto_file_threshold(
    threshold: f32,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    state
        .settings
        .set_auto_file_threshold(threshold)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Register all four new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, find the `commands::` import line (around line 42) and add the four names:

```rust
use commands::{
    /* … existing … */
    undo_log_capture, get_auto_file_enabled, set_auto_file_enabled,
    get_auto_file_threshold, set_auto_file_threshold,
};
```

Then in the `tauri::generate_handler![...]` block (around line 189), add them to the list:

```rust
/* … existing handlers … */
undo_log_capture,
get_auto_file_enabled,
set_auto_file_enabled,
get_auto_file_threshold,
set_auto_file_threshold,
```

- [ ] **Step 6: Build and run unit tests**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/db/items.rs src-tauri/src/coordinator.rs
git commit -m "commands: undo_log_capture + auto_file settings getters/setters"
```

---

### Task 6: Frontend API bindings

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add types and bindings**

In `src/lib/api.ts`, append:

```ts
export type LogCaptureAutoFiled = {
  item_id: string;
  project_name: string;
  kind: "note" | "task";
  preview: string;
  confidence: number;
};

export const undoLogCapture = (itemId: string): Promise<void> =>
  invoke("undo_log_capture", { itemId });

export const getAutoFileEnabled = (): Promise<boolean> =>
  invoke("get_auto_file_enabled");

export const setAutoFileEnabled = (enabled: boolean): Promise<void> =>
  invoke("set_auto_file_enabled", { enabled });

export const getAutoFileThreshold = (): Promise<number> =>
  invoke("get_auto_file_threshold");

export const setAutoFileThreshold = (threshold: number): Promise<void> =>
  invoke("set_auto_file_threshold", { threshold });
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api.ts
git commit -m "frontend api: undo + auto-file settings bindings"
```

---

### Task 7: In-app toast for auto-filed captures (with Undo)

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the listener inside `AppShell`**

In `src/App.tsx`, find the existing `useEffect` that listens for `log_capture:classification_ready` (around line 60). Below it, add a new `useEffect`:

```tsx
// Toast-with-undo for high-confidence auto-filed captures. Backend also
// fires an OS notification when this window isn't visible.
useEffect(() => {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  (async () => {
    const fn = await listen<LogCaptureAutoFiled>(
      "log_capture:auto_filed",
      (event) => {
        const { item_id, project_name, kind, preview } = event.payload;
        const kindLabel = kind === "task" ? "Task" : "Note";
        toasts.push({
          tone: "success",
          message: `${kindLabel} filed to ${project_name}\n${preview}`,
          durationMs: 6000,
          action: {
            label: "Undo",
            onClick: () => {
              void undoLogCapture(item_id).catch((e) => {
                toasts.push({
                  tone: "error",
                  message: `Undo failed: ${e instanceof Error ? e.message : String(e)}`,
                });
              });
            },
          },
        });
      },
    );
    if (cancelled) fn();
    else unlisten = fn;
  })();
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}, [toasts]);
```

Add the missing imports at the top of the file:

```tsx
import {
  /* … existing … */
  type LogCaptureAutoFiled,
  undoLogCapture,
} from "./lib/api";
```

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "ui: toast w/ Undo for auto-filed captures"
```

---

### Task 8: Low-confidence warning banner in the review overlay

**Files:**
- Modify: `src/views/LogCaptureOverlay.tsx`

- [ ] **Step 1: Surface confidence + threshold in the overlay**

Today the overlay is shown for every classification that doesn't auto-file. After this change it's also shown when `confidence < threshold`. Add a banner above "Review capture" that calls this out so the user knows *why* they're being asked.

In `src/views/LogCaptureOverlay.tsx`, change the `Stage` `ready` variant to include `confidence` (already in `classification.confidence`, so no extra field needed — pull from `stage.classification`).

Find the `<h2>Review capture</h2>` block (around line 158) and replace the surrounding description block with:

```tsx
<div>
  <h2 className="text-lg font-semibold tracking-tight">
    Review capture
  </h2>
  {stage.error ? (
    <p className="mt-1 text-xs text-amber-300">
      Classifier hint unavailable: {stage.error}
    </p>
  ) : stage.classification && stage.classification.confidence < 0.75 ? (
    <p className="mt-1 text-xs text-amber-300">
      Low confidence ({Math.round(stage.classification.confidence * 100)}%) —
      please double-check the project and kind below.
    </p>
  ) : stage.classification && stage.classification.new_project_name ? (
    <p className="mt-1 text-xs text-amber-300">
      Suggesting a new project — confirm the name below before saving.
    </p>
  ) : (
    <p className="mt-1 text-xs text-neutral-400">
      Classifier suggested fields below — adjust as needed.
    </p>
  )}
</div>
```

(The hard-coded `0.75` mirrors the backend default. We could fetch the live threshold via `getAutoFileThreshold()` on overlay mount; deferring that for now since it's a cosmetic banner — the auto-file decision is already made backend-side.)

- [ ] **Step 2: Manually verify in dev**

Run `bun run dev` (frontend only — don't run `bun tauri dev` in this plan; smoke-check the JSX compiles by running `bunx tsc --noEmit` if a tsconfig exists).

Run: `bunx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/views/LogCaptureOverlay.tsx
git commit -m "ui: low-confidence + new-project banners on review overlay"
```

---

### Task 9: Settings UI — auto-file toggle + threshold slider

**Files:**
- Modify: `src/views/Settings.tsx`

- [ ] **Step 1: Add the controls**

Read the current `src/views/Settings.tsx` to find the section structure (each setting block follows a consistent pattern). Add a new "Capture" section near the LLM/Classifier-related settings.

Add to the imports at the top:

```tsx
import {
  /* … existing … */
  getAutoFileEnabled,
  setAutoFileEnabled,
  getAutoFileThreshold,
  setAutoFileThreshold,
} from "../lib/api";
```

Inside the `Settings` component, add state + load:

```tsx
const [autoFileEnabled, setAutoFileEnabledLocal] = useState(true);
const [autoFileThreshold, setAutoFileThresholdLocal] = useState(0.75);

useEffect(() => {
  let cancelled = false;
  (async () => {
    const [enabled, threshold] = await Promise.all([
      getAutoFileEnabled().catch(() => true),
      getAutoFileThreshold().catch(() => 0.75),
    ]);
    if (cancelled) return;
    setAutoFileEnabledLocal(enabled);
    setAutoFileThresholdLocal(threshold);
  })();
  return () => {
    cancelled = true;
  };
}, []);
```

Add the section JSX (place after the existing classifier/LLM block — match the surrounding section styling):

```tsx
<section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
  <h3 className="text-sm font-semibold">Auto-file confident captures</h3>
  <p className="text-xs text-neutral-400">
    When the local AI is at least <span className="font-mono">
    {Math.round(autoFileThreshold * 100)}%</span> sure about the project and
    kind, file the capture silently with a toast (or system notification when
    the window is closed). New-project proposals always show the review
    overlay.
  </p>
  <label className="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      checked={autoFileEnabled}
      onChange={async (e) => {
        const next = e.target.checked;
        setAutoFileEnabledLocal(next);
        try {
          await setAutoFileEnabled(next);
        } catch {
          setAutoFileEnabledLocal(!next);
        }
      }}
    />
    Enable auto-file
  </label>
  <label className="flex flex-col gap-1 text-sm">
    <span className="text-neutral-300">
      Threshold: {Math.round(autoFileThreshold * 100)}%
    </span>
    <input
      type="range"
      min={0.5}
      max={0.95}
      step={0.05}
      disabled={!autoFileEnabled}
      value={autoFileThreshold}
      onChange={(e) => setAutoFileThresholdLocal(Number(e.target.value))}
      onMouseUp={async (e) => {
        const next = Number((e.target as HTMLInputElement).value);
        try {
          await setAutoFileThreshold(next);
        } catch {
          // Reload from backend on error.
          getAutoFileThreshold().then(setAutoFileThresholdLocal).catch(() => {});
        }
      }}
      onTouchEnd={async (e) => {
        const next = Number((e.target as HTMLInputElement).value);
        try {
          await setAutoFileThreshold(next);
        } catch {
          getAutoFileThreshold().then(setAutoFileThresholdLocal).catch(() => {});
        }
      }}
      className="w-full"
    />
  </label>
</section>
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/views/Settings.tsx
git commit -m "settings ui: auto-file toggle + threshold slider"
```

---

### Task 10: End-to-end verification

**Files:** none (manual)

- [ ] **Step 1: Build a release `.app`**

Run: `bun tauri build --bundles app`
Expected: build succeeds; `src-tauri/target/release/bundle/macos/Echo Scribe.app` exists.

- [ ] **Step 2: Reinstall and reset TCC**

Per CLAUDE.md, run the full reinstall sequence:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
tccutil reset Microphone com.echoscribe.app
tccutil reset Accessibility com.echoscribe.app
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 3: Manual smoke checks (report back which pass)**

The user should walk through these — agents cannot verify them:

1. **Auto-file path (window visible):** Trigger a log_capture for a topic that clearly fits an existing project (e.g. "another bug in the recording overlay" if "Echo Scribe" is a project). Confirm:
   - No review overlay appears.
   - A success toast at the bottom-right says "Note filed to <Project>" with an Undo button.
   - The item shows up in the activity feed within ~1 second.

2. **Auto-file path (window hidden):** Close the main window (red traffic light). Trigger a log_capture for the same fitting topic. Confirm:
   - The macOS notification banner appears with title "Filed to <Project>" and a body preview.
   - Re-open the window — item is in the feed.

3. **Low-confidence path:** Trigger a log_capture for something deliberately ambiguous ("uh, the thing"). Confirm:
   - The review overlay appears.
   - A yellow banner at the top says "Low confidence (XX%) — please double-check…".

4. **New-project path:** Trigger a log_capture for a topic with no matching project (e.g. "groceries: buy milk" with no Groceries project). Confirm:
   - The review overlay appears.
   - The yellow banner says "Suggesting a new project — confirm the name below…".

5. **Undo path:** Trigger an auto-file, click "Undo" in the toast within 6 seconds. Confirm the item disappears from the activity feed.

6. **Settings persistence:** Open Settings, toggle auto-file off, quit + relaunch, confirm the toggle is still off. Re-enable, drag threshold to 0.9, quit + relaunch, confirm the slider is still at 0.9.

- [ ] **Step 4: Final commit (only if any tweaks were needed during smoke testing)**

If smoke testing passes without code changes, skip. Otherwise, fix and:

```bash
git add -A
git commit -m "fixes from smoke testing"
```

---

## Self-Review

**Spec coverage:**
- AI classifies project + kind on every log_capture: ✓ already happens (existing classifier).
- Auto-file when confident in *existing* project: Task 4 (`should_auto_file` + branch).
- Always confirm when proposing a new project: Task 4 (`new_project_name.is_none()` gate).
- Threshold default 0.75: Task 2 (`DEFAULT_AUTO_FILE_THRESHOLD`).
- User-tunable threshold + toggle: Task 9 (Settings UI), Task 5 (commands), Task 2 (settings storage).
- In-app toast when window visible: Task 7 (App.tsx listener using existing `ToastProvider`).
- OS notification when window hidden (menu-bar-only): Task 4 (`notify_auto_filed` checks `is_visible`), Task 3 (plugin wired).
- Low-confidence path still uses overlay with hint: Task 8 (banner), Task 4 (fallback path).
- Undo: Task 5 (command), Task 7 (toast action).
- Persisted audit trail (AI vs. user): Task 1 (`classified_by` column), Task 4 (set "ai" on auto-file, "user" on overlay confirm).

**Placeholder scan:** No "TBD", "TODO", or "implement later" left. The single soft "could fetch the live threshold" note in Task 8 is a deliberate, justified deferral — overlay banner is cosmetic, the actual auto-file decision is backend-authoritative.

**Type consistency:**
- `confidence: f32` everywhere (Rust) ↔ `number` (TS) ✓
- `classified_by: Option<String>` accepts `"ai"` or `"user"` ✓ (the schema doesn't enforce, but only those two literals are written by the codebase)
- `LogCaptureAutoFiled` payload fields (`item_id`, `project_name`, `kind`, `preview`, `confidence`) match what `notify_auto_filed` emits ✓
- `undo_log_capture(item_id: String)` Rust ↔ `undoLogCapture(itemId: string)` TS, invoked with `{ itemId }` ✓
- `Item` struct has both new fields wherever it's constructed ✓ (Task 1 Step 6 enumerates each call site)

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-02-auto-file-confident-captures.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session with checkpoints for review.

Which approach?
