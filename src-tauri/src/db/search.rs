//! Full-text search over `items` via the FTS5 virtual table.

use rusqlite::{params, Connection};

use super::items::{row_to_item_for_search, Item};
use super::DbError;

/// Search items by FTS5 MATCH expression. Soft-deleted items are excluded.
/// Results are ordered by FTS rank (most relevant first).
/// `kind` optionally restricts results to one exact item kind — `"meeting"`
/// matches the meeting itself, not items captured during it (mirrors
/// `db::items::list_items`).
pub fn search_items(
    conn: &Connection,
    query: &str,
    kind: Option<&str>,
    limit: u32,
) -> Result<Vec<Item>, DbError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = String::from(
        "SELECT items.id, items.content, items.source, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by, items.capture_context
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(query.to_string()), Box::new(limit as i64)];
    if let Some(k) = kind {
        sql.push_str(" AND items.kind = ?3");
        args.push(Box::new(k.to_string()));
    }
    sql.push_str(" ORDER BY rank LIMIT ?2");

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), row_to_item_for_search)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Search items by FTS5 MATCH, optionally scoped to a single project.
/// When `project_id` is `None`, searches all items (same as `search_items`).
pub fn search_items_for_project(
    conn: &Connection,
    query: &str,
    project_id: Option<&str>,
    limit: u32,
) -> Result<Vec<Item>, DbError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sql = if project_id.is_some() {
        "SELECT items.id, items.content, items.source, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by, items.capture_context
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL AND items.project_id = ?3
         ORDER BY rank
         LIMIT ?2"
    } else {
        "SELECT items.id, items.content, items.source, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by, items.capture_context
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL
         ORDER BY rank
         LIMIT ?2"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = if let Some(pid) = project_id {
        stmt.query_map(params![query, limit as i64, pid], row_to_item_for_search)?
    } else {
        stmt.query_map(params![query, limit as i64], row_to_item_for_search)?
    };
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// FTS5 search with optional date window and optional project scope.
/// `from` and `to` are ISO-8601 strings matched against `captured_at`.
/// When either is `None`, that bound is not applied.
pub fn search_items_with_date_window(
    conn: &Connection,
    query: &str,
    from: Option<&str>,
    to: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
) -> Result<Vec<Item>, DbError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = String::from(
        "SELECT items.id, items.content, items.source, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by, items.capture_context
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(query.to_string()),
        Box::new(limit as i64),
    ];
    let mut next_idx = 3usize;

    if let Some(f) = from {
        sql.push_str(&format!(" AND items.captured_at >= ?{next_idx}"));
        args.push(Box::new(f.to_string()));
        next_idx += 1;
    }
    if let Some(t) = to {
        sql.push_str(&format!(" AND items.captured_at <= ?{next_idx}"));
        args.push(Box::new(t.to_string()));
        next_idx += 1;
    }
    if let Some(pid) = project_id {
        sql.push_str(&format!(" AND items.project_id = ?{next_idx}"));
        args.push(Box::new(pid.to_string()));
    }
    sql.push_str(" ORDER BY rank LIMIT ?2");

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), row_to_item_for_search)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::{insert_item, soft_delete_item, Item, ItemSource};
    use crate::db::projects::{insert_project, Project};
    use crate::db::schema::run_migrations;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make_item(id: &str, content: &str) -> Item {
        Item {
            id: id.to_string(),
            content: content.to_string(),
            source: ItemSource::VoiceAtCursor,
            kind: None,
            project_id: None,
            captured_at: "2026-05-01T00:00:00Z".to_string(),
            created_at: "2026-05-01T00:00:00Z".to_string(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context: None,
        }
    }

    #[test]
    fn search_items_finds_full_text_match() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "the quick brown fox jumps")).unwrap();
        insert_item(&conn, &make_item("b", "lazy dog barks at moon")).unwrap();
        insert_item(&conn, &make_item("c", "quick action items review")).unwrap();

        let hits = search_items(&conn, "quick", None, 50).unwrap();
        let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"c"));
        assert!(!ids.contains(&"b"));
    }

    #[test]
    fn search_excludes_soft_deleted() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "alpha bravo charlie")).unwrap();
        insert_item(&conn, &make_item("b", "alpha delta echo")).unwrap();

        soft_delete_item(&conn, "a").unwrap();
        let hits = search_items(&conn, "alpha", None, 50).unwrap();
        let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn search_items_filters_by_kind() {
        let conn = fresh_db();
        let mut note = make_item("n1", "alpha planning note");
        note.kind = Some(crate::db::items::ItemKind::Note);
        insert_item(&conn, &note).unwrap();

        let mut task = make_item("k1", "alpha planning task");
        task.kind = Some(crate::db::items::ItemKind::Task);
        insert_item(&conn, &task).unwrap();

        // Meeting row via raw SQL (no ItemKind::Meeting variant).
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES ('m1', 'alpha planning meeting', 'meeting', 'meeting', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')",
            [],
        )
        .unwrap();

        // Meeting-derived task: source = meeting but kind = task.
        let mut mtask = make_item("m2", "alpha planning follow-up");
        mtask.kind = Some(crate::db::items::ItemKind::Task);
        mtask.source = crate::db::items::ItemSource::Meeting;
        insert_item(&conn, &mtask).unwrap();

        let ids = |kind: Option<&str>| {
            let mut v: Vec<String> = search_items(&conn, "alpha", kind, 50)
                .unwrap()
                .iter()
                .map(|i| i.id.clone())
                .collect();
            v.sort();
            v
        };

        assert_eq!(ids(None), vec!["k1", "m1", "m2", "n1"]);
        assert_eq!(ids(Some("note")), vec!["n1"]);
        assert_eq!(ids(Some("task")), vec!["k1", "m2"]);
        // Exact kind: the meeting, not the task it produced.
        assert_eq!(ids(Some("meeting")), vec!["m1"]);
    }

    #[test]
    fn search_items_filters_by_project() {
        let conn = fresh_db();

        // Insert projects so FK constraints are satisfied
        insert_project(&conn, &Project {
            id: "proj-1".to_string(),
            name: "Project One".to_string(),
            created_at: "2026-05-01T00:00:00Z".to_string(),
            archived_at: None,
            ..Default::default()
        }).unwrap();
        insert_project(&conn, &Project {
            id: "proj-2".to_string(),
            name: "Project Two".to_string(),
            created_at: "2026-05-01T00:00:00Z".to_string(),
            archived_at: None,
            ..Default::default()
        }).unwrap();

        let mut item_a = make_item("a", "alpha bravo meeting notes");
        item_a.project_id = Some("proj-1".to_string());
        insert_item(&conn, &item_a).unwrap();

        let mut item_b = make_item("b", "alpha delta standup notes");
        item_b.project_id = Some("proj-2".to_string());
        insert_item(&conn, &item_b).unwrap();

        let mut item_c = make_item("c", "alpha gamma design review");
        item_c.project_id = None;
        insert_item(&conn, &item_c).unwrap();

        // Filter to proj-1 only
        let hits = search_items_for_project(&conn, "alpha", Some("proj-1"), 50).unwrap();
        let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);

        // No filter — returns all
        let hits = search_items_for_project(&conn, "alpha", None, 50).unwrap();
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn search_empty_query_returns_empty() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "hello")).unwrap();
        assert!(search_items(&conn, "", None, 50).unwrap().is_empty());
        assert!(search_items(&conn, "   ", None, 50).unwrap().is_empty());
    }

    #[test]
    fn search_with_date_window_filters_by_date() {
        let conn = fresh_db();
        let mut old = make_item("a", "standup blocker meeting");
        old.captured_at = "2026-04-01T10:00:00Z".to_string();
        old.created_at = old.captured_at.clone();
        insert_item(&conn, &old).unwrap();

        let mut recent = make_item("b", "standup blocker review");
        recent.captured_at = "2026-05-02T10:00:00Z".to_string();
        recent.created_at = recent.captured_at.clone();
        insert_item(&conn, &recent).unwrap();

        let hits = search_items_with_date_window(
            &conn,
            "standup",
            Some("2026-05-01T00:00:00Z"),
            Some("2026-05-03T00:00:00Z"),
            None,
            50,
        ).unwrap();
        let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"b"));
        assert!(!ids.contains(&"a"));
    }

    #[test]
    fn search_with_date_window_no_window_returns_all() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "project planning notes")).unwrap();
        insert_item(&conn, &make_item("b", "project review session")).unwrap();
        let hits = search_items_with_date_window(&conn, "project", None, None, None, 50).unwrap();
        assert_eq!(hits.len(), 2);
    }
}
