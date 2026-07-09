//! Persistent queue for deferred project auto-tagging.

use rusqlite::{params, Connection};

use crate::db::items::ItemSource;
use crate::db::DbError;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_DEFERRED: &str = "deferred";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";

/// Job targets: `item_id` points at either an `items` row or a `recordings`
/// row depending on `target`.
pub const TARGET_ITEM: &str = "item";
pub const TARGET_RECORDING: &str = "recording";

#[derive(Debug, Clone, Copy, Default, serde::Serialize, PartialEq, Eq)]
pub struct ProjectTagJobCounts {
    pub pending: u32,
    pub deferred: u32,
    pub done: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct ProjectTagJob {
    pub item_id: String,
    pub target: String,
    pub status: String,
    pub attempts: u32,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn enqueue(conn: &Connection, item_id: &str, now_iso: &str) -> Result<(), DbError> {
    enqueue_target(conn, item_id, TARGET_ITEM, now_iso)
}

pub fn enqueue_recording(conn: &Connection, recording_id: &str, now_iso: &str) -> Result<(), DbError> {
    enqueue_target(conn, recording_id, TARGET_RECORDING, now_iso)
}

fn enqueue_target(
    conn: &Connection,
    id: &str,
    target: &str,
    now_iso: &str,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR IGNORE INTO project_tag_jobs
            (item_id, target, status, attempts, next_run_at, last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4, ?4)",
        params![id, target, STATUS_PENDING, now_iso],
    )?;
    Ok(())
}

/// Re-open a done/failed job so its target gets reconsidered. Used when a
/// recording's transcript arrives after the job already ran on title alone.
pub fn reopen(conn: &Connection, id: &str, now_iso: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE project_tag_jobs
            SET status = ?1, next_run_at = NULL, last_error = NULL, updated_at = ?2
          WHERE item_id = ?3",
        params![STATUS_PENDING, now_iso, id],
    )?;
    Ok(())
}

pub fn enqueue_backfill(
    conn: &Connection,
    source: Option<ItemSource>,
    limit: u32,
    now_iso: &str,
) -> Result<u32, DbError> {
    let limit = limit.clamp(1, 10_000);
    let source = source.unwrap_or(ItemSource::VoiceAtCursor);
    let mut stmt = conn.prepare(
        "SELECT id
           FROM items
          WHERE deleted_at IS NULL
            AND project_id IS NULL
            AND source = ?1
            AND id NOT IN (SELECT item_id FROM project_tag_jobs)
          ORDER BY captured_at DESC
          LIMIT ?2",
    )?;
    let ids = stmt
        .query_map(params![source.as_str(), limit as i64], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for id in &ids {
        enqueue(conn, id, now_iso)?;
    }
    Ok(ids.len() as u32)
}

/// Enqueue every untagged capture — items of all sources/kinds plus
/// recordings — that isn't already in the queue. Returns how many jobs were
/// added.
pub fn enqueue_backfill_all(conn: &Connection, now_iso: &str) -> Result<u32, DbError> {
    let mut added = 0u32;
    {
        let mut stmt = conn.prepare(
            "SELECT id
               FROM items
              WHERE deleted_at IS NULL
                AND project_id IS NULL
                AND id NOT IN (SELECT item_id FROM project_tag_jobs)
              ORDER BY captured_at DESC",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for id in &ids {
            enqueue(conn, id, now_iso)?;
            added += 1;
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id
               FROM recordings
              WHERE project_id IS NULL
                AND id NOT IN (SELECT item_id FROM project_tag_jobs)
              ORDER BY created_at DESC",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for id in &ids {
            enqueue_recording(conn, id, now_iso)?;
            added += 1;
        }
    }
    Ok(added)
}

pub fn list_runnable(
    conn: &Connection,
    limit: u32,
    now_iso: &str,
) -> Result<Vec<ProjectTagJob>, DbError> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT item_id, target, status, attempts, next_run_at, last_error, created_at, updated_at
           FROM project_tag_jobs
          WHERE status = ?1
             OR (status = ?2 AND (next_run_at IS NULL OR next_run_at <= ?3))
          ORDER BY created_at ASC
          LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![STATUS_PENDING, STATUS_DEFERRED, now_iso, limit as i64],
        |r| {
            Ok(ProjectTagJob {
                item_id: r.get("item_id")?,
                target: r.get("target")?,
                status: r.get("status")?,
                attempts: r.get::<_, i64>("attempts")?.max(0) as u32,
                next_run_at: r.get("next_run_at")?,
                last_error: r.get("last_error")?,
                created_at: r.get("created_at")?,
                updated_at: r.get("updated_at")?,
            })
        },
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// How many jobs are runnable right now (pending, or deferred past their
/// retry time). Drives the manual full run's progress denominator.
pub fn count_runnable(conn: &Connection, now_iso: &str) -> Result<u32, DbError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM project_tag_jobs
          WHERE status = ?1
             OR (status = ?2 AND (next_run_at IS NULL OR next_run_at <= ?3))",
        params![STATUS_PENDING, STATUS_DEFERRED, now_iso],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u32)
}

pub fn mark_done(conn: &Connection, item_id: &str, now_iso: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE project_tag_jobs
            SET status = ?1, last_error = NULL, updated_at = ?2
          WHERE item_id = ?3",
        params![STATUS_DONE, now_iso, item_id],
    )?;
    Ok(())
}

pub fn defer(
    conn: &Connection,
    item_id: &str,
    next_run_at: Option<&str>,
    error: Option<&str>,
    now_iso: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE project_tag_jobs
            SET status = ?1,
                attempts = attempts + 1,
                next_run_at = ?2,
                last_error = ?3,
                updated_at = ?4
          WHERE item_id = ?5",
        params![STATUS_DEFERRED, next_run_at, error, now_iso, item_id],
    )?;
    Ok(())
}

pub fn mark_failed(
    conn: &Connection,
    item_id: &str,
    error: &str,
    now_iso: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE project_tag_jobs
            SET status = ?1,
                attempts = attempts + 1,
                last_error = ?2,
                updated_at = ?3
          WHERE item_id = ?4",
        params![STATUS_FAILED, error, now_iso, item_id],
    )?;
    Ok(())
}

pub fn counts(conn: &Connection) -> Result<ProjectTagJobCounts, DbError> {
    let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM project_tag_jobs GROUP BY status")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut counts = ProjectTagJobCounts::default();
    for row in rows {
        let (status, n) = row?;
        let n = n.max(0) as u32;
        match status.as_str() {
            STATUS_PENDING => counts.pending = n,
            STATUS_DEFERRED => counts.deferred = n,
            STATUS_DONE => counts.done = n,
            STATUS_FAILED => counts.failed = n,
            _ => {}
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::items::{ItemKind, ItemSource};
    use crate::db::schema::run_migrations;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn insert_voice_item(conn: &Connection, id: &str, project_id: Option<&str>, deleted: bool) {
        conn.execute(
            "INSERT INTO items
                (id, content, source, kind, project_id, captured_at, created_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                format!("content {id}"),
                ItemSource::VoiceAtCursor.as_str(),
                ItemKind::Transcription.as_str(),
                project_id,
                "2026-06-25T10:00:00Z",
                "2026-06-25T10:00:00Z",
                if deleted {
                    Some("2026-06-25T11:00:00Z")
                } else {
                    None::<&str>
                },
            ],
        )
        .unwrap();
    }

    #[test]
    fn enqueue_is_idempotent() {
        let conn = fresh_db();
        insert_voice_item(&conn, "item-1", None, false);

        super::enqueue(&conn, "item-1", "2026-06-25T12:00:00Z").unwrap();
        super::enqueue(&conn, "item-1", "2026-06-25T12:05:00Z").unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM project_tag_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn enqueue_recording_does_not_trip_items_foreign_key() {
        // Regression: project_tag_jobs.item_id used to be REFERENCES items(id),
        // so enqueueing a recording id (absent from items) failed with a
        // FOREIGN KEY constraint. Migration 27 dropped that FK.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", &"ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO recordings (id, created_at, file_path) VALUES ('rec-1', 0, '/tmp/rec-1.mp4')",
            [],
        )
        .unwrap();

        super::enqueue_recording(&conn, "rec-1", "2026-06-25T12:00:00Z").unwrap();

        let target: String = conn
            .query_row(
                "SELECT target FROM project_tag_jobs WHERE item_id = 'rec-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(target, super::TARGET_RECORDING);
    }

    #[test]
    fn enqueue_backfill_all_covers_items_and_recordings() {
        let conn = fresh_db();
        insert_voice_item(&conn, "item-1", None, false);
        conn.execute(
            "INSERT INTO recordings (id, created_at, file_path) VALUES ('rec-1', 0, '/tmp/rec-1.mp4')",
            [],
        )
        .unwrap();

        let added = super::enqueue_backfill_all(&conn, "2026-06-25T12:00:00Z").unwrap();

        assert_eq!(added, 2);
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_tag_jobs WHERE target = 'recording'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn enqueue_backfill_only_adds_unassigned_active_voice_rows() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO projects(id, name, created_at) VALUES ('p1', 'Project', '2026-06-25T00:00:00Z')",
            [],
        )
        .unwrap();
        insert_voice_item(&conn, "needs-tag", None, false);
        insert_voice_item(&conn, "has-project", Some("p1"), false);
        insert_voice_item(&conn, "deleted", None, true);
        conn.execute(
            "INSERT INTO items(id, content, source, kind, captured_at, created_at)
             VALUES ('log-1', 'log', 'log_capture', 'note', '2026-06-25T10:00:00Z', '2026-06-25T10:00:00Z')",
            [],
        )
        .unwrap();

        let inserted = super::enqueue_backfill(
            &conn,
            Some(ItemSource::VoiceAtCursor),
            100,
            "2026-06-25T12:00:00Z",
        )
        .unwrap();

        assert_eq!(inserted, 1);
        let item_id: String = conn
            .query_row("SELECT item_id FROM project_tag_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(item_id, "needs-tag");
    }
}
