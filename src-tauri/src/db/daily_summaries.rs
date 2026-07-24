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
    pub date: String,
    pub generated_at: String,
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

fn parse_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DailySummaryRow> {
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
}

pub fn get(conn: &Connection, date: &str) -> rusqlite::Result<Option<DailySummaryRow>> {
    let mut stmt = conn.prepare(
        "SELECT date, generated_at, status, narrative, sections_json,
                source_meeting_ids_json, source_item_ids_json, model_version, input_token_count
         FROM daily_summaries WHERE date = ?1",
    )?;
    let mut rows = stmt.query(params![date])?;
    if let Some(r) = rows.next()? {
        Ok(Some(parse_row(r)?))
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
    let rows = stmt.query_map(params![limit], parse_row)?;
    rows.collect()
}

/// Return the list of `date` values that have a row within the last `n` days
/// (computed in the local timezone). Used by the scheduler to detect missing
/// backfill days.
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
