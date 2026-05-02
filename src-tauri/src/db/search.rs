//! Full-text search over `items` via the FTS5 virtual table.

use rusqlite::{params, Connection};

use super::items::{row_to_item_for_search, Item};
use super::DbError;

/// Search items by FTS5 MATCH expression. Soft-deleted items are excluded.
/// Results are ordered by FTS rank (most relevant first).
pub fn search_items(conn: &Connection, query: &str, limit: u32) -> Result<Vec<Item>, DbError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT items.id, items.content, items.source, items.visibility, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL
         ORDER BY rank
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![query, limit as i64], row_to_item_for_search)?;
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
        "SELECT items.id, items.content, items.source, items.visibility, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by
         FROM items
         JOIN items_fts ON items.rowid = items_fts.rowid
         WHERE items_fts MATCH ?1 AND items.deleted_at IS NULL AND items.project_id = ?3
         ORDER BY rank
         LIMIT ?2"
    } else {
        "SELECT items.id, items.content, items.source, items.visibility, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::items::{insert_item, soft_delete_item, Item, ItemSource, Visibility};
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
            visibility: Visibility::Hidden,
            kind: None,
            project_id: None,
            captured_at: "2026-05-01T00:00:00Z".to_string(),
            created_at: "2026-05-01T00:00:00Z".to_string(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
        }
    }

    #[test]
    fn search_items_finds_full_text_match() {
        let conn = fresh_db();
        insert_item(&conn, &make_item("a", "the quick brown fox jumps")).unwrap();
        insert_item(&conn, &make_item("b", "lazy dog barks at moon")).unwrap();
        insert_item(&conn, &make_item("c", "quick action items review")).unwrap();

        let hits = search_items(&conn, "quick", 50).unwrap();
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
        let hits = search_items(&conn, "alpha", 50).unwrap();
        let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["b"]);
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
        }).unwrap();
        insert_project(&conn, &Project {
            id: "proj-2".to_string(),
            name: "Project Two".to_string(),
            created_at: "2026-05-01T00:00:00Z".to_string(),
            archived_at: None,
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
        assert!(search_items(&conn, "", 50).unwrap().is_empty());
        assert!(search_items(&conn, "   ", 50).unwrap().is_empty());
    }
}
