# Chat Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist chat conversations in SQLite with named sessions, session management (new/delete), and automatic temporal intent parsing so the AI can answer "tell me everything I did today."

**Architecture:** Two new DB tables (`chat_sessions`, `chat_messages`) via migration v2. A new `temporal.rs` module parses date keywords from the user's message and injects a date window into the FTS5 RAG search. `chat_with_memory` gains a `session_id` parameter and persists every turn. The ChatView becomes a two-panel layout: session list on the left, chat on the right.

**Tech Stack:** Rust/rusqlite for DB, SystemTime-based date math (no new deps), React/TypeScript frontend, existing Tauri command pattern.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/db/schema.rs` | Modify | Add migration v2: `chat_sessions` + `chat_messages` tables |
| `src-tauri/src/db/items.rs` | Modify | Make `format_iso_utc` and `civil_from_days` `pub(crate)` |
| `src-tauri/src/db/chat.rs` | Create | CRUD: insert/list/delete/rename sessions; insert/load messages |
| `src-tauri/src/db/mod.rs` | Modify | Declare and re-export `chat` module types |
| `src-tauri/src/db/search.rs` | Modify | Add `search_items_with_date_window` |
| `src-tauri/src/temporal.rs` | Create | `extract_date_window` — rule-based date window from message |
| `src-tauri/src/commands.rs` | Modify | Add 5 new session commands; update `chat_with_memory` |
| `src-tauri/src/lib.rs` | Modify | Register 5 new commands + import new types |
| `src/lib/api.ts` | Modify | Add `ChatSession`, `ChatMessage` types + 5 new bindings; update `chatWithMemory` |
| `src/views/sections/ChatView.tsx` | Modify | Two-panel layout: session list + chat area |

---

## Task 1: Expose date helpers and add migration v2

**Files:**
- Modify: `src-tauri/src/db/items.rs`
- Modify: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: Make `format_iso_utc` and `civil_from_days` pub(crate)**

In `src-tauri/src/db/items.rs`, find the two private functions and add `pub(crate)`:

```rust
pub(crate) fn format_iso_utc(secs: i64) -> String {
```

```rust
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
```

(`civil_from_days` is the helper called by `format_iso_utc` — make it pub(crate) too.)

- [ ] **Step 2: Add migration v2**

In `src-tauri/src/db/schema.rs`, append a second tuple to the `MIGRATIONS` array (after the closing `"#,` of migration 1, before the closing `];`):

```rust
(
    2,
    r#"
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
"#,
),
```

- [ ] **Step 3: Run the migration test**

```bash
cd src-tauri && cargo test db::schema -- --nocapture 2>&1 | tail -10
```

Expected: all schema tests PASS (idempotent migration test covers v2).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/items.rs src-tauri/src/db/schema.rs
git commit -m "feat(db): add chat_sessions and chat_messages migration v2"
```

---

## Task 2: DB CRUD module for chat

**Files:**
- Create: `src-tauri/src/db/chat.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: Write failing tests first**

Create `src-tauri/src/db/chat.rs` with just the test module so they fail to compile:

```rust
//! CRUD for chat sessions and messages.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::db::items::chrono_now_iso;
use super::DbError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", &"ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn insert_and_list_session() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "My Session", None).unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "My Session");
    }

    #[test]
    fn list_sessions_ordered_by_updated_at_desc() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "Older", None).unwrap();
        insert_session(&conn, "s2", "Newer", None).unwrap();
        touch_session(&conn, "s2").unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert_eq!(sessions[0].id, "s2");
    }

    #[test]
    fn rename_session_works() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "Old Name", None).unwrap();
        rename_session(&conn, "s1", "New Name").unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert_eq!(sessions[0].name, "New Name");
    }

    #[test]
    fn delete_session_cascades_messages() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "Session", None).unwrap();
        insert_message(&conn, "s1", "user", "hello").unwrap();
        insert_message(&conn, "s1", "assistant", "world").unwrap();
        delete_session(&conn, "s1").unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert!(sessions.is_empty());
        // messages should be gone via cascade
        let msgs = load_messages(&conn, "s1", 20).unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn load_messages_capped_at_limit() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "S", None).unwrap();
        for i in 0..25u32 {
            insert_message(&conn, "s1", "user", &format!("msg {i}")).unwrap();
        }
        let msgs = load_messages(&conn, "s1", 20).unwrap();
        assert_eq!(msgs.len(), 20);
        // Should be the last 20 (most recent), returned oldest-first
        assert_eq!(msgs[0].content, "msg 5");
        assert_eq!(msgs[19].content, "msg 24");
    }

    #[test]
    fn list_sessions_filtered_by_project() {
        let conn = fresh_db();
        // Insert a project to satisfy FK
        conn.execute(
            "INSERT INTO projects(id, name, created_at) VALUES ('p1', 'Proj', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        insert_session(&conn, "s1", "In project", Some("p1")).unwrap();
        insert_session(&conn, "s2", "No project", None).unwrap();
        let filtered = list_sessions(&conn, Some("p1")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "s1");
        let all = list_sessions(&conn, None).unwrap();
        assert_eq!(all.len(), 2);
    }
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd src-tauri && cargo test db::chat -- --nocapture 2>&1 | tail -15
```

Expected: compile error — functions not found.

- [ ] **Step 3: Implement the CRUD functions**

Add the following functions above the `#[cfg(test)]` block in `src-tauri/src/db/chat.rs`:

```rust
pub fn insert_session(
    conn: &Connection,
    id: &str,
    name: &str,
    project_id: Option<&str>,
) -> Result<ChatSession, DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "INSERT INTO chat_sessions (id, name, project_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, project_id, now, now],
    )?;
    Ok(ChatSession {
        id: id.to_string(),
        name: name.to_string(),
        project_id: project_id.map(|s| s.to_string()),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_sessions(
    conn: &Connection,
    project_id: Option<&str>,
) -> Result<Vec<ChatSession>, DbError> {
    let sql = if project_id.is_some() {
        "SELECT id, name, project_id, created_at, updated_at
         FROM chat_sessions WHERE project_id = ?1
         ORDER BY updated_at DESC"
    } else {
        "SELECT id, name, project_id, created_at, updated_at
         FROM chat_sessions
         ORDER BY updated_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = if let Some(pid) = project_id {
        stmt.query_map(params![pid], row_to_session)?
    } else {
        stmt.query_map([], row_to_session)?
    };
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn rename_session(conn: &Connection, id: &str, name: &str) -> Result<(), DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "UPDATE chat_sessions SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, id],
    )?;
    Ok(())
}

pub fn touch_session(conn: &Connection, id: &str) -> Result<(), DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn insert_message(
    conn: &Connection,
    session_id: &str,
    role: &str,
    content: &str,
) -> Result<ChatMessage, DbError> {
    let id = Ulid::new().to_string();
    let now = chrono_now_iso();
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, session_id, role, content, now],
    )?;
    Ok(ChatMessage {
        id,
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        created_at: now,
    })
}

/// Load the most recent `limit` messages for a session, returned oldest-first.
pub fn load_messages(
    conn: &Connection,
    session_id: &str,
    limit: u32,
) -> Result<Vec<ChatMessage>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at
         FROM (
           SELECT id, session_id, role, content, created_at
           FROM chat_messages
           WHERE session_id = ?1
           ORDER BY created_at DESC
           LIMIT ?2
         )
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![session_id, limit as i64], |row| {
        Ok(ChatMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSession> {
    Ok(ChatSession {
        id: row.get(0)?,
        name: row.get(1)?,
        project_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}
```

- [ ] **Step 4: Declare module in db/mod.rs**

In `src-tauri/src/db/mod.rs`, add after the existing `pub mod search;` line:

```rust
pub mod chat;
```

And add to the `pub use` block:

```rust
pub use chat::{ChatMessage, ChatSession};
```

- [ ] **Step 5: Run tests**

```bash
cd src-tauri && cargo test db::chat -- --nocapture 2>&1 | tail -20
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/chat.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): add chat session and message CRUD"
```

---

## Task 3: Temporal intent parsing

**Files:**
- Create: `src-tauri/src/temporal.rs`
- Modify: `src-tauri/src/lib.rs` (declare module)

- [ ] **Step 1: Write failing tests**

Create `src-tauri/src/temporal.rs` with just the test module:

```rust
//! Rule-based temporal intent extraction.
//!
//! Parses phrases like "today", "yesterday", "this week" from a user message
//! and returns an ISO-8601 date window `(from, to)` suitable for SQL queries
//! against `captured_at`.

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-05-02 12:00:00 UTC  →  epoch seconds
    // 2026-05-02 = day 20575 since epoch
    // 20575 * 86400 = 1,777,680,000  +  43200 (noon) = 1,777,723,200
    const SAMPLE_NOW: i64 = 1_777_723_200;

    #[test]
    fn today_window() {
        let w = extract_date_window("what did I do today", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-05-02T00:00:00Z");
        assert_eq!(w.1, "2026-05-02T12:00:00Z");
    }

    #[test]
    fn yesterday_window() {
        let w = extract_date_window("everything I captured yesterday", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-05-01T00:00:00Z");
        assert_eq!(w.1, "2026-05-01T23:59:59Z");
    }

    #[test]
    fn this_week_window() {
        // 2026-05-02 is a Saturday. Monday of this week = 2026-04-27.
        let w = extract_date_window("what happened this week", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-04-27T00:00:00Z");
        assert_eq!(w.1, "2026-05-02T12:00:00Z");
    }

    #[test]
    fn last_week_window() {
        // Last week Mon=2026-04-20, Sun=2026-04-26
        let w = extract_date_window("tasks from last week", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-04-20T00:00:00Z");
        assert_eq!(w.1, "2026-04-26T23:59:59Z");
    }

    #[test]
    fn this_month_window() {
        let w = extract_date_window("my captures this month", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-05-01T00:00:00Z");
        assert_eq!(w.1, "2026-05-02T12:00:00Z");
    }

    #[test]
    fn last_month_window() {
        let w = extract_date_window("blocked items last month", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-04-01T00:00:00Z");
        assert_eq!(w.1, "2026-04-30T23:59:59Z");
    }

    #[test]
    fn no_temporal_keyword_returns_none() {
        assert!(extract_date_window("what is a project", SAMPLE_NOW).is_none());
        assert!(extract_date_window("help me write a summary", SAMPLE_NOW).is_none());
    }

    #[test]
    fn case_insensitive() {
        assert!(extract_date_window("What Did I Do TODAY", SAMPLE_NOW).is_some());
    }
}
```

- [ ] **Step 2: Declare module in lib.rs**

In `src-tauri/src/lib.rs`, add with the other module declarations (near the top where `mod` statements live):

```rust
mod temporal;
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd src-tauri && cargo test temporal -- --nocapture 2>&1 | tail -10
```

Expected: compile error — `extract_date_window` not found.

- [ ] **Step 4: Implement extract_date_window**

Add the following above the `#[cfg(test)]` block in `src-tauri/src/temporal.rs`:

```rust
use crate::db::items::{civil_from_days, format_iso_utc};

/// Parse temporal keywords from `message` and return an ISO-8601 `(from, to)` window.
/// `now_secs` is seconds since Unix epoch (UTC).
/// Returns `None` if no recognized temporal phrase is found.
pub fn extract_date_window(message: &str, now_secs: i64) -> Option<(String, String)> {
    let lower = message.to_lowercase();

    let today_start = (now_secs / 86_400) * 86_400;
    let days_since_epoch = now_secs / 86_400;
    // weekday_mon0: 0=Mon … 6=Sun. Epoch (1970-01-01) was Thursday = 3.
    let weekday_mon0 = ((days_since_epoch + 3) % 7) as i64;

    if lower.contains("yesterday") {
        let from = today_start - 86_400;
        let to = today_start - 1;
        return Some((format_iso_utc(from), format_iso_utc(to)));
    }

    if lower.contains("last week") {
        let this_monday = today_start - weekday_mon0 * 86_400;
        let from = this_monday - 7 * 86_400;
        let to = this_monday - 1;
        return Some((format_iso_utc(from), format_iso_utc(to)));
    }

    if lower.contains("this week") {
        let from = today_start - weekday_mon0 * 86_400;
        return Some((format_iso_utc(from), format_iso_utc(now_secs)));
    }

    if lower.contains("last month") {
        let (y, m, _) = civil_from_days(days_since_epoch);
        let (from_y, from_m) = if m == 1 { (y - 1, 12u32) } else { (y, m - 1) };
        let days_in_from_m = days_in_month(from_y, from_m);
        let from = days_to_epoch(from_y, from_m, 1) * 86_400;
        let to = days_to_epoch(from_y, from_m, days_in_from_m) * 86_400 + 86_399;
        return Some((format_iso_utc(from), format_iso_utc(to)));
    }

    if lower.contains("this month") {
        let (y, m, _) = civil_from_days(days_since_epoch);
        let from = days_to_epoch(y, m, 1) * 86_400;
        return Some((format_iso_utc(from), format_iso_utc(now_secs)));
    }

    if lower.contains("today") {
        return Some((format_iso_utc(today_start), format_iso_utc(now_secs)));
    }

    None
}

/// Number of days in a given month (1-indexed), accounting for leap years.
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Days since Unix epoch for the start of a given UTC date.
/// Uses the inverse of Howard Hinnant's civil_from_days.
fn days_to_epoch(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let m = month as i64;
    let d = day as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
```

- [ ] **Step 5: Run tests**

```bash
cd src-tauri && cargo test temporal -- --nocapture 2>&1 | tail -15
```

Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/temporal.rs src-tauri/src/lib.rs
git commit -m "feat(temporal): rule-based date window extraction for RAG"
```

---

## Task 4: Date-windowed search

**Files:**
- Modify: `src-tauri/src/db/search.rs`

- [ ] **Step 1: Write failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/db/search.rs`:

```rust
#[test]
fn search_with_date_window_filters_by_date() {
    let conn = fresh_db();
    let mut old = make_item("a", "standup blocker meeting");
    old.captured_at = "2026-04-01T10:00:00Z".to_string();
    old.created_at = old.captured_at.clone();
    insert_item(&conn, &old).unwrap();

    let mut recent = make_item("b", "standup blocker review");
    recent.captured_at = "2026-05-02T10:00:00Z".to_string();
    recent.created_at = recent.captured_at.clone();
    insert_item(&conn, &recent).unwrap();

    let hits = search_items_with_date_window(
        &conn,
        "standup",
        Some("2026-05-01T00:00:00Z"),
        Some("2026-05-03T00:00:00Z"),
        None,
        50,
    ).unwrap();
    let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"b"));
    assert!(!ids.contains(&"a"));
}

#[test]
fn search_with_date_window_no_window_returns_all() {
    let conn = fresh_db();
    insert_item(&conn, &make_item("a", "project planning notes")).unwrap();
    insert_item(&conn, &make_item("b", "project review session")).unwrap();
    let hits = search_items_with_date_window(&conn, "project", None, None, None, 50).unwrap();
    assert_eq!(hits.len(), 2);
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd src-tauri && cargo test db::search -- --nocapture 2>&1 | tail -10
```

Expected: compile error — `search_items_with_date_window` not found.

- [ ] **Step 3: Implement search_items_with_date_window**

Add after `search_items_for_project` in `src-tauri/src/db/search.rs`:

```rust
/// FTS5 search with optional date window and optional project scope.
/// `from` and `to` are ISO-8601 strings matched against `captured_at`.
/// When either is `None`, that bound is not applied.
pub fn search_items_with_date_window(
    conn: &Connection,
    query: &str,
    from: Option<&str>,
    to: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
) -> Result<Vec<Item>, DbError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = String::from(
        "SELECT items.id, items.content, items.source, items.visibility, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(query.to_string()), Box::new(limit as i64)];
    // placeholder index 2 is reserved for limit — we build the WHERE before adding it
    let mut extra_idx = 3usize;

    if let Some(f) = from {
        sql.push_str(&format!(" AND items.captured_at >= ?{extra_idx}"));
        args.insert(extra_idx - 1, Box::new(f.to_string()));
        extra_idx += 1;
    }
    if let Some(t) = to {
        sql.push_str(&format!(" AND items.captured_at <= ?{extra_idx}"));
        args.insert(extra_idx - 1, Box::new(t.to_string()));
        extra_idx += 1;
    }
    if let Some(pid) = project_id {
        sql.push_str(&format!(" AND items.project_id = ?{extra_idx}"));
        args.insert(extra_idx - 1, Box::new(pid.to_string()));
    }
    sql.push_str(" ORDER BY rank LIMIT ?2");

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), row_to_item_for_search)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test db::search -- --nocapture 2>&1 | tail -15
```

Expected: all search tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/search.rs
git commit -m "feat(db): add search_items_with_date_window for temporal RAG"
```

---

## Task 5: New session management commands

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add imports**

Near the top of `src-tauri/src/commands.rs`, in the `use crate::db` import block, add `ChatMessage, ChatSession` to the existing `use crate::db::{self, Db, Item, Visibility};` line:

```rust
use crate::db::{self, ChatMessage, ChatSession, Db, Item, Visibility};
```

And add a new import line for the db::chat module functions and temporal:

```rust
use crate::db::chat;
use crate::temporal::extract_date_window;
```

- [ ] **Step 2: Add the 5 new commands**

Append after the `build_rag_query` function (before the existing `chat_with_memory`):

```rust
// ----- Chat session commands -----

#[tauri::command]
pub fn create_chat_session(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<ChatSession, String> {
    let db = require_db(&state)?;
    let id = ulid::Ulid::new().to_string();
    db.with_conn(|c| chat::insert_session(c, &id, "New Chat", project_id.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chat_sessions(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<ChatSession>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::list_sessions(c, project_id.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_chat_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::load_messages(c, &session_id, 20))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::delete_session(c, &session_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_chat_session(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::rename_session(c, &session_id, &name))
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Check it compiles**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): add chat session management commands"
```

---

## Task 6: Update chat_with_memory

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Replace chat_with_memory**

Find the existing `pub async fn chat_with_memory` function (starting around line 1247) and replace it entirely with:

```rust
#[tauri::command]
pub async fn chat_with_memory(
    state: State<'_, AppState>,
    session_id: String,
    message: String,
    project_id: Option<String>,
) -> Result<String, String> {
    if !state.llm.ready() {
        return Ok(
            "No local AI model is loaded. Please download one in Settings → AI Model.".to_string(),
        );
    }

    let db = require_db(&state)?;

    // Persist the user message.
    db.with_conn(|c| chat::insert_message(c, &session_id, "user", &message))
        .map_err(|e| e.to_string())?;

    // Auto-rename session if it still has the placeholder name.
    let sessions = db
        .with_conn(|c| chat::list_sessions(c, None))
        .unwrap_or_default();
    let is_new = sessions
        .iter()
        .find(|s| s.id == session_id)
        .map(|s| s.name == "New Chat")
        .unwrap_or(false);

    // FTS5 retrieval with optional temporal window.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let date_window = extract_date_window(&message, now_secs);
    let now_iso = crate::db::items::chrono_now_iso();
    let today_str = &now_iso[..10];

    let context_items: Vec<String> = {
        let rag_query = build_rag_query(&message);
        if rag_query.is_empty() {
            Vec::new()
        } else {
            let (from, to) = match &date_window {
                Some((f, t)) => (Some(f.as_str()), Some(t.as_str())),
                None => (None, None),
            };
            db.with_conn(|c| {
                db::search::search_items_with_date_window(
                    c,
                    &rag_query,
                    from,
                    to,
                    project_id.as_deref(),
                    6,
                )
            })
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                let kind = item.kind.as_ref().map(|k| k.as_str()).unwrap_or("note");
                let date = &item.captured_at[..10.min(item.captured_at.len())];
                format!("[{date}] ({kind}): {}", item.content)
            })
            .collect()
        }
    };

    let system = if context_items.is_empty() {
        format!(
            "You are a helpful assistant built into Echo Scribe, a voice note and task capture app. \
             Today is {today_str}. \
             No relevant notes were found for this question. Answer helpfully."
        )
    } else {
        format!(
            "You are a helpful assistant built into Echo Scribe. \
             Today is {today_str}. \
             Here are the user's relevant notes and captures:\n\n---\n{}\n---\n\n\
             Answer based on these notes when relevant. \
             If the notes don't address the question, say so and answer from general knowledge.",
            context_items.join("\n")
        )
    };

    // Load history from DB (last 20 messages, excluding the one we just inserted).
    let history_msgs = db
        .with_conn(|c| chat::load_messages(c, &session_id, 20))
        .unwrap_or_default();
    // The last message is the one we just inserted; exclude it from history.
    let hist: Vec<(String, String)> = history_msgs
        .into_iter()
        .rev()
        .skip(1)
        .rev()
        .map(|m| (m.role, m.content))
        .collect();

    let req = GenerateRequest {
        system: Some(system),
        user: message.clone(),
        history: hist,
        max_tokens: 512,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };

    let reply = state.llm.generate(req).await.map_err(|e| e.to_string())?;

    // Persist the assistant reply.
    db.with_conn(|c| chat::insert_message(c, &session_id, "assistant", &reply))
        .map_err(|e| e.to_string())?;

    // Touch updated_at on the session.
    db.with_conn(|c| chat::touch_session(c, &session_id))
        .map_err(|e| e.to_string())?;

    // Auto-rename on first message.
    if is_new {
        let auto_name: String = message.chars().take(50).collect();
        db.with_conn(|c| chat::rename_session(c, &session_id, &auto_name))
            .map_err(|e| e.to_string())?;
    }

    Ok(reply)
}
```

- [ ] **Step 2: Remove the now-unused ChatTurnInput struct and history parameter**

Find and delete this struct (it's no longer used — history comes from DB):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurnInput {
    pub role: String,
    pub content: String,
}
```

- [ ] **Step 3: Check it compiles**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: 0 errors. (If `ChatTurnInput` is referenced elsewhere, remove those references too.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): update chat_with_memory to persist turns and use temporal RAG"
```

---

## Task 7: Register new commands in lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add imports**

In the `use crate::commands::{ ... }` block in `src-tauri/src/lib.rs`, add the 5 new functions:

```rust
create_chat_session, delete_chat_session, list_chat_sessions,
load_chat_messages, rename_chat_session,
```

(Remove `ChatTurnInput` from the import if it appears there.)

- [ ] **Step 2: Register in invoke_handler**

In the `.invoke_handler(tauri::generate_handler![` block, add:

```rust
create_chat_session,
list_chat_sessions,
load_chat_messages,
delete_chat_session,
rename_chat_session,
```

- [ ] **Step 3: Compile check + full test run**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -20
```

Expected: all tests PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): register chat session commands"
```

---

## Task 8: Frontend API bindings

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add types and bindings**

Find the `// ----- Memory chat -----` section in `src/lib/api.ts`. Replace the existing `ChatTurn` type and `chatWithMemory` function with:

```typescript
// ----- Memory chat -----

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatSession = {
  id: string;
  name: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatMessage = {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export const createChatSession = (
  projectId: string | null,
): Promise<ChatSession> =>
  invoke("create_chat_session", { projectId });

export const listChatSessions = (
  projectId: string | null,
): Promise<ChatSession[]> =>
  invoke("list_chat_sessions", { projectId });

export const loadChatMessages = (sessionId: string): Promise<ChatMessage[]> =>
  invoke("load_chat_messages", { sessionId });

export const deleteChatSession = (sessionId: string): Promise<void> =>
  invoke("delete_chat_session", { sessionId });

export const renameChatSession = (
  sessionId: string,
  name: string,
): Promise<void> => invoke("rename_chat_session", { sessionId, name });

export const chatWithMemory = (
  sessionId: string,
  message: string,
  projectId?: string | null,
): Promise<string> =>
  invoke("chat_with_memory", {
    sessionId,
    message,
    projectId: projectId ?? null,
  });
```

- [ ] **Step 2: TypeScript check**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors. If ChatTurn is used elsewhere as a type, those usages still work (it's still exported). If `chatWithMemory` callers exist outside ChatView, they'll show a compile error — update the call site.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add chat session bindings and update chatWithMemory signature"
```

---

## Task 9: ChatView two-panel refactor

**Files:**
- Modify: `src/views/sections/ChatView.tsx`

- [ ] **Step 1: Replace ChatView.tsx**

Replace the entire content of `src/views/sections/ChatView.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react";
import {
  chatWithMemory,
  createChatSession,
  deleteChatSession,
  listChatSessions,
  loadChatMessages,
  type ChatMessage,
  type ChatSession,
  type Project,
} from "../../lib/api";

type Props = {
  projects: Project[];
};

export default function ChatView({ projects }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load sessions when project filter changes
  useEffect(() => {
    void loadSessions();
    setActiveSessionId(null);
    setMessages([]);
  }, [projectFilter]);

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    loadChatMessages(activeSessionId)
      .then(setMessages)
      .catch(console.error);
  }, [activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const loadSessions = async () => {
    try {
      const s = await listChatSessions(projectFilter);
      setSessions(s);
    } catch (e) {
      console.error(e);
    }
  };

  const handleNewChat = async () => {
    try {
      const session = await createChatSession(projectFilter);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string,
  ) => {
    e.stopPropagation();
    try {
      await deleteChatSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const send = async () => {
    if (!activeSessionId) return;
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const optimisticMsg: ChatMessage = {
      id: crypto.randomUUID(),
      session_id: activeSessionId,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setLoading(true);
    try {
      const reply = await chatWithMemory(activeSessionId, text, projectFilter);
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        session_id: activeSessionId,
        role: "assistant",
        content: reply,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      // Refresh session list to get updated name and updated_at ordering
      void loadSessions();
    } catch (e) {
      const errMsg: ChatMessage = {
        id: crypto.randomUUID(),
        session_id: activeSessionId,
        role: "assistant",
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full">
      {/* Session list panel */}
      <div className="flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/60">
        <div className="border-b border-neutral-800 p-3">
          {projects.length > 0 && (
            <select
              value={projectFilter ?? ""}
              onChange={(e) =>
                setProjectFilter(e.target.value === "" ? null : e.target.value)
              }
              className="mb-2 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 focus:border-neutral-500 focus:outline-none"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void handleNewChat()}
            className="w-full rounded-md bg-neutral-700 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-600"
          >
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-neutral-600">
              No conversations yet
            </p>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onClick={() => setActiveSessionId(s.id)}
                onDelete={(e) => void handleDeleteSession(e, s.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">
            {activeSessionId
              ? (sessions.find((s) => s.id === activeSessionId)?.name ?? "Chat")
              : "Chat"}
          </h1>
          <p className="mt-0.5 text-xs text-neutral-500">
            Ask questions about your notes and captures
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!activeSessionId ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-neutral-400">
                Chat with your memory
              </p>
              <p className="max-w-xs text-xs text-neutral-600">
                Start a new chat or select a previous conversation.
              </p>
            </div>
          ) : messages.length === 0 && !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-neutral-400">
                New conversation
              </p>
              <p className="max-w-xs text-xs text-neutral-600">
                Ask about your captures, notes, and tasks. Try "what did I
                capture today?"
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              {loading ? <ThinkingBubble /> : null}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="border-t border-neutral-800 bg-neutral-950/60 px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                activeSessionId
                  ? "Ask about your notes… (Enter to send)"
                  : "Start a new chat first"
              }
              rows={2}
              className="flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none disabled:opacity-40"
              disabled={loading || !activeSessionId}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || loading || !activeSessionId}
              className="rounded-md bg-neutral-700 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mt-1 text-[10px] text-neutral-600">
            Shift+Enter for newline
          </p>
        </div>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onClick,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-800/60 ${
        active ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
      }`}
    >
      <span className="truncate">{session.name}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={onDelete}
        onKeyDown={(e) => e.key === "Enter" && onDelete(e as unknown as React.MouseEvent)}
        className="ml-1 shrink-0 rounded p-0.5 text-neutral-600 opacity-0 hover:bg-neutral-700 hover:text-neutral-300 group-hover:opacity-100"
        aria-label="Delete session"
      >
        ✕
      </span>
    </button>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? "bg-neutral-700 text-neutral-100"
            : "bg-neutral-800/60 text-neutral-200"
        }`}
      >
        {!isUser ? (
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            Echo Scribe AI
          </p>
        ) : null}
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg bg-neutral-800/60 px-3 py-2 text-sm text-neutral-500">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider">
          Echo Scribe AI
        </p>
        <p>Thinking…</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/views/sections/ChatView.tsx
git commit -m "feat(ui): refactor ChatView to two-panel session layout"
```

---

## Task 10: Build and smoke-test

- [ ] **Step 1: Full Rust test suite**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 2: Build release bundle**

```bash
bun tauri build --bundles app 2>&1 | tail -30
```

Expected: build succeeds, `.app` emitted to `src-tauri/target/release/bundle/macos/`.

- [ ] **Step 3: Reinstall with TCC reset**

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

- [ ] **Step 4: Smoke test — session lifecycle**

1. Open Chat tab — left panel shows "No conversations yet"
2. Click "+ New Chat" — a "New Chat" session appears selected
3. Type "what did I capture today?" and send
4. Verify: thinking bubble appears, then reply arrives
5. Session name in left panel auto-updates to "what did I capture today?" (truncated)
6. Close and reopen the app — session persists and loads when clicked

- [ ] **Step 5: Smoke test — temporal query**

1. Start a new chat
2. Type "tell me everything I blocked today" and send
3. Verify: AI response references items from today (if any exist)

- [ ] **Step 6: Smoke test — delete session**

1. Hover over a session row — ✕ button appears
2. Click ✕ — session disappears, chat area resets to empty state

- [ ] **Step 7: Smoke test — no LLM**

If no LLM model is downloaded, sending any message returns the fallback: _"No local AI model is loaded…"_

---

## Self-Review

**Spec coverage:**
- ✅ Persistent chat sessions (DB tables, load on startup)
- ✅ Session list with auto-generated names from first message
- ✅ New Chat button and delete button
- ✅ Temporal intent parsing (today/yesterday/this week/last week/this month/last month)
- ✅ Both voice_at_cursor and log_capture items searched (no source filter)
- ✅ History capped at 20 messages
- ✅ Two-panel layout
- ✅ Project filter preserved

**Type consistency check:**
- `ChatSession` Rust struct fields match TS type exactly (snake_case → camelCase via serde)
- `ChatMessage` same
- `chatWithMemory` TS signature `(sessionId, message, projectId?)` matches Rust `(session_id, message, project_id?)`
- `createChatSession(projectId)` → Rust `create_chat_session(project_id: Option<String>)` ✓
- `load_messages` returns `Vec<ChatMessage>` ordered oldest-first ✓ (subquery reversal in SQL)

**Placeholder check:** None found — all steps have concrete code.
