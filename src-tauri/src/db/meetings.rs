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
}

pub fn insert_meeting(conn: &Connection, m: &MeetingRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meetings (
            item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
            status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only,
            calendar_match_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
        ],
    )?;
    Ok(())
}

pub fn get_meeting(conn: &Connection, item_id: &str) -> Result<Option<MeetingRow>, DbError> {
    conn.query_row(
        "SELECT item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
                status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only,
                calendar_match_json
         FROM meetings WHERE item_id = ?1",
        [item_id],
        row_to_meeting,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn list_meetings(conn: &Connection) -> Result<Vec<MeetingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
                status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only,
                calendar_match_json
         FROM meetings ORDER BY started_at DESC",
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
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
             VALUES ('m-1', 'Test Meeting', 'meeting', 'visible', 'meeting', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')",
            [],
        ).unwrap();
        conn
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
}
