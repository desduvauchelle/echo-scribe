//! CRUD for chat sessions and messages.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::db::items::chrono_now_iso;
use super::DbError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub fn insert_session(
    conn: &Connection,
    id: &str,
    name: &str,
    project_id: Option<&str>,
) -> Result<ChatSession, DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "INSERT INTO chat_sessions (id, name, project_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, project_id, now, now],
    )?;
    Ok(ChatSession {
        id: id.to_string(),
        name: name.to_string(),
        project_id: project_id.map(|s| s.to_string()),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_sessions(
    conn: &Connection,
    project_id: Option<&str>,
) -> Result<Vec<ChatSession>, DbError> {
    let sql = if project_id.is_some() {
        "SELECT id, name, project_id, created_at, updated_at
         FROM chat_sessions WHERE project_id = ?1
         ORDER BY updated_at DESC"
    } else {
        "SELECT id, name, project_id, created_at, updated_at
         FROM chat_sessions
         ORDER BY updated_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = if let Some(pid) = project_id {
        stmt.query_map(params![pid], row_to_session)?
    } else {
        stmt.query_map([], row_to_session)?
    };
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn rename_session(conn: &Connection, id: &str, name: &str) -> Result<(), DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "UPDATE chat_sessions SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, id],
    )?;
    Ok(())
}

pub fn touch_session(conn: &Connection, id: &str) -> Result<(), DbError> {
    let now = chrono_now_iso();
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn insert_message(
    conn: &Connection,
    session_id: &str,
    role: &str,
    content: &str,
) -> Result<ChatMessage, DbError> {
    let id = Ulid::new().to_string();
    let now = chrono_now_iso();
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, session_id, role, content, now],
    )?;
    Ok(ChatMessage {
        id,
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        created_at: now,
    })
}

/// Load the most recent `limit` messages for a session, returned oldest-first.
pub fn load_messages(
    conn: &Connection,
    session_id: &str,
    limit: u32,
) -> Result<Vec<ChatMessage>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at
         FROM (
           SELECT id, session_id, role, content, created_at
           FROM chat_messages
           WHERE session_id = ?1
           ORDER BY created_at DESC
           LIMIT ?2
         )
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![session_id, limit as i64], |row| {
        Ok(ChatMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSession> {
    Ok(ChatSession {
        id: row.get(0)?,
        name: row.get(1)?,
        project_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", &"ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    #[test]
    fn insert_and_list_session() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "My Session", None).unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "My Session");
    }

    #[test]
    fn list_sessions_ordered_by_updated_at_desc() {
        let conn = fresh_db();
        // Insert both sessions, then force distinct updated_at values via raw SQL
        // so the ordering is deterministic regardless of wall-clock granularity.
        insert_session(&conn, "s1", "Older", None).unwrap();
        insert_session(&conn, "s2", "Newer", None).unwrap();
        conn.execute(
            "UPDATE chat_sessions SET updated_at = '2026-01-01T00:00:01Z' WHERE id = 's1'",
            [],
        ).unwrap();
        conn.execute(
            "UPDATE chat_sessions SET updated_at = '2026-01-01T00:00:02Z' WHERE id = 's2'",
            [],
        ).unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert_eq!(sessions[0].id, "s2");
    }

    #[test]
    fn rename_session_works() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "Old Name", None).unwrap();
        rename_session(&conn, "s1", "New Name").unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert_eq!(sessions[0].name, "New Name");
    }

    #[test]
    fn delete_session_cascades_messages() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "Session", None).unwrap();
        insert_message(&conn, "s1", "user", "hello").unwrap();
        insert_message(&conn, "s1", "assistant", "world").unwrap();
        delete_session(&conn, "s1").unwrap();
        let sessions = list_sessions(&conn, None).unwrap();
        assert!(sessions.is_empty());
        let msgs = load_messages(&conn, "s1", 20).unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn load_messages_capped_at_limit() {
        let conn = fresh_db();
        insert_session(&conn, "s1", "S", None).unwrap();
        for i in 0..25u32 {
            insert_message(&conn, "s1", "user", &format!("msg {i}")).unwrap();
        }
        let msgs = load_messages(&conn, "s1", 20).unwrap();
        assert_eq!(msgs.len(), 20);
    }

    #[test]
    fn list_sessions_filtered_by_project() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO projects(id, name, created_at) VALUES ('p1', 'Proj', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        insert_session(&conn, "s1", "In project", Some("p1")).unwrap();
        insert_session(&conn, "s2", "No project", None).unwrap();
        let filtered = list_sessions(&conn, Some("p1")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "s1");
        let all = list_sessions(&conn, None).unwrap();
        assert_eq!(all.len(), 2);
    }
}
