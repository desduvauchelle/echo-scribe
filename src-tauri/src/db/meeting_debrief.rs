//! Post-meeting debrief persistence: LLM-suggested follow-ups
//! (`meeting_task_suggestions`), the meeting's `debrief_status`, and the
//! accept path that turns one suggestion into a real task item.
//!
//! Product rule: tasks are NEVER auto-created from meetings. Suggestions sit
//! here as 'pending' until the user accepts (→ task item) or skips them.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::items::{Item, ItemKind, ItemSource};
use super::meeting_intelligence::MeetingParticipant;
use super::DbError;
use crate::meeting::synthesizer::SuggestedTask;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_ACCEPTED: &str = "accepted";
pub const STATUS_DISMISSED: &str = "dismissed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSuggestion {
    pub id: String,
    pub text: String,
    pub owner_name: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDebrief {
    pub meeting_id: String,
    pub title: String,
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub project_id: Option<String>,
    /// Same struct (and serialization) as the `list_meeting_participants`
    /// command returns.
    pub participants: Vec<MeetingParticipant>,
    /// Only still-'pending' suggestions.
    pub suggestions: Vec<TaskSuggestion>,
}

/// Meeting title, mirroring `meetingTitle()` in `src/lib/meetingDisplay.ts`:
/// the LLM's suggested title, else "<app> meeting", else "Manual meeting".
pub fn meeting_title(summary_json: Option<&str>, detected_app_name: Option<&str>) -> String {
    let suggested = summary_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| {
            v.get("suggested_title")
                .and_then(|t| t.as_str())
                .map(|t| t.trim().to_string())
        })
        .filter(|t| !t.is_empty());
    if let Some(t) = suggested {
        return t;
    }
    match detected_app_name.map(str::trim).filter(|a| !a.is_empty()) {
        Some(app) => format!("{app} meeting"),
        None => "Manual meeting".to_string(),
    }
}

fn insert_suggestions(
    conn: &Connection,
    meeting_id: &str,
    tasks: &[SuggestedTask],
    now: &str,
) -> Result<usize, DbError> {
    let mut n = 0;
    for t in tasks {
        let text = t.text.trim();
        if text.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO meeting_task_suggestions
               (id, meeting_id, text, owner_name, status, created_item_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, ?5)",
            params![
                ulid::Ulid::new().to_string(),
                meeting_id,
                text,
                t.owner.as_deref(),
                now
            ],
        )?;
        n += 1;
    }
    Ok(n)
}

/// Finalize path: store the fresh suggestions as 'pending' and mark the
/// meeting's debrief 'pending'. Returns the number of suggestions inserted.
pub fn record_initial_suggestions(
    conn: &Connection,
    meeting_id: &str,
    tasks: &[SuggestedTask],
    now: &str,
) -> Result<usize, DbError> {
    let n = insert_suggestions(conn, meeting_id, tasks, now)?;
    conn.execute(
        "UPDATE meetings SET debrief_status = 'pending' WHERE item_id = ?1",
        params![meeting_id],
    )?;
    Ok(n)
}

/// Retry-summary path: replace only still-'pending' suggestions (accepted /
/// dismissed rows are history and never touched). The debrief is (re)opened
/// only when it was never set — a finished or dismissed debrief stays closed.
/// Returns the number of suggestions inserted.
pub fn replace_pending_suggestions(
    conn: &Connection,
    meeting_id: &str,
    tasks: &[SuggestedTask],
    now: &str,
) -> Result<usize, DbError> {
    conn.execute(
        "DELETE FROM meeting_task_suggestions WHERE meeting_id = ?1 AND status = 'pending'",
        params![meeting_id],
    )?;
    let n = insert_suggestions(conn, meeting_id, tasks, now)?;
    conn.execute(
        "UPDATE meetings SET debrief_status = 'pending'
         WHERE item_id = ?1 AND debrief_status IS NULL",
        params![meeting_id],
    )?;
    Ok(n)
}

pub fn list_pending_suggestions(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<TaskSuggestion>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, text, owner_name, status FROM meeting_task_suggestions
         WHERE meeting_id = ?1 AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC",
    )?;
    let rows = stmt
        .query_map([meeting_id], |r| {
            Ok(TaskSuggestion {
                id: r.get(0)?,
                text: r.get(1)?,
                owner_name: r.get(2)?,
                status: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Meetings whose debrief is 'pending', not deleted, started at/after
/// `cutoff_iso` (RFC 3339), newest first, at most `limit`.
pub fn list_pending_debriefs(
    conn: &Connection,
    cutoff_iso: &str,
    limit: u32,
) -> Result<Vec<MeetingDebrief>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT m.item_id, m.started_at, m.duration_ms, m.summary_json, m.detected_app_name,
                i.project_id
         FROM meetings m
         JOIN items i ON i.id = m.item_id
         WHERE m.debrief_status = 'pending'
           AND i.deleted_at IS NULL
           AND julianday(m.started_at) >= julianday(?1)
         ORDER BY julianday(m.started_at) DESC
         LIMIT ?2",
    )?;
    #[allow(clippy::type_complexity)]
    let heads: Vec<(
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = stmt
        .query_map(params![cutoff_iso, limit], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(heads.len());
    for (meeting_id, started_at, duration_ms, summary_json, app, project_id) in heads {
        let participants = super::meeting_intelligence::list_participants(conn, &meeting_id)?;
        let suggestions = list_pending_suggestions(conn, &meeting_id)?;
        out.push(MeetingDebrief {
            title: meeting_title(summary_json.as_deref(), app.as_deref()),
            meeting_id,
            started_at,
            duration_ms,
            project_id,
            participants,
            suggestions,
        });
    }
    Ok(out)
}

/// Outcome of trying to accept a suggestion.
#[derive(Debug, PartialEq, Eq)]
pub enum AcceptOutcome {
    /// Task created; carries the new item id and the meeting id.
    Created { item_id: String, meeting_id: String },
    /// No suggestion with that id.
    NotFound,
    /// Suggestion exists but was already accepted/dismissed.
    NotPending(String),
}

/// Promote one suggestion to a task item, in a single transaction: task item
/// (`source='meeting'`, `kind='task'`, like the historical meeting action
/// path) + `tasks` row (deadline, assignee) + `meeting_action_links` row, and
/// mark the suggestion 'accepted' with `created_item_id`. Unassigned tasks
/// join the project auto-tagging queue like any other capture.
pub fn accept_suggestion(
    conn: &Connection,
    suggestion_id: &str,
    text: &str,
    assignee_person_id: Option<&str>,
    project_id: Option<&str>,
    deadline: Option<&str>,
    now: &str,
) -> Result<AcceptOutcome, DbError> {
    let tx = conn.unchecked_transaction()?;
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT meeting_id, status FROM meeting_task_suggestions WHERE id = ?1",
            [suggestion_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((meeting_id, status)) = row else {
        return Ok(AcceptOutcome::NotFound);
    };
    if status != STATUS_PENDING {
        return Ok(AcceptOutcome::NotPending(status));
    }
    let item = Item {
        id: ulid::Ulid::new().to_string(),
        content: text.to_string(),
        source: ItemSource::Meeting,
        kind: Some(ItemKind::Task),
        project_id: project_id.map(str::to_string),
        captured_at: now.to_string(),
        created_at: now.to_string(),
        deleted_at: None,
        confidence: Some(1.0),
        classified_by: Some("meeting_debrief".into()),
        capture_context: None,
        importance: None,
    };
    super::items::insert_item(&tx, &item)?;
    super::events::insert_event(&tx, &item.id, "created", Some("via meeting_debrief"))?;
    if let Some(pid) = project_id {
        super::events::insert_event(&tx, &item.id, "project_assigned", Some(pid))?;
    } else {
        super::project_tag_jobs::enqueue(&tx, &item.id, now)?;
    }
    tx.execute(
        "INSERT INTO tasks(item_id, deadline, completed_at, assignee_person_id)
         VALUES (?1, ?2, NULL, ?3)",
        params![item.id, deadline, assignee_person_id],
    )?;
    super::meetings::link_action(&tx, &meeting_id, &item.id, now)?;
    tx.execute(
        "UPDATE meeting_task_suggestions
         SET status = 'accepted', created_item_id = ?2, text = ?3, updated_at = ?4
         WHERE id = ?1",
        params![suggestion_id, item.id, text, now],
    )?;
    tx.commit()?;
    Ok(AcceptOutcome::Created {
        item_id: item.id,
        meeting_id,
    })
}

/// Mark one still-pending suggestion 'dismissed'. Returns the meeting id, or
/// `None` when no pending suggestion with that id exists.
pub fn dismiss_suggestion(
    conn: &Connection,
    suggestion_id: &str,
    now: &str,
) -> Result<Option<String>, DbError> {
    let meeting_id: Option<String> = conn
        .query_row(
            "SELECT meeting_id FROM meeting_task_suggestions WHERE id = ?1 AND status = 'pending'",
            [suggestion_id],
            |r| r.get(0),
        )
        .optional()?;
    if meeting_id.is_some() {
        conn.execute(
            "UPDATE meeting_task_suggestions SET status = 'dismissed', updated_at = ?2 WHERE id = ?1",
            params![suggestion_id, now],
        )?;
    }
    Ok(meeting_id)
}

/// Close a debrief ('done' | 'dismissed' — validated by the caller) and
/// dismiss any suggestions still pending. Returns rows updated on `meetings`
/// (0 = unknown meeting).
pub fn complete_debrief(
    conn: &Connection,
    meeting_id: &str,
    status: &str,
    now: &str,
) -> Result<usize, DbError> {
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
        "UPDATE meetings SET debrief_status = ?2 WHERE item_id = ?1",
        params![meeting_id, status],
    )?;
    tx.execute(
        "UPDATE meeting_task_suggestions SET status = 'dismissed', updated_at = ?2
         WHERE meeting_id = ?1 AND status = 'pending'",
        params![meeting_id, now],
    )?;
    tx.commit()?;
    Ok(n)
}

pub fn get_debrief_status(conn: &Connection, meeting_id: &str) -> Result<Option<String>, DbError> {
    Ok(conn
        .query_row(
            "SELECT debrief_status FROM meetings WHERE item_id = ?1",
            [meeting_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Set (or clear) the meeting item's project. Returns rows updated.
pub fn set_meeting_project(
    conn: &Connection,
    meeting_id: &str,
    project_id: Option<&str>,
) -> Result<usize, DbError> {
    let n = conn.execute(
        "UPDATE items SET project_id = ?2
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM meetings WHERE item_id = ?1)",
        params![meeting_id, project_id],
    )?;
    if n > 0 {
        if let Some(pid) = project_id {
            super::events::insert_event(conn, meeting_id, "project_assigned", Some(pid))?;
        }
    }
    Ok(n)
}

/// Outcome of adding a person to a meeting by hand.
#[derive(Debug, PartialEq, Eq)]
pub enum AddParticipantOutcome {
    Added,
    AlreadyPresent,
    PersonNotFound,
}

/// Add a known person to a meeting (`speaker_key = manual:<person_id>`,
/// source 'manual', confirmed). No-op when the person is already linked to
/// the meeting under any speaker key.
pub fn add_participant(
    conn: &Connection,
    meeting_id: &str,
    person_id: &str,
    now: &str,
) -> Result<AddParticipantOutcome, DbError> {
    let Some(person) = super::meeting_intelligence::get_person(conn, person_id)? else {
        return Ok(AddParticipantOutcome::PersonNotFound);
    };
    let speaker_key = format!("manual:{person_id}");
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meeting_participants
                       WHERE meeting_id = ?1 AND (speaker_key = ?2 OR person_id = ?3))",
        params![meeting_id, speaker_key, person_id],
        |r| r.get(0),
    )?;
    if exists {
        return Ok(AddParticipantOutcome::AlreadyPresent);
    }
    conn.execute(
        "INSERT INTO meeting_participants
           (meeting_id, speaker_key, person_id, display_name, source, confirmed, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', 1, ?5, ?5)",
        params![meeting_id, speaker_key, person_id, person.name, now],
    )?;
    Ok(AddParticipantOutcome::Added)
}

/// Remove one participant row. Returns rows deleted.
pub fn remove_participant(
    conn: &Connection,
    meeting_id: &str,
    speaker_key: &str,
) -> Result<usize, DbError> {
    Ok(conn.execute(
        "DELETE FROM meeting_participants WHERE meeting_id = ?1 AND speaker_key = ?2",
        params![meeting_id, speaker_key],
    )?)
}

/// Assign a task to a person (`None` = me). Returns rows affected (0 = the
/// item is not a task item).
pub fn set_task_assignee(
    conn: &Connection,
    item_id: &str,
    person_id: Option<&str>,
) -> Result<usize, DbError> {
    let is_task: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM items WHERE id = ?1 AND kind = 'task')",
        [item_id],
        |r| r.get(0),
    )?;
    if !is_task {
        return Ok(0);
    }
    Ok(conn.execute(
        "INSERT INTO tasks(item_id, deadline, completed_at, assignee_person_id)
         VALUES (?1, NULL, NULL, ?2)
         ON CONFLICT(item_id) DO UPDATE SET assignee_person_id = excluded.assignee_person_id",
        params![item_id, person_id],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    const NOW: &str = "2026-09-25T10:00:00+00:00";

    fn fresh_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn seed_meeting(conn: &Connection, id: &str, started_at: &str, summary: Option<&str>) {
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES (?1, 'body', 'meeting', 'meeting', ?2, ?2)",
            params![id, started_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meetings (item_id, started_at, status, summary_json, detected_app_name, duration_ms)
             VALUES (?1, ?2, 'complete', ?3, 'Zoom', 60000)",
            params![id, started_at, summary],
        )
        .unwrap();
    }

    fn seed_person(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO people (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, name, NOW],
        )
        .unwrap();
    }

    fn st(text: &str, owner: Option<&str>) -> SuggestedTask {
        SuggestedTask {
            text: text.into(),
            owner: owner.map(str::to_string),
        }
    }

    fn statuses(conn: &Connection, meeting_id: &str) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT text, status FROM meeting_task_suggestions WHERE meeting_id = ?1 ORDER BY rowid",
            )
            .unwrap();
        stmt.query_map([meeting_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn title_mirrors_frontend_fallbacks() {
        assert_eq!(
            meeting_title(Some(r#"{"suggested_title":" Roadmap "}"#), Some("Zoom")),
            "Roadmap"
        );
        assert_eq!(meeting_title(Some("{}"), Some("Zoom")), "Zoom meeting");
        assert_eq!(meeting_title(Some("nope"), None), "Manual meeting");
        assert_eq!(meeting_title(None, Some("  ")), "Manual meeting");
    }

    #[test]
    fn initial_suggestions_mark_debrief_pending_and_list() {
        let conn = fresh_conn();
        seed_meeting(&conn, "m1", NOW, Some(r#"{"suggested_title":"Sync"}"#));
        seed_person(&conn, "p1", "Anna");
        add_participant(&conn, "m1", "p1", NOW).unwrap();
        let n = record_initial_suggestions(
            &conn,
            "m1",
            &[
                st("Send deck", Some("Anna")),
                st("  ", None),
                st("Book room", None),
            ],
            NOW,
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            get_debrief_status(&conn, "m1").unwrap().as_deref(),
            Some("pending")
        );

        let list = list_pending_debriefs(&conn, "2026-09-11T00:00:00+00:00", 5).unwrap();
        assert_eq!(list.len(), 1);
        let d = &list[0];
        assert_eq!(d.title, "Sync");
        assert_eq!(d.duration_ms, Some(60000));
        assert_eq!(d.participants.len(), 1);
        assert_eq!(d.participants[0].speaker_key, "manual:p1");
        assert_eq!(d.suggestions.len(), 2);
        assert_eq!(d.suggestions[0].owner_name.as_deref(), Some("Anna"));

        let json = serde_json::to_value(d).unwrap();
        assert!(json.get("meetingId").is_some());
        assert!(json.get("startedAt").is_some());
        assert!(json.get("durationMs").is_some());
        assert!(json.get("projectId").is_some());
        assert!(json["suggestions"][0].get("ownerName").is_some());
    }

    #[test]
    fn list_filters_age_deleted_status_and_orders_newest_first() {
        let conn = fresh_conn();
        seed_meeting(&conn, "old", "2026-09-01T10:00:00+00:00", None);
        seed_meeting(&conn, "a", "2026-09-20T10:00:00+00:00", None);
        seed_meeting(&conn, "b", "2026-09-24T10:00:00.123+00:00", None);
        seed_meeting(&conn, "gone", "2026-09-24T11:00:00+00:00", None);
        seed_meeting(&conn, "legacy", "2026-09-24T12:00:00+00:00", None);
        for id in ["old", "a", "b", "gone"] {
            record_initial_suggestions(&conn, id, &[], NOW).unwrap();
        }
        conn.execute("UPDATE items SET deleted_at = ?1 WHERE id = 'gone'", [NOW])
            .unwrap();
        let list = list_pending_debriefs(&conn, "2026-09-11T10:00:00+00:00", 5).unwrap();
        let ids: Vec<_> = list.iter().map(|d| d.meeting_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
        assert_eq!(list[0].title, "Zoom meeting");
        let limited = list_pending_debriefs(&conn, "2026-09-11T10:00:00+00:00", 1).unwrap();
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn retry_replaces_only_pending_and_keeps_closed_debrief_closed() {
        let conn = fresh_conn();
        seed_meeting(&conn, "m1", NOW, None);
        record_initial_suggestions(
            &conn,
            "m1",
            &[st("A", None), st("B", None), st("C", None)],
            NOW,
        )
        .unwrap();
        let ids: Vec<String> = list_pending_suggestions(&conn, "m1")
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        accept_suggestion(&conn, &ids[0], "A!", None, None, None, NOW).unwrap();
        dismiss_suggestion(&conn, &ids[1], NOW).unwrap();

        replace_pending_suggestions(&conn, "m1", &[st("D", None)], NOW).unwrap();
        assert_eq!(
            statuses(&conn, "m1"),
            vec![
                ("A!".to_string(), "accepted".to_string()),
                ("B".to_string(), "dismissed".to_string()),
                ("D".to_string(), "pending".to_string()),
            ]
        );

        complete_debrief(&conn, "m1", "done", NOW).unwrap();
        replace_pending_suggestions(&conn, "m1", &[st("E", None)], NOW).unwrap();
        assert_eq!(
            get_debrief_status(&conn, "m1").unwrap().as_deref(),
            Some("done")
        );

        // Legacy meeting (NULL status) gets opened by a retry.
        seed_meeting(&conn, "m2", NOW, None);
        replace_pending_suggestions(&conn, "m2", &[st("X", None)], NOW).unwrap();
        assert_eq!(
            get_debrief_status(&conn, "m2").unwrap().as_deref(),
            Some("pending")
        );
    }

    #[test]
    fn accept_creates_linked_task_with_assignee_and_is_single_use() {
        let conn = fresh_conn();
        seed_meeting(&conn, "m1", NOW, None);
        seed_person(&conn, "p1", "Anna");
        conn.execute(
            "INSERT INTO projects (id, name, created_at) VALUES ('proj', 'Alpha', ?1)",
            [NOW],
        )
        .unwrap();
        record_initial_suggestions(&conn, "m1", &[st("Send deck", Some("Anna"))], NOW).unwrap();
        let sid = list_pending_suggestions(&conn, "m1").unwrap()[0].id.clone();

        let out = accept_suggestion(
            &conn,
            &sid,
            "Send the deck",
            Some("p1"),
            Some("proj"),
            Some("2026-10-01"),
            NOW,
        )
        .unwrap();
        let AcceptOutcome::Created {
            item_id,
            meeting_id,
        } = out
        else {
            panic!("expected Created, got {out:?}");
        };
        assert_eq!(meeting_id, "m1");

        let item = crate::db::items::get_item(&conn, &item_id)
            .unwrap()
            .unwrap();
        assert_eq!(item.content, "Send the deck");
        assert_eq!(item.kind, Some(ItemKind::Task));
        assert_eq!(item.project_id.as_deref(), Some("proj"));
        let (deadline, assignee): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT deadline, assignee_person_id FROM tasks WHERE item_id = ?1",
                [&item_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(deadline.as_deref(), Some("2026-10-01"));
        assert_eq!(assignee.as_deref(), Some("p1"));
        let linked = crate::db::meetings::list_action_items(&conn, "m1").unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].id, item_id);
        let created: Option<String> = conn
            .query_row(
                "SELECT created_item_id FROM meeting_task_suggestions WHERE id = ?1",
                [&sid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(created.as_deref(), Some(item_id.as_str()));

        // Task list exposes the assignee.
        let tasks = crate::db::tasks::list_tasks(&conn, false, None).unwrap();
        assert_eq!(tasks[0].assignee_person_id.as_deref(), Some("p1"));
        assert_eq!(tasks[0].assignee_name.as_deref(), Some("Anna"));

        // Second accept is refused.
        assert_eq!(
            accept_suggestion(&conn, &sid, "x", None, None, None, NOW).unwrap(),
            AcceptOutcome::NotPending("accepted".into())
        );
        assert_eq!(
            accept_suggestion(&conn, "nope", "x", None, None, None, NOW).unwrap(),
            AcceptOutcome::NotFound
        );
    }

    #[test]
    fn complete_dismisses_remaining_pending() {
        let conn = fresh_conn();
        seed_meeting(&conn, "m1", NOW, None);
        record_initial_suggestions(&conn, "m1", &[st("A", None), st("B", None)], NOW).unwrap();
        assert_eq!(complete_debrief(&conn, "m1", "dismissed", NOW).unwrap(), 1);
        assert_eq!(
            get_debrief_status(&conn, "m1").unwrap().as_deref(),
            Some("dismissed")
        );
        assert!(list_pending_suggestions(&conn, "m1").unwrap().is_empty());
        assert!(list_pending_debriefs(&conn, "2000-01-01T00:00:00Z", 5)
            .unwrap()
            .is_empty());
        assert_eq!(complete_debrief(&conn, "missing", "done", NOW).unwrap(), 0);
    }

    #[test]
    fn participants_add_is_idempotent_and_remove_works() {
        let conn = fresh_conn();
        seed_meeting(&conn, "m1", NOW, None);
        seed_person(&conn, "p1", "Anna");
        assert_eq!(
            add_participant(&conn, "m1", "p1", NOW).unwrap(),
            AddParticipantOutcome::Added
        );
        assert_eq!(
            add_participant(&conn, "m1", "p1", NOW).unwrap(),
            AddParticipantOutcome::AlreadyPresent
        );
        assert_eq!(
            add_participant(&conn, "m1", "ghost", NOW).unwrap(),
            AddParticipantOutcome::PersonNotFound
        );
        let parts = crate::db::meeting_intelligence::list_participants(&conn, "m1").unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].display_name, "Anna");
        assert!(parts[0].confirmed);
        assert_eq!(parts[0].source, "manual");
        assert_eq!(remove_participant(&conn, "m1", "manual:p1").unwrap(), 1);
        assert!(
            crate::db::meeting_intelligence::list_participants(&conn, "m1")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn set_project_and_task_assignee() {
        let conn = fresh_conn();
        seed_meeting(&conn, "m1", NOW, None);
        conn.execute(
            "INSERT INTO projects (id, name, created_at) VALUES ('proj', 'Alpha', ?1)",
            [NOW],
        )
        .unwrap();
        assert_eq!(set_meeting_project(&conn, "m1", Some("proj")).unwrap(), 1);
        let pid: Option<String> = conn
            .query_row("SELECT project_id FROM items WHERE id='m1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pid.as_deref(), Some("proj"));
        assert_eq!(set_meeting_project(&conn, "m1", None).unwrap(), 1);
        assert_eq!(set_meeting_project(&conn, "nope", None).unwrap(), 0);

        seed_person(&conn, "p1", "Anna");
        conn.execute(
            "INSERT INTO items (id, content, source, kind, captured_at, created_at)
             VALUES ('t1', 'do it', 'log_capture', 'task', ?1, ?1)",
            [NOW],
        )
        .unwrap();
        assert_eq!(set_task_assignee(&conn, "t1", Some("p1")).unwrap(), 1);
        let tasks = crate::db::tasks::list_tasks(&conn, false, None).unwrap();
        assert_eq!(tasks[0].assignee_name.as_deref(), Some("Anna"));
        // Deleted person → name hidden.
        conn.execute("UPDATE people SET deleted_at = ?1 WHERE id = 'p1'", [NOW])
            .unwrap();
        let tasks = crate::db::tasks::list_tasks(&conn, false, None).unwrap();
        assert!(tasks[0].assignee_name.is_none());
        assert_eq!(set_task_assignee(&conn, "t1", None).unwrap(), 1);
        let tasks = crate::db::tasks::list_tasks(&conn, false, None).unwrap();
        assert!(tasks[0].assignee_person_id.is_none());
        // Not a task → 0.
        assert_eq!(set_task_assignee(&conn, "m1", Some("p1")).unwrap(), 0);
    }
}
