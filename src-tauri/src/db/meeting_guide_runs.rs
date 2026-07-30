//! CRUD for `meeting_guide_runs`: one row per guide attached to a meeting.
//! A row is created at guide-attach time (`status = "pending"`), its timeline
//! is flushed at meeting stop, and its review is filled in by a background
//! job (`status` → "ready" | "failed"). Mirrors `db/guide_templates.rs`.

use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GuideRunRow {
    pub id: String,
    pub meeting_id: String,
    pub template_id: String,
    pub template_name: String,
    pub template_json: String,
    pub slot: i64,
    pub started_at: String,
    pub timeline_json: Option<String>,
    pub review_json: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub generated_at: Option<String>,
    pub created_at: String,
    pub run_kind: String,
    pub insight_kind: String,
    pub subject_scope: String,
    pub transcript_hash: String,
}

const COLS: &str = "id, meeting_id, template_id, template_name, template_json, slot, \
started_at, timeline_json, review_json, status, error, generated_at, created_at, \
run_kind, insight_kind, subject_scope, transcript_hash";

const QUALIFIED_COLS: &str =
    "r.id, r.meeting_id, r.template_id, r.template_name, r.template_json, r.slot, \
r.started_at, r.timeline_json, r.review_json, r.status, r.error, r.generated_at, r.created_at, \
r.run_kind, r.insight_kind, r.subject_scope, r.transcript_hash";

fn row_to_run(row: &Row<'_>) -> rusqlite::Result<GuideRunRow> {
    Ok(GuideRunRow {
        id: row.get("id")?,
        meeting_id: row.get("meeting_id")?,
        template_id: row.get("template_id")?,
        template_name: row.get("template_name")?,
        template_json: row.get("template_json")?,
        slot: row.get("slot")?,
        started_at: row.get("started_at")?,
        timeline_json: row.get("timeline_json")?,
        review_json: row.get("review_json")?,
        status: row.get("status")?,
        error: row.get("error")?,
        generated_at: row.get("generated_at")?,
        created_at: row.get("created_at")?,
        run_kind: row.get("run_kind")?,
        insight_kind: row.get("insight_kind")?,
        subject_scope: row.get("subject_scope")?,
        transcript_hash: row.get("transcript_hash")?,
    })
}

pub fn insert_guide_run(conn: &Connection, r: &GuideRunRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meeting_guide_runs
            (id, meeting_id, template_id, template_name, template_json, slot,
             started_at, timeline_json, review_json, status, error, generated_at, created_at,
             run_kind, insight_kind, subject_scope, transcript_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            r.id,
            r.meeting_id,
            r.template_id,
            r.template_name,
            r.template_json,
            r.slot,
            r.started_at,
            r.timeline_json,
            r.review_json,
            r.status,
            r.error,
            r.generated_at,
            r.created_at,
            r.run_kind,
            r.insight_kind,
            r.subject_scope,
            r.transcript_hash,
        ],
    )?;
    Ok(())
}

pub fn update_guide_run_timeline(
    conn: &Connection,
    id: &str,
    timeline_json: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs SET timeline_json = ?1 WHERE id = ?2",
        params![timeline_json, id],
    )?;
    Ok(())
}

pub fn update_guide_run_review(
    conn: &Connection,
    id: &str,
    review_json: Option<&str>,
    status: &str,
    generated_at: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs SET review_json = ?1, status = ?2, generated_at = ?3, error = NULL WHERE id = ?4",
        params![review_json, status, generated_at, id],
    )?;
    Ok(())
}

/// Persist a validated review and the transcript fingerprint it was derived
/// from in one write, so proof can never appear current for another transcript.
pub fn complete_guide_run_review(
    conn: &Connection,
    id: &str,
    review_json: &str,
    generated_at: &str,
    transcript_hash: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs
         SET review_json=?1, status='ready', generated_at=?2,
             transcript_hash=?3, error=NULL
         WHERE id=?4",
        params![review_json, generated_at, transcript_hash, id],
    )?;
    Ok(())
}

pub fn update_guide_run_analysis_contract(
    conn: &Connection,
    id: &str,
    run_kind: &str,
    insight_kind: &str,
    subject_scope: &str,
    transcript_hash: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs
         SET run_kind=?1, insight_kind=?2, subject_scope=?3, transcript_hash=?4
         WHERE id=?5",
        params![run_kind, insight_kind, subject_scope, transcript_hash, id],
    )?;
    Ok(())
}

pub fn set_guide_run_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meeting_guide_runs SET status = ?1, error = ?2 WHERE id = ?3",
        params![status, error, id],
    )?;
    Ok(())
}

/// Mark as `failed` any guide runs still `pending` whose meeting has already
/// completed — these were interrupted (app quit/crash) between meeting stop and
/// the background review finishing. Lets the UI's Retry path recover them.
/// Returns the number of rows reaped.
pub fn fail_interrupted_pending_runs(conn: &Connection) -> Result<usize, DbError> {
    let n = conn.execute(
        "UPDATE meeting_guide_runs
         SET status = 'failed', error = 'interrupted before review completed'
         WHERE status = 'pending'
           AND meeting_id IN (SELECT item_id FROM meetings WHERE status = 'complete')",
        [],
    )?;
    Ok(n)
}

pub fn get_guide_run(conn: &Connection, id: &str) -> Result<Option<GuideRunRow>, DbError> {
    conn.query_row(
        &format!("SELECT {COLS} FROM meeting_guide_runs WHERE id = ?1"),
        [id],
        row_to_run,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn list_guide_runs_for_meeting(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<GuideRunRow>, DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM meeting_guide_runs WHERE meeting_id = ?1 ORDER BY slot ASC"
    ))?;
    let rows = stmt
        .query_map([meeting_id], row_to_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_guide_runs_for_template(
    conn: &Connection,
    template_id: &str,
    limit: i64,
) -> Result<Vec<GuideRunRow>, DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM meeting_guide_runs
         WHERE template_id = ?1 AND status = 'ready'
         ORDER BY started_at DESC LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![template_id, limit], row_to_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn has_run_for_meeting_template(
    conn: &Connection,
    meeting_id: &str,
    template_id: &str,
) -> Result<bool, DbError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM meeting_guide_runs WHERE meeting_id=?1 AND template_id=?2",
        params![meeting_id, template_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Runs shown in Daily recap are independently controlled by the template's
/// tracking configuration. Attached guides that are not opted in never leak
/// into the recap, and chat/notes are not part of this query.
pub fn list_daily_insight_runs(conn: &Connection, date: &str) -> Result<Vec<GuideRunRow>, DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {QUALIFIED_COLS}
         FROM meeting_guide_runs r
         JOIN guide_template_insight_settings c ON c.template_id=r.template_id
         WHERE c.enabled=1 AND c.show_in_daily_recap=1
           AND substr(r.started_at, 1, 10)=?1
         ORDER BY r.started_at DESC, r.template_name COLLATE NOCASE"
    ))?;
    let rows = stmt
        .query_map([date], row_to_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        // Disable foreign_keys for tests so we can insert without parent rows.
        conn.pragma_update(None, "foreign_keys", &"OFF").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make(id: &str, meeting: &str) -> GuideRunRow {
        GuideRunRow {
            id: id.into(),
            meeting_id: meeting.into(),
            template_id: "builtin-leadership".into(),
            template_name: "Leadership presence".into(),
            template_json: r#"{"goal":"g","notes":"a\nb"}"#.into(),
            slot: 0,
            started_at: "2026-07-08T16:19:08Z".into(),
            timeline_json: None,
            review_json: None,
            status: "pending".into(),
            error: None,
            generated_at: None,
            created_at: "2026-07-08T16:19:08Z".into(),
            run_kind: "attached".into(),
            insight_kind: "rubric".into(),
            subject_scope: "you".into(),
            transcript_hash: String::new(),
        }
    }

    #[test]
    fn insert_get_round_trip() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        assert_eq!(get_guide_run(&c, "r1").unwrap().unwrap(), make("r1", "m1"));
    }

    #[test]
    fn update_timeline_then_review_transitions_status() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        update_guide_run_timeline(&c, "r1", Some("[]")).unwrap();
        update_guide_run_review(
            &c,
            "r1",
            Some(r#"{"overall":"mixed"}"#),
            "ready",
            Some("2026-07-08T17:00:00Z"),
        )
        .unwrap();
        let got = get_guide_run(&c, "r1").unwrap().unwrap();
        assert_eq!(got.timeline_json.as_deref(), Some("[]"));
        assert_eq!(got.status, "ready");
        assert_eq!(got.review_json.as_deref(), Some(r#"{"overall":"mixed"}"#));
        assert_eq!(got.generated_at.as_deref(), Some("2026-07-08T17:00:00Z"));
    }

    #[test]
    fn set_status_failed_records_error() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        set_guide_run_status(&c, "r1", "failed", Some("boom")).unwrap();
        let got = get_guide_run(&c, "r1").unwrap().unwrap();
        assert_eq!(got.status, "failed");
        assert_eq!(got.error.as_deref(), Some("boom"));
    }

    #[test]
    fn list_for_meeting_orders_by_slot() {
        let c = fresh();
        let mut a = make("r2", "m1");
        a.slot = 1;
        insert_guide_run(&c, &a).unwrap();
        insert_guide_run(&c, &make("r1", "m1")).unwrap(); // slot 0
        let rows = list_guide_runs_for_meeting(&c, "m1").unwrap();
        assert_eq!(rows.iter().map(|r| r.slot).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn list_for_template_only_ready_desc() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap(); // pending — excluded
        let mut ready = make("r2", "m2");
        ready.status = "ready".into();
        ready.started_at = "2026-07-09T00:00:00Z".into();
        insert_guide_run(&c, &ready).unwrap();
        let rows = list_guide_runs_for_template(&c, "builtin-leadership", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r2");
    }

    #[test]
    fn detects_existing_meeting_template_run() {
        let c = fresh();
        insert_guide_run(&c, &make("r1", "m1")).unwrap();
        assert!(has_run_for_meeting_template(&c, "m1", "builtin-leadership").unwrap());
        assert!(!has_run_for_meeting_template(&c, "m2", "builtin-leadership").unwrap());
    }

    #[test]
    fn daily_insights_require_enabled_recap_config_and_matching_day() {
        let c = fresh();
        let mut visible = make("r-visible", "m1");
        visible.template_id = "builtin-emotional-signals".into();
        visible.template_name = "Conversation signals".into();
        visible.started_at = "2026-07-08T23:00:00Z".into();
        insert_guide_run(&c, &visible).unwrap();
        let mut other_day = visible.clone();
        other_day.id = "r-other".into();
        other_day.meeting_id = "m2".into();
        other_day.started_at = "2026-07-09T00:00:00Z".into();
        insert_guide_run(&c, &other_day).unwrap();

        let hidden = list_daily_insight_runs(&c, "2026-07-08").unwrap();
        assert!(hidden.is_empty());
        c.execute(
            "INSERT INTO guide_template_insight_settings
              (template_id,enabled,show_in_daily_recap,insight_kind,subject_scope,updated_at)
             VALUES ('builtin-emotional-signals',1,1,'signals','interaction','2026-07-08T00:00:00Z')",
            [],
        )
        .unwrap();
        let rows = list_daily_insight_runs(&c, "2026-07-08").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "r-visible");
    }

    #[test]
    fn fail_interrupted_pending_runs_only_touches_completed_meetings() {
        let c = fresh();
        // Two meetings: one complete, one still recording.
        c.execute(
            "INSERT INTO meetings (item_id, started_at, status, failed_chunk_count, mic_only)
             VALUES ('m-done', '2026-07-08T00:00:00Z', 'complete', 0, 0),
                    ('m-live', '2026-07-08T00:00:00Z', 'recording', 0, 0)",
            [],
        )
        .unwrap();
        // A pending run under each, plus a ready run under the complete one.
        insert_guide_run(&c, &make("r-done-pending", "m-done")).unwrap();
        insert_guide_run(&c, &make("r-live-pending", "m-live")).unwrap();
        let mut ready = make("r-done-ready", "m-done");
        ready.status = "ready".into();
        insert_guide_run(&c, &ready).unwrap();

        let n = fail_interrupted_pending_runs(&c).unwrap();
        assert_eq!(n, 1); // only r-done-pending
        assert_eq!(
            get_guide_run(&c, "r-done-pending").unwrap().unwrap().status,
            "failed"
        );
        assert_eq!(
            get_guide_run(&c, "r-done-pending")
                .unwrap()
                .unwrap()
                .error
                .as_deref(),
            Some("interrupted before review completed")
        );
        assert_eq!(
            get_guide_run(&c, "r-live-pending").unwrap().unwrap().status,
            "pending"
        ); // untouched
        assert_eq!(
            get_guide_run(&c, "r-done-ready").unwrap().unwrap().status,
            "ready"
        ); // untouched
    }
}
