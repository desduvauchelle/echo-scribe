//! Query meetings + items for one local day and group into a summary input.

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MeetingForSummary {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub suggested_title: Option<String>,
    pub summary_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ItemForSummary {
    pub id: String,
    pub content: String,
    pub captured_at: String,
    pub capture_context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailySummaryInput {
    pub date: String,
    pub meetings: Vec<MeetingForSummary>,
    pub notes: Vec<ItemForSummary>,
    /// Dictations grouped by `capture_context` (the frontmost app at capture
    /// time). Sorted by group size descending; entries within a group sorted
    /// by `captured_at` ascending.
    pub dictations_by_app: Vec<(String, Vec<ItemForSummary>)>,
}

/// A day is empty if it has no meetings, no notes, and fewer than 3 dictations.
pub fn is_empty(input: &DailySummaryInput) -> bool {
    let dictation_count: usize = input.dictations_by_app.iter().map(|(_, v)| v.len()).sum();
    input.meetings.is_empty() && input.notes.is_empty() && dictation_count < 3
}

const UNKNOWN_APP: &str = "Unknown";

pub fn collect(conn: &Connection, date: &str) -> rusqlite::Result<DailySummaryInput> {
    let day_start = format!("{date}T00:00:00Z");
    let day_end = format!("{date}T23:59:59Z");

    let meetings = {
        let mut stmt = conn.prepare(
            "SELECT m.item_id, m.started_at, m.ended_at, i.content, m.summary_json
             FROM meetings m
             JOIN items i ON i.id = m.item_id
             WHERE m.started_at >= ?1 AND m.started_at <= ?2
               AND i.deleted_at IS NULL
             ORDER BY m.started_at ASC",
        )?;
        let rows = stmt.query_map(params![day_start, day_end], |r| {
            Ok(MeetingForSummary {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                suggested_title: r.get(3)?,
                summary_json: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let notes = query_items(conn, "log_capture", &day_start, &day_end)?;
    let dictations = query_items(conn, "voice_at_cursor", &day_start, &day_end)?;

    let mut by_app: std::collections::BTreeMap<String, Vec<ItemForSummary>> =
        std::collections::BTreeMap::new();
    for d in dictations {
        let key = d
            .capture_context
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| UNKNOWN_APP.to_string());
        by_app.entry(key).or_default().push(d);
    }
    let mut grouped: Vec<(String, Vec<ItemForSummary>)> = by_app.into_iter().collect();
    grouped.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

    Ok(DailySummaryInput {
        date: date.to_string(),
        meetings,
        notes,
        dictations_by_app: grouped,
    })
}

fn query_items(
    conn: &Connection,
    source: &str,
    day_start: &str,
    day_end: &str,
) -> rusqlite::Result<Vec<ItemForSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, content, captured_at, capture_context
         FROM items
         WHERE source = ?1
           AND captured_at >= ?2 AND captured_at <= ?3
           AND deleted_at IS NULL
         ORDER BY captured_at ASC",
    )?;
    let rows = stmt.query_map(params![source, day_start, day_end], |r| {
        Ok(ItemForSummary {
            id: r.get(0)?,
            content: r.get(1)?,
            captured_at: r.get(2)?,
            capture_context: r.get(3)?,
        })
    })?;
    rows.collect()
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

    fn insert_item(
        conn: &Connection,
        id: &str,
        source: &str,
        captured_at: &str,
        content: &str,
        ctx: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at, capture_context)
             VALUES (?1, ?2, ?3, 'visible', NULL, ?4, ?4, ?5)",
            params![id, content, source, captured_at, ctx],
        )
        .unwrap();
    }

    fn insert_meeting(conn: &Connection, id: &str, started_at: &str) {
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
             VALUES (?1, 'Meeting', 'meeting', 'visible', 'meeting', ?2, ?2)",
            params![id, started_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meetings (item_id, started_at, status, mic_only)
             VALUES (?1, ?2, 'completed', 0)",
            params![id, started_at],
        )
        .unwrap();
    }

    #[test]
    fn empty_day_returns_empty_bundle() {
        let conn = setup();
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(input.meetings.is_empty());
        assert!(input.notes.is_empty());
        assert!(input.dictations_by_app.is_empty());
        assert!(is_empty(&input));
    }

    #[test]
    fn light_day_with_2_dictations_is_empty() {
        let conn = setup();
        insert_item(&conn, "d1", "voice_at_cursor", "2026-05-12T10:00:00Z", "hi", Some("VS Code"));
        insert_item(&conn, "d2", "voice_at_cursor", "2026-05-12T11:00:00Z", "ok", Some("VS Code"));
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations_by_app.len(), 1);
        assert!(is_empty(&input));
    }

    #[test]
    fn light_day_with_3_dictations_is_not_empty() {
        let conn = setup();
        for (i, t) in ["10:00", "11:00", "12:00"].iter().enumerate() {
            insert_item(
                &conn,
                &format!("d{i}"),
                "voice_at_cursor",
                &format!("2026-05-12T{t}:00Z"),
                "hi",
                Some("VS Code"),
            );
        }
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(!is_empty(&input));
    }

    #[test]
    fn day_with_meeting_is_not_empty() {
        let conn = setup();
        insert_meeting(&conn, "m1", "2026-05-12T09:00:00Z");
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.meetings.len(), 1);
        assert!(!is_empty(&input));
    }

    #[test]
    fn day_with_note_is_not_empty() {
        let conn = setup();
        insert_item(&conn, "n1", "log_capture", "2026-05-12T10:00:00Z", "note", None);
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.notes.len(), 1);
        assert!(!is_empty(&input));
    }

    #[test]
    fn dictations_group_by_app_sorted_by_group_size_desc() {
        let conn = setup();
        // 3 in VS Code, 1 in Slack
        for (i, app) in [
            ("d1", "VS Code"),
            ("d2", "VS Code"),
            ("d3", "VS Code"),
            ("d4", "Slack"),
        ] {
            insert_item(&conn, i, "voice_at_cursor", "2026-05-12T10:00:00Z", "x", Some(app));
        }
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations_by_app.len(), 2);
        assert_eq!(input.dictations_by_app[0].0, "VS Code");
        assert_eq!(input.dictations_by_app[0].1.len(), 3);
        assert_eq!(input.dictations_by_app[1].0, "Slack");
    }

    #[test]
    fn dictations_with_null_context_group_under_unknown() {
        let conn = setup();
        for i in 0..3 {
            insert_item(&conn, &format!("d{i}"), "voice_at_cursor", "2026-05-12T10:00:00Z", "x", None);
        }
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations_by_app.len(), 1);
        assert_eq!(input.dictations_by_app[0].0, UNKNOWN_APP);
    }

    #[test]
    fn collect_ignores_other_days() {
        let conn = setup();
        insert_item(&conn, "n-yesterday", "log_capture", "2026-05-11T10:00:00Z", "x", None);
        insert_item(&conn, "n-today", "log_capture", "2026-05-12T10:00:00Z", "x", None);
        insert_item(&conn, "n-tomorrow", "log_capture", "2026-05-13T10:00:00Z", "x", None);
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.notes.len(), 1);
        assert_eq!(input.notes[0].id, "n-today");
    }

    #[test]
    fn collect_ignores_deleted_items() {
        let conn = setup();
        insert_item(&conn, "n1", "log_capture", "2026-05-12T10:00:00Z", "x", None);
        conn.execute(
            "UPDATE items SET deleted_at = '2026-05-12T11:00:00Z' WHERE id = 'n1'",
            [],
        )
        .unwrap();
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(input.notes.is_empty());
    }
}
