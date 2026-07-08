//! SQLite migration runner for Echo Scribe.
//!
//! We deliberately avoid pulling in `refinery` or another migration crate.
//! The schema is small and stable; we keep an in-code list of versioned
//! `(version, sql)` pairs and apply them sequentially against a
//! `schema_meta(key TEXT PRIMARY KEY, value TEXT)` table. Re-running on a
//! fully-migrated DB is a no-op.

use rusqlite::{params, Connection};

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
    (
        7,
        r#"
CREATE TABLE IF NOT EXISTS meetings (
  item_id            TEXT PRIMARY KEY REFERENCES items(id),
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  duration_ms        INTEGER,
  detected_app       TEXT,
  detected_app_name  TEXT,
  status             TEXT NOT NULL,
  transcript_json    TEXT,
  summary_json       TEXT,
  user_notes         TEXT,
  failed_chunk_count INTEGER NOT NULL DEFAULT 0,
  mic_only           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

CREATE TABLE IF NOT EXISTS meeting_action_links (
  meeting_id TEXT NOT NULL REFERENCES meetings(item_id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_action_links_item ON meeting_action_links(item_id);
"#,
    ),
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
    (
        11,
        r#"
UPDATE items SET kind = 'transcription'
  WHERE source = 'voice_at_cursor' AND kind IS NULL;
"#,
    ),
    (
        12,
        r#"
DROP INDEX IF EXISTS idx_items_visibility;
ALTER TABLE items DROP COLUMN visibility;
"#,
    ),
    (
        13,
        r#"
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  source_label TEXT,
  has_mic INTEGER NOT NULL DEFAULT 0,
  has_sysaudio INTEGER NOT NULL DEFAULT 1,
  thumb_path TEXT,
  drive_file_id TEXT,
  drive_link TEXT,
  upload_status TEXT NOT NULL DEFAULT 'none',
  upload_error TEXT,
  exports TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC);
"#,
    ),
    (
        14,
        r#"
ALTER TABLE recordings ADD COLUMN title TEXT;
"#,
    ),
    (
        15,
        r#"
ALTER TABLE recordings ADD COLUMN transcript TEXT;
"#,
    ),
    (
        16,
        r#"
ALTER TABLE recordings ADD COLUMN denoised_path TEXT;
"#,
    ),
    (
        17,
        r#"
ALTER TABLE projects ADD COLUMN description TEXT;
ALTER TABLE projects ADD COLUMN keywords TEXT;
ALTER TABLE projects ADD COLUMN color TEXT;
ALTER TABLE projects ADD COLUMN emoji TEXT;
ALTER TABLE projects ADD COLUMN updated_at TEXT;
"#,
    ),
    (
        18,
        r#"
ALTER TABLE projects ADD COLUMN export_folder TEXT;
"#,
    ),
    (
        19,
        r#"
CREATE TABLE IF NOT EXISTS project_tag_jobs (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_tag_jobs_status_next_run
  ON project_tag_jobs(status, next_run_at);
"#,
    ),
    (
        20,
        r#"
ALTER TABLE projects ADD COLUMN routing_aliases TEXT;
ALTER TABLE projects ADD COLUMN routing_app_hints TEXT;
ALTER TABLE projects ADD COLUMN routing_url_hints TEXT;
ALTER TABLE projects ADD COLUMN routing_window_hints TEXT;
ALTER TABLE projects ADD COLUMN routing_positive_examples TEXT;
ALTER TABLE projects ADD COLUMN routing_negative_examples TEXT;
"#,
    ),
    (
        // NOTE: 19 and 20 are claimed by concurrent branches (project auto-tagging /
        // session links). Numbered 21 so this actually runs on DBs already at v20.
        21,
        r#"
CREATE TABLE IF NOT EXISTS embeddings (
  id            TEXT PRIMARY KEY,
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  passage_idx   INTEGER NOT NULL,
  passage_text  TEXT NOT NULL,
  vec           BLOB NOT NULL,
  dim           INTEGER NOT NULL,
  model_id      TEXT NOT NULL,
  project_id    TEXT,
  captured_at   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_source   ON embeddings(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_emb_captured ON embeddings(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_emb_project  ON embeddings(project_id);

CREATE TABLE IF NOT EXISTS embedding_index_state (
  source_kind   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  indexed_at    TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
"#,
    ),
    (
        22,
        r#"
ALTER TABLE recordings ADD COLUMN events_path TEXT;
"#,
    ),
    (
        23,
        r#"
ALTER TABLE recordings ADD COLUMN project_json TEXT;
ALTER TABLE recordings ADD COLUMN webcam_path TEXT;
ALTER TABLE recordings ADD COLUMN cursor_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN webcam_offset_ms INTEGER;
"#,
    ),
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
    (
        // NOTE: 24 is claimed by concurrent WIP (guide-template-review's
        // meeting_guide_runs table, uncommitted in this working tree at the
        // time this was written). Numbered 25 so this actually runs on DBs
        // already at v24 — see migration 21's note for the same pattern.
        25,
        r#"
ALTER TABLE recordings ADD COLUMN n_events INTEGER;
ALTER TABLE recordings ADD COLUMN n_clicks INTEGER;
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
        assert_eq!(v, "25");
    }

    #[test]
    fn migration_v21_creates_embedding_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('embeddings','embedding_index_state')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn migration_v9_adds_calendar_match_json_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(meetings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            cols.iter().any(|c| c == "calendar_match_json"),
            "missing calendar_match_json column; got {:?}",
            cols
        );
    }

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
        for expected in [
            "id",
            "name",
            "description",
            "goal",
            "notes",
            "created_at",
            "updated_at",
        ] {
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
        assert!(
            cols.iter().any(|c| c == "confidence"),
            "missing confidence column; got {:?}",
            cols
        );
        assert!(
            cols.iter().any(|c| c == "classified_by"),
            "missing classified_by column; got {:?}",
            cols
        );
    }

    #[test]
    fn migration_v6_adds_capture_context() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute_batch("SELECT capture_context FROM items LIMIT 0")
            .expect("capture_context column should exist after migration v6");
    }

    #[test]
    fn migrations_preserve_data_across_reapplication() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO items(id, content, source, captured_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "01ABC",
                "hello world",
                "voice_at_cursor",
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

    #[test]
    fn migration_v7_creates_meetings_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('meetings', 'meeting_action_links')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);

        let version: String = conn
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, "25");
    }

    #[test]
    fn migration_v18_adds_project_export_folder_column() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(projects)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            cols.iter().any(|c| c == "export_folder"),
            "projects missing export_folder column; got {cols:?}"
        );
    }

    #[test]
    fn migration_v17_adds_project_metadata_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(projects)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["description", "keywords", "color", "emoji", "updated_at"] {
            assert!(
                cols.iter().any(|c| c == expected),
                "projects missing column {expected}; got {cols:?}"
            );
        }
    }

    #[test]
    fn migration_v23_adds_project_webcam_cursor_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(recordings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in [
            "project_json",
            "webcam_path",
            "cursor_hidden",
            "webcam_offset_ms",
        ] {
            assert!(
                cols.iter().any(|c| c == expected),
                "recordings missing column {expected}; got {cols:?}"
            );
        }
    }

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

    #[test]
    fn migration_v25_adds_n_events_and_n_clicks_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(recordings)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["n_events", "n_clicks"] {
            assert!(
                cols.iter().any(|c| c == expected),
                "recordings missing column {expected}; got {cols:?}"
            );
        }
    }
}
