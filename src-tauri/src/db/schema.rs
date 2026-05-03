//! SQLite migration runner for Echo Scribe.
//!
//! We deliberately avoid pulling in `refinery` or another migration crate.
//! The schema is small and stable; we keep an in-code list of versioned
//! `(version, sql)` pairs and apply them sequentially against a
//! `schema_meta(key TEXT PRIMARY KEY, value TEXT)` table. Re-running on a
//! fully-migrated DB is a no-op.

use rusqlite::{Connection, params};

use super::DbError;

/// All migrations, in order. Version numbers are monotonically increasing.
/// Adding a new migration: append a new tuple — never edit existing entries.
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
    (
        3,
        r#"
ALTER TABLE items ADD COLUMN confidence REAL;
ALTER TABLE items ADD COLUMN classified_by TEXT;
"#,
    ),
    (
        4,
        r#"
CREATE TABLE IF NOT EXISTS item_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events(item_id, created_at);
"#,
    ),
    (
        5,
        r#"
CREATE TABLE IF NOT EXISTS item_session_links (
  item_id TEXT NOT NULL REFERENCES items(id),
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_item_session_links_item ON item_session_links(item_id);
CREATE INDEX IF NOT EXISTS idx_item_session_links_session ON item_session_links(session_id);
"#,
    ),
    (
        6,
        r#"
ALTER TABLE items ADD COLUMN capture_context TEXT;
"#,
    ),
];

const META_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

const VERSION_KEY: &str = "schema_version";

/// Run all pending migrations against `conn`. Idempotent.
pub fn run_migrations(conn: &mut Connection) -> Result<(), DbError> {
    conn.execute_batch(META_TABLE_SQL)?;
    let current = current_version(conn)?;
    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![VERSION_KEY, version.to_string()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

fn current_version(conn: &Connection) -> Result<u32, DbError> {
    let row: Result<String, rusqlite::Error> = conn.query_row(
        "SELECT value FROM schema_meta WHERE key = ?1",
        params![VERSION_KEY],
        |r| r.get(0),
    );
    match row {
        Ok(s) => Ok(s.parse().unwrap_or(0)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(other) => Err(other.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();
        // schema_meta should reflect the highest known version.
        let v: String = conn
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "6");
    }

    #[test]
    fn migration_v3_adds_confidence_and_classified_by() {
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

    #[test]
    fn migration_v6_adds_capture_context() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute_batch(
            "SELECT capture_context FROM items LIMIT 0"
        ).expect("capture_context column should exist after migration v6");
    }

    #[test]
    fn migrations_preserve_data_across_reapplication() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO items(id, content, source, visibility, captured_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "01ABC",
                "hello world",
                "voice_at_cursor",
                "hidden",
                "2026-05-01T00:00:00Z",
                "2026-05-01T00:00:00Z"
            ],
        )
        .unwrap();
        run_migrations(&mut conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
