//! Query meetings + items for one local day and shape them into a summary input.

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MeetingForSummary {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Human title: the matched calendar event, else "<app> call". Never the
    /// `items.content` column — that holds the summary/transcript text.
    pub title: String,
    /// Plain-text/markdown meeting summary extracted from `summary_json`.
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ItemForSummary {
    pub id: String,
    pub content: String,
    pub captured_at: String,
    /// Frontmost app at capture time ("Claude", "Arc", …). `capture_context`
    /// is a JSON blob on current rows and a bare app name on legacy rows.
    pub app: String,
    /// Extra place hint: browser tab / window title and a trimmed URL path.
    pub context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailySummaryInput {
    pub date: String,
    pub meetings: Vec<MeetingForSummary>,
    pub notes: Vec<ItemForSummary>,
    /// All dictations for the day in chronological order. Grouping by app
    /// was the wrong axis: most dictations go to one or two AI assistants,
    /// so time order is what keeps a thread of work together.
    pub dictations: Vec<ItemForSummary>,
}

/// A day is empty if it has no meetings, no notes, and fewer than 3 dictations.
pub fn is_empty(input: &DailySummaryInput) -> bool {
    input.meetings.is_empty() && input.notes.is_empty() && input.dictations.len() < 3
}

const UNKNOWN_APP: &str = "Unknown";

/// UTC bounds `[start, end)` of the user's *local* calendar day, formatted
/// without a zone suffix so lexicographic comparison works against both the
/// `...Z` and `...+00:00` timestamp spellings stored in the DB.
pub fn local_day_window_utc(date: &str) -> Option<(String, String)> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let to_utc = |day: NaiveDate| -> Option<String> {
        let local = Local
            .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
            .earliest()?;
        Some(local.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S").to_string())
    };
    Some((to_utc(d)?, to_utc(d + Duration::days(1))?))
}

/// Local wall-clock "HH:MM" for an RFC 3339 timestamp; falls back to the raw
/// string's time part when it doesn't parse.
pub fn local_clock(ts: &str) -> String {
    match DateTime::parse_from_rfc3339(ts) {
        Ok(dt) => dt.with_timezone(&Local).format("%H:%M").to_string(),
        Err(_) => ts.get(11..16).unwrap_or(ts).to_string(),
    }
}

pub fn collect(conn: &Connection, date: &str) -> rusqlite::Result<DailySummaryInput> {
    let (start, end) = local_day_window_utc(date).unwrap_or_else(|| {
        (
            format!("{date}T00:00:00"),
            format!("{date}T23:59:59.999"),
        )
    });
    collect_window(conn, date, &start, &end)
}

/// Collect everything captured in `[start, end)` (UTC, see
/// [`local_day_window_utc`]). Split out so tests don't depend on the host TZ.
pub fn collect_window(
    conn: &Connection,
    date: &str,
    start: &str,
    end: &str,
) -> rusqlite::Result<DailySummaryInput> {
    let meetings = {
        let mut stmt = conn.prepare(
            "SELECT m.item_id, m.started_at, m.ended_at, m.detected_app_name,
                    m.calendar_match_json, m.summary_json
             FROM meetings m
             JOIN items i ON i.id = m.item_id
             WHERE m.started_at >= ?1 AND m.started_at < ?2
               AND i.deleted_at IS NULL
             ORDER BY m.started_at ASC",
        )?;
        let rows = stmt.query_map(params![start, end], |r| {
            let app: Option<String> = r.get(3)?;
            let calendar: Option<String> = r.get(4)?;
            let summary_json: Option<String> = r.get(5)?;
            Ok(MeetingForSummary {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                title: meeting_title(calendar.as_deref(), app.as_deref()),
                summary: summary_json.as_deref().and_then(meeting_summary_text),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let notes = query_items(conn, "log_capture", start, end)?;
    let dictations = query_items(conn, "voice_at_cursor", start, end)?;

    Ok(DailySummaryInput {
        date: date.to_string(),
        meetings,
        notes,
        dictations,
    })
}

fn query_items(
    conn: &Connection,
    source: &str,
    start: &str,
    end: &str,
) -> rusqlite::Result<Vec<ItemForSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, content, captured_at, capture_context
         FROM items
         WHERE source = ?1
           AND captured_at >= ?2 AND captured_at < ?3
           AND deleted_at IS NULL
         ORDER BY captured_at ASC",
    )?;
    let rows = stmt.query_map(params![source, start, end], |r| {
        let ctx: Option<String> = r.get(3)?;
        let (app, context) = parse_capture_context(ctx.as_deref());
        Ok(ItemForSummary {
            id: r.get(0)?,
            content: r.get(1)?,
            captured_at: r.get(2)?,
            app,
            context,
        })
    })?;
    rows.collect()
}

/// `capture_context` is a JSON object on current rows
/// (`{"app_name":…,"window_title":…,"browser_url":…}`) and a bare app name on
/// legacy rows. Returns `(app, place hint)`.
pub fn parse_capture_context(raw: Option<&str>) -> (String, Option<String>) {
    let raw = match raw.map(str::trim) {
        Some(s) if !s.is_empty() => s,
        _ => return (UNKNOWN_APP.to_string(), None),
    };
    let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (raw.to_string(), None);
    };
    let field = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let app = field("app_name").unwrap_or(UNKNOWN_APP).to_string();
    let title = field("browser_tab_title")
        .or_else(|| field("window_title"))
        .filter(|t| !t.eq_ignore_ascii_case(&app));
    let url = field("browser_url")
        .or_else(|| field("content_url"))
        .and_then(url_hint);
    let context = match (title, url) {
        (Some(t), Some(u)) => Some(format!("{t} — {u}")),
        (Some(t), None) => Some(t.to_string()),
        (None, Some(u)) => Some(u),
        (None, None) => None,
    };
    (app, context.map(|c| truncate_chars(&c, 120)))
}

/// Host + first two path segments, no query/fragment ("mail.google.com",
/// "app.example.com/portal/livecase"). Enough to say *where* without leaking
/// long ids into the prompt.
fn url_hint(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let host = parts.next()?;
    if host.starts_with("claude.ai") || host.starts_with("localhost") {
        return None;
    }
    let path: Vec<&str> = parts
        .take(2)
        .filter(|p| !looks_like_id(p))
        .collect();
    if path.is_empty() {
        Some(host.to_string())
    } else {
        Some(format!("{host}/{}", path.join("/")))
    }
}

fn looks_like_id(seg: &str) -> bool {
    seg.len() >= 16 && seg.chars().filter(|c| c.is_ascii_digit()).count() >= 4
}

fn meeting_title(calendar_json: Option<&str>, app: Option<&str>) -> String {
    if let Some(v) = calendar_json.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()) {
        for key in ["title", "event_title", "summary"] {
            if let Some(t) = v.get(key).and_then(|t| t.as_str()).map(str::trim) {
                if !t.is_empty() {
                    return t.to_string();
                }
            }
        }
    }
    match app.map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => format!("{a} call"),
        None => "Meeting".to_string(),
    }
}

/// Current rows store `{"markdown": "..."}`; older rows used a structured
/// object with a `summary` array. Anything else is passed through as text.
fn meeting_summary_text(raw: &str) -> Option<String> {
    let text = match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v) => {
            if let Some(md) = v.get("markdown").and_then(|m| m.as_str()) {
                md.to_string()
            } else if let Some(arr) = v.get("summary").and_then(|s| s.as_array()) {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .map(|x| format!("- {x}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                raw.to_string()
            }
        }
        Err(_) => raw.to_string(),
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
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

    /// UTC-day collection so tests don't depend on the host timezone.
    fn collect(conn: &Connection, date: &str) -> rusqlite::Result<DailySummaryInput> {
        collect_window(conn, date, &format!("{date}T00:00:00"), &format!("{date}T23:59:59.999"))
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
            "INSERT INTO items (id, content, source, kind, captured_at, created_at, capture_context)
             VALUES (?1, ?2, ?3, NULL, ?4, ?4, ?5)",
            params![id, content, source, captured_at, ctx],
        )
        .unwrap();
    }

    fn insert_meeting(conn: &Connection, id: &str, started_at: &str) {
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES (?1, 'Meeting', 'meeting', 'meeting', ?2, ?2)",
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
        assert!(input.dictations.is_empty());
        assert!(is_empty(&input));
    }

    #[test]
    fn light_day_with_2_dictations_is_empty() {
        let conn = setup();
        insert_item(
            &conn,
            "d1",
            "voice_at_cursor",
            "2026-05-12T10:00:00Z",
            "hi",
            Some("VS Code"),
        );
        insert_item(
            &conn,
            "d2",
            "voice_at_cursor",
            "2026-05-12T11:00:00Z",
            "ok",
            Some("VS Code"),
        );
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.dictations.len(), 2);
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
        insert_item(
            &conn,
            "n1",
            "log_capture",
            "2026-05-12T10:00:00Z",
            "note",
            None,
        );
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.notes.len(), 1);
        assert!(!is_empty(&input));
    }

    #[test]
    fn dictations_are_chronological_with_parsed_app() {
        let conn = setup();
        let json = r#"{"app_name":"Arc","browser_tab_title":"Growth Engine","browser_url":"https://growth.example.com/portal/livecase/nurturing/51299f77-ad42-4ee8-8a66-e2ff96138250/edit?x=1","window_title":"Growth Engine"}"#;
        insert_item(&conn, "d2", "voice_at_cursor", "2026-05-12T11:00:00Z", "second", Some(json));
        insert_item(&conn, "d1", "voice_at_cursor", "2026-05-12T10:00:00Z", "first", Some("VS Code"));
        insert_item(&conn, "d3", "voice_at_cursor", "2026-05-12T12:00:00Z", "third", None);
        let input = collect(&conn, "2026-05-12").unwrap();
        let ids: Vec<_> = input.dictations.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["d1", "d2", "d3"]);
        assert_eq!(input.dictations[0].app, "VS Code");
        assert_eq!(input.dictations[1].app, "Arc");
        assert_eq!(
            input.dictations[1].context.as_deref(),
            Some("Growth Engine — growth.example.com/portal/livecase")
        );
        assert_eq!(input.dictations[2].app, UNKNOWN_APP);
    }

    #[test]
    fn parse_capture_context_drops_title_equal_to_app_and_claude_urls() {
        let json = r#"{"app_name":"Claude","window_title":"Claude","content_url":"https://claude.ai/epitaxy/local_x"}"#;
        assert_eq!(parse_capture_context(Some(json)), ("Claude".to_string(), None));
    }

    #[test]
    fn meeting_title_and_summary_come_from_metadata_not_content() {
        let conn = setup();
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES ('m1', '[Summary] ## Summary - blah', 'meeting', 'meeting', '2026-05-12T09:00:00Z', '2026-05-12T09:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meetings (item_id, started_at, status, mic_only, detected_app_name, summary_json)
             VALUES ('m1', '2026-05-12T09:00:00.123+00:00', 'completed', 0, 'Zoom', ?1)",
            params![r###"{"markdown":"## Summary\n- Agreed pricing"}"###],
        )
        .unwrap();
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.meetings[0].title, "Zoom call");
        assert_eq!(
            input.meetings[0].summary.as_deref(),
            Some("## Summary\n- Agreed pricing")
        );
    }

    #[test]
    fn local_day_window_spans_24h_or_dst_length() {
        let (start, end) = local_day_window_utc("2026-09-24").unwrap();
        let s = chrono::NaiveDateTime::parse_from_str(&start, "%Y-%m-%dT%H:%M:%S").unwrap();
        let e = chrono::NaiveDateTime::parse_from_str(&end, "%Y-%m-%dT%H:%M:%S").unwrap();
        let hours = (e - s).num_hours();
        assert!((23..=25).contains(&hours), "got {hours}h");
    }

    #[test]
    fn collect_ignores_other_days() {
        let conn = setup();
        insert_item(
            &conn,
            "n-yesterday",
            "log_capture",
            "2026-05-11T10:00:00Z",
            "x",
            None,
        );
        insert_item(
            &conn,
            "n-today",
            "log_capture",
            "2026-05-12T10:00:00Z",
            "x",
            None,
        );
        insert_item(
            &conn,
            "n-tomorrow",
            "log_capture",
            "2026-05-13T10:00:00Z",
            "x",
            None,
        );
        let input = collect(&conn, "2026-05-12").unwrap();
        assert_eq!(input.notes.len(), 1);
        assert_eq!(input.notes[0].id, "n-today");
    }

    #[test]
    fn collect_ignores_deleted_items() {
        let conn = setup();
        insert_item(
            &conn,
            "n1",
            "log_capture",
            "2026-05-12T10:00:00Z",
            "x",
            None,
        );
        conn.execute(
            "UPDATE items SET deleted_at = '2026-05-12T11:00:00Z' WHERE id = 'n1'",
            [],
        )
        .unwrap();
        let input = collect(&conn, "2026-05-12").unwrap();
        assert!(input.notes.is_empty());
    }
}
