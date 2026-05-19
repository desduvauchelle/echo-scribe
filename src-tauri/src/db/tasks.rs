//! Task views over items.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::items::{row_to_item_for_join, Item};
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

pub fn get_task(conn: &Connection, item_id: &str) -> Result<Option<Task>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT item_id, deadline, completed_at FROM tasks WHERE item_id = ?1",
    )?;
    let mut rows = stmt.query(params![item_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Task {
            item_id: row.get(0)?,
            deadline: row.get(1)?,
            completed_at: row.get(2)?,
        }))
    } else {
        Ok(None)
    }
}

/// Mark the task as completed (idempotent). If no task row exists for this
/// item, creates one (caller is expected to have ensured the item is a task).
pub fn complete_task(conn: &Connection, item_id: &str, now_iso: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO tasks(item_id, deadline, completed_at) VALUES(?1, NULL, ?2)
         ON CONFLICT(item_id) DO UPDATE SET completed_at = excluded.completed_at",
        params![item_id, now_iso],
    )?;
    Ok(())
}

pub fn uncomplete_task(conn: &Connection, item_id: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO tasks(item_id, deadline, completed_at) VALUES(?1, NULL, NULL)
         ON CONFLICT(item_id) DO UPDATE SET completed_at = NULL",
        params![item_id],
    )?;
    Ok(())
}

pub fn set_deadline(
    conn: &Connection,
    item_id: &str,
    deadline_iso: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO tasks(item_id, deadline, completed_at) VALUES(?1, ?2, NULL)
         ON CONFLICT(item_id) DO UPDATE SET deadline = excluded.deadline",
        params![item_id, deadline_iso],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskWithItem {
    pub item: Item,
    pub deadline: Option<String>,
    pub completed_at: Option<String>,
}

/// List tasks. Returns rows joined with their backing item.
///
/// - When `include_completed=false`: only tasks with `completed_at IS NULL` AND
///   the item is `kind = 'task'`. Ordered by deadline ASC (NULLs last), then
///   captured_at DESC.
/// - When `include_completed=true`: completed tasks are returned, ordered by
///   `completed_at DESC` (most recently completed first).
pub fn list_tasks(
    conn: &Connection,
    include_completed: bool,
    project_id: Option<&str>,
) -> Result<Vec<TaskWithItem>, DbError> {
    let mut sql = String::from(
        "SELECT items.id, items.content, items.source, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by, items.capture_context,
                tasks.deadline AS deadline, tasks.completed_at AS completed_at
         FROM items
         LEFT JOIN tasks ON tasks.item_id = items.id
         WHERE items.deleted_at IS NULL AND items.kind = 'task'",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(pid) = project_id {
        sql.push_str(" AND items.project_id = ?");
        args.push(Box::new(pid.to_string()));
    }
    if include_completed {
        sql.push_str(" AND tasks.completed_at IS NOT NULL");
        sql.push_str(" ORDER BY tasks.completed_at DESC");
    } else {
        sql.push_str(" AND (tasks.completed_at IS NULL OR tasks.completed_at IS NULL)");
        // Order: deadline asc with nulls last, then captured_at desc.
        sql.push_str(" ORDER BY (tasks.deadline IS NULL) ASC, tasks.deadline ASC, items.captured_at DESC");
    }
    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        let item = row_to_item_for_join(row)?;
        let deadline: Option<String> = row.get("deadline")?;
        let completed_at: Option<String> = row.get("completed_at")?;
        Ok(TaskWithItem {
            item,
            deadline,
            completed_at,
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
    use crate::db::items::{insert_item, Item, ItemKind, ItemSource};
    use crate::db::schema::run_migrations;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn task_item(id: &str, captured: &str) -> Item {
        Item {
            id: id.into(),
            content: format!("task {id}"),
            source: ItemSource::LogCapture,
            kind: Some(ItemKind::Task),
            project_id: None,
            captured_at: captured.into(),
            created_at: captured.into(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context: None,
        }
    }

    #[test]
    fn list_open_tasks_orders_deadline_asc_nulls_last() {
        let c = fresh();
        insert_item(&c, &task_item("a", "2026-05-01T00:00:00Z")).unwrap();
        insert_item(&c, &task_item("b", "2026-05-02T00:00:00Z")).unwrap();
        insert_item(&c, &task_item("c", "2026-05-03T00:00:00Z")).unwrap();

        // a: late deadline. b: no deadline. c: early deadline.
        upsert_task(&c, &Task { item_id: "a".into(), deadline: Some("2026-06-10T00:00:00Z".into()), completed_at: None }).unwrap();
        upsert_task(&c, &Task { item_id: "b".into(), deadline: None, completed_at: None }).unwrap();
        upsert_task(&c, &Task { item_id: "c".into(), deadline: Some("2026-05-15T00:00:00Z".into()), completed_at: None }).unwrap();

        let tasks = list_tasks(&c, false, None).unwrap();
        let ids: Vec<_> = tasks.iter().map(|t| t.item.id.as_str()).collect();
        // c (earliest deadline) → a (later deadline) → b (no deadline)
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn list_completed_tasks_orders_by_completed_desc() {
        let c = fresh();
        insert_item(&c, &task_item("a", "2026-05-01T00:00:00Z")).unwrap();
        insert_item(&c, &task_item("b", "2026-05-02T00:00:00Z")).unwrap();
        upsert_task(&c, &Task { item_id: "a".into(), deadline: None, completed_at: Some("2026-05-05T00:00:00Z".into()) }).unwrap();
        upsert_task(&c, &Task { item_id: "b".into(), deadline: None, completed_at: Some("2026-05-06T00:00:00Z".into()) }).unwrap();
        let tasks = list_tasks(&c, true, None).unwrap();
        let ids: Vec<_> = tasks.iter().map(|t| t.item.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[test]
    fn complete_and_uncomplete_round_trip() {
        let c = fresh();
        insert_item(&c, &task_item("a", "2026-05-01T00:00:00Z")).unwrap();
        complete_task(&c, "a", "2026-05-05T00:00:00Z").unwrap();
        assert!(get_task(&c, "a").unwrap().unwrap().completed_at.is_some());
        uncomplete_task(&c, "a").unwrap();
        assert!(get_task(&c, "a").unwrap().unwrap().completed_at.is_none());
    }

    #[test]
    fn set_deadline_updates_existing() {
        let c = fresh();
        insert_item(&c, &task_item("a", "2026-05-01T00:00:00Z")).unwrap();
        set_deadline(&c, "a", Some("2026-05-10T00:00:00Z")).unwrap();
        assert_eq!(
            get_task(&c, "a").unwrap().unwrap().deadline.as_deref(),
            Some("2026-05-10T00:00:00Z")
        );
        set_deadline(&c, "a", None).unwrap();
        assert!(get_task(&c, "a").unwrap().unwrap().deadline.is_none());
    }

    #[test]
    fn list_tasks_filters_by_project() {
        let c = fresh();
        // FK requires both project rows to exist.
        for pid in &["p1", "p2"] {
            crate::db::projects::insert_project(
                &c,
                &crate::db::projects::Project {
                    id: (*pid).to_string(),
                    name: (*pid).to_string(),
                    created_at: "2026-05-01T00:00:00Z".into(),
                    archived_at: None,
                },
            )
            .unwrap();
        }
        let mut a = task_item("a", "2026-05-01T00:00:00Z");
        a.project_id = Some("p1".into());
        let mut b = task_item("b", "2026-05-02T00:00:00Z");
        b.project_id = Some("p2".into());
        insert_item(&c, &a).unwrap();
        insert_item(&c, &b).unwrap();
        upsert_task(&c, &Task { item_id: "a".into(), deadline: None, completed_at: None }).unwrap();
        upsert_task(&c, &Task { item_id: "b".into(), deadline: None, completed_at: None }).unwrap();

        let only_p1 = list_tasks(&c, false, Some("p1")).unwrap();
        assert_eq!(only_p1.len(), 1);
        assert_eq!(only_p1[0].item.id, "a");
    }
}
