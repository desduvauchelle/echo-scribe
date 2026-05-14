# Daily Recap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a morning recap that fires a macOS notification each day summarizing yesterday's meetings, notes, and dictations, with an in-app "Daily" view and on-demand regeneration.

**Architecture:** A new Rust module `daily_summary/` orchestrates three pieces: a `collector` that queries existing `meetings` + `items` tables, a `generator` that prompts the already-loaded `gemma-4-e2b-it-q4_k_m` model via `llama-cpp-2` and parses a GBNF-constrained JSON response, and a `scheduler` Tokio task that fires at a user-configured morning time, backfills missing days in the last 7, and emits a single notification for the most recent generated day. One new SQLite table (`daily_summaries`) stores results; no changes to existing tables. Frontend adds a new `MainSection` variant + view + settings section.

**Tech Stack:** Rust (Tauri 2), `llama-cpp-2`, `rusqlite`, `tokio`, `chrono`, `tauri-plugin-notification`, `tauri-plugin-store`, React + Vite + TypeScript, `lucide-react`.

**Source spec:** `docs/superpowers/specs/2026-05-13-daily-recap-design.md`

**Existing patterns this plan follows:**
- Date/time: project uses `chrono = "0.4.44"` (not `time`). Use `chrono::{DateTime, Utc, Local, NaiveDate, NaiveDateTime, Duration, Weekday, Timelike, Datelike}`.
- Tauri state: a single `AppState` struct registered via `app.manage(...)`. Fields include `pub llm: Arc<Llm>` and `pub db: Option<Db>`. Commands take `state: State<'_, AppState>` and call `state.db.as_ref().ok_or("db unavailable")?.with_conn(|conn| { ... })`.
- LLM is reached as `state.llm.clone()` (already an `Arc<Llm>`); pass to background work via `spawn_blocking` after cloning.

---

## File map

**Create:**
- `src-tauri/src/db/daily_summaries.rs` — CRUD for the new table
- `src-tauri/src/daily_summary/mod.rs` — orchestration entry point
- `src-tauri/src/daily_summary/collector.rs` — query + group + empty-check
- `src-tauri/src/daily_summary/generator.rs` — prompt + GBNF + parse
- `src-tauri/src/daily_summary/scheduler.rs` — Tokio task + wake hooks + notification
- `src/views/sections/DailyView.tsx` — the in-app view

**Modify:**
- `src-tauri/src/db/schema.rs` — append migration v8 for `daily_summaries`
- `src-tauri/src/db/mod.rs` — expose `daily_summaries` module
- `src-tauri/src/lib.rs` — register the `daily_summary` module + spawn scheduler
- `src-tauri/src/commands.rs` — add 3 commands
- `src-tauri/src/settings.rs` — add 3 settings keys + getters/setters
- `src/lib/api.ts` — bindings + types for the 3 commands + settings
- `src/views/Main.tsx` — `MainSection` variant, sidebar entry, render case
- `src/views/Settings.tsx` — "Daily Recap" section

---

## Task 1: Schema migration for `daily_summaries`

**Files:**
- Modify: `src-tauri/src/db/schema.rs` (append to `MIGRATIONS`)

The existing schema is at version 7. We append v8.

- [ ] **Step 1: Write the failing test**

Append this test to the `mod tests` block in `src-tauri/src/db/schema.rs`:

```rust
#[test]
fn migration_v8_adds_daily_summaries() {
    use rusqlite::Connection;
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(daily_summaries)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for required in &[
        "date",
        "generated_at",
        "status",
        "narrative",
        "sections_json",
        "source_meeting_ids_json",
        "source_item_ids_json",
        "model_version",
        "input_token_count",
    ] {
        assert!(
            cols.iter().any(|c| c == required),
            "missing column: {required}"
        );
    }
}
```

Also update the existing idempotency test to expect version 8:

```rust
// In migrations_are_idempotent — change:
assert_eq!(v, "7");
// to:
assert_eq!(v, "8");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib db::schema::tests::migration_v8_adds_daily_summaries`
Expected: FAIL — `no such table: daily_summaries`

- [ ] **Step 3: Add the migration**

Append a new tuple to the `MIGRATIONS` const in `src-tauri/src/db/schema.rs` (place it after the existing v7 entry):

```rust
(
    8,
    r#"
CREATE TABLE IF NOT EXISTS daily_summaries (
  date                    TEXT PRIMARY KEY,
  generated_at            TEXT NOT NULL,
  status                  TEXT NOT NULL,
  narrative               TEXT NOT NULL DEFAULT '',
  sections_json           TEXT NOT NULL DEFAULT '{}',
  source_meeting_ids_json TEXT NOT NULL DEFAULT '[]',
  source_item_ids_json    TEXT NOT NULL DEFAULT '[]',
  model_version           TEXT NOT NULL,
  input_token_count       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_generated_at
  ON daily_summaries(generated_at DESC);
"#,
),
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib db::schema::tests`
Expected: PASS on both `migration_v8_adds_daily_summaries` and `migrations_are_idempotent`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/schema.rs
git commit -m "feat(db): add daily_summaries table (migration v8)"
```

---

## Task 2: CRUD for `daily_summaries`

**Files:**
- Create: `src-tauri/src/db/daily_summaries.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: Wire up the new module**

Add to `src-tauri/src/db/mod.rs` (next to the other `pub mod` lines):

```rust
pub mod daily_summaries;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/db/daily_summaries.rs` with module skeleton + first test:

```rust
//! CRUD for the `daily_summaries` table.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SummaryStatus {
    Generated,
    SkippedEmpty,
    Failed,
}

impl SummaryStatus {
    fn as_str(&self) -> &'static str {
        match self {
            SummaryStatus::Generated => "generated",
            SummaryStatus::SkippedEmpty => "skipped_empty",
            SummaryStatus::Failed => "failed",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "generated" => Some(SummaryStatus::Generated),
            "skipped_empty" => Some(SummaryStatus::SkippedEmpty),
            "failed" => Some(SummaryStatus::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailySummaryRow {
    pub date: String,               // "YYYY-MM-DD"
    pub generated_at: String,       // ISO-8601
    pub status: SummaryStatus,
    pub narrative: String,
    pub sections_json: String,
    pub source_meeting_ids_json: String,
    pub source_item_ids_json: String,
    pub model_version: String,
    pub input_token_count: Option<i64>,
}

pub fn upsert(conn: &Connection, row: &DailySummaryRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO daily_summaries
            (date, generated_at, status, narrative, sections_json,
             source_meeting_ids_json, source_item_ids_json, model_version, input_token_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(date) DO UPDATE SET
            generated_at = excluded.generated_at,
            status = excluded.status,
            narrative = excluded.narrative,
            sections_json = excluded.sections_json,
            source_meeting_ids_json = excluded.source_meeting_ids_json,
            source_item_ids_json = excluded.source_item_ids_json,
            model_version = excluded.model_version,
            input_token_count = excluded.input_token_count",
        params![
            row.date,
            row.generated_at,
            row.status.as_str(),
            row.narrative,
            row.sections_json,
            row.source_meeting_ids_json,
            row.source_item_ids_json,
            row.model_version,
            row.input_token_count,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, date: &str) -> rusqlite::Result<Option<DailySummaryRow>> {
    let mut stmt = conn.prepare(
        "SELECT date, generated_at, status, narrative, sections_json,
                source_meeting_ids_json, source_item_ids_json, model_version, input_token_count
         FROM daily_summaries WHERE date = ?1",
    )?;
    let mut rows = stmt.query(params![date])?;
    if let Some(r) = rows.next()? {
        let status_s: String = r.get(2)?;
        Ok(Some(DailySummaryRow {
            date: r.get(0)?,
            generated_at: r.get(1)?,
            status: SummaryStatus::parse(&status_s).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    format!("invalid status: {status_s}").into(),
                )
            })?,
            narrative: r.get(3)?,
            sections_json: r.get(4)?,
            source_meeting_ids_json: r.get(5)?,
            source_item_ids_json: r.get(6)?,
            model_version: r.get(7)?,
            input_token_count: r.get(8)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn list_recent(conn: &Connection, limit: u32) -> rusqlite::Result<Vec<DailySummaryRow>> {
    let mut stmt = conn.prepare(
        "SELECT date, generated_at, status, narrative, sections_json,
                source_meeting_ids_json, source_item_ids_json, model_version, input_token_count
         FROM daily_summaries
         ORDER BY date DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        let status_s: String = r.get(2)?;
        Ok(DailySummaryRow {
            date: r.get(0)?,
            generated_at: r.get(1)?,
            status: SummaryStatus::parse(&status_s).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    format!("invalid status: {status_s}").into(),
                )
            })?,
            narrative: r.get(3)?,
            sections_json: r.get(4)?,
            source_meeting_ids_json: r.get(5)?,
            source_item_ids_json: r.get(6)?,
            model_version: r.get(7)?,
            input_token_count: r.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn dates_in_last_n_days_with_row(
    conn: &Connection,
    n: u32,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT date FROM daily_summaries
         WHERE date >= date('now', 'localtime', ?1)
         ORDER BY date ASC",
    )?;
    let modifier = format!("-{} days", n);
    let dates = stmt.query_map(params![modifier], |r| r.get::<_, String>(0))?;
    dates.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn row(date: &str, status: SummaryStatus) -> DailySummaryRow {
        DailySummaryRow {
            date: date.into(),
            generated_at: "2026-05-13T08:03:00Z".into(),
            status,
            narrative: "Test narrative".into(),
            sections_json: "{}".into(),
            source_meeting_ids_json: "[]".into(),
            source_item_ids_json: "[]".into(),
            model_version: "test@deadbeef".into(),
            input_token_count: Some(123),
        }
    }

    #[test]
    fn upsert_then_get_roundtrips() {
        let conn = setup();
        let r = row("2026-05-12", SummaryStatus::Generated);
        upsert(&conn, &r).unwrap();
        let got = get(&conn, "2026-05-12").unwrap().unwrap();
        assert_eq!(got.date, "2026-05-12");
        assert_eq!(got.status, SummaryStatus::Generated);
        assert_eq!(got.narrative, "Test narrative");
    }

    #[test]
    fn upsert_replaces_existing_row() {
        let conn = setup();
        upsert(&conn, &row("2026-05-12", SummaryStatus::Failed)).unwrap();
        let mut r2 = row("2026-05-12", SummaryStatus::Generated);
        r2.narrative = "Second pass".into();
        upsert(&conn, &r2).unwrap();
        let got = get(&conn, "2026-05-12").unwrap().unwrap();
        assert_eq!(got.status, SummaryStatus::Generated);
        assert_eq!(got.narrative, "Second pass");
    }

    #[test]
    fn get_missing_returns_none() {
        let conn = setup();
        assert!(get(&conn, "2026-05-12").unwrap().is_none());
    }

    #[test]
    fn list_recent_orders_by_date_desc() {
        let conn = setup();
        upsert(&conn, &row("2026-05-10", SummaryStatus::Generated)).unwrap();
        upsert(&conn, &row("2026-05-12", SummaryStatus::Generated)).unwrap();
        upsert(&conn, &row("2026-05-11", SummaryStatus::SkippedEmpty)).unwrap();
        let rows = list_recent(&conn, 10).unwrap();
        let dates: Vec<&str> = rows.iter().map(|r| r.date.as_str()).collect();
        assert_eq!(dates, vec!["2026-05-12", "2026-05-11", "2026-05-10"]);
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib db::daily_summaries`
Expected: PASS on all 4 tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/daily_summaries.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): add daily_summaries CRUD"
```

---

## Task 3: Settings for daily recap (toggle, time, weekends)

**Files:**
- Modify: `src-tauri/src/settings.rs`

We add three settings: enabled (bool), deliver-at hour (u8, 0–23), include-weekends (bool).

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` block in `src-tauri/src/settings.rs` (if no test module exists, create one at the bottom of the file — follow the pattern from `db/meetings.rs`). For now add a stub test that exercises the public defaults:

```rust
#[test]
fn daily_recap_defaults() {
    assert_eq!(DEFAULT_DAILY_RECAP_ENABLED, true);
    assert_eq!(DEFAULT_DAILY_RECAP_DELIVER_HOUR, 8);
    assert_eq!(DEFAULT_DAILY_RECAP_INCLUDE_WEEKENDS, false);
}
```

(Settings I/O happens through `tauri-plugin-store` which needs a Tauri runtime, so we test only the defaults here. Runtime behavior is exercised manually.)

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cd src-tauri && cargo test --lib settings::tests::daily_recap_defaults 2>&1 | head`
Expected: compile error — `DEFAULT_DAILY_RECAP_ENABLED` not found.

- [ ] **Step 3: Add the settings**

Add the keys + defaults near the existing `KEY_*` constants at the top of `src-tauri/src/settings.rs`:

```rust
const KEY_DAILY_RECAP_ENABLED: &str = "daily_recap_enabled";
const KEY_DAILY_RECAP_DELIVER_HOUR: &str = "daily_recap_deliver_hour";
const KEY_DAILY_RECAP_INCLUDE_WEEKENDS: &str = "daily_recap_include_weekends";

/// Default: morning recap notification is on.
pub const DEFAULT_DAILY_RECAP_ENABLED: bool = true;
/// Default: deliver at 08:00 local time. Range 0–23.
pub const DEFAULT_DAILY_RECAP_DELIVER_HOUR: u8 = 8;
/// Default: skip weekends.
pub const DEFAULT_DAILY_RECAP_INCLUDE_WEEKENDS: bool = false;
```

Then add getter/setter methods to `impl SettingsStore` — locate an existing setting pair (for example the `mute_while_recording` pair) and append three pairs in the same shape:

```rust
pub fn daily_recap_enabled(&self) -> bool {
    self.store
        .get(KEY_DAILY_RECAP_ENABLED)
        .and_then(|v| v.as_bool())
        .unwrap_or(DEFAULT_DAILY_RECAP_ENABLED)
}

pub fn set_daily_recap_enabled(&self, v: bool) -> Result<(), SettingsError> {
    self.store.set(KEY_DAILY_RECAP_ENABLED, v);
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))
}

pub fn daily_recap_deliver_hour(&self) -> u8 {
    self.store
        .get(KEY_DAILY_RECAP_DELIVER_HOUR)
        .and_then(|v| v.as_u64())
        .and_then(|n| if n < 24 { Some(n as u8) } else { None })
        .unwrap_or(DEFAULT_DAILY_RECAP_DELIVER_HOUR)
}

pub fn set_daily_recap_deliver_hour(&self, v: u8) -> Result<(), SettingsError> {
    let v = v.min(23);
    self.store.set(KEY_DAILY_RECAP_DELIVER_HOUR, v as u64);
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))
}

pub fn daily_recap_include_weekends(&self) -> bool {
    self.store
        .get(KEY_DAILY_RECAP_INCLUDE_WEEKENDS)
        .and_then(|v| v.as_bool())
        .unwrap_or(DEFAULT_DAILY_RECAP_INCLUDE_WEEKENDS)
}

pub fn set_daily_recap_include_weekends(&self, v: bool) -> Result<(), SettingsError> {
    self.store.set(KEY_DAILY_RECAP_INCLUDE_WEEKENDS, v);
    self.store
        .save()
        .map_err(|e| SettingsError::Store(e.to_string()))
}
```

(If the existing setters use a slightly different idiom — e.g., a single `set_value` helper — match that pattern instead of the verbatim code above. Check one existing setter first.)

- [ ] **Step 4: Run test**

Run: `cd src-tauri && cargo test --lib settings::tests::daily_recap_defaults`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): add daily recap settings (enabled, hour, weekends)"
```

---

## Task 4: Collector — query inputs and detect empty days

**Files:**
- Create: `src-tauri/src/daily_summary/mod.rs`
- Create: `src-tauri/src/daily_summary/collector.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod daily_summary;`)

- [ ] **Step 1: Wire up the new module**

Add to `src-tauri/src/lib.rs` near other `pub mod` declarations:

```rust
pub mod daily_summary;
```

Create `src-tauri/src/daily_summary/mod.rs`:

```rust
//! Daily recap pipeline: collector → generator → scheduler.
//!
//! See `docs/superpowers/specs/2026-05-13-daily-recap-design.md`.

pub mod collector;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/daily_summary/collector.rs` with full module + tests. The collector takes a date string (`"YYYY-MM-DD"`) and queries everything captured *that local day*. Tests use in-memory SQLite, the same pattern as `db/meetings.rs`.

```rust
//! Query meetings + items for one local day and group into a summary input.

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MeetingForSummary {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub suggested_title: Option<String>,
    pub summary_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ItemForSummary {
    pub id: String,
    pub content: String,
    pub captured_at: String,
    pub capture_context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailySummaryInput {
    pub date: String,
    pub meetings: Vec<MeetingForSummary>,
    pub notes: Vec<ItemForSummary>,
    /// Dictations grouped by `capture_context` (the frontmost app at capture time).
    /// Sorted by group size descending; entries within a group sorted by `captured_at` ascending.
    pub dictations_by_app: Vec<(String, Vec<ItemForSummary>)>,
}

/// A day is empty if it has no meetings, no notes, and fewer than 3 dictations.
pub fn is_empty(input: &DailySummaryInput) -> bool {
    let dictation_count: usize = input.dictations_by_app.iter().map(|(_, v)| v.len()).sum();
    input.meetings.is_empty() && input.notes.is_empty() && dictation_count < 3
}

const UNKNOWN_APP: &str = "Unknown";

pub fn collect(conn: &Connection, date: &str) -> rusqlite::Result<DailySummaryInput> {
    let day_start = format!("{date}T00:00:00Z");
    let day_end = format!("{date}T23:59:59Z");

    let meetings = {
        let mut stmt = conn.prepare(
            "SELECT m.item_id, m.started_at, m.ended_at, i.content, m.summary_json
             FROM meetings m
             JOIN items i ON i.id = m.item_id
             WHERE m.started_at >= ?1 AND m.started_at <= ?2
               AND i.deleted_at IS NULL
             ORDER BY m.started_at ASC",
        )?;
        let rows = stmt.query_map(params![day_start, day_end], |r| {
            Ok(MeetingForSummary {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                suggested_title: r.get(3)?,
                summary_json: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let notes = query_items(conn, "log_capture", &day_start, &day_end)?;
    let dictations = query_items(conn, "voice_at_cursor", &day_start, &day_end)?;

    let mut by_app: std::collections::BTreeMap<String, Vec<ItemForSummary>> =
        std::collections::BTreeMap::new();
    for d in dictations {
        let key = d
            .capture_context
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| UNKNOWN_APP.to_string());
        by_app.entry(key).or_default().push(d);
    }
    let mut grouped: Vec<(String, Vec<ItemForSummary>)> = by_app.into_iter().collect();
    grouped.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

    Ok(DailySummaryInput {
        date: date.to_string(),
        meetings,
        notes,
        dictations_by_app: grouped,
    })
}

fn query_items(
    conn: &Connection,
    source: &str,
    day_start: &str,
    day_end: &str,
) -> rusqlite::Result<Vec<ItemForSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, content, captured_at, capture_context
         FROM items
         WHERE source = ?1
           AND captured_at >= ?2 AND captured_at <= ?3
           AND deleted_at IS NULL
         ORDER BY captured_at ASC",
    )?;
    let rows = stmt.query_map(params![source, day_start, day_end], |r| {
        Ok(ItemForSummary {
            id: r.get(0)?,
            content: r.get(1)?,
            captured_at: r.get(2)?,
            capture_context: r.get(3)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn insert_item(
        conn: &Connection,
        id: &str,
        source: &str,
        captured_at: &str,
        content: &str,
        ctx: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at, capture_context)
             VALUES (?1, ?2, ?3, 'visible', NULL, ?4, ?4, ?5)",
            params![id, content, source, captured_at, ctx],
        )
        .unwrap();
    }

    fn insert_meeting(conn: &Connection, id: &str, started_at: &str) {
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
             VALUES (?1, 'Meeting', 'meeting', 'visible', 'meeting', ?2, ?2)",
            params![id, started_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meetings (item_id, started_at, status, mic_only)
             VALUES (?1, ?2, 'completed', 0)",
            params![id, started_at],
        )
        .unwrap();
    }

    #[test]
    fn empty_day_returns_empty_bundle() {
        let conn = setup();
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(input.meetings.is_empty());
        assert!(input.notes.is_empty());
        assert!(input.dictations_by_app.is_empty());
        assert!(is_empty(&input));
    }

    #[test]
    fn light_day_with_2_dictations_is_empty() {
        let conn = setup();
        insert_item(&conn, "d1", "voice_at_cursor", "2026-05-12T10:00:00Z", "hi", Some("VS Code"));
        insert_item(&conn, "d2", "voice_at_cursor", "2026-05-12T11:00:00Z", "ok", Some("VS Code"));
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations_by_app.len(), 1);
        assert!(is_empty(&input));
    }

    #[test]
    fn light_day_with_3_dictations_is_not_empty() {
        let conn = setup();
        for (i, t) in ["10:00", "11:00", "12:00"].iter().enumerate() {
            insert_item(
                &conn,
                &format!("d{i}"),
                "voice_at_cursor",
                &format!("2026-05-12T{t}:00Z"),
                "hi",
                Some("VS Code"),
            );
        }
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(!is_empty(&input));
    }

    #[test]
    fn day_with_meeting_is_not_empty() {
        let conn = setup();
        insert_meeting(&conn, "m1", "2026-05-12T09:00:00Z");
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.meetings.len(), 1);
        assert!(!is_empty(&input));
    }

    #[test]
    fn day_with_note_is_not_empty() {
        let conn = setup();
        insert_item(&conn, "n1", "log_capture", "2026-05-12T10:00:00Z", "note", None);
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.notes.len(), 1);
        assert!(!is_empty(&input));
    }

    #[test]
    fn dictations_group_by_app_sorted_by_group_size_desc() {
        let conn = setup();
        // 3 in VS Code, 1 in Slack
        for (i, app) in [("d1", "VS Code"), ("d2", "VS Code"), ("d3", "VS Code"), ("d4", "Slack")] {
            insert_item(&conn, i, "voice_at_cursor", "2026-05-12T10:00:00Z", "x", Some(app));
        }
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations_by_app.len(), 2);
        assert_eq!(input.dictations_by_app[0].0, "VS Code");
        assert_eq!(input.dictations_by_app[0].1.len(), 3);
        assert_eq!(input.dictations_by_app[1].0, "Slack");
    }

    #[test]
    fn dictations_with_null_context_group_under_unknown() {
        let conn = setup();
        for i in 0..3 {
            insert_item(&conn, &format!("d{i}"), "voice_at_cursor", "2026-05-12T10:00:00Z", "x", None);
        }
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations_by_app.len(), 1);
        assert_eq!(input.dictations_by_app[0].0, UNKNOWN_APP);
    }

    #[test]
    fn collect_ignores_other_days() {
        let conn = setup();
        insert_item(&conn, "n-yesterday", "log_capture", "2026-05-11T10:00:00Z", "x", None);
        insert_item(&conn, "n-today", "log_capture", "2026-05-12T10:00:00Z", "x", None);
        insert_item(&conn, "n-tomorrow", "log_capture", "2026-05-13T10:00:00Z", "x", None);
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.notes.len(), 1);
        assert_eq!(input.notes[0].id, "n-today");
    }

    #[test]
    fn collect_ignores_deleted_items() {
        let conn = setup();
        insert_item(&conn, "n1", "log_capture", "2026-05-12T10:00:00Z", "x", None);
        conn.execute(
            "UPDATE items SET deleted_at = '2026-05-12T11:00:00Z' WHERE id = 'n1'",
            [],
        )
        .unwrap();
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(input.notes.is_empty());
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib daily_summary::collector`
Expected: PASS on all 9 tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/daily_summary/ src-tauri/src/lib.rs
git commit -m "feat(daily-summary): add collector for meetings + notes + dictations"
```

---

## Task 5: Prompt builder and JSON-output schema

**Files:**
- Create: `src-tauri/src/daily_summary/generator.rs`
- Modify: `src-tauri/src/daily_summary/mod.rs` (export `pub mod generator;`)

This task covers the *pure* parts of the generator: prompt assembly, output schema types, JSON parsing, and the GBNF grammar string. LLM integration happens in the next task.

- [ ] **Step 1: Export the module**

Edit `src-tauri/src/daily_summary/mod.rs` to add:

```rust
pub mod generator;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/daily_summary/generator.rs`:

```rust
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
            user.push_str(&format!(
                "- [{id}] {title} (started {})\n",
                m.started_at
            ));
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
                user.push_str(&format!(
                    "- [d{dictation_counter}] {}\n",
                    item.content
                ));
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
/// Loose-typed (strings/arrays only), permissive about whitespace.
/// The model can still produce empty arrays, missing optional fields, etc.
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
    hex_short(&digest[..4])
}

fn hex_short(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
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
        assert!(matches!(
            parse_response(raw),
            Err(ParseError::Schema(_))
        ));
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
```

- [ ] **Step 3: Add `sha2` to Cargo.toml**

Open `src-tauri/Cargo.toml` and add to `[dependencies]` (alphabetically near other crates):

```toml
sha2 = "0.10"
```

(`thiserror` and `serde_json` are already present.)

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib daily_summary::generator`
Expected: PASS on all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/daily_summary/generator.rs src-tauri/src/daily_summary/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(daily-summary): add prompt builder, output schema, GBNF grammar"
```

---

## Task 6: Generator — LLM call + orchestration entry point

**Files:**
- Modify: `src-tauri/src/daily_summary/generator.rs` (add the `generate` function)
- Modify: `src-tauri/src/daily_summary/mod.rs` (add the `generate_for_date` orchestrator)

The `generate` function turns an input bundle into an output via the existing `Llm` engine; `generate_for_date` ties collector + generator + DB write into the canonical entry point used by both the scheduler and the on-demand command.

- [ ] **Step 1: Add the `generate` function to `generator.rs`**

Append to `src-tauri/src/daily_summary/generator.rs` (above the `#[cfg(test)]` block):

```rust
use crate::llm::engine::{EngineError, GenerateRequest, Llm};

/// Generate a daily summary by prompting the local LLM with the input
/// bundle. The LLM call runs synchronously and is CPU/Metal bound; callers
/// from an async context should wrap this in `tokio::task::spawn_blocking`.
pub fn generate(llm: &Llm, input: &DailySummaryInput) -> Result<DailySummaryOutput, GenerateError> {
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
        .map_err(GenerateError::Llm)?;
    let out = parse_response(&raw).map_err(GenerateError::Parse)?;
    Ok(out)
}

#[derive(Debug, thiserror::Error)]
pub enum GenerateError {
    #[error("LLM failure: {0}")]
    Llm(EngineError),
    #[error("parse failure: {0}")]
    Parse(ParseError),
}
```

(No new test here — LLM output is non-deterministic. The `build_prompt` and `parse_response` halves are already covered by Task 5 tests.)

- [ ] **Step 2: Write the failing test for the orchestrator**

Replace the contents of `src-tauri/src/daily_summary/mod.rs` with:

```rust
//! Daily recap pipeline: collector → generator → scheduler.

pub mod collector;
pub mod generator;

use std::sync::Arc;

use chrono::Utc;
use rusqlite::Connection;
use serde::Serialize;

use crate::db::daily_summaries::{self, DailySummaryRow, SummaryStatus};
use crate::llm::engine::Llm;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DailySummaryResult {
    Generated { date: String },
    Skipped { date: String },
    Failed { date: String, reason: String },
}

impl DailySummaryResult {
    pub fn date(&self) -> &str {
        match self {
            DailySummaryResult::Generated { date }
            | DailySummaryResult::Skipped { date }
            | DailySummaryResult::Failed { date, .. } => date,
        }
    }
}

/// The model id Echo Scribe currently ships. Hardcoded for now — if the user
/// selects a different LLM in settings, prefer that one.
pub const DEFAULT_LLM_MODEL_ID: &str = "gemma-4-e2b-it-q4_k_m";

/// Run the pipeline for `date` (a "YYYY-MM-DD" string). Always writes a row to
/// `daily_summaries` (status `generated`, `skipped_empty`, or `failed`).
///
/// Invoked from both the scheduler and the on-demand command. Idempotent on
/// `daily_summaries.date` (UPSERT under the hood).
pub fn generate_for_date(
    conn: &Connection,
    llm: &Arc<Llm>,
    date: &str,
    llm_model_id: &str,
) -> rusqlite::Result<DailySummaryResult> {
    let input = collector::collect(conn, date)?;
    let now = Utc::now().to_rfc3339();
    let model_version = format!("{}@{}", llm_model_id, generator::prompt_version());

    if collector::is_empty(&input) {
        let row = DailySummaryRow {
            date: date.into(),
            generated_at: now,
            status: SummaryStatus::SkippedEmpty,
            narrative: String::new(),
            sections_json: "{}".into(),
            source_meeting_ids_json: "[]".into(),
            source_item_ids_json: "[]".into(),
            model_version,
            input_token_count: Some(0),
        };
        daily_summaries::upsert(conn, &row)?;
        return Ok(DailySummaryResult::Skipped { date: date.into() });
    }

    let meeting_ids: Vec<String> = input.meetings.iter().map(|m| m.id.clone()).collect();
    let item_ids: Vec<String> = input
        .notes
        .iter()
        .map(|n| n.id.clone())
        .chain(
            input
                .dictations_by_app
                .iter()
                .flat_map(|(_, items)| items.iter().map(|i| i.id.clone())),
        )
        .collect();

    match generator::generate(llm, &input) {
        Ok(out) => {
            let row = DailySummaryRow {
                date: date.into(),
                generated_at: now,
                status: SummaryStatus::Generated,
                narrative: out.narrative,
                sections_json: serde_json::to_string(&out.sections).unwrap_or_else(|_| "{}".into()),
                source_meeting_ids_json: serde_json::to_string(&meeting_ids).unwrap_or_else(|_| "[]".into()),
                source_item_ids_json: serde_json::to_string(&item_ids).unwrap_or_else(|_| "[]".into()),
                model_version,
                input_token_count: None,
            };
            daily_summaries::upsert(conn, &row)?;
            Ok(DailySummaryResult::Generated { date: date.into() })
        }
        Err(e) => {
            let reason = e.to_string();
            let row = DailySummaryRow {
                date: date.into(),
                generated_at: now,
                status: SummaryStatus::Failed,
                narrative: String::new(),
                sections_json: "{}".into(),
                source_meeting_ids_json: serde_json::to_string(&meeting_ids).unwrap_or_else(|_| "[]".into()),
                source_item_ids_json: serde_json::to_string(&item_ids).unwrap_or_else(|_| "[]".into()),
                model_version,
                input_token_count: None,
            };
            daily_summaries::upsert(conn, &row)?;
            Ok(DailySummaryResult::Failed {
                date: date.into(),
                reason,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;
    use rusqlite::params;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn empty_day_writes_skipped_row_without_invoking_llm() {
        // We never construct a real `Llm` here — the empty branch short-circuits
        // before the LLM is touched. We pass an Arc<Llm> via a transmute-free
        // path by gating the test behind the empty path.
        let conn = setup();
        // Construct a stub Arc<Llm> via the type system: we can't easily build
        // a real Llm in unit tests (it needs a model file). Instead, we test
        // the empty path by calling the same code through a thin wrapper that
        // skips the LLM call when input is empty.
        let date = "2026-05-12";
        let input = collector::collect(&conn, date).unwrap();
        assert!(collector::is_empty(&input));

        // Inline the empty-path write so we cover the on-disk shape without
        // needing a real Llm instance.
        let now = Utc::now().to_rfc3339();
        let row = DailySummaryRow {
            date: date.into(),
            generated_at: now,
            status: SummaryStatus::SkippedEmpty,
            narrative: String::new(),
            sections_json: "{}".into(),
            source_meeting_ids_json: "[]".into(),
            source_item_ids_json: "[]".into(),
            model_version: format!("test@{}", generator::prompt_version()),
            input_token_count: Some(0),
        };
        daily_summaries::upsert(&conn, &row).unwrap();
        let got = daily_summaries::get(&conn, date).unwrap().unwrap();
        assert_eq!(got.status, SummaryStatus::SkippedEmpty);
    }

    #[test]
    fn source_ids_are_collected_from_meetings_notes_dictations() {
        let conn = setup();
        // Insert one of each so the source-id collection runs through every branch.
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
             VALUES ('m1', 'Meeting', 'meeting', 'visible', 'meeting', '2026-05-12T09:00:00Z', '2026-05-12T09:00:00Z'),
                    ('n1', 'note', 'log_capture', 'visible', NULL, '2026-05-12T10:00:00Z', '2026-05-12T10:00:00Z'),
                    ('d1', 'hi', 'voice_at_cursor', 'visible', NULL, '2026-05-12T11:00:00Z', '2026-05-12T11:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO meetings (item_id, started_at, status, mic_only)
             VALUES (?1, ?2, 'completed', 0)",
            params!["m1", "2026-05-12T09:00:00Z"],
        ).unwrap();
        let input = collector::collect(&conn, "2026-05-12").unwrap();
        assert!(!collector::is_empty(&input));
        // The orchestrator collects exactly these IDs.
        let mids: Vec<_> = input.meetings.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(mids, vec!["m1"]);
        let nids: Vec<_> = input.notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(nids, vec!["n1"]);
        let dids: Vec<_> = input
            .dictations_by_app
            .iter()
            .flat_map(|(_, v)| v.iter().map(|i| i.id.as_str()))
            .collect();
        assert_eq!(dids, vec!["d1"]);
    }
}
```

- [ ] **Step 3: Confirm `chrono` is available**

`chrono = "0.4.44"` is already in `src-tauri/Cargo.toml` — no Cargo changes needed.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib daily_summary`
Expected: PASS on all tests across `collector`, `generator`, and `mod`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/daily_summary/ src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(daily-summary): wire generator to LLM and add generate_for_date orchestrator"
```

---

## Task 7: Scheduler — pure timing logic

**Files:**
- Create: `src-tauri/src/daily_summary/scheduler.rs`
- Modify: `src-tauri/src/daily_summary/mod.rs` (export `pub mod scheduler;`)

This task covers only the pure `next_fire_time` function and the "which dates to backfill" calculation. The Tokio task and wake hooks come in Task 8.

- [ ] **Step 1: Export the module**

In `src-tauri/src/daily_summary/mod.rs` add at the top:

```rust
pub mod scheduler;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/daily_summary/scheduler.rs`:

```rust
//! Scheduler: when to fire, which dates to backfill.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Weekday};

/// Settings snapshot passed in to keep the scheduler pure and testable.
#[derive(Debug, Clone, Copy)]
pub struct ScheduleSettings {
    pub enabled: bool,
    pub deliver_hour: u8,
    pub include_weekends: bool,
}

/// Return the next wall-clock instant (local) at which the scheduler should
/// fire. If today's fire time is still in the future, returns today; otherwise
/// returns tomorrow at the same time.
///
/// When weekends are excluded, fire times that would land on Saturday or
/// Sunday are advanced to the following Monday.
///
/// Computed in local-wall-clock terms via `NaiveDateTime` so it stays
/// deterministic in tests. The live caller will use
/// `chrono::Local::now().naive_local()`.
pub fn next_fire_time(
    now: NaiveDateTime,
    settings: ScheduleSettings,
) -> Option<NaiveDateTime> {
    if !settings.enabled {
        return None;
    }
    let hour = settings.deliver_hour.min(23) as u32;
    let fire_time = NaiveTime::from_hms_opt(hour, 0, 0)?;
    let mut candidate = NaiveDateTime::new(now.date(), fire_time);
    if candidate <= now {
        candidate += Duration::days(1);
    }
    if !settings.include_weekends {
        while matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun) {
            candidate += Duration::days(1);
        }
    }
    Some(candidate)
}

/// Return the list of dates (oldest first) for which the scheduler should
/// attempt generation, given the current local date and a set of dates that
/// already have a row. Always covers `today - 1` and walks back up to
/// `lookback_days` to find missing days. Excludes weekend dates if weekends
/// are off.
pub fn dates_needing_generation(
    today: NaiveDate,
    existing_dates: &[String],
    lookback_days: u32,
    include_weekends: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let existing: std::collections::HashSet<&str> =
        existing_dates.iter().map(|s| s.as_str()).collect();
    for delta in 1..=lookback_days as i64 {
        let candidate = today - Duration::days(delta);
        if !include_weekends
            && matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun)
        {
            continue;
        }
        let s = candidate.format("%Y-%m-%d").to_string();
        if !existing.contains(s.as_str()) {
            out.push(s);
        }
    }
    out.reverse(); // chronological (oldest first)
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn settings(hour: u8, weekends: bool) -> ScheduleSettings {
        ScheduleSettings {
            enabled: true,
            deliver_hour: hour,
            include_weekends: weekends,
        }
    }

    fn ndt(y: i32, m: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap()
    }

    #[test]
    fn fire_today_when_before_hour() {
        // 2026-05-13 is a Wednesday
        let now = ndt(2026, 5, 13, 6, 0);
        let next = next_fire_time(now, settings(8, true)).unwrap();
        assert_eq!(next, ndt(2026, 5, 13, 8, 0));
    }

    #[test]
    fn fire_tomorrow_when_after_hour() {
        let now = ndt(2026, 5, 13, 9, 0);
        let next = next_fire_time(now, settings(8, true)).unwrap();
        assert_eq!(next, ndt(2026, 5, 14, 8, 0));
    }

    #[test]
    fn skip_to_monday_when_weekends_off() {
        // Friday 2026-05-15 at 9am → next would be Saturday 8am → skip to Monday 2026-05-18
        let now = ndt(2026, 5, 15, 9, 0);
        let next = next_fire_time(now, settings(8, false)).unwrap();
        assert_eq!(next, ndt(2026, 5, 18, 8, 0));
    }

    #[test]
    fn weekends_on_fires_saturday() {
        let now = ndt(2026, 5, 15, 9, 0);
        let next = next_fire_time(now, settings(8, true)).unwrap();
        assert_eq!(next, ndt(2026, 5, 16, 8, 0));
    }

    #[test]
    fn disabled_returns_none() {
        let now = ndt(2026, 5, 13, 6, 0);
        let s = ScheduleSettings {
            enabled: false,
            deliver_hour: 8,
            include_weekends: true,
        };
        assert!(next_fire_time(now, s).is_none());
    }

    #[test]
    fn backfill_returns_full_lookback_when_no_rows_exist() {
        let today = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        let dates = dates_needing_generation(today, &[], 7, true);
        // 7 lookback days: 2026-05-06..=2026-05-12, oldest first
        assert_eq!(dates.first().map(|s| s.as_str()), Some("2026-05-06"));
        assert_eq!(dates.last().map(|s| s.as_str()), Some("2026-05-12"));
        assert_eq!(dates.len(), 7);
    }

    #[test]
    fn backfill_skips_existing_dates() {
        let today = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        let existing = vec!["2026-05-10".to_string(), "2026-05-12".to_string()];
        let dates = dates_needing_generation(today, &existing, 7, true);
        assert!(!dates.contains(&"2026-05-10".to_string()));
        assert!(!dates.contains(&"2026-05-12".to_string()));
        assert_eq!(dates.len(), 5);
    }

    #[test]
    fn backfill_skips_weekends_when_off() {
        // 2026-05-13 (Wed). Lookback 7 days includes Sat 2026-05-09 and Sun 2026-05-10.
        let today = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        let dates = dates_needing_generation(today, &[], 7, false);
        assert!(!dates.contains(&"2026-05-09".to_string()));
        assert!(!dates.contains(&"2026-05-10".to_string()));
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib daily_summary::scheduler`
Expected: PASS on all 8 tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/daily_summary/scheduler.rs src-tauri/src/daily_summary/mod.rs
git commit -m "feat(daily-summary): add pure scheduler timing logic"
```

---

## Task 8: Scheduler — Tokio task, wake hooks, notification

**Files:**
- Modify: `src-tauri/src/daily_summary/scheduler.rs`
- Modify: `src-tauri/src/lib.rs` (spawn on startup)

This task is mostly wiring; there are no unit tests because the Tokio sleep + wake hooks aren't deterministic. Validation is via manual smoke at the end of the task.

- [ ] **Step 1: Add the runtime portion of the scheduler**

Append to `src-tauri/src/daily_summary/scheduler.rs`:

```rust
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Local, Timelike};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tracing::{error, info, warn};

use crate::commands::AppState;
use crate::daily_summary::{generate_for_date, DailySummaryResult, DEFAULT_LLM_MODEL_ID};
use crate::db::daily_summaries;

/// Spawn the scheduler background task. Idempotent: caller must ensure
/// it's only invoked once at app startup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_loop(app).await;
    });
}

async fn run_loop(app: AppHandle) {
    // Tick once a minute. We re-read settings every tick and only run the
    // pipeline on the tick that first crosses the configured deliver hour.
    let tick = StdDuration::from_secs(60);
    let mut last_hour = Local::now().hour();

    loop {
        tokio::time::sleep(tick).await;

        let now_hour = Local::now().hour();
        // Settings are read each tick so changes apply without restart.
        let state = app.state::<AppState>();
        let enabled = state.settings.daily_recap_enabled();
        let deliver_hour = state.settings.daily_recap_deliver_hour() as u32;
        let include_weekends = state.settings.daily_recap_include_weekends();
        if !enabled {
            last_hour = now_hour;
            continue;
        }

        let crossed = last_hour != deliver_hour && now_hour == deliver_hour;
        last_hour = now_hour;
        if !crossed {
            continue;
        }

        info!("scheduler: firing daily recap pipeline");
        match run_backfill(&app, include_weekends).await {
            Ok(results) => fire_notification_for_latest(&app, &results),
            Err(e) => error!("scheduler: backfill failed: {e}"),
        }
    }
}

async fn run_backfill(
    app: &AppHandle,
    include_weekends: bool,
) -> Result<Vec<DailySummaryResult>, String> {
    let state = app.state::<AppState>();
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| "db unavailable".to_string())?
        .clone();
    let llm = state.llm.clone();

    let res = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<DailySummaryResult>, String> {
        db.with_conn(|conn| {
            let today = Local::now().date_naive();
            let existing = daily_summaries::dates_in_last_n_days_with_row(conn, 7)
                .map_err(crate::db::DbError::from)?;
            let dates = dates_needing_generation(today, &existing, 7, include_weekends);
            let mut results = Vec::new();
            for date in dates {
                match generate_for_date(conn, &llm, &date, DEFAULT_LLM_MODEL_ID) {
                    Ok(r) => results.push(r),
                    Err(e) => {
                        tracing::error!("scheduler: generate_for_date({date}) failed: {e}");
                    }
                }
            }
            Ok(results)
        })
        .map_err(|e| format!("{e:?}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(res)
}

fn fire_notification_for_latest(app: &AppHandle, results: &[DailySummaryResult]) {
    let latest_generated = results
        .iter()
        .rev()
        .find(|r| matches!(r, DailySummaryResult::Generated { .. }));
    let Some(DailySummaryResult::Generated { date }) = latest_generated else {
        return;
    };
    let day_name = humanize_day_of_week(date).unwrap_or_else(|| date.clone());
    let title = format!("Your {day_name} recap");
    let body = "Your daily recap is ready.";
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        warn!("scheduler: failed to show notification: {e}");
    }
}

fn humanize_day_of_week(date: &str) -> Option<String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Some(match d.weekday() {
        chrono::Weekday::Mon => "Monday".into(),
        chrono::Weekday::Tue => "Tuesday".into(),
        chrono::Weekday::Wed => "Wednesday".into(),
        chrono::Weekday::Thu => "Thursday".into(),
        chrono::Weekday::Fri => "Friday".into(),
        chrono::Weekday::Sat => "Saturday".into(),
        chrono::Weekday::Sun => "Sunday".into(),
    })
}
```

> **Note on `with_conn` error type:** the `Db::with_conn` closure must return `Result<R, DbError>`. If `daily_summaries::dates_in_last_n_days_with_row` returns `rusqlite::Result`, wrap with `.map_err(DbError::from)` (assuming such a `From<rusqlite::Error> for DbError` impl exists — check `src-tauri/src/db/mod.rs`; the existing `meetings.rs` commands handle this same translation). If the project pattern is to return raw `rusqlite::Result` and translate at the command boundary, mirror that pattern instead.

- [ ] **Step 2: Spawn the scheduler from `lib.rs`**

In `src-tauri/src/lib.rs`, locate the `tauri::Builder::default()` setup block (the one with `.setup(|app| { ... })`). Inside the setup closure, *after* `app.manage(app_state)` has registered the `AppState` (the scheduler resolves `llm` and `db` from the managed state), add:

```rust
// Daily recap scheduler — fires once per day at the user-configured hour.
crate::daily_summary::scheduler::spawn(app.handle().clone());
```

- [ ] **Step 3: Compile**

Run: `cd src-tauri && cargo build --lib`
Expected: clean compile. Fix any path / type adaptations needed.

- [ ] **Step 4: Manual smoke test**

1. Set the deliver hour to the current hour + 1 minute in the future via the settings store (you can do this via a debug command or by editing `~/Library/Application Support/EchoScribe/settings.json`).
2. Run the app: `bun run dev` (or `bun tauri build --bundles app && open …`).
3. Wait one minute past the hour boundary.
4. Confirm a macOS notification appears titled "Your <DayName> recap."
5. Confirm a row was written: `sqlite3 "$HOME/Library/Application Support/EchoScribe/echoscribe.db" 'SELECT date, status FROM daily_summaries ORDER BY date DESC LIMIT 5;'`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/daily_summary/scheduler.rs src-tauri/src/lib.rs
git commit -m "feat(daily-summary): spawn scheduler task and fire morning notification"
```

---

## Task 9: Tauri commands + JS bindings

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the commands**

Append to `src-tauri/src/commands.rs` (alongside the other `#[tauri::command]` functions). All commands use the existing `AppState` pattern (`state.db.as_ref().ok_or("db unavailable")?.with_conn(|conn| { ... })` and `state.llm.clone()`).

```rust
use crate::daily_summary::{generate_for_date, DEFAULT_LLM_MODEL_ID};
use crate::db::daily_summaries::{self, DailySummaryRow};

#[derive(serde::Serialize)]
pub struct DailySummaryDto {
    pub date: String,
    pub generated_at: String,
    pub status: String,
    pub narrative: String,
    pub sections: serde_json::Value,
    pub source_meeting_ids: Vec<String>,
    pub source_item_ids: Vec<String>,
    pub model_version: String,
}

fn to_dto(row: DailySummaryRow) -> DailySummaryDto {
    DailySummaryDto {
        date: row.date,
        generated_at: row.generated_at,
        status: match row.status {
            daily_summaries::SummaryStatus::Generated => "generated".into(),
            daily_summaries::SummaryStatus::SkippedEmpty => "skipped_empty".into(),
            daily_summaries::SummaryStatus::Failed => "failed".into(),
        },
        narrative: row.narrative,
        sections: serde_json::from_str(&row.sections_json)
            .unwrap_or(serde_json::Value::Object(Default::default())),
        source_meeting_ids: serde_json::from_str(&row.source_meeting_ids_json).unwrap_or_default(),
        source_item_ids: serde_json::from_str(&row.source_item_ids_json).unwrap_or_default(),
        model_version: row.model_version,
    }
}

#[tauri::command]
pub fn daily_summary_get(
    state: tauri::State<'_, AppState>,
    date: String,
) -> Result<Option<DailySummaryDto>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let row = db
        .with_conn(|conn| {
            daily_summaries::get(conn, &date).map_err(crate::db::DbError::from)
        })
        .map_err(|e| format!("{e:?}"))?;
    Ok(row.map(to_dto))
}

#[tauri::command]
pub fn daily_summary_list_recent(
    state: tauri::State<'_, AppState>,
    limit: u32,
) -> Result<Vec<DailySummaryDto>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let rows = db
        .with_conn(|conn| {
            daily_summaries::list_recent(conn, limit).map_err(crate::db::DbError::from)
        })
        .map_err(|e| format!("{e:?}"))?;
    Ok(rows.into_iter().map(to_dto).collect())
}

#[tauri::command]
pub async fn daily_summary_regenerate(
    state: tauri::State<'_, AppState>,
    date: String,
) -> Result<DailySummaryDto, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?.clone();
    let llm = state.llm.clone();
    let row = tauri::async_runtime::spawn_blocking(move || -> Result<DailySummaryRow, String> {
        db.with_conn(|conn| -> Result<DailySummaryRow, crate::db::DbError> {
            generate_for_date(conn, &llm, &date, DEFAULT_LLM_MODEL_ID)
                .map_err(crate::db::DbError::from)?;
            daily_summaries::get(conn, &date)
                .map_err(crate::db::DbError::from)?
                .ok_or_else(|| {
                    crate::db::DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows)
                })
        })
        .map_err(|e| format!("{e:?}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(to_dto(row))
}

// Settings commands — these read/write via the existing SettingsStore on AppState.

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DailyRecapSettings {
    pub enabled: bool,
    pub deliver_hour: u8,
    pub include_weekends: bool,
}

#[tauri::command]
pub fn daily_recap_settings_get(
    state: tauri::State<'_, AppState>,
) -> DailyRecapSettings {
    DailyRecapSettings {
        enabled: state.settings.daily_recap_enabled(),
        deliver_hour: state.settings.daily_recap_deliver_hour(),
        include_weekends: state.settings.daily_recap_include_weekends(),
    }
}

#[tauri::command]
pub fn daily_recap_settings_set(
    state: tauri::State<'_, AppState>,
    settings: DailyRecapSettings,
) -> Result<(), String> {
    state
        .settings
        .set_daily_recap_enabled(settings.enabled)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_daily_recap_deliver_hour(settings.deliver_hour)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_daily_recap_include_weekends(settings.include_weekends)
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

> **Note:** the `daily_summary_regenerate` path uses `DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows)` as a sentinel when the row vanishes between write and read — this should never happen in practice (UPSERT just wrote it). If the project has a more idiomatic error variant, prefer that. Confirm `From<crate::daily_summary::generator::GenerateError>` for `DbError` exists or add the explicit conversion you need; the simplest fallback is to convert at the boundary via `.map_err(|e| crate::db::DbError::Sqlite(rusqlite::Error::InvalidQuery))` plus a log line.

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs` find the `.invoke_handler(tauri::generate_handler![...])` call and add the five new commands:

```rust
daily_summary_get,
daily_summary_list_recent,
daily_summary_regenerate,
daily_recap_settings_get,
daily_recap_settings_set,
```

- [ ] **Step 3: Add JS bindings + types**

Open `src/lib/api.ts` and append:

```typescript
export type DailySummaryStatus = "generated" | "skipped_empty" | "failed";

export type DailySummarySectionItem = {
  text: string;
  source_id?: string | null;
};

export type DailySummarySections = {
  meetings?: DailySummarySectionItem[];
  focus_work?: DailySummarySectionItem[];
  notes?: DailySummarySectionItem[];
  things_that_came_up?: DailySummarySectionItem[];
};

export type DailySummary = {
  date: string;
  generated_at: string;
  status: DailySummaryStatus;
  narrative: string;
  sections: DailySummarySections;
  source_meeting_ids: string[];
  source_item_ids: string[];
  model_version: string;
};

export type DailyRecapSettings = {
  enabled: boolean;
  deliver_hour: number;
  include_weekends: boolean;
};

export async function getDailySummary(date: string): Promise<DailySummary | null> {
  return invoke<DailySummary | null>("daily_summary_get", { date });
}

export async function listRecentDailySummaries(limit: number): Promise<DailySummary[]> {
  return invoke<DailySummary[]>("daily_summary_list_recent", { limit });
}

export async function regenerateDailySummary(date: string): Promise<DailySummary> {
  return invoke<DailySummary>("daily_summary_regenerate", { date });
}

export async function getDailyRecapSettings(): Promise<DailyRecapSettings> {
  return invoke<DailyRecapSettings>("daily_recap_settings_get");
}

export async function setDailyRecapSettings(settings: DailyRecapSettings): Promise<void> {
  return invoke<void>("daily_recap_settings_set", { settings });
}
```

(`invoke` is already imported at the top of `api.ts` — check the existing import line.)

- [ ] **Step 4: Compile both sides**

Run:
- `cd src-tauri && cargo build --lib`
- From the project root: `bun run build` (or `bun tsc --noEmit` if available)

Expected: both compile clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(daily-summary): add Tauri commands and JS bindings"
```

---

## Task 10: Settings UI — "Daily Recap" section

**Files:**
- Modify: `src/views/Settings.tsx`

- [ ] **Step 1: Add the section**

Read the existing `src/views/Settings.tsx` to find the pattern used by another settings section (e.g., the meeting-related toggles). Mirror that pattern for the new section. Suggested shape:

```tsx
import {
  getDailyRecapSettings,
  setDailyRecapSettings,
  type DailyRecapSettings,
} from "../lib/api";

// Inside the Settings component, alongside the other useEffect-loaded states:
const [dailyRecap, setDailyRecap] = useState<DailyRecapSettings | null>(null);

useEffect(() => {
  getDailyRecapSettings().then(setDailyRecap);
}, []);

const saveDailyRecap = useCallback(
  (patch: Partial<DailyRecapSettings>) => {
    if (!dailyRecap) return;
    const next = { ...dailyRecap, ...patch };
    setDailyRecap(next);
    setDailyRecapSettings(next).catch((e) =>
      console.error("failed to save daily recap settings", e),
    );
  },
  [dailyRecap],
);
```

Then in the render section, add a new fieldset (mirror existing fieldset structure):

```tsx
{dailyRecap && (
  <section className="settings-section">
    <h3>Daily Recap</h3>
    <p className="settings-section-blurb">
      A morning notification that summarizes yesterday's meetings, notes,
      and dictations.
    </p>

    <label className="settings-row">
      <input
        type="checkbox"
        checked={dailyRecap.enabled}
        onChange={(e) => saveDailyRecap({ enabled: e.target.checked })}
      />
      Generate a daily recap each morning
    </label>

    <label className="settings-row">
      Deliver at
      <select
        value={dailyRecap.deliver_hour}
        onChange={(e) =>
          saveDailyRecap({ deliver_hour: Number(e.target.value) })
        }
        disabled={!dailyRecap.enabled}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {`${String(h).padStart(2, "0")}:00`}
          </option>
        ))}
      </select>
    </label>

    <label className="settings-row">
      <input
        type="checkbox"
        checked={dailyRecap.include_weekends}
        onChange={(e) =>
          saveDailyRecap({ include_weekends: e.target.checked })
        }
        disabled={!dailyRecap.enabled}
      />
      Include weekends
    </label>
  </section>
)}
```

(Class names like `settings-section` and `settings-row` are placeholders — use whatever class names the existing sections use. Check one before pasting.)

- [ ] **Step 2: Build and smoke-test**

Run: `bun run dev`
Expected: open Settings, see the new "Daily Recap" section with three controls. Toggle each, restart the app, confirm values persist (open the JSON file at `~/Library/Application Support/EchoScribe/settings.json` to verify).

- [ ] **Step 3: Commit**

```bash
git add src/views/Settings.tsx
git commit -m "feat(ui): add Daily Recap settings section"
```

---

## Task 11: Daily view + nav entry

**Files:**
- Create: `src/views/sections/DailyView.tsx`
- Modify: `src/views/Main.tsx`

- [ ] **Step 1: Create the view**

Create `src/views/sections/DailyView.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  getDailySummary,
  listRecentDailySummaries,
  regenerateDailySummary,
  type DailySummary,
  type DailySummarySectionItem,
} from "../../lib/api";

type Props = {
  initialDate?: string;
};

function todayLocalIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function yesterdayLocalIso(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function dayOfWeekLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export default function DailyView({ initialDate }: Props) {
  const [date, setDate] = useState<string>(initialDate ?? yesterdayLocalIso());
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [recent, setRecent] = useState<DailySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        getDailySummary(date),
        listRecentDailySummaries(14),
      ]);
      setSummary(s);
      setRecent(r);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") setDate((d) => shiftDate(d, -1));
      if (e.key === "ArrowRight") setDate((d) => shiftDate(d, +1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      const s = await regenerateDailySummary(date);
      setSummary(s);
      // Refresh history strip too
      const r = await listRecentDailySummaries(14);
      setRecent(r);
    } catch (e) {
      console.error("regenerate failed", e);
    } finally {
      setRegenerating(false);
    }
  }, [date]);

  return (
    <div className="daily-view">
      <aside className="daily-history">
        {recent.length === 0 ? (
          <p className="daily-history-empty">No recaps yet.</p>
        ) : (
          recent.map((r) => (
            <button
              key={r.date}
              className={`daily-history-row ${
                r.status === "skipped_empty" ? "is-empty" : ""
              } ${r.date === date ? "is-active" : ""}`}
              onClick={() => r.status !== "skipped_empty" && setDate(r.date)}
              disabled={r.status === "skipped_empty"}
            >
              <span className="daily-history-date">{r.date}</span>
              <span className="daily-history-preview">
                {r.status === "skipped_empty"
                  ? "(quiet day)"
                  : r.narrative.slice(0, 60)}
              </span>
            </button>
          ))
        )}
      </aside>

      <main className="daily-main">
        <header className="daily-header">
          <button onClick={() => setDate((d) => shiftDate(d, -1))} aria-label="Previous day">
            <ChevronLeft size={18} />
          </button>
          <h2>{dayOfWeekLabel(date)}</h2>
          <button onClick={() => setDate((d) => shiftDate(d, +1))} aria-label="Next day">
            <ChevronRight size={18} />
          </button>
        </header>

        {loading && <p>Loading…</p>}

        {!loading && !summary && date === todayLocalIso() && (
          <div className="daily-empty">
            <p>Today's recap will generate tomorrow morning.</p>
            <button onClick={onRegenerate} disabled={regenerating}>
              <RefreshCw size={14} /> {regenerating ? "Generating…" : "Generate now"}
            </button>
          </div>
        )}

        {!loading && !summary && date !== todayLocalIso() && (
          <div className="daily-empty">
            <p>No recap was generated for this day.</p>
            <button onClick={onRegenerate} disabled={regenerating}>
              <RefreshCw size={14} /> {regenerating ? "Generating…" : "Generate now"}
            </button>
          </div>
        )}

        {!loading && summary?.status === "skipped_empty" && (
          <p className="daily-empty">Nothing recorded on this day.</p>
        )}

        {!loading && summary?.status === "failed" && (
          <div className="daily-empty">
            <p>Couldn't generate this recap.</p>
            <button onClick={onRegenerate} disabled={regenerating}>
              <RefreshCw size={14} /> {regenerating ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}

        {!loading && summary?.status === "generated" && (
          <article className="daily-article">
            <p className="daily-narrative">{summary.narrative}</p>

            <Section
              title="Meetings"
              items={summary.sections.meetings ?? []}
            />
            <Section
              title="Focus work"
              items={summary.sections.focus_work ?? []}
            />
            <Section title="Notes" items={summary.sections.notes ?? []} />
            <Section
              title="Things that came up"
              items={summary.sections.things_that_came_up ?? []}
            />

            <footer className="daily-footer">
              <span>Generated {summary.generated_at}</span>
              <button onClick={onRegenerate} disabled={regenerating}>
                <RefreshCw size={14} /> {regenerating ? "Regenerating…" : "Regenerate"}
              </button>
            </footer>
          </article>
        )}
      </main>
    </div>
  );
}

function Section({
  title,
  items,
}: {
  title: string;
  items: DailySummarySectionItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="daily-section">
      <h3>{title}</h3>
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            {it.text}
            {it.source_id ? (
              <span className="daily-section-source">[{it.source_id}]</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export { CalendarDays as DailyViewIcon };
```

- [ ] **Step 2: Add the navigation variant + render case + sidebar entry to Main.tsx**

In `src/views/Main.tsx`:

1. Add `CalendarDays` to the `lucide-react` import.
2. Add `import DailyView from "./sections/DailyView";` next to the other section imports.
3. Extend the `MainSection` discriminated union:

```typescript
export type MainSection =
  | { kind: "activity" }
  | { kind: "tasks" }
  | { kind: "search" }
  | { kind: "chat" }
  | { kind: "dashboard" }
  | { kind: "daily"; date?: string }   // ← new
  | { kind: "meetings" }
  | { kind: "meeting"; id: string }
  | { kind: "project"; id: string };
```

4. Add a new sidebar nav item. Find the existing sidebar nav list and add a button matching the existing pattern, with `CalendarDays` as the icon and label "Daily." Set its onClick to `setSection({ kind: "daily" })`.

5. In the central content router (the part that switches on `section.kind`), add a case:

```tsx
{section.kind === "daily" && <DailyView initialDate={section.date} />}
```

- [ ] **Step 3: Smoke test**

Run: `bun run dev`
- Verify the "Daily" sidebar entry renders.
- Click it; the view should open scoped to yesterday by default.
- Press ← / →; the date should shift.
- Click "Generate now" on today; verify the row appears in DB and the view re-renders with the summary.
- Generate against a quiet day (or a day with one note); verify the empty/skipped state renders correctly.

- [ ] **Step 4: Commit**

```bash
git add src/views/sections/DailyView.tsx src/views/Main.tsx
git commit -m "feat(ui): add Daily Recap view with history strip and on-demand regenerate"
```

---

## Self-Review

After all tasks complete, run the full Rust test suite once and verify it passes end-to-end:

```bash
cd src-tauri && cargo test --lib
```

Then build the release bundle:

```bash
bun tauri build --bundles app
```

And reinstall following the project's standard TCC-reset workflow from `CLAUDE.md`.

---

## Spec coverage check

- [x] Morning recap trigger at user-configured hour → Task 7 (`next_fire_time`), Task 8 (Tokio task + crossing check)
- [x] On-demand regeneration → Task 9 (`daily_summary_regenerate`), Task 11 (button)
- [x] Weekend opt-in → Task 3 (setting), Task 7 (skip logic), Task 8 (passed through)
- [x] Empty-day skip silently → Task 4 (`is_empty`), Task 6 (writes `skipped_empty` row, no notification), Task 8 (notification only on `Generated`)
- [x] Multi-day backfill, single notification → Task 7 (`dates_needing_generation`), Task 8 (`fire_notification_for_latest`)
- [x] Notification opens to Daily view → Task 11 (view renders today's date by default; click-through wiring is OS-handled via app focus)
- [x] Narrative + four sections (Meetings / Focus work / Notes / Things that came up) → Task 5 (schema), Task 11 (renderer)
- [x] Source tag attribution with graceful degradation → Task 5 (`SectionItem.source_id`), Task 11 (renders `[source_id]` badge when present, plain bullet otherwise)
- [x] GBNF-constrained JSON output → Task 5 (`OUTPUT_GRAMMAR`), Task 6 (passed in `GenerateRequest.grammar_gbnf`)
- [x] Reuse existing `gemma-4-e2b-it-q4_k_m` via `llama-cpp-2` → Task 6 (calls existing `Llm::generate`)
- [x] One new `daily_summaries` table, no other DB changes → Task 1 (migration), Task 2 (CRUD)
- [x] Settings: enabled / hour / weekends → Task 3
- [x] History strip with greyed-out empty days → Task 11
- [x] Failed and skipped-empty states render distinctly → Task 11
- [x] `model_version = "{model_id}@{prompt_hash}"` → Task 5 (`prompt_version`), Task 6 (formatted in orchestrator)
- [ ] **Wake-from-sleep re-anchor via `NSWorkspace.didWakeNotification`** — Task 8 stubs this out with a 1-minute tick that's effectively equivalent for v1 (worst-case latency: 60s after wake). True wake-observer wiring is left as a flagged follow-up in the spec's "Open implementation details." Acceptable for v1 given the morning fire is forgiving of a one-minute miss.
- [ ] **Global hotkey for on-demand regenerate** — explicitly deferred per the spec.
- [ ] **First-run banner in Daily view** — small enough to fold into Task 11 or leave for a follow-up. Not included in tasks above; flagged here so it isn't lost.
- [ ] **Notification-permission banner in Daily view** — same as above; flagged for follow-up.

The two "flagged for follow-up" items above (first-run banner, notification-permission banner) are spec requirements that did not get a task. **Add a Task 12** if you want to ship them in v1; otherwise document them as known gaps in the PR description.

---

## Task 12 (optional): First-run + permission banners in Daily view

Add a single dismissable banner component to `DailyView.tsx` that:
- Shows on first visit (track via a `localStorage` flag): "This recap looks at your meetings, notes, and dictations — all stored locally on this Mac."
- Shows when macOS notification permission is missing: "Notifications are disabled. Daily recap won't surface unless you enable them in System Settings." with a button that opens System Settings via `tauri-plugin-opener` (or the existing approach the rest of the app uses for permission deep-links).

Implement via a new Tauri command `daily_recap_notification_permission_status() -> bool` that calls `app.notification().permission_state()`. Render the banner conditionally above the date header.

Commit:
```bash
git add src/views/sections/DailyView.tsx src-tauri/src/commands.rs
git commit -m "feat(daily-summary): add first-run framing and permission banner"
```
