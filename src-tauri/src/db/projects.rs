//! Minimal CRUD on the `projects` table. Phase 2 scope is just enough to
//! reference projects from items; UI surfaces and richer queries land in a
//! later phase.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::DbError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub archived_at: Option<String>,
}

fn row_to_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        archived_at: row.get("archived_at")?,
    })
}

#[allow(dead_code)]
pub fn insert_project(conn: &Connection, p: &Project) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO projects(id, name, created_at, archived_at) VALUES(?1, ?2, ?3, ?4)",
        params![p.id, p.name, p.created_at, p.archived_at],
    )?;
    Ok(())
}

#[allow(dead_code)]
pub fn list_projects(conn: &Connection, include_archived: bool) -> Result<Vec<Project>, DbError> {
    let sql = if include_archived {
        "SELECT id, name, created_at, archived_at FROM projects ORDER BY created_at ASC"
    } else {
        "SELECT id, name, created_at, archived_at FROM projects WHERE archived_at IS NULL ORDER BY created_at ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], row_to_project)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
