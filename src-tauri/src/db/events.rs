//! CRUD on the `item_events` table — lifecycle audit log for items.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::DbError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ItemEvent {
    pub id: String,
    pub item_id: String,
    pub event_type: String,
    pub detail: Option<String>,
    pub created_at: String,
}

/// Insert a lifecycle event for an item.
pub fn insert_event(
    conn: &Connection,
    item_id: &str,
    event_type: &str,
    detail: Option<&str>,
) -> Result<(), DbError> {
    let id = ulid::Ulid::new().to_string();
    let now = crate::db::items::chrono_now_iso();
    conn.execute(
        "INSERT INTO item_events (id, item_id, event_type, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, item_id, event_type, detail, now],
    )?;
    Ok(())
}

/// List all events for a given item, oldest-first.
pub fn list_events_for_item(
    conn: &Connection,
    item_id: &str,
) -> Result<Vec<ItemEvent>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, item_id, event_type, detail, created_at
         FROM item_events
         WHERE item_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(ItemEvent {
            id: row.get("id")?,
            item_id: row.get("item_id")?,
            event_type: row.get("event_type")?,
            detail: row.get("detail")?,
            created_at: row.get("created_at")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Record that an item was used as a RAG context source in a chat session.
/// Ignores duplicates (same item+session pair).
pub fn link_item_to_session(
    conn: &Connection,
    item_id: &str,
    session_id: &str,
) -> Result<(), DbError> {
    let now = crate::db::items::chrono_now_iso();
    conn.execute(
        "INSERT OR IGNORE INTO item_session_links (item_id, session_id, created_at)
         VALUES (?1, ?2, ?3)",
        params![item_id, session_id, now],
    )?;
    Ok(())
}

/// List chat sessions that referenced a given item as a RAG source.
pub fn list_sessions_for_item(
    conn: &Connection,
    item_id: &str,
) -> Result<Vec<super::chat::ChatSession>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT cs.id, cs.name, cs.project_id, cs.created_at, cs.updated_at
         FROM item_session_links isl
         JOIN chat_sessions cs ON cs.id = isl.session_id
         WHERE isl.item_id = ?1
         ORDER BY isl.created_at DESC",
    )?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(super::chat::ChatSession {
            id: row.get("id")?,
            name: row.get("name")?,
            project_id: row.get("project_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;
    use rusqlite::Connection;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn insert_and_list_events() {
        let conn = fresh_db();
        // Need an item to reference.
        crate::db::items::insert_item(
            &conn,
            &crate::db::items::Item {
                id: "item-1".into(),
                content: "hello".into(),
                source: crate::db::items::ItemSource::VoiceAtCursor,
                visibility: crate::db::items::Visibility::Hidden,
                kind: None,
                project_id: None,
                captured_at: "2026-05-01T00:00:00Z".into(),
                created_at: "2026-05-01T00:00:00Z".into(),
                deleted_at: None,
                confidence: None,
                classified_by: None,
            },
        )
        .unwrap();

        insert_event(&conn, "item-1", "created", Some("via voice_at_cursor")).unwrap();
        insert_event(&conn, "item-1", "kind_changed", Some("note → task")).unwrap();

        let events = list_events_for_item(&conn, "item-1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "created");
        assert_eq!(events[1].event_type, "kind_changed");
    }

    #[test]
    fn list_events_returns_empty_for_unknown_item() {
        let conn = fresh_db();
        let events = list_events_for_item(&conn, "nonexistent").unwrap();
        assert!(events.is_empty());
    }
}
