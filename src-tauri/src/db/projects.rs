//! CRUD on the `projects` table.

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

pub fn insert_project(conn: &Connection, p: &Project) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO projects(id, name, created_at, archived_at) VALUES(?1, ?2, ?3, ?4)",
        params![p.id, p.name, p.created_at, p.archived_at],
    )?;
    Ok(())
}

/// Sorted alphabetically by name (case-insensitive).
pub fn list_projects(conn: &Connection, include_archived: bool) -> Result<Vec<Project>, DbError> {
    let sql = if include_archived {
        "SELECT id, name, created_at, archived_at FROM projects ORDER BY name COLLATE NOCASE ASC"
    } else {
        "SELECT id, name, created_at, archived_at FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], row_to_project)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Option<Project>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, archived_at FROM projects WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_project(row)?))
    } else {
        Ok(None)
    }
}

pub fn rename_project(conn: &Connection, id: &str, name: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE projects SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

pub fn archive_project(conn: &Connection, id: &str, now_iso: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE projects SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        params![now_iso, id],
    )?;
    Ok(())
}

pub fn unarchive_project(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE projects SET archived_at = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Count of non-deleted items associated with this project.
pub fn count_items_for_project(conn: &Connection, id: &str) -> Result<u32, DbError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE project_id = ?1 AND deleted_at IS NULL",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn make(id: &str, name: &str) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            created_at: "2026-05-01T00:00:00Z".into(),
            archived_at: None,
        }
    }

    #[test]
    fn list_projects_alphabetical_ignoring_case() {
        let c = fresh();
        insert_project(&c, &make("1", "zeta")).unwrap();
        insert_project(&c, &make("2", "Alpha")).unwrap();
        insert_project(&c, &make("3", "beta")).unwrap();
        let names: Vec<_> = list_projects(&c, false).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["Alpha", "beta", "zeta"]);
    }

    #[test]
    fn archive_excludes_then_unarchive_includes() {
        let c = fresh();
        insert_project(&c, &make("1", "alpha")).unwrap();
        archive_project(&c, "1", "2026-05-02T00:00:00Z").unwrap();
        assert!(list_projects(&c, false).unwrap().is_empty());
        assert_eq!(list_projects(&c, true).unwrap().len(), 1);
        unarchive_project(&c, "1").unwrap();
        assert_eq!(list_projects(&c, false).unwrap().len(), 1);
    }

    #[test]
    fn rename_updates_name() {
        let c = fresh();
        insert_project(&c, &make("1", "alpha")).unwrap();
        rename_project(&c, "1", "Renamed").unwrap();
        let p = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(p.name, "Renamed");
    }
}
