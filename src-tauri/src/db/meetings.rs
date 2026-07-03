use crate::db::DbError;
use crate::meeting::MeetingStatus;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingRow {
    pub item_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub detected_app: Option<String>,
    pub detected_app_name: Option<String>,
    pub status: String,
    pub transcript_json: Option<String>,
    pub summary_json: Option<String>,
    pub user_notes: Option<String>,
    pub failed_chunk_count: i64,
    pub mic_only: bool,
    /// Snapshot of the calendar event that matched this meeting at start /
    /// stop time. Schema is `crate::calendar::CalendarMatch` serialized as
    /// JSON. `None` when no match was found, calendar permission was
    /// denied, or the sidecar timed out.
    #[serde(default)]
    pub calendar_match_json: Option<String>,
    /// Immutable snapshot of the guide template attached to this meeting at
    /// start time (a `crate::db::guide_templates::GuideTemplate` serialized as
    /// JSON). `None` for non-guided meetings. Frozen — later edits to the
    /// template must not rewrite history.
    #[serde(default)]
    pub guide_template_json: Option<String>,
    /// Name of the project this meeting's item is assigned to, resolved via a
    /// LEFT JOIN at read time. `None` when unassigned. Not a stored column —
    /// derived from `items.project_id`, so it reflects later reassignment.
    #[serde(default)]
    pub project_name: Option<String>,
}

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

pub fn get_meeting(conn: &Connection, item_id: &str) -> Result<Option<MeetingRow>, DbError> {
    conn.query_row(
        "SELECT m.item_id, m.started_at, m.ended_at, m.duration_ms, m.detected_app, m.detected_app_name,
                m.status, m.transcript_json, m.summary_json, m.user_notes, m.failed_chunk_count, m.mic_only,
                m.calendar_match_json, m.guide_template_json, p.name
         FROM meetings m
         JOIN items i ON i.id = m.item_id
         LEFT JOIN projects p ON p.id = i.project_id
         WHERE m.item_id = ?1",
        [item_id],
        row_to_meeting,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn list_meetings(conn: &Connection) -> Result<Vec<MeetingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT m.item_id, m.started_at, m.ended_at, m.duration_ms, m.detected_app, m.detected_app_name,
                m.status, m.transcript_json, m.summary_json, m.user_notes, m.failed_chunk_count, m.mic_only,
                m.calendar_match_json, m.guide_template_json, p.name
         FROM meetings m
         JOIN items i ON i.id = m.item_id
         LEFT JOIN projects p ON p.id = i.project_id
         ORDER BY m.started_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_meeting)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Update the calendar match snapshot on an existing meeting row. Used both
/// at meeting stop (after the second sidecar query refines the match) and
/// from the UI's "Wrong match?" override.
pub fn update_calendar_match(
    conn: &Connection,
    item_id: &str,
    calendar_match_json: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET calendar_match_json = ?1 WHERE item_id = ?2",
        params![calendar_match_json, item_id],
    )?;
    Ok(())
}

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
        Some(Ok(other)) => {
            tracing::warn!(target: "guide", item_id, kind = %other.to_string().chars().take(40).collect::<String>(), "existing guide_template_json neither array nor object; discarding");
            Vec::new()
        }
        Some(Err(e)) => {
            tracing::warn!(target: "guide", item_id, error = %e, "existing guide_template_json unparseable; discarding");
            Vec::new()
        }
        None => Vec::new(),
    };
    arr.push(snapshot.clone());
    conn.execute(
        "UPDATE meetings SET guide_template_json = ?1 WHERE item_id = ?2",
        params![serde_json::Value::Array(arr).to_string(), item_id],
    )?;
    Ok(())
}

pub fn update_status(conn: &Connection, item_id: &str, status: MeetingStatus) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET status = ?1 WHERE item_id = ?2",
        params![status.as_str(), item_id],
    )?;
    Ok(())
}

pub fn finalize_meeting(
    conn: &Connection,
    item_id: &str,
    ended_at: &str,
    duration_ms: i64,
    transcript_json: &str,
    summary_json: Option<&str>,
    failed_chunk_count: i64,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET
            ended_at = ?1,
            duration_ms = ?2,
            transcript_json = ?3,
            summary_json = ?4,
            failed_chunk_count = ?5,
            status = 'complete'
         WHERE item_id = ?6",
        params![ended_at, duration_ms, transcript_json, summary_json, failed_chunk_count, item_id],
    )?;
    Ok(())
}

pub fn update_user_notes(conn: &Connection, item_id: &str, notes: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET user_notes = ?1 WHERE item_id = ?2",
        params![notes, item_id],
    )?;
    Ok(())
}

pub fn link_action(conn: &Connection, meeting_id: &str, item_id: &str, created_at: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR IGNORE INTO meeting_action_links (meeting_id, item_id, created_at)
         VALUES (?1, ?2, ?3)",
        params![meeting_id, item_id, created_at],
    )?;
    Ok(())
}

pub fn delete_meeting(conn: &Connection, item_id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM meetings WHERE item_id = ?1", [item_id])?;
    Ok(())
}

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
        project_name: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        let conn = conn;
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES ('m-1', 'Test Meeting', 'meeting', 'meeting', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')",
            [],
        ).unwrap();
        conn
    }

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn insert_test_meeting(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES (?1, 'Test Meeting', 'meeting', 'meeting', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')",
            [id],
        ).unwrap();
        let row = MeetingRow {
            item_id: id.into(),
            started_at: "2026-05-03T00:00:00Z".into(),
            ended_at: None,
            duration_ms: None,
            detected_app: None,
            detected_app_name: None,
            status: "recording".into(),
            transcript_json: None,
            summary_json: None,
            user_notes: None,
            failed_chunk_count: 0,
            mic_only: false,
            calendar_match_json: None,
            guide_template_json: None,
            project_name: None,
        };
        insert_meeting(conn, &row).unwrap();
    }

    fn sample() -> MeetingRow {
        MeetingRow {
            item_id: "m-1".into(),
            started_at: "2026-05-03T00:00:00Z".into(),
            ended_at: None,
            duration_ms: None,
            detected_app: Some("us.zoom.xos".into()),
            detected_app_name: Some("Zoom".into()),
            status: "recording".into(),
            transcript_json: None,
            summary_json: None,
            user_notes: None,
            failed_chunk_count: 0,
            mic_only: false,
            calendar_match_json: None,
            guide_template_json: None,
            project_name: None,
        }
    }

    #[test]
    fn insert_and_get_round_trip() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.item_id, "m-1");
        assert_eq!(got.detected_app_name.as_deref(), Some("Zoom"));
        assert_eq!(got.status, "recording");
    }

    #[test]
    fn update_status_changes_row() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        update_status(&conn, "m-1", MeetingStatus::Transcribing).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.status, "transcribing");
    }

    #[test]
    fn calendar_match_round_trip() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        let cm = r#"{"title":"Standup","match_score":0.9}"#;
        update_calendar_match(&conn, "m-1", Some(cm)).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.calendar_match_json.as_deref(), Some(cm));

        // Clearing back to None.
        update_calendar_match(&conn, "m-1", None).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert!(got.calendar_match_json.is_none());
    }

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

    #[test]
    fn finalize_writes_all_fields() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        finalize_meeting(
            &conn,
            "m-1",
            "2026-05-03T00:30:00Z",
            1_800_000,
            r#"{"segments":[]}"#,
            Some(r#"{"summary":["x"]}"#),
            0,
        )
        .unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.duration_ms, Some(1_800_000));
        assert_eq!(got.status, "complete");
        assert_eq!(got.transcript_json.as_deref(), Some(r#"{"segments":[]}"#));
    }

    #[test]
    fn append_snapshot_starts_array() {
        let c = fresh();
        insert_test_meeting(&c, "m1");
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
}
