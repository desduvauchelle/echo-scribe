//! CRUD for user-authored guide templates. A template is reusable context
//! (goal + freeform notes) the user attaches to a guided meeting session.

use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuideTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub goal: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_template(row: &Row<'_>) -> rusqlite::Result<GuideTemplate> {
    Ok(GuideTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        goal: row.get("goal")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_template(conn: &Connection, t: &GuideTemplate) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO guide_templates
            (id, name, description, goal, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![t.id, t.name, t.description, t.goal, t.notes, t.created_at, t.updated_at],
    )?;
    Ok(())
}

pub fn list_templates(conn: &Connection) -> Result<Vec<GuideTemplate>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, goal, notes, created_at, updated_at
         FROM guide_templates ORDER BY name COLLATE NOCASE ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_template)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_template(conn: &Connection, id: &str) -> Result<Option<GuideTemplate>, DbError> {
    conn.query_row(
        "SELECT id, name, description, goal, notes, created_at, updated_at
         FROM guide_templates WHERE id = ?1",
        [id],
        row_to_template,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn update_template(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    goal: &str,
    notes: &str,
    updated_at: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE guide_templates
         SET name = ?1, description = ?2, goal = ?3, notes = ?4, updated_at = ?5
         WHERE id = ?6",
        params![name, description, goal, notes, updated_at, id],
    )?;
    Ok(())
}

pub fn delete_template(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM guide_templates WHERE id = ?1", [id])?;
    Ok(())
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

    fn make(id: &str, name: &str) -> GuideTemplate {
        GuideTemplate {
            id: id.into(),
            name: name.into(),
            description: "desc".into(),
            goal: "the goal".into(),
            notes: "ask about tools\nask about bottlenecks".into(),
            created_at: "2026-05-18T00:00:00Z".into(),
            updated_at: "2026-05-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn insert_get_round_trip() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        let got = get_template(&c, "t1").unwrap().unwrap();
        assert_eq!(got, make("t1", "Discovery"));
    }

    #[test]
    fn get_missing_is_none() {
        let c = fresh();
        assert!(get_template(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn list_sorted_by_name_nocase() {
        let c = fresh();
        insert_template(&c, &make("t1", "zebra")).unwrap();
        insert_template(&c, &make("t2", "Alpha")).unwrap();
        let names: Vec<String> = list_templates(&c).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["Alpha".to_string(), "zebra".to_string()]);
    }

    #[test]
    fn update_changes_fields_and_timestamp() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        update_template(&c, "t1", "Renamed", "d2", "g2", "n2", "2026-05-19T00:00:00Z").unwrap();
        let got = get_template(&c, "t1").unwrap().unwrap();
        assert_eq!(got.name, "Renamed");
        assert_eq!(got.description, "d2");
        assert_eq!(got.goal, "g2");
        assert_eq!(got.notes, "n2");
        assert_eq!(got.updated_at, "2026-05-19T00:00:00Z");
        assert_eq!(got.created_at, "2026-05-18T00:00:00Z");
    }

    #[test]
    fn delete_removes_row() {
        let c = fresh();
        insert_template(&c, &make("t1", "Discovery")).unwrap();
        delete_template(&c, "t1").unwrap();
        assert!(get_template(&c, "t1").unwrap().is_none());
    }
}
