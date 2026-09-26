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
    let mut stmt =
        conn.prepare("SELECT item_id, deadline, completed_at FROM tasks WHERE item_id = ?1")?;
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
    /// Person the task is assigned to (migration 35). `None` = me.
    #[serde(default)]
    pub assignee_person_id: Option<String>,
    /// Name of the assignee, joined from `people`. `None` when unassigned or
    /// the person was deleted.
    #[serde(default)]
    pub assignee_name: Option<String>,
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
                items.confidence, items.classified_by, items.capture_context, items.importance,
                tasks.deadline AS deadline, tasks.completed_at AS completed_at,
                tasks.assignee_person_id AS assignee_person_id,
                assignee.name AS assignee_name
         FROM items
         LEFT JOIN tasks ON tasks.item_id = items.id
         LEFT JOIN people assignee
           ON assignee.id = tasks.assignee_person_id AND assignee.deleted_at IS NULL
         WHERE items.deleted_at IS NULL AND items.kind = 'task'
           AND tasks.focus_rank IS NULL",
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
        sql.push_str(
            " ORDER BY (tasks.deadline IS NULL) ASC, tasks.deadline ASC, items.captured_at DESC",
        );
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
            assignee_person_id: row.get("assignee_person_id")?,
            assignee_name: row.get("assignee_name")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ── Focus tasks ──────────────────────────────────────────────────────────
// A focus task is an ordinary task item whose `tasks.focus_rank` is set. It
// shows only in the dashboard Focus section (ordered by rank) and is left out
// of `list_tasks`.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FocusTask {
    pub item: Item,
    pub completed_at: Option<String>,
    pub focus_rank: i64,
}

pub fn list_focus_tasks(conn: &Connection) -> Result<Vec<FocusTask>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT items.id, items.content, items.source, items.kind,
                items.project_id, items.captured_at, items.created_at, items.deleted_at,
                items.confidence, items.classified_by, items.capture_context, items.importance,
                tasks.completed_at AS completed_at, tasks.focus_rank AS focus_rank
         FROM items
         JOIN tasks ON tasks.item_id = items.id
         WHERE items.deleted_at IS NULL AND items.kind = 'task'
           AND tasks.focus_rank IS NOT NULL
         ORDER BY tasks.focus_rank ASC, items.captured_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(FocusTask {
            item: row_to_item_for_join(row)?,
            completed_at: row.get("completed_at")?,
            focus_rank: row.get("focus_rank")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Is `item_id` a (live) focus task?
pub fn is_focus_task(conn: &Connection, item_id: &str) -> Result<bool, DbError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tasks JOIN items ON items.id = tasks.item_id
         WHERE tasks.item_id = ?1 AND tasks.focus_rank IS NOT NULL AND items.deleted_at IS NULL",
        params![item_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Mark a task as focus (appended to the end of the list) or back to an
/// ordinary task (`focus = false`). Creates the task row if missing.
pub fn set_focus(conn: &Connection, item_id: &str, focus: bool) -> Result<(), DbError> {
    if focus {
        if is_focus_task(conn, item_id)? {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO tasks(item_id, deadline, completed_at, focus_rank)
             VALUES(?1, NULL, NULL, (SELECT COALESCE(MAX(focus_rank), 0) + 1 FROM tasks))
             ON CONFLICT(item_id) DO UPDATE SET focus_rank = excluded.focus_rank",
            params![item_id],
        )?;
    } else {
        conn.execute(
            "UPDATE tasks SET focus_rank = NULL WHERE item_id = ?1",
            params![item_id],
        )?;
    }
    Ok(())
}

/// Create a new focus task item at the end of the focus list.
pub fn add_focus_task(
    conn: &Connection,
    project_id: Option<&str>,
    content: &str,
    classified_by: &str,
) -> Result<Item, DbError> {
    let now = super::items::chrono_now_iso();
    let item = Item {
        id: ulid::Ulid::new().to_string(),
        content: content.to_string(),
        source: super::items::ItemSource::LogCapture,
        kind: Some(super::items::ItemKind::Task),
        project_id: project_id.map(str::to_string),
        captured_at: now.clone(),
        created_at: now,
        deleted_at: None,
        confidence: Some(1.0),
        classified_by: Some(classified_by.to_string()),
        capture_context: None,
        importance: None,
    };
    let tx = conn.unchecked_transaction()?;
    super::items::insert_item(&tx, &item)?;
    set_focus(&tx, &item.id, true)?;
    super::events::insert_event(&tx, &item.id, "created", Some("focus"))?;
    tx.commit()?;
    Ok(item)
}

/// One row of a reordered focus board: the item and the project it now sits
/// under (`None` = no project).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FocusOrderEntry {
    pub item_id: String,
    pub project_id: Option<String>,
}

/// Rewrite focus ranks (and project moves from cross-card drags) in one go.
/// Only rows that are already focus tasks are touched.
pub fn reorder_focus_tasks(conn: &Connection, order: &[FocusOrderEntry]) -> Result<(), DbError> {
    let tx = conn.unchecked_transaction()?;
    for (i, entry) in order.iter().enumerate() {
        let n = tx.execute(
            "UPDATE tasks SET focus_rank = ?2 WHERE item_id = ?1 AND focus_rank IS NOT NULL",
            params![entry.item_id, (i + 1) as i64],
        )?;
        if n == 0 {
            continue;
        }
        let moved = tx.execute(
            "UPDATE items SET project_id = ?2 WHERE id = ?1 AND project_id IS NOT ?2",
            params![entry.item_id, entry.project_id],
        )?;
        if moved > 0 {
            super::events::insert_event(
                &tx,
                &entry.item_id,
                "project_assigned",
                entry.project_id.as_deref(),
            )?;
        }
    }
    tx.commit()?;
    Ok(())
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
            importance: None,
        }
    }

    #[test]
    fn list_open_tasks_orders_deadline_asc_nulls_last() {
        let c = fresh();
        insert_item(&c, &task_item("a", "2026-05-01T00:00:00Z")).unwrap();
        insert_item(&c, &task_item("b", "2026-05-02T00:00:00Z")).unwrap();
        insert_item(&c, &task_item("c", "2026-05-03T00:00:00Z")).unwrap();

        // a: late deadline. b: no deadline. c: early deadline.
        upsert_task(
            &c,
            &Task {
                item_id: "a".into(),
                deadline: Some("2026-06-10T00:00:00Z".into()),
                completed_at: None,
            },
        )
        .unwrap();
        upsert_task(
            &c,
            &Task {
                item_id: "b".into(),
                deadline: None,
                completed_at: None,
            },
        )
        .unwrap();
        upsert_task(
            &c,
            &Task {
                item_id: "c".into(),
                deadline: Some("2026-05-15T00:00:00Z".into()),
                completed_at: None,
            },
        )
        .unwrap();

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
        upsert_task(
            &c,
            &Task {
                item_id: "a".into(),
                deadline: None,
                completed_at: Some("2026-05-05T00:00:00Z".into()),
            },
        )
        .unwrap();
        upsert_task(
            &c,
            &Task {
                item_id: "b".into(),
                deadline: None,
                completed_at: Some("2026-05-06T00:00:00Z".into()),
            },
        )
        .unwrap();
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
                    ..Default::default()
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
        upsert_task(
            &c,
            &Task {
                item_id: "a".into(),
                deadline: None,
                completed_at: None,
            },
        )
        .unwrap();
        upsert_task(
            &c,
            &Task {
                item_id: "b".into(),
                deadline: None,
                completed_at: None,
            },
        )
        .unwrap();

        let only_p1 = list_tasks(&c, false, Some("p1")).unwrap();
        assert_eq!(only_p1.len(), 1);
        assert_eq!(only_p1[0].item.id, "a");
    }

    #[test]
    fn focus_tasks_are_separate_from_task_lists_and_reorderable() {
        let c = fresh();
        crate::db::projects::insert_project(
            &c,
            &crate::db::projects::Project {
                id: "p1".into(),
                name: "p1".into(),
                created_at: "2026-05-01T00:00:00Z".into(),
                archived_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        insert_item(&c, &task_item("plain", "2026-05-01T00:00:00Z")).unwrap();
        let a = add_focus_task(&c, None, "first", "user").unwrap();
        let b = add_focus_task(&c, None, "second", "user").unwrap();

        // Focus tasks stay out of the ordinary task list…
        let open: Vec<_> = list_tasks(&c, false, None).unwrap().into_iter().map(|t| t.item.id).collect();
        assert_eq!(open, vec!["plain".to_string()]);
        // …and come back in rank order from the focus list.
        let focus: Vec<_> = list_focus_tasks(&c).unwrap().into_iter().map(|t| t.item.id).collect();
        assert_eq!(focus, vec![a.id.clone(), b.id.clone()]);

        // Reorder + move `a` into a project; non-focus ids are ignored.
        reorder_focus_tasks(
            &c,
            &[
                FocusOrderEntry { item_id: b.id.clone(), project_id: None },
                FocusOrderEntry { item_id: "plain".into(), project_id: Some("x".into()) },
                FocusOrderEntry { item_id: a.id.clone(), project_id: Some("p1".into()) },
            ],
        )
        .unwrap();
        let focus = list_focus_tasks(&c).unwrap();
        assert_eq!(focus[0].item.id, b.id);
        assert_eq!(focus[1].item.id, a.id);
        assert_eq!(focus[1].item.project_id.as_deref(), Some("p1"));
        assert!(!is_focus_task(&c, "plain").unwrap());

        // Completing keeps it on the board; un-focusing returns it to tasks.
        complete_task(&c, &a.id, "2026-05-02T00:00:00Z").unwrap();
        assert!(list_focus_tasks(&c).unwrap()[1].completed_at.is_some());
        set_focus(&c, &b.id, false).unwrap();
        assert_eq!(list_focus_tasks(&c).unwrap().len(), 1);
        assert!(list_tasks(&c, false, None).unwrap().iter().any(|t| t.item.id == b.id));
    }
}
