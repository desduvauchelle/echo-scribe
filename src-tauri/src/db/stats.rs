//! Aggregate statistics for the analytics dashboard.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::DbError;

#[derive(Debug, Clone, Serialize, Default)]
pub struct PeriodStats {
    pub transcriptions: u32,
    pub words: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub today: PeriodStats,
    pub week: PeriodStats,
    pub month: PeriodStats,
    pub all_time: PeriodStats,
    pub daily_counts: Vec<(String, u32)>,
    pub current_streak: u32,
    pub longest_streak: u32,
    pub avg_words_per_capture: f32,
    pub busiest_hour: Option<u8>,
}

fn period_stats(conn: &Connection, from: &str, to: &str) -> Result<PeriodStats, DbError> {
    let mut stmt = conn.prepare(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1), 0)
         FROM items
         WHERE deleted_at IS NULL
           AND captured_at >= ?1
           AND captured_at < ?2",
    )?;
    let (count, words): (i64, i64) = stmt.query_row(params![from, to], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })?;
    Ok(PeriodStats {
        transcriptions: count.max(0) as u32,
        words: words.max(0) as u32,
    })
}

fn all_time_stats(conn: &Connection) -> Result<PeriodStats, DbError> {
    let mut stmt = conn.prepare(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1), 0)
         FROM items
         WHERE deleted_at IS NULL",
    )?;
    let (count, words): (i64, i64) = stmt.query_row([], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })?;
    Ok(PeriodStats {
        transcriptions: count.max(0) as u32,
        words: words.max(0) as u32,
    })
}

fn daily_counts(conn: &Connection, from: &str) -> Result<Vec<(String, u32)>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT SUBSTR(captured_at, 1, 10) AS day, COUNT(*)
         FROM items
         WHERE deleted_at IS NULL AND captured_at >= ?1
         GROUP BY day
         ORDER BY day ASC",
    )?;
    let rows = stmt.query_map(params![from], |r| {
        let day: String = r.get(0)?;
        let count: i64 = r.get(1)?;
        Ok((day, count.max(0) as u32))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn busiest_hour(conn: &Connection) -> Result<Option<u8>, DbError> {
    let result: Result<(i64, i64), _> = conn.query_row(
        "SELECT CAST(SUBSTR(captured_at, 12, 2) AS INTEGER) AS hr, COUNT(*) AS cnt
         FROM items
         WHERE deleted_at IS NULL
         GROUP BY hr
         ORDER BY cnt DESC
         LIMIT 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    match result {
        Ok((hr, _)) => Ok(Some(hr.clamp(0, 23) as u8)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn compute_streaks(daily: &[(String, u32)], today: &str) -> (u32, u32) {
    if daily.is_empty() {
        return (0, 0);
    }
    let days_set: std::collections::HashSet<&str> = daily.iter().map(|(d, _)| d.as_str()).collect();

    let mut current = 0u32;
    let mut check = today.to_string();
    while days_set.contains(check.as_str()) {
        current += 1;
        check = prev_day(&check);
    }

    let mut sorted: Vec<&str> = days_set.iter().copied().collect();
    sorted.sort();
    let mut longest = 0u32;
    let mut run = 1u32;
    for i in 1..sorted.len() {
        if next_day(sorted[i - 1]) == sorted[i] {
            run += 1;
        } else {
            if run > longest {
                longest = run;
            }
            run = 1;
        }
    }
    if run > longest {
        longest = run;
    }

    (current, longest)
}

fn prev_day(date: &str) -> String {
    let secs = date_to_epoch(date);
    epoch_to_date(secs - 86_400)
}

fn next_day(date: &str) -> String {
    let secs = date_to_epoch(date);
    epoch_to_date(secs + 86_400)
}

fn date_to_epoch(date: &str) -> i64 {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return 0;
    }
    let y: i64 = parts[0].parse().unwrap_or(1970);
    let m: i64 = parts[1].parse().unwrap_or(1);
    let d: i64 = parts[2].parse().unwrap_or(1);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let m2 = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400 + 43_200
}

fn epoch_to_date(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

pub fn dashboard_stats(conn: &Connection, now_epoch: i64) -> Result<DashboardStats, DbError> {
    let today = epoch_to_date(now_epoch);
    let tomorrow = next_day(&today);

    let week_start = epoch_to_date(now_epoch - 6 * 86_400);
    let month_start = epoch_to_date(now_epoch - 29 * 86_400);
    let heatmap_start = epoch_to_date(now_epoch - 89 * 86_400);

    let today_from = format!("{today}T00:00:00Z");
    let tomorrow_from = format!("{tomorrow}T00:00:00Z");
    let week_from = format!("{week_start}T00:00:00Z");
    let month_from = format!("{month_start}T00:00:00Z");
    let heatmap_from = format!("{heatmap_start}T00:00:00Z");

    let today_stats = period_stats(conn, &today_from, &tomorrow_from)?;
    let week_stats = period_stats(conn, &week_from, &tomorrow_from)?;
    let month_stats = period_stats(conn, &month_from, &tomorrow_from)?;
    let all_time = all_time_stats(conn)?;

    let daily = daily_counts(conn, &heatmap_from)?;
    let (current_streak, longest_streak) = compute_streaks(&daily, &today);
    let busiest = busiest_hour(conn)?;

    let avg_words = if all_time.transcriptions > 0 {
        all_time.words as f32 / all_time.transcriptions as f32
    } else {
        0.0
    };

    Ok(DashboardStats {
        today: today_stats,
        week: week_stats,
        month: month_stats,
        all_time,
        daily_counts: daily,
        current_streak,
        longest_streak,
        avg_words_per_capture: avg_words,
        busiest_hour: busiest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;
    use crate::db::items::{insert_item, Item, ItemSource, Visibility};

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make(id: &str, content: &str, captured: &str) -> Item {
        Item {
            id: id.to_string(),
            content: content.to_string(),
            source: ItemSource::VoiceAtCursor,
            visibility: Visibility::Visible,
            kind: None,
            project_id: None,
            captured_at: captured.to_string(),
            created_at: captured.to_string(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context: None,
        }
    }

    #[test]
    fn dashboard_stats_empty_db() {
        let conn = fresh_db();
        let stats = dashboard_stats(&conn, 1_777_593_600).unwrap();
        assert_eq!(stats.today.transcriptions, 0);
        assert_eq!(stats.week.transcriptions, 0);
        assert_eq!(stats.month.transcriptions, 0);
        assert_eq!(stats.all_time.transcriptions, 0);
        assert!(stats.daily_counts.is_empty());
        assert_eq!(stats.current_streak, 0);
        assert_eq!(stats.longest_streak, 0);
        assert_eq!(stats.busiest_hour, None);
    }

    #[test]
    fn dashboard_stats_counts_words_correctly() {
        let conn = fresh_db();
        insert_item(&conn, &make("a", "hello world", "2026-05-01T10:00:00Z")).unwrap();
        insert_item(&conn, &make("b", "one two three", "2026-05-01T14:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600).unwrap();
        assert_eq!(stats.today.transcriptions, 2);
        assert_eq!(stats.today.words, 5);
        assert_eq!(stats.all_time.words, 5);
    }

    #[test]
    fn dashboard_stats_respects_time_windows() {
        let conn = fresh_db();
        insert_item(&conn, &make("a", "today item", "2026-05-01T10:00:00Z")).unwrap();
        insert_item(&conn, &make("b", "this week", "2026-04-28T10:00:00Z")).unwrap();
        insert_item(&conn, &make("c", "this month", "2026-04-16T10:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600).unwrap();
        assert_eq!(stats.today.transcriptions, 1);
        assert_eq!(stats.week.transcriptions, 2);
        assert_eq!(stats.month.transcriptions, 3);
    }

    #[test]
    fn dashboard_stats_excludes_soft_deleted() {
        let conn = fresh_db();
        let mut item = make("a", "deleted item", "2026-05-01T10:00:00Z");
        item.deleted_at = Some("2026-05-01T12:00:00Z".to_string());
        insert_item(&conn, &item).unwrap();
        insert_item(&conn, &make("b", "kept item", "2026-05-01T10:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600).unwrap();
        assert_eq!(stats.today.transcriptions, 1);
    }

    #[test]
    fn dashboard_streaks_computed_correctly() {
        let conn = fresh_db();
        insert_item(&conn, &make("a", "a", "2026-04-29T10:00:00Z")).unwrap();
        insert_item(&conn, &make("b", "b", "2026-04-30T10:00:00Z")).unwrap();
        insert_item(&conn, &make("c", "c", "2026-05-01T10:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600).unwrap();
        assert_eq!(stats.current_streak, 3);
        assert_eq!(stats.longest_streak, 3);
    }

    #[test]
    fn busiest_hour_returns_correct_hour() {
        let conn = fresh_db();
        insert_item(&conn, &make("a", "x", "2026-05-01T14:00:00Z")).unwrap();
        insert_item(&conn, &make("b", "y", "2026-05-01T14:30:00Z")).unwrap();
        insert_item(&conn, &make("c", "z", "2026-05-01T09:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600).unwrap();
        assert_eq!(stats.busiest_hour, Some(14));
    }

    #[test]
    fn epoch_to_date_and_back_round_trips() {
        assert_eq!(epoch_to_date(1_777_593_600), "2026-05-01");
        let d = "2026-05-01";
        let e = date_to_epoch(d);
        assert_eq!(epoch_to_date(e), d);
    }

    #[test]
    fn prev_and_next_day() {
        assert_eq!(next_day("2026-04-30"), "2026-05-01");
        assert_eq!(prev_day("2026-05-01"), "2026-04-30");
        assert_eq!(prev_day("2026-03-01"), "2026-02-28");
    }
}
