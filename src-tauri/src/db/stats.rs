//! Aggregate statistics for the analytics dashboard.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::BTreeMap;

use super::DbError;

#[derive(Debug, Clone, Serialize, Default)]
pub struct PeriodStats {
    pub transcriptions: u32,
    pub words: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CategoryPeriodStats {
    pub count: u32,
    pub words: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CategoryStats {
    pub today: CategoryPeriodStats,
    pub week: CategoryPeriodStats,
    pub month: CategoryPeriodStats,
    pub all_time: CategoryPeriodStats,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatsCategories {
    pub transcriptions: CategoryStats,
    pub notes: CategoryStats,
    pub tasks: CategoryStats,
    pub meetings: CategoryStats,
    pub recordings: CategoryStats,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DailyActivity {
    pub date: String,
    pub transcriptions: u32,
    pub notes: u32,
    pub tasks: u32,
    pub meetings: u32,
    pub recordings: u32,
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
    pub categories: StatsCategories,
    pub daily_activity: Vec<DailyActivity>,
}

fn category_period_from_items(
    conn: &Connection,
    kind: &str,
    from: Option<&str>,
    to: Option<&str>,
    tz_mod: &str,
) -> Result<CategoryPeriodStats, DbError> {
    let mut sql = String::from(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1), 0)
         FROM items
         WHERE deleted_at IS NULL
           AND ((?1 = 'transcription' AND (kind = 'transcription' OR (kind IS NULL AND source = 'voice_at_cursor')))
                OR (?1 != 'transcription' AND kind = ?1))",
    );
    if from.is_some() {
        sql.push_str(" AND datetime(captured_at, ?2) >= ?3");
    }
    if to.is_some() {
        sql.push_str(" AND datetime(captured_at, ?2) < ?4");
    }

    let (count, words): (i64, i64) = match (from, to) {
        (Some(from), Some(to)) => conn.query_row(&sql, params![kind, tz_mod, from, to], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
        _ => conn.query_row(&sql, params![kind], |r| Ok((r.get(0)?, r.get(1)?)))?,
    };
    Ok(CategoryPeriodStats {
        count: count.max(0) as u32,
        words: words.max(0) as u32,
        duration_ms: 0,
    })
}

fn category_period_from_meetings(
    conn: &Connection,
    from: Option<&str>,
    to: Option<&str>,
    tz_mod: &str,
) -> Result<CategoryPeriodStats, DbError> {
    let mut sql = String::from(
        "SELECT COUNT(*),
                COALESCE(SUM(LENGTH(i.content) - LENGTH(REPLACE(i.content, ' ', '')) + 1), 0),
                COALESCE(SUM(m.duration_ms), 0)
         FROM meetings m
         JOIN items i ON i.id = m.item_id
         WHERE i.deleted_at IS NULL",
    );
    if from.is_some() {
        sql.push_str(" AND datetime(m.started_at, ?1) >= ?2");
    }
    if to.is_some() {
        sql.push_str(" AND datetime(m.started_at, ?1) < ?3");
    }
    let (count, words, duration): (i64, i64, i64) = match (from, to) {
        (Some(from), Some(to)) => conn.query_row(&sql, params![tz_mod, from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?,
        _ => conn.query_row(&sql, [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?,
    };
    Ok(CategoryPeriodStats {
        count: count.max(0) as u32,
        words: words.max(0) as u32,
        duration_ms: duration.max(0) as u64,
    })
}

fn category_period_from_recordings(
    conn: &Connection,
    from: Option<&str>,
    to: Option<&str>,
    tz_mod: &str,
) -> Result<CategoryPeriodStats, DbError> {
    let mut sql = String::from(
        "SELECT COUNT(*), COALESCE(SUM(duration_ms), 0)
         FROM recordings WHERE 1 = 1",
    );
    if from.is_some() {
        sql.push_str(" AND datetime(created_at / 1000, 'unixepoch', ?1) >= ?2");
    }
    if to.is_some() {
        sql.push_str(" AND datetime(created_at / 1000, 'unixepoch', ?1) < ?3");
    }
    let (count, duration): (i64, i64) = match (from, to) {
        (Some(from), Some(to)) => conn.query_row(&sql, params![tz_mod, from, to], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
        _ => conn.query_row(&sql, [], |r| Ok((r.get(0)?, r.get(1)?)))?,
    };
    Ok(CategoryPeriodStats {
        count: count.max(0) as u32,
        words: 0,
        duration_ms: duration.max(0) as u64,
    })
}

fn category_stats_from_items(
    conn: &Connection,
    kind: &str,
    bounds: &[(&str, &str); 3],
    tz_mod: &str,
) -> Result<CategoryStats, DbError> {
    Ok(CategoryStats {
        today: category_period_from_items(
            conn,
            kind,
            Some(bounds[0].0),
            Some(bounds[0].1),
            tz_mod,
        )?,
        week: category_period_from_items(conn, kind, Some(bounds[1].0), Some(bounds[1].1), tz_mod)?,
        month: category_period_from_items(
            conn,
            kind,
            Some(bounds[2].0),
            Some(bounds[2].1),
            tz_mod,
        )?,
        all_time: category_period_from_items(conn, kind, None, None, tz_mod)?,
    })
}

fn category_stats_from_meetings(
    conn: &Connection,
    bounds: &[(&str, &str); 3],
    tz_mod: &str,
) -> Result<CategoryStats, DbError> {
    Ok(CategoryStats {
        today: category_period_from_meetings(conn, Some(bounds[0].0), Some(bounds[0].1), tz_mod)?,
        week: category_period_from_meetings(conn, Some(bounds[1].0), Some(bounds[1].1), tz_mod)?,
        month: category_period_from_meetings(conn, Some(bounds[2].0), Some(bounds[2].1), tz_mod)?,
        all_time: category_period_from_meetings(conn, None, None, tz_mod)?,
    })
}

fn category_stats_from_recordings(
    conn: &Connection,
    bounds: &[(&str, &str); 3],
    tz_mod: &str,
) -> Result<CategoryStats, DbError> {
    Ok(CategoryStats {
        today: category_period_from_recordings(conn, Some(bounds[0].0), Some(bounds[0].1), tz_mod)?,
        week: category_period_from_recordings(conn, Some(bounds[1].0), Some(bounds[1].1), tz_mod)?,
        month: category_period_from_recordings(conn, Some(bounds[2].0), Some(bounds[2].1), tz_mod)?,
        all_time: category_period_from_recordings(conn, None, None, tz_mod)?,
    })
}

/// `tz_mod` is a SQLite datetime modifier like `"-25200 seconds"` that shifts
/// the UTC-stored `captured_at` into the user's local wall-clock before
/// comparing against local-day boundaries.
fn period_stats(
    conn: &Connection,
    from: &str,
    to: &str,
    tz_mod: &str,
) -> Result<PeriodStats, DbError> {
    let mut stmt = conn.prepare(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1), 0)
         FROM items
         WHERE deleted_at IS NULL
           AND datetime(captured_at, ?1) >= ?2
           AND datetime(captured_at, ?1) < ?3",
    )?;
    let (count, words): (i64, i64) =
        stmt.query_row(params![tz_mod, from, to], |r| Ok((r.get(0)?, r.get(1)?)))?;
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
    let (count, words): (i64, i64) = stmt.query_row([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(PeriodStats {
        transcriptions: count.max(0) as u32,
        words: words.max(0) as u32,
    })
}

fn daily_counts(
    conn: &Connection,
    from: &str,
    tz_mod: &str,
) -> Result<Vec<(String, u32)>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT SUBSTR(datetime(captured_at, ?1), 1, 10) AS day, COUNT(*)
         FROM items
         WHERE deleted_at IS NULL AND datetime(captured_at, ?1) >= ?2
         GROUP BY day
         ORDER BY day ASC",
    )?;
    let rows = stmt.query_map(params![tz_mod, from], |r| {
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

fn daily_activity(
    conn: &Connection,
    start_date: &str,
    today: &str,
    tz_mod: &str,
) -> Result<Vec<DailyActivity>, DbError> {
    let mut days = BTreeMap::<String, DailyActivity>::new();
    let mut day = start_date.to_string();
    loop {
        days.insert(
            day.clone(),
            DailyActivity {
                date: day.clone(),
                ..Default::default()
            },
        );
        if day == today {
            break;
        }
        day = next_day(&day);
    }

    let from = format!("{start_date} 00:00:00");
    let mut item_stmt = conn.prepare(
        "SELECT SUBSTR(datetime(captured_at, ?1), 1, 10) AS day,
                CASE
                  WHEN kind = 'note' THEN 'note'
                  WHEN kind = 'task' THEN 'task'
                  WHEN kind = 'transcription' OR (kind IS NULL AND source = 'voice_at_cursor') THEN 'transcription'
                  ELSE NULL
                END AS category,
                COUNT(*)
         FROM items
         WHERE deleted_at IS NULL AND datetime(captured_at, ?1) >= ?2
         GROUP BY day, category",
    )?;
    let item_rows = item_stmt.query_map(params![tz_mod, from], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    for row in item_rows {
        let (date, category, count) = row?;
        let Some(entry) = days.get_mut(&date) else {
            continue;
        };
        match category.as_deref() {
            Some("transcription") => entry.transcriptions = count.max(0) as u32,
            Some("note") => entry.notes = count.max(0) as u32,
            Some("task") => entry.tasks = count.max(0) as u32,
            _ => {}
        }
    }

    let mut meeting_stmt = conn.prepare(
        "SELECT SUBSTR(datetime(m.started_at, ?1), 1, 10) AS day, COUNT(*)
         FROM meetings m
         JOIN items i ON i.id = m.item_id
         WHERE i.deleted_at IS NULL AND datetime(m.started_at, ?1) >= ?2
         GROUP BY day",
    )?;
    let meeting_rows = meeting_stmt.query_map(params![tz_mod, from], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    for row in meeting_rows {
        let (date, count) = row?;
        if let Some(entry) = days.get_mut(&date) {
            entry.meetings = count.max(0) as u32;
        }
    }

    let mut recording_stmt = conn.prepare(
        "SELECT SUBSTR(datetime(created_at / 1000, 'unixepoch', ?1), 1, 10) AS day, COUNT(*)
         FROM recordings
         WHERE datetime(created_at / 1000, 'unixepoch', ?1) >= ?2
         GROUP BY day",
    )?;
    let recording_rows = recording_stmt.query_map(params![tz_mod, from], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    for row in recording_rows {
        let (date, count) = row?;
        if let Some(entry) = days.get_mut(&date) {
            entry.recordings = count.max(0) as u32;
        }
    }

    Ok(days.into_values().collect())
}

fn busiest_hour(conn: &Connection, tz_mod: &str) -> Result<Option<u8>, DbError> {
    let result: Result<(i64, i64), _> = conn.query_row(
        "SELECT CAST(SUBSTR(datetime(captured_at, ?1), 12, 2) AS INTEGER) AS hr, COUNT(*) AS cnt
         FROM items
         WHERE deleted_at IS NULL
         GROUP BY hr
         ORDER BY cnt DESC
         LIMIT 1",
        params![tz_mod],
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

/// `tz_offset_secs` is the user's local offset from UTC in seconds (east-positive,
/// e.g. `-25200` for PDT). All day/week/month windows, the heatmap, streaks, and
/// busiest-hour are computed in *local* time so "Today" rolls over at local
/// midnight rather than UTC midnight. `captured_at` is stored as UTC ISO-8601.
pub fn dashboard_stats(
    conn: &Connection,
    now_epoch: i64,
    tz_offset_secs: i64,
) -> Result<DashboardStats, DbError> {
    // SQLite modifier to shift UTC `captured_at` into local wall-clock.
    let tz_mod = format!("{:+} seconds", tz_offset_secs);
    // Local "now" for deriving local calendar dates.
    let local_now = now_epoch + tz_offset_secs;

    let today = epoch_to_date(local_now);
    let tomorrow = next_day(&today);

    let week_start = epoch_to_date(local_now - 6 * 86_400);
    let month_start = epoch_to_date(local_now - 29 * 86_400);
    let heatmap_start = epoch_to_date(local_now - 89 * 86_400);

    // Bounds in local wall-clock; matches `datetime(...)` output format
    // ("YYYY-MM-DD HH:MM:SS"), which is lexically sortable.
    let today_from = format!("{today} 00:00:00");
    let tomorrow_from = format!("{tomorrow} 00:00:00");
    let week_from = format!("{week_start} 00:00:00");
    let month_from = format!("{month_start} 00:00:00");
    let heatmap_from = format!("{heatmap_start} 00:00:00");

    let today_stats = period_stats(conn, &today_from, &tomorrow_from, &tz_mod)?;
    let week_stats = period_stats(conn, &week_from, &tomorrow_from, &tz_mod)?;
    let month_stats = period_stats(conn, &month_from, &tomorrow_from, &tz_mod)?;
    let all_time = all_time_stats(conn)?;

    let daily = daily_counts(conn, &heatmap_from, &tz_mod)?;
    let (current_streak, longest_streak) = compute_streaks(&daily, &today);
    let busiest = busiest_hour(conn, &tz_mod)?;

    let avg_words = if all_time.transcriptions > 0 {
        all_time.words as f32 / all_time.transcriptions as f32
    } else {
        0.0
    };

    let bounds = [
        (today_from.as_str(), tomorrow_from.as_str()),
        (week_from.as_str(), tomorrow_from.as_str()),
        (month_from.as_str(), tomorrow_from.as_str()),
    ];
    let categories = StatsCategories {
        transcriptions: category_stats_from_items(conn, "transcription", &bounds, &tz_mod)?,
        notes: category_stats_from_items(conn, "note", &bounds, &tz_mod)?,
        tasks: category_stats_from_items(conn, "task", &bounds, &tz_mod)?,
        meetings: category_stats_from_meetings(conn, &bounds, &tz_mod)?,
        recordings: category_stats_from_recordings(conn, &bounds, &tz_mod)?,
    };
    let activity = daily_activity(conn, &heatmap_start, &today, &tz_mod)?;

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
        categories,
        daily_activity: activity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::{insert_item, Item, ItemKind, ItemSource};
    use crate::db::schema::run_migrations;

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
        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
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

        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
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

        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
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

        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
        assert_eq!(stats.today.transcriptions, 1);
    }

    #[test]
    fn dashboard_streaks_computed_correctly() {
        let conn = fresh_db();
        insert_item(&conn, &make("a", "a", "2026-04-29T10:00:00Z")).unwrap();
        insert_item(&conn, &make("b", "b", "2026-04-30T10:00:00Z")).unwrap();
        insert_item(&conn, &make("c", "c", "2026-05-01T10:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
        assert_eq!(stats.current_streak, 3);
        assert_eq!(stats.longest_streak, 3);
    }

    #[test]
    fn busiest_hour_returns_correct_hour() {
        let conn = fresh_db();
        insert_item(&conn, &make("a", "x", "2026-05-01T14:00:00Z")).unwrap();
        insert_item(&conn, &make("b", "y", "2026-05-01T14:30:00Z")).unwrap();
        insert_item(&conn, &make("c", "z", "2026-05-01T09:00:00Z")).unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
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

    #[test]
    fn dashboard_stats_uses_local_day_boundary() {
        let conn = fresh_db();
        // PDT = UTC-7.
        let offset = -7 * 3600;
        // now = 2026-05-22T17:00:00Z = 2026-05-22 10:00 PDT (date_to_epoch is noon UTC).
        let now = date_to_epoch("2026-05-22") + 5 * 3600;

        // 2026-05-23T02:00:00Z -> 2026-05-22 19:00 PDT: TODAY locally, but TOMORROW in UTC.
        insert_item(
            &conn,
            &make("a", "late local today", "2026-05-23T02:00:00Z"),
        )
        .unwrap();
        // 2026-05-22T15:00:00Z -> 2026-05-22 08:00 PDT: today in both.
        insert_item(&conn, &make("b", "morning today", "2026-05-22T15:00:00Z")).unwrap();

        // Local: both count. (UTC/offset-0 would count only "b".)
        let local = dashboard_stats(&conn, now, offset).unwrap();
        assert_eq!(local.today.transcriptions, 2);

        // Sanity: the buggy UTC computation would have counted only 1.
        let utc = dashboard_stats(&conn, now, 0).unwrap();
        assert_eq!(utc.today.transcriptions, 1);
    }

    #[test]
    fn category_stats_cover_every_dashboard_type_and_duration() {
        let conn = fresh_db();
        let captured = "2026-05-01T10:00:00Z";

        insert_item(&conn, &make("transcription", "spoken words", captured)).unwrap();
        let mut note = make("note", "written note", captured);
        note.kind = Some(ItemKind::Note);
        insert_item(&conn, &note).unwrap();
        let mut task = make("task", "follow up", captured);
        task.kind = Some(ItemKind::Task);
        insert_item(&conn, &task).unwrap();

        conn.execute(
            "INSERT INTO items(id, content, source, kind, captured_at, created_at)
             VALUES ('meeting', 'meeting summary', 'meeting', 'meeting', ?1, ?1)",
            [captured],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meetings(item_id, started_at, duration_ms, status)
             VALUES ('meeting', ?1, 1800000, 'complete')",
            [captured],
        )
        .unwrap();
        let recording_epoch_ms = (date_to_epoch("2026-05-01") - 2 * 3600) * 1000;
        conn.execute(
            "INSERT INTO recordings(id, created_at, file_path, duration_ms)
             VALUES ('recording', ?1, '/tmp/recording.mp4', 900000)",
            [recording_epoch_ms],
        )
        .unwrap();

        let stats = dashboard_stats(&conn, 1_777_593_600, 0).unwrap();
        assert_eq!(stats.categories.transcriptions.today.count, 1);
        assert_eq!(stats.categories.notes.today.count, 1);
        assert_eq!(stats.categories.tasks.today.count, 1);
        assert_eq!(stats.categories.meetings.today.count, 1);
        assert_eq!(stats.categories.recordings.today.count, 1);
        assert_eq!(stats.categories.meetings.week.duration_ms, 1_800_000);
        assert_eq!(stats.categories.recordings.all_time.duration_ms, 900_000);

        let today = stats.daily_activity.last().unwrap();
        assert_eq!(today.date, "2026-05-01");
        assert_eq!(today.transcriptions, 1);
        assert_eq!(today.notes, 1);
        assert_eq!(today.tasks, 1);
        assert_eq!(today.meetings, 1);
        assert_eq!(today.recordings, 1);
    }
}
