//! CRUD on the `items` table.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::DbError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemSource {
    VoiceAtCursor,
    LogCapture,
}

impl ItemSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemSource::VoiceAtCursor => "voice_at_cursor",
            ItemSource::LogCapture => "log_capture",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "voice_at_cursor" => Some(ItemSource::VoiceAtCursor),
            "log_capture" => Some(ItemSource::LogCapture),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Hidden,
    Visible,
}

impl Visibility {
    pub fn as_str(&self) -> &'static str {
        match self {
            Visibility::Hidden => "hidden",
            Visibility::Visible => "visible",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "hidden" => Some(Visibility::Hidden),
            "visible" => Some(Visibility::Visible),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Note,
    Task,
}

impl ItemKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemKind::Note => "note",
            ItemKind::Task => "task",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "note" => Some(ItemKind::Note),
            "task" => Some(ItemKind::Task),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: String,
    pub content: String,
    pub source: ItemSource,
    pub visibility: Visibility,
    pub kind: Option<ItemKind>,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub confidence: Option<f32>,
    pub classified_by: Option<String>,
    pub capture_context: Option<String>,
}

pub(crate) fn row_to_item_for_search(row: &Row<'_>) -> rusqlite::Result<Item> {
    row_to_item(row)
}

pub(crate) fn row_to_item_for_join(row: &Row<'_>) -> rusqlite::Result<Item> {
    row_to_item(row)
}

fn row_to_item(row: &Row<'_>) -> rusqlite::Result<Item> {
    let source_s: String = row.get("source")?;
    let visibility_s: String = row.get("visibility")?;
    let kind_s: Option<String> = row.get("kind")?;
    Ok(Item {
        id: row.get("id")?,
        content: row.get("content")?,
        source: ItemSource::parse(&source_s).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("invalid source: {source_s}").into(),
            )
        })?,
        visibility: Visibility::parse(&visibility_s).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("invalid visibility: {visibility_s}").into(),
            )
        })?,
        kind: kind_s.and_then(|s| ItemKind::parse(&s)),
        project_id: row.get("project_id")?,
        captured_at: row.get("captured_at")?,
        created_at: row.get("created_at")?,
        deleted_at: row.get("deleted_at")?,
        confidence: row.get::<_, Option<f64>>("confidence")?.map(|v| v as f32),
        classified_by: row.get("classified_by")?,
        capture_context: row.get("capture_context")?,
    })
}

pub fn insert_item(conn: &Connection, item: &Item) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO items
            (id, content, source, visibility, kind, project_id, captured_at, created_at,
             deleted_at, confidence, classified_by, capture_context)
         VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            item.id,
            item.content,
            item.source.as_str(),
            item.visibility.as_str(),
            item.kind.map(|k| k.as_str()),
            item.project_id,
            item.captured_at,
            item.created_at,
            item.deleted_at,
            item.confidence.map(|f| f as f64),
            item.classified_by,
            item.capture_context,
        ],
    )?;
    Ok(())
}

pub fn get_item(conn: &Connection, id: &str) -> Result<Option<Item>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, content, source, visibility, kind, project_id, captured_at, created_at,
                deleted_at, confidence, classified_by, capture_context
         FROM items WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_item(row)?))
    } else {
        Ok(None)
    }
}

/// Newest-first list, soft-deleted excluded.
pub fn list_items(
    conn: &Connection,
    visibility: Option<Visibility>,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Item>, DbError> {
    let mut sql = String::from(
        "SELECT id, content, source, visibility, kind, project_id, captured_at, created_at,
                deleted_at, confidence, classified_by, capture_context
         FROM items WHERE deleted_at IS NULL",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(v) = visibility {
        sql.push_str(" AND visibility = ?");
        args.push(Box::new(v.as_str().to_string()));
    }
    if let Some(pid) = project_id {
        sql.push_str(" AND project_id = ?");
        args.push(Box::new(pid.to_string()));
    }
    sql.push_str(" ORDER BY captured_at DESC LIMIT ? OFFSET ?");
    args.push(Box::new(limit as i64));
    args.push(Box::new(offset as i64));

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), row_to_item)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn soft_delete_item(conn: &Connection, id: &str) -> Result<(), DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "UPDATE items SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    Ok(())
}

/// Restore a soft-deleted item (clears `deleted_at`).
pub fn restore_item(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE items SET deleted_at = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// In-place item update. Each field is optional; `None` means "leave alone".
/// `project_id` uses double-Option semantics: outer `None` = leave alone,
/// outer `Some(None)` = clear, outer `Some(Some(id))` = set.
#[allow(clippy::too_many_arguments)]
pub fn update_item(
    conn: &Connection,
    id: &str,
    content: Option<&str>,
    project_id: Option<Option<&str>>,
    kind: Option<Option<ItemKind>>,
) -> Result<(), DbError> {
    if let Some(c) = content {
        conn.execute(
            "UPDATE items SET content = ?1 WHERE id = ?2",
            params![c, id],
        )?;
    }
    if let Some(pid) = project_id {
        conn.execute(
            "UPDATE items SET project_id = ?1 WHERE id = ?2",
            params![pid, id],
        )?;
    }
    if let Some(k) = kind {
        conn.execute(
            "UPDATE items SET kind = ?1 WHERE id = ?2",
            params![k.map(|kk| kk.as_str()), id],
        )?;
    }
    Ok(())
}

pub fn replace_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<(), DbError> {
    conn.execute("DELETE FROM item_tags WHERE item_id = ?1", params![item_id])?;
    for t in tags {
        conn.execute(
            "INSERT OR IGNORE INTO item_tags(item_id, tag) VALUES(?1, ?2)",
            params![item_id, t],
        )?;
    }
    Ok(())
}

pub fn list_tags_for_item(conn: &Connection, item_id: &str) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare("SELECT tag FROM item_tags WHERE item_id = ?1 ORDER BY tag ASC")?;
    let rows = stmt.query_map(params![item_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn count_items(conn: &Connection, visibility: Option<Visibility>) -> Result<u32, DbError> {
    let count: i64 = match visibility {
        Some(v) => conn.query_row(
            "SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND visibility = ?1",
            params![v.as_str()],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT COUNT(*) FROM items WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )?,
    };
    Ok(count.max(0) as u32)
}

/// Tiny ISO-8601-ish UTC timestamp helper. We avoid a `chrono` dep — `SystemTime`
/// → seconds-since-epoch → format manually. Stable, sortable, good enough.
pub fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_iso_utc(secs)
}

pub(crate) fn format_iso_utc(secs: i64) -> String {
    // Civil-from-days. Algorithm via Howard Hinnant.
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
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

    let h = time_of_day / 3600;
    let min = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, h, min, s
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make_item(id: &str, content: &str, vis: Visibility, captured: &str) -> Item {
        Item {
            id: id.to_string(),
            content: content.to_string(),
            source: ItemSource::VoiceAtCursor,
            visibility: vis,
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
    fn insert_item_then_get_round_trips() {
        let conn = fresh_db();
        let item = make_item("01A", "hello", Visibility::Hidden, "2026-05-01T00:00:00Z");
        insert_item(&conn, &item).unwrap();
        let got = get_item(&conn, "01A").unwrap().unwrap();
        assert_eq!(got, item);
    }

    #[test]
    fn list_items_filters_by_visibility() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z")).unwrap();
        insert_item(&conn, &make_item("b", "y", Visibility::Visible, "2026-05-01T00:00:01Z")).unwrap();

        let hidden = list_items(&conn, Some(Visibility::Hidden), None, 50, 0).unwrap();
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0].id, "a");

        let visible = list_items(&conn, Some(Visibility::Visible), None, 50, 0).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "b");

        let all = list_items(&conn, None, None, 50, 0).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn list_items_orders_newest_first() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("old", "x", Visibility::Hidden, "2026-04-01T00:00:00Z")).unwrap();
        insert_item(&conn, &make_item("mid", "y", Visibility::Hidden, "2026-04-15T00:00:00Z")).unwrap();
        insert_item(&conn, &make_item("new", "z", Visibility::Hidden, "2026-05-01T00:00:00Z")).unwrap();

        let listed = list_items(&conn, None, None, 50, 0).unwrap();
        let ids: Vec<&str> = listed.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn soft_delete_excludes_from_list_items() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z")).unwrap();
        insert_item(&conn, &make_item("b", "y", Visibility::Hidden, "2026-05-01T00:00:01Z")).unwrap();

        soft_delete_item(&conn, "a").unwrap();
        let listed = list_items(&conn, None, None, 50, 0).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "b");

        // get_item still returns the deleted row (raw fetch).
        let got = get_item(&conn, "a").unwrap().unwrap();
        assert!(got.deleted_at.is_some());
    }

    #[test]
    fn soft_delete_is_idempotent() {
        // Second call must be a no-op: the WHERE clause excludes already-deleted rows
        // so the original deleted_at timestamp is preserved.
        let conn = fresh_db();
        insert_item(
            &conn,
            &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z"),
        )
        .unwrap();
        soft_delete_item(&conn, "a").unwrap();
        let first = get_item(&conn, "a").unwrap().unwrap().deleted_at.unwrap();
        // Sleep would be flaky; instead just verify the second call doesn't change
        // the timestamp (the SQL WHERE clause guards against re-stamping).
        soft_delete_item(&conn, "a").unwrap();
        let second = get_item(&conn, "a").unwrap().unwrap().deleted_at.unwrap();
        assert_eq!(first, second, "second soft-delete must not overwrite deleted_at");
    }

    #[test]
    fn restore_item_clears_deleted_at() {
        let conn = fresh_db();
        insert_item(
            &conn,
            &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z"),
        )
        .unwrap();
        soft_delete_item(&conn, "a").unwrap();
        assert!(list_items(&conn, None, None, 50, 0).unwrap().is_empty());
        restore_item(&conn, "a").unwrap();
        assert_eq!(list_items(&conn, None, None, 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn update_item_modifies_fields() {
        let conn = fresh_db();
        insert_item(
            &conn,
            &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z"),
        )
        .unwrap();
        // Content + kind set.
        update_item(&conn, "a", Some("hello"), None, Some(Some(ItemKind::Task))).unwrap();
        let it = get_item(&conn, "a").unwrap().unwrap();
        assert_eq!(it.content, "hello");
        assert_eq!(it.kind, Some(ItemKind::Task));

        // Clear kind via Some(None).
        update_item(&conn, "a", None, None, Some(None)).unwrap();
        let it = get_item(&conn, "a").unwrap().unwrap();
        assert_eq!(it.kind, None);

        // Project id set + clear.
        // FK requires the project row exists first.
        crate::db::projects::insert_project(
            &conn,
            &crate::db::projects::Project {
                id: "proj-1".into(),
                name: "p".into(),
                created_at: "2026-05-01T00:00:00Z".into(),
                archived_at: None,
            },
        )
        .unwrap();
        update_item(&conn, "a", None, Some(Some("proj-1")), None).unwrap();
        assert_eq!(
            get_item(&conn, "a").unwrap().unwrap().project_id.as_deref(),
            Some("proj-1")
        );
        update_item(&conn, "a", None, Some(None), None).unwrap();
        assert!(get_item(&conn, "a").unwrap().unwrap().project_id.is_none());
    }

    #[test]
    fn replace_tags_overwrites() {
        let conn = fresh_db();
        insert_item(
            &conn,
            &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z"),
        )
        .unwrap();
        replace_tags(&conn, "a", &["alpha".into(), "beta".into()]).unwrap();
        assert_eq!(
            list_tags_for_item(&conn, "a").unwrap(),
            vec!["alpha".to_string(), "beta".into()]
        );
        replace_tags(&conn, "a", &["gamma".into()]).unwrap();
        assert_eq!(list_tags_for_item(&conn, "a").unwrap(), vec!["gamma".to_string()]);
    }

    #[test]
    fn count_items_respects_soft_delete_and_visibility() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "x", Visibility::Hidden, "2026-05-01T00:00:00Z")).unwrap();
        insert_item(&conn, &make_item("b", "y", Visibility::Visible, "2026-05-01T00:00:01Z")).unwrap();
        insert_item(&conn, &make_item("c", "z", Visibility::Hidden, "2026-05-01T00:00:02Z")).unwrap();
        soft_delete_item(&conn, "c").unwrap();

        assert_eq!(count_items(&conn, None).unwrap(), 2);
        assert_eq!(count_items(&conn, Some(Visibility::Hidden)).unwrap(), 1);
        assert_eq!(count_items(&conn, Some(Visibility::Visible)).unwrap(), 1);
    }

    #[test]
    fn format_iso_utc_known_epoch() {
        assert_eq!(format_iso_utc(0), "1970-01-01T00:00:00Z");
        // 2026-05-01T00:00:00Z
        assert_eq!(format_iso_utc(1_777_593_600), "2026-05-01T00:00:00Z");
        // 2024-02-29T12:34:56Z (leap-day round-trip sanity)
        assert_eq!(format_iso_utc(1_709_210_096), "2024-02-29T12:34:56Z");
    }
}
