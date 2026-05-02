//! Task views over items. Phase 2: minimal scaffolding only. Phase 3+ will
//! add classifier integration and richer queries (overdue, by deadline, etc.).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::DbError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Task {
    pub item_id: String,
    pub deadline: Option<String>,
    pub completed_at: Option<String>,
}

pub fn upsert_task(conn: &Connection, t: &Task) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO tasks(item_id, deadline, completed_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(item_id) DO UPDATE SET
            deadline = excluded.deadline,
            completed_at = excluded.completed_at",
        params![t.item_id, t.deadline, t.completed_at],
    )?;
    Ok(())
}
