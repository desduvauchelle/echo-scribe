//! Daily recap pipeline: collector → generator → scheduler.
//!
//! See `docs/superpowers/specs/2026-05-13-daily-recap-design.md`.

pub mod collector;
pub mod generator;
pub mod scheduler;

use std::sync::Arc;

use chrono::Utc;
use serde::Serialize;
use tracing::{error, info};

use crate::db::daily_summaries::{self, DailySummaryRow, SummaryStatus};
use crate::db::{Db, DbError};
use crate::llm::Llm;

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

/// The model id Echo Scribe currently ships. The scheduler uses this when the
/// user hasn't selected a specific LLM in settings; commands that want to
/// honor the user's choice can pass a different id.
pub const DEFAULT_LLM_MODEL_ID: &str = "gemma-4-e2b-it-q4_k_m";

/// Run the pipeline for `date` (a "YYYY-MM-DD" string). Always writes a row
/// to `daily_summaries` (status `generated`, `skipped_empty`, or `failed`)
/// before returning.
///
/// Invoked from both the scheduler and the on-demand command. Idempotent on
/// `daily_summaries.date` (UPSERT under the hood).
pub async fn generate_for_date(
    db: &Db,
    llm: &Arc<Llm>,
    date: &str,
    llm_model_id: &str,
) -> Result<DailySummaryResult, DbError> {
    // 1. Sync: collect input.
    let date_owned = date.to_string();
    let input = db.with_conn(|conn| {
        collector::collect(conn, &date_owned).map_err(DbError::from)
    })?;

    let now = Utc::now().to_rfc3339();
    let model_version = format!("{}@{}", llm_model_id, generator::prompt_version());

    info!(
        date = %date,
        meetings = input.meetings.len(),
        notes = input.notes.len(),
        dictation_apps = input.dictations_by_app.len(),
        dictations = input.dictations_by_app.iter().map(|(_, v)| v.len()).sum::<usize>(),
        model_version = %model_version,
        "daily_summary: starting generation"
    );

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
        db.with_conn(|conn| daily_summaries::upsert(conn, &row).map_err(DbError::from))?;
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

    // 2. Async: call LLM.
    match generator::generate(llm, &input).await {
        Ok(out) => {
            info!(
                date = %date,
                narrative_len = out.narrative.len(),
                meetings_bullets = out.sections.meetings.len(),
                focus_work_bullets = out.sections.focus_work.len(),
                notes_bullets = out.sections.notes.len(),
                things_bullets = out.sections.things_that_came_up.len(),
                "daily_summary: generated"
            );
            let row = DailySummaryRow {
                date: date.into(),
                generated_at: now,
                status: SummaryStatus::Generated,
                narrative: out.narrative,
                sections_json: serde_json::to_string(&out.sections).unwrap_or_else(|_| "{}".into()),
                source_meeting_ids_json: serde_json::to_string(&meeting_ids)
                    .unwrap_or_else(|_| "[]".into()),
                source_item_ids_json: serde_json::to_string(&item_ids)
                    .unwrap_or_else(|_| "[]".into()),
                model_version,
                input_token_count: None,
            };
            db.with_conn(|conn| daily_summaries::upsert(conn, &row).map_err(DbError::from))?;
            Ok(DailySummaryResult::Generated { date: date.into() })
        }
        Err(e) => {
            let reason = e.to_string();
            error!(date = %date, reason = %reason, "daily_summary: generation failed");
            // Persist the reason in the narrative field so it's visible from the DB
            // and surfaces in the Daily view's failed state (debugging aid).
            let row = DailySummaryRow {
                date: date.into(),
                generated_at: now,
                status: SummaryStatus::Failed,
                narrative: format!("Generation failed: {reason}"),
                sections_json: "{}".into(),
                source_meeting_ids_json: serde_json::to_string(&meeting_ids)
                    .unwrap_or_else(|_| "[]".into()),
                source_item_ids_json: serde_json::to_string(&item_ids)
                    .unwrap_or_else(|_| "[]".into()),
                model_version,
                input_token_count: None,
            };
            db.with_conn(|conn| daily_summaries::upsert(conn, &row).map_err(DbError::from))?;
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
    use rusqlite::{params, Connection};

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn empty_day_input_writes_skipped_row_without_invoking_llm() {
        // We don't construct a real Llm here. We exercise the same row shape
        // the orchestrator would write on the empty path, against the same
        // schema, to cover the on-disk contract.
        let conn = setup();
        let date = "2026-05-12";
        let input = collector::collect(&conn, date).unwrap();
        assert!(collector::is_empty(&input));

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
        )
        .unwrap();
        let input = collector::collect(&conn, "2026-05-12").unwrap();
        assert!(!collector::is_empty(&input));
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
