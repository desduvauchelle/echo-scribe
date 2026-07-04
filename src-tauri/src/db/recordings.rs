use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingRow {
    pub id: String,
    pub created_at: i64,
    pub file_path: String,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub size_bytes: Option<i64>,
    pub source_label: Option<String>,
    pub has_mic: bool,
    pub has_sysaudio: bool,
    pub thumb_path: Option<String>,
    pub drive_file_id: Option<String>,
    pub drive_link: Option<String>,
    pub upload_status: String,
    pub upload_error: Option<String>,
    /// JSON array of export variants: `[{"quality":"1080","path":"...","size":123}]`.
    pub exports: String,
    /// User-assigned display name; falls back to `source_label` when `None`.
    pub title: Option<String>,
    /// Cached plain-text transcript; `None` until generated on demand.
    pub transcript: Option<String>,
    /// Path to the denoised MP4 (separate file). `None` until cleaned.
    pub denoised_path: Option<String>,
    /// Path to the recorded input-events JSONL sidecar file. `None` if the
    /// sidecar didn't report one (e.g. the no-frames abort path).
    pub events_path: Option<String>,
}

pub fn insert(conn: &Connection, r: &RecordingRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO recordings (
            id, created_at, file_path, duration_ms, width, height, size_bytes,
            source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
            drive_link, upload_status, upload_error, exports, title, transcript,
            denoised_path, events_path
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            r.id,
            r.created_at,
            r.file_path,
            r.duration_ms,
            r.width,
            r.height,
            r.size_bytes,
            r.source_label,
            r.has_mic as i64,
            r.has_sysaudio as i64,
            r.thumb_path,
            r.drive_file_id,
            r.drive_link,
            r.upload_status,
            r.upload_error,
            r.exports,
            r.title,
            r.transcript,
            r.denoised_path,
            r.events_path,
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<RecordingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, created_at, file_path, duration_ms, width, height, size_bytes,
                source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
                drive_link, upload_status, upload_error, exports, title, transcript,
                denoised_path, events_path
         FROM recordings
         ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_recording)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<RecordingRow>, DbError> {
    conn.query_row(
        "SELECT id, created_at, file_path, duration_ms, width, height, size_bytes,
                source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
                drive_link, upload_status, upload_error, exports, title, transcript,
                denoised_path, events_path
         FROM recordings WHERE id = ?1",
        [id],
        row_to_recording,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM recordings WHERE id = ?1", [id])?;
    Ok(())
}

pub fn update_exports(conn: &Connection, id: &str, exports_json: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET exports = ?2 WHERE id = ?1",
        params![id, exports_json],
    )?;
    Ok(())
}

pub fn update_upload_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET upload_status = ?2, upload_error = ?3 WHERE id = ?1",
        params![id, status, error],
    )?;
    Ok(())
}

/// Record a successful upload: stores the file id + link and sets status `done`.
pub fn update_drive_link(
    conn: &Connection,
    id: &str,
    file_id: &str,
    link: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings
           SET drive_file_id = ?2, drive_link = ?3, upload_status = 'done', upload_error = NULL
         WHERE id = ?1",
        params![id, file_id, link],
    )?;
    Ok(())
}

/// Set the user-assigned display name for a recording.
pub fn rename(conn: &Connection, id: &str, title: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

/// Store the generated transcript text for a recording.
pub fn set_transcript(conn: &Connection, id: &str, transcript: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET transcript = ?1 WHERE id = ?2",
        params![transcript, id],
    )?;
    Ok(())
}

/// Set or clear the denoised-file path for a recording.
pub fn set_denoised_path(conn: &Connection, id: &str, path: Option<&str>) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET denoised_path = ?1 WHERE id = ?2",
        params![path, id],
    )?;
    Ok(())
}

/// Promote the cleaned file to be the recording's primary file and clear the
/// denoised marker. Used when the original is deleted after denoise.
pub fn promote_denoised(conn: &Connection, id: &str, cleaned_path: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET file_path = ?1, denoised_path = NULL WHERE id = ?2",
        params![cleaned_path, id],
    )?;
    Ok(())
}

fn row_to_recording(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecordingRow> {
    Ok(RecordingRow {
        id: row.get(0)?,
        created_at: row.get(1)?,
        file_path: row.get(2)?,
        duration_ms: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
        size_bytes: row.get(6)?,
        source_label: row.get(7)?,
        has_mic: row.get::<_, i64>(8)? != 0,
        has_sysaudio: row.get::<_, i64>(9)? != 0,
        thumb_path: row.get(10)?,
        drive_file_id: row.get(11)?,
        drive_link: row.get(12)?,
        upload_status: row.get(13)?,
        upload_error: row.get(14)?,
        exports: row.get(15)?,
        title: row.get(16)?,
        transcript: row.get(17)?,
        denoised_path: row.get(18)?,
        events_path: row.get(19)?,
    })
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

    fn sample() -> RecordingRow {
        RecordingRow {
            id: "rec-1".into(),
            created_at: 1_716_300_000_000,
            file_path: "/tmp/rec-1.mp4".into(),
            duration_ms: Some(4000),
            width: Some(3456),
            height: Some(2234),
            size_bytes: Some(1_234_567),
            source_label: Some("Entire screen".into()),
            has_mic: false,
            has_sysaudio: true,
            thumb_path: Some("/tmp/rec-1.jpg".into()),
            drive_file_id: None,
            drive_link: None,
            upload_status: "none".into(),
            upload_error: None,
            exports: "[]".into(),
            title: None,
            transcript: None,
            denoised_path: None,
            events_path: None,
        }
    }

    #[test]
    fn migration_creates_recordings_table() {
        let conn = setup();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='recordings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn insert_list_delete_round_trip() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "rec-1");
        assert_eq!(rows[0].source_label.as_deref(), Some("Entire screen"));
        assert!(rows[0].has_sysaudio);
        assert!(!rows[0].has_mic);

        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.file_path, "/tmp/rec-1.mp4");

        delete(&conn, "rec-1").unwrap();
        assert!(list(&conn).unwrap().is_empty());
        assert!(get(&conn, "rec-1").unwrap().is_none());
    }

    #[test]
    fn rename_updates_title() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().title, None);

        rename(&conn, "rec-1", "Demo walkthrough").unwrap();
        assert_eq!(
            get(&conn, "rec-1").unwrap().unwrap().title.as_deref(),
            Some("Demo walkthrough")
        );
    }

    #[test]
    fn set_transcript_round_trip() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().transcript, None);

        set_transcript(&conn, "rec-1", "hello world").unwrap();
        assert_eq!(
            get(&conn, "rec-1").unwrap().unwrap().transcript.as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn set_and_promote_denoised() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().denoised_path, None);

        set_denoised_path(&conn, "rec-1", Some("/tmp/rec-1.cleaned.mp4")).unwrap();
        assert_eq!(
            get(&conn, "rec-1").unwrap().unwrap().denoised_path.as_deref(),
            Some("/tmp/rec-1.cleaned.mp4")
        );

        promote_denoised(&conn, "rec-1", "/tmp/rec-1.cleaned.mp4").unwrap();
        let row = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(row.file_path, "/tmp/rec-1.cleaned.mp4");
        assert_eq!(row.denoised_path, None);

        set_denoised_path(&conn, "rec-1", None).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().denoised_path, None);
    }

    #[test]
    fn update_exports_persists_json() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        let json = r#"[{"quality":"720","path":"/tmp/rec-1-720.mp4","size":4242}]"#;
        update_exports(&conn, "rec-1", json).unwrap();
        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.exports, json);
    }

    #[test]
    fn events_path_round_trip() {
        let conn = setup();
        let mut r = sample();
        r.id = "rec-ev".into();
        r.events_path = Some("/r/rec-ev.events.jsonl".into());
        insert(&conn, &r).unwrap();
        let got = get(&conn, "rec-ev").unwrap().unwrap();
        assert_eq!(got.events_path.as_deref(), Some("/r/rec-ev.events.jsonl"));
    }

    #[test]
    fn update_upload_status_and_link_round_trip() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();

        update_upload_status(&conn, "rec-1", "uploading", None).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().upload_status, "uploading");

        update_drive_link(&conn, "rec-1", "fid-9", "https://drive.example/abc").unwrap();
        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.drive_file_id.as_deref(), Some("fid-9"));
        assert_eq!(got.drive_link.as_deref(), Some("https://drive.example/abc"));
        assert_eq!(got.upload_status, "done");

        update_upload_status(&conn, "rec-1", "error", Some("network")).unwrap();
        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.upload_status, "error");
        assert_eq!(got.upload_error.as_deref(), Some("network"));
    }
}
