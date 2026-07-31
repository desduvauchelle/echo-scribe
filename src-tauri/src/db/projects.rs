//! CRUD on the `projects` table.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::DbError;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub archived_at: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Topical keywords / aliases that help the classifier route items to
    /// this project. Stored as a JSON array of lowercase strings in the
    /// `keywords` column.
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Absolute filesystem path where high-confidence items routed to this
    /// project are exported as markdown. `None` = export disabled.
    #[serde(default)]
    pub export_folder: Option<String>,
    #[serde(default)]
    pub routing_aliases: Vec<String>,
    #[serde(default)]
    pub routing_app_hints: Vec<String>,
    #[serde(default)]
    pub routing_url_hints: Vec<String>,
    #[serde(default)]
    pub routing_window_hints: Vec<String>,
    #[serde(default)]
    pub routing_positive_examples: Vec<String>,
    #[serde(default)]
    pub routing_negative_examples: Vec<String>,
}

/// Partial update payload for `update_project`. Each field follows the
/// double-Option pattern:
///   - `None`        = leave column alone
///   - `Some(None)`  = clear column to NULL (or empty for keywords)
///   - `Some(Some))` = set column to value
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProjectPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
    #[serde(default, with = "double_option")]
    pub color: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub emoji: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub export_folder: Option<Option<String>>,
    #[serde(default)]
    pub routing_aliases: Option<Vec<String>>,
    #[serde(default)]
    pub routing_app_hints: Option<Vec<String>>,
    #[serde(default)]
    pub routing_url_hints: Option<Vec<String>>,
    #[serde(default)]
    pub routing_window_hints: Option<Vec<String>>,
    #[serde(default)]
    pub routing_positive_examples: Option<Vec<String>>,
    #[serde(default)]
    pub routing_negative_examples: Option<Vec<String>>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

fn parse_keywords(raw: Option<String>) -> Vec<String> {
    parse_json_vec(raw)
}

fn parse_json_vec(raw: Option<String>) -> Vec<String> {
    match raw {
        Some(s) if !s.trim().is_empty() => {
            serde_json::from_str::<Vec<String>>(&s).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

fn row_to_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    let kw_raw: Option<String> = row.get("keywords").ok();
    let routing_aliases_raw: Option<String> = row.get("routing_aliases").ok();
    let routing_app_hints_raw: Option<String> = row.get("routing_app_hints").ok();
    let routing_url_hints_raw: Option<String> = row.get("routing_url_hints").ok();
    let routing_window_hints_raw: Option<String> = row.get("routing_window_hints").ok();
    let routing_positive_examples_raw: Option<String> = row.get("routing_positive_examples").ok();
    let routing_negative_examples_raw: Option<String> = row.get("routing_negative_examples").ok();
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        archived_at: row.get("archived_at")?,
        description: row.get("description").ok(),
        keywords: parse_keywords(kw_raw),
        color: row.get("color").ok(),
        emoji: row.get("emoji").ok(),
        updated_at: row.get("updated_at").ok(),
        export_folder: row.get("export_folder").ok(),
        routing_aliases: parse_json_vec(routing_aliases_raw),
        routing_app_hints: parse_json_vec(routing_app_hints_raw),
        routing_url_hints: parse_json_vec(routing_url_hints_raw),
        routing_window_hints: parse_json_vec(routing_window_hints_raw),
        routing_positive_examples: parse_json_vec(routing_positive_examples_raw),
        routing_negative_examples: parse_json_vec(routing_negative_examples_raw),
    })
}

const SELECT_COLS: &str = "id, name, created_at, archived_at, description, keywords, color, emoji, updated_at, export_folder, routing_aliases, routing_app_hints, routing_url_hints, routing_window_hints, routing_positive_examples, routing_negative_examples";

pub fn insert_project(conn: &Connection, p: &Project) -> Result<(), DbError> {
    let keywords_json = serde_json::to_string(&p.keywords).unwrap_or_else(|_| "[]".to_string());
    let routing_aliases_json =
        serde_json::to_string(&p.routing_aliases).unwrap_or_else(|_| "[]".to_string());
    let routing_app_hints_json =
        serde_json::to_string(&p.routing_app_hints).unwrap_or_else(|_| "[]".to_string());
    let routing_url_hints_json =
        serde_json::to_string(&p.routing_url_hints).unwrap_or_else(|_| "[]".to_string());
    let routing_window_hints_json =
        serde_json::to_string(&p.routing_window_hints).unwrap_or_else(|_| "[]".to_string());
    let routing_positive_examples_json =
        serde_json::to_string(&p.routing_positive_examples).unwrap_or_else(|_| "[]".to_string());
    let routing_negative_examples_json =
        serde_json::to_string(&p.routing_negative_examples).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO projects(id, name, created_at, archived_at, description, keywords, color, emoji, updated_at, export_folder, routing_aliases, routing_app_hints, routing_url_hints, routing_window_hints, routing_positive_examples, routing_negative_examples)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            p.id,
            p.name,
            p.created_at,
            p.archived_at,
            p.description,
            keywords_json,
            p.color,
            p.emoji,
            p.updated_at,
            p.export_folder,
            routing_aliases_json,
            routing_app_hints_json,
            routing_url_hints_json,
            routing_window_hints_json,
            routing_positive_examples_json,
            routing_negative_examples_json,
        ],
    )?;
    Ok(())
}

/// Sorted alphabetically by name (case-insensitive).
pub fn list_projects(conn: &Connection, include_archived: bool) -> Result<Vec<Project>, DbError> {
    let sql = if include_archived {
        format!("SELECT {SELECT_COLS} FROM projects ORDER BY name COLLATE NOCASE ASC")
    } else {
        format!("SELECT {SELECT_COLS} FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE ASC")
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_project)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Option<Project>, DbError> {
    let sql = format!("SELECT {SELECT_COLS} FROM projects WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_project(row)?))
    } else {
        Ok(None)
    }
}

/// Look up a project by exact name, case-insensitive. The `UNIQUE(name)`
/// constraint makes names effectively unique, so there is at most one match
/// (modulo case). Used for get-or-create so a capture routed to an existing
/// project name reuses it instead of hitting the UNIQUE constraint.
pub fn get_project_by_name(conn: &Connection, name: &str) -> Result<Option<Project>, DbError> {
    let sql = format!("SELECT {SELECT_COLS} FROM projects WHERE name = ?1 COLLATE NOCASE LIMIT 1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![name])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_project(row)?))
    } else {
        Ok(None)
    }
}

pub fn rename_project(conn: &Connection, id: &str, name: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, crate::db::items::chrono_now_iso(), id],
    )?;
    Ok(())
}

/// Apply a partial update. Always bumps `updated_at`.
pub fn update_project(
    conn: &Connection,
    id: &str,
    patch: &ProjectPatch,
    now_iso: &str,
) -> Result<(), DbError> {
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(n) = &patch.name {
        sets.push(format!("name = ?{}", sets.len() + 1));
        vals.push(Box::new(n.clone()));
    }
    if let Some(desc_opt) = &patch.description {
        sets.push(format!("description = ?{}", sets.len() + 1));
        vals.push(Box::new(desc_opt.clone()));
    }
    if let Some(kw) = &patch.keywords {
        let json = serde_json::to_string(kw).unwrap_or_else(|_| "[]".to_string());
        sets.push(format!("keywords = ?{}", sets.len() + 1));
        vals.push(Box::new(json));
    }
    if let Some(color_opt) = &patch.color {
        sets.push(format!("color = ?{}", sets.len() + 1));
        vals.push(Box::new(color_opt.clone()));
    }
    if let Some(emoji_opt) = &patch.emoji {
        sets.push(format!("emoji = ?{}", sets.len() + 1));
        vals.push(Box::new(emoji_opt.clone()));
    }
    if let Some(folder_opt) = &patch.export_folder {
        sets.push(format!("export_folder = ?{}", sets.len() + 1));
        vals.push(Box::new(folder_opt.clone()));
    }
    if let Some(v) = &patch.routing_aliases {
        sets.push(format!("routing_aliases = ?{}", sets.len() + 1));
        vals.push(Box::new(
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        ));
    }
    if let Some(v) = &patch.routing_app_hints {
        sets.push(format!("routing_app_hints = ?{}", sets.len() + 1));
        vals.push(Box::new(
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        ));
    }
    if let Some(v) = &patch.routing_url_hints {
        sets.push(format!("routing_url_hints = ?{}", sets.len() + 1));
        vals.push(Box::new(
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        ));
    }
    if let Some(v) = &patch.routing_window_hints {
        sets.push(format!("routing_window_hints = ?{}", sets.len() + 1));
        vals.push(Box::new(
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        ));
    }
    if let Some(v) = &patch.routing_positive_examples {
        sets.push(format!("routing_positive_examples = ?{}", sets.len() + 1));
        vals.push(Box::new(
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        ));
    }
    if let Some(v) = &patch.routing_negative_examples {
        sets.push(format!("routing_negative_examples = ?{}", sets.len() + 1));
        vals.push(Box::new(
            serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()),
        ));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push(format!("updated_at = ?{}", sets.len() + 1));
    vals.push(Box::new(now_iso.to_string()));

    let sql = format!(
        "UPDATE projects SET {} WHERE id = ?{}",
        sets.join(", "),
        vals.len() + 1
    );
    vals.push(Box::new(id.to_string()));

    let params: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

pub fn archive_project(conn: &Connection, id: &str, now_iso: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE projects SET archived_at = ?1, updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        params![now_iso, id],
    )?;
    Ok(())
}

pub fn unarchive_project(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE projects SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
        params![crate::db::items::chrono_now_iso(), id],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ProjectDeleteImpact {
    pub items: u32,
    pub meetings: u32,
    pub notes: u32,
    pub tasks: u32,
    pub transcriptions: u32,
    pub recordings: u32,
    pub chats: u32,
    pub artifacts: u32,
}

pub fn project_delete_impact(conn: &Connection, id: &str) -> Result<ProjectDeleteImpact, DbError> {
    let (items, meetings, notes, tasks, transcriptions): (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN kind = 'meeting' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'task' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'transcription' THEN 1 ELSE 0 END), 0)
               FROM items
              WHERE project_id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
    let recordings: i64 = conn.query_row(
        "SELECT COUNT(*) FROM recordings WHERE project_id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    let chats: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM chat_sessions cs
          WHERE cs.project_id = ?1
             OR EXISTS (
                SELECT 1 FROM chat_session_scopes scope
                 WHERE scope.session_id = cs.id
                   AND scope.scope_kind = 'project'
                   AND scope.scope_id = ?1
             )",
        params![id],
        |row| row.get(0),
    )?;
    let artifacts: i64 = conn.query_row(
        "SELECT COUNT(*) FROM meeting_artifacts
          WHERE project_id = ?1
             OR meeting_id IN (SELECT id FROM items WHERE project_id = ?1)",
        params![id],
        |row| row.get(0),
    )?;

    Ok(ProjectDeleteImpact {
        items: items.max(0) as u32,
        meetings: meetings.max(0) as u32,
        notes: notes.max(0) as u32,
        tasks: tasks.max(0) as u32,
        transcriptions: transcriptions.max(0) as u32,
        recordings: recordings.max(0) as u32,
        chats: chats.max(0) as u32,
        artifacts: artifacts.max(0) as u32,
    })
}

/// Hard-delete a project. Linked content is either reassigned, detached while
/// preserving the content, or permanently deleted. Wrapped in a transaction so
/// a failed dependency cleanup never leaves a partially removed project.
pub fn delete_project(
    conn: &mut Connection,
    id: &str,
    reassign_to: Option<&str>,
    delete_related: bool,
) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    if delete_related {
        // Project-scoped artifacts can exist without a meeting, while meeting
        // artifacts may only inherit the project through their parent item.
        tx.execute(
            "DELETE FROM meeting_artifacts
              WHERE project_id = ?1
                 OR meeting_id IN (SELECT id FROM items WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM project_tag_jobs
              WHERE item_id IN (SELECT id FROM items WHERE project_id = ?1)
                 OR item_id IN (SELECT id FROM recordings WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM embedding_index_state
              WHERE source_id IN (SELECT id FROM items WHERE project_id = ?1)
                 OR source_id IN (SELECT id FROM recordings WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM embeddings
              WHERE project_id = ?1
                 OR source_id IN (SELECT id FROM items WHERE project_id = ?1)
                 OR source_id IN (SELECT id FROM recordings WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM meeting_action_links
              WHERE meeting_id IN (SELECT id FROM items WHERE project_id = ?1)
                 OR item_id IN (SELECT id FROM items WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM meetings WHERE item_id IN (SELECT id FROM items WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM tasks WHERE item_id IN (SELECT id FROM items WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM item_tags WHERE item_id IN (SELECT id FROM items WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE project_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM item_session_links
              WHERE item_id IN (SELECT id FROM items WHERE project_id = ?1)
                 OR session_id IN (
                    SELECT id FROM chat_sessions WHERE project_id = ?1
                    UNION
                    SELECT session_id FROM chat_session_scopes
                     WHERE scope_kind = 'project' AND scope_id = ?1
                 )",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_messages
              WHERE session_id IN (
                SELECT id FROM chat_sessions WHERE project_id = ?1
                UNION
                SELECT session_id FROM chat_session_scopes
                 WHERE scope_kind = 'project' AND scope_id = ?1
              )",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_sessions
              WHERE project_id = ?1
                 OR id IN (
                    SELECT session_id FROM chat_session_scopes
                     WHERE scope_kind = 'project' AND scope_id = ?1
                 )",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM chat_session_scopes
              WHERE scope_kind = 'project' AND scope_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM items WHERE project_id = ?1", params![id])?;
        tx.execute("DELETE FROM recordings WHERE project_id = ?1", params![id])?;
    } else {
        match reassign_to {
            Some(target) if target != id => {
                tx.execute(
                    "UPDATE items SET project_id = ?1 WHERE project_id = ?2",
                    params![target, id],
                )?;
                tx.execute(
                    "UPDATE chat_sessions SET project_id = ?1 WHERE project_id = ?2",
                    params![target, id],
                )?;
                tx.execute(
                    "UPDATE chat_session_scopes
                        SET scope_id = ?1
                      WHERE scope_kind = 'project' AND scope_id = ?2",
                    params![target, id],
                )?;
                tx.execute(
                    "UPDATE recordings SET project_id = ?1 WHERE project_id = ?2",
                    params![target, id],
                )?;
                tx.execute(
                    "UPDATE embeddings SET project_id = ?1 WHERE project_id = ?2",
                    params![target, id],
                )?;
                tx.execute(
                    "UPDATE meeting_artifacts SET project_id = ?1 WHERE project_id = ?2",
                    params![target, id],
                )?;
            }
            _ => {
                tx.execute(
                    "UPDATE items
                        SET project_id = NULL, confidence = NULL, classified_by = NULL
                      WHERE project_id = ?1",
                    params![id],
                )?;
                tx.execute(
                    "UPDATE chat_sessions SET project_id = NULL WHERE project_id = ?1",
                    params![id],
                )?;
                tx.execute(
                    "DELETE FROM chat_session_scopes
                      WHERE scope_kind = 'project' AND scope_id = ?1",
                    params![id],
                )?;
                tx.execute(
                    "UPDATE recordings
                        SET project_id = NULL, confidence = NULL, classified_by = NULL
                      WHERE project_id = ?1",
                    params![id],
                )?;
                tx.execute(
                    "UPDATE embeddings SET project_id = NULL WHERE project_id = ?1",
                    params![id],
                )?;
                tx.execute(
                    "UPDATE meeting_artifacts SET project_id = NULL WHERE project_id = ?1",
                    params![id],
                )?;
            }
        }
    }
    tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    tx.commit()?;
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
            description: None,
            keywords: Vec::new(),
            color: None,
            emoji: None,
            updated_at: None,
            export_folder: None,
            routing_aliases: Vec::new(),
            routing_app_hints: Vec::new(),
            routing_url_hints: Vec::new(),
            routing_window_hints: Vec::new(),
            routing_positive_examples: Vec::new(),
            routing_negative_examples: Vec::new(),
        }
    }

    #[test]
    fn list_projects_alphabetical_ignoring_case() {
        let c = fresh();
        insert_project(&c, &make("1", "zeta")).unwrap();
        insert_project(&c, &make("2", "Alpha")).unwrap();
        insert_project(&c, &make("3", "beta")).unwrap();
        let names: Vec<_> = list_projects(&c, false)
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
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
    fn get_project_by_name_is_case_insensitive() {
        let c = fresh();
        insert_project(&c, &make("1", "Echo Scribe")).unwrap();
        assert_eq!(
            get_project_by_name(&c, "echo scribe").unwrap().unwrap().id,
            "1"
        );
        assert_eq!(
            get_project_by_name(&c, "Echo Scribe").unwrap().unwrap().id,
            "1"
        );
        assert!(get_project_by_name(&c, "Nonexistent").unwrap().is_none());
    }

    #[test]
    fn rename_updates_name() {
        let c = fresh();
        insert_project(&c, &make("1", "alpha")).unwrap();
        rename_project(&c, "1", "Renamed").unwrap();
        let p = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(p.name, "Renamed");
    }

    #[test]
    fn insert_and_read_back_full_metadata() {
        let c = fresh();
        let mut p = make("1", "Echo");
        p.description = Some("Voice notes app".into());
        p.keywords = vec!["tauri".into(), "rust".into(), "voice".into()];
        p.color = Some("#ff0088".into());
        p.emoji = Some("🎤".into());
        p.updated_at = Some("2026-05-26T10:00:00Z".into());
        insert_project(&c, &p).unwrap();
        let got = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(got.description.as_deref(), Some("Voice notes app"));
        assert_eq!(got.keywords, vec!["tauri", "rust", "voice"]);
        assert_eq!(got.color.as_deref(), Some("#ff0088"));
        assert_eq!(got.emoji.as_deref(), Some("🎤"));
    }

    #[test]
    fn insert_and_read_back_routing_profile() {
        let c = fresh();
        let mut p = make("1", "LiveCase");
        p.routing_aliases = vec!["livecase".into(), "hbsp".into()];
        p.routing_app_hints = vec!["Code".into()];
        p.routing_url_hints = vec!["hbsp.harvard.edu".into()];
        p.routing_window_hints = vec!["livecaseplus".into()];
        p.routing_positive_examples = vec!["update the HBSP proof section".into()];
        p.routing_negative_examples = vec!["generic source-code case statement".into()];
        insert_project(&c, &p).unwrap();

        let got = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(got.routing_aliases, vec!["livecase", "hbsp"]);
        assert_eq!(got.routing_app_hints, vec!["Code"]);
        assert_eq!(got.routing_url_hints, vec!["hbsp.harvard.edu"]);
        assert_eq!(got.routing_window_hints, vec!["livecaseplus"]);
        assert_eq!(
            got.routing_positive_examples,
            vec!["update the HBSP proof section"]
        );
        assert_eq!(
            got.routing_negative_examples,
            vec!["generic source-code case statement"]
        );
    }

    #[test]
    fn update_project_partial_patches_apply() {
        let c = fresh();
        insert_project(&c, &make("1", "alpha")).unwrap();
        let patch = ProjectPatch {
            name: Some("Beta".into()),
            description: Some(Some("desc".into())),
            keywords: Some(vec!["k1".into(), "k2".into()]),
            color: Some(Some("#000000".into())),
            emoji: Some(Some("✨".into())),
            export_folder: Some(Some("/tmp/notes".into())),
            routing_aliases: None,
            routing_app_hints: None,
            routing_url_hints: None,
            routing_window_hints: None,
            routing_positive_examples: None,
            routing_negative_examples: None,
        };
        update_project(&c, "1", &patch, "2026-05-26T10:00:00Z").unwrap();
        let got = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(got.name, "Beta");
        assert_eq!(got.description.as_deref(), Some("desc"));
        assert_eq!(got.keywords, vec!["k1", "k2"]);
        assert_eq!(got.color.as_deref(), Some("#000000"));
        assert_eq!(got.emoji.as_deref(), Some("✨"));
        assert_eq!(got.export_folder.as_deref(), Some("/tmp/notes"));
        assert_eq!(got.updated_at.as_deref(), Some("2026-05-26T10:00:00Z"));
    }

    #[test]
    fn update_project_clears_via_some_none() {
        let c = fresh();
        let mut p = make("1", "alpha");
        p.description = Some("orig".into());
        p.color = Some("#aaaaaa".into());
        p.emoji = Some("x".into());
        insert_project(&c, &p).unwrap();
        let patch = ProjectPatch {
            name: None,
            description: Some(None),
            keywords: None,
            color: Some(None),
            emoji: Some(None),
            export_folder: Some(None),
            routing_aliases: None,
            routing_app_hints: None,
            routing_url_hints: None,
            routing_window_hints: None,
            routing_positive_examples: None,
            routing_negative_examples: None,
        };
        update_project(&c, "1", &patch, "2026-05-26T10:00:00Z").unwrap();
        let got = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(got.description, None);
        assert_eq!(got.color, None);
        assert_eq!(got.emoji, None);
        assert_eq!(got.export_folder, None);
    }

    #[test]
    fn update_project_noop_with_empty_patch() {
        let c = fresh();
        insert_project(&c, &make("1", "alpha")).unwrap();
        let patch = ProjectPatch::default();
        update_project(&c, "1", &patch, "2026-05-26T10:00:00Z").unwrap();
        let got = get_project(&c, "1").unwrap().unwrap();
        assert_eq!(got.name, "alpha");
        assert_eq!(got.updated_at, None);
    }

    #[test]
    fn delete_project_reassigns_items() {
        let mut c = fresh();
        insert_project(&c, &make("p1", "Old")).unwrap();
        insert_project(&c, &make("p2", "New")).unwrap();
        c.execute(
            "INSERT INTO items(id, content, source, project_id, captured_at, created_at)
             VALUES('i1','hi','log_capture','p1','2026-05-01T00:00:00Z','2026-05-01T00:00:00Z')",
            [],
        )
        .unwrap();
        delete_project(&mut c, "p1", Some("p2"), false).unwrap();
        assert!(get_project(&c, "p1").unwrap().is_none());
        let pid: Option<String> = c
            .query_row("SELECT project_id FROM items WHERE id = 'i1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pid.as_deref(), Some("p2"));
    }

    #[test]
    fn delete_project_detaches_all_linked_content_when_no_reassign() {
        let mut c = fresh();
        insert_project(&c, &make("p1", "Solo")).unwrap();
        c.execute(
            "INSERT INTO items(
                id, content, source, kind, project_id, confidence, classified_by,
                captured_at, created_at
             ) VALUES(
                'i1','hi','log_capture','note','p1',0.9,'router-v1',
                '2026-05-01T00:00:00Z','2026-05-01T00:00:00Z'
             )",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO recordings(
                id, created_at, file_path, project_id, confidence, classified_by
             ) VALUES('r1',0,'/tmp/r1.mp4','p1',0.8,'ai-background')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_sessions(id,name,project_id,created_at,updated_at)
             VALUES('c1','Assigned chat','p1','now','now'),
                   ('c2','Scoped chat',NULL,'now','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_session_scopes(session_id,scope_kind,scope_id,created_at)
             VALUES('c2','project','p1','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO embeddings(
                id,source_kind,source_id,passage_idx,passage_text,vec,dim,
                model_id,project_id,captured_at,content_hash,created_at
             ) VALUES('e1','item','i1',0,'hi',X'00',1,'test','p1','now','hash','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meeting_artifacts(
                id,kind,project_id,title,content,created_at,updated_at
             ) VALUES('a1','project_recap','p1','Recap','Body','now','now')",
            [],
        )
        .unwrap();

        delete_project(&mut c, "p1", None, false).unwrap();
        assert!(get_project(&c, "p1").unwrap().is_none());
        for (table, row_id) in [
            ("items", "i1"),
            ("recordings", "r1"),
            ("chat_sessions", "c1"),
            ("embeddings", "e1"),
            ("meeting_artifacts", "a1"),
        ] {
            let sql = format!("SELECT project_id FROM {table} WHERE id = ?1");
            let project_id: Option<String> = c
                .query_row(&sql, params![row_id], |row| row.get(0))
                .unwrap();
            assert_eq!(project_id, None, "{table} should be detached");
        }
        let scoped_chat_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM chat_sessions WHERE id = 'c2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let project_scope_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM chat_session_scopes
                  WHERE scope_kind = 'project' AND scope_id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scoped_chat_count, 1);
        assert_eq!(project_scope_count, 0);
        let classification: (Option<f64>, Option<String>) = c
            .query_row(
                "SELECT confidence, classified_by FROM items WHERE id = 'i1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(classification, (None, None));
    }

    #[test]
    fn project_delete_impact_counts_each_related_content_type() {
        let c = fresh();
        insert_project(&c, &make("p1", "Counted")).unwrap();
        for (id, kind) in [
            ("m1", "meeting"),
            ("n1", "note"),
            ("t1", "task"),
            ("x1", "transcription"),
        ] {
            c.execute(
                "INSERT INTO items(id,content,source,kind,project_id,captured_at,created_at)
                 VALUES(?1,'body','log_capture',?2,'p1','now','now')",
                params![id, kind],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO recordings(id,created_at,file_path,project_id)
             VALUES('r1',0,'/tmp/r1.mp4','p1')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_sessions(id,name,project_id,created_at,updated_at)
             VALUES('c1','Assigned','p1','now','now'),
                   ('c2','Scoped',NULL,'now','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_session_scopes(session_id,scope_kind,scope_id,created_at)
             VALUES('c2','project','p1','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meeting_artifacts(
                id,kind,project_id,title,content,created_at,updated_at
             ) VALUES('a1','project_recap','p1','Recap','Body','now','now')",
            [],
        )
        .unwrap();

        assert_eq!(
            project_delete_impact(&c, "p1").unwrap(),
            ProjectDeleteImpact {
                items: 4,
                meetings: 1,
                notes: 1,
                tasks: 1,
                transcriptions: 1,
                recordings: 1,
                chats: 2,
                artifacts: 1,
            }
        );
    }

    #[test]
    fn delete_project_with_related_content_hard_deletes_only_linked_rows() {
        let mut c = fresh();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        insert_project(&c, &make("p1", "Delete me")).unwrap();
        insert_project(&c, &make("p2", "Keep me")).unwrap();
        for (id, project_id, kind) in [
            ("m1", "p1", "meeting"),
            ("n1", "p1", "note"),
            ("u1", "p2", "note"),
        ] {
            c.execute(
                "INSERT INTO items(id,content,source,kind,project_id,captured_at,created_at)
                 VALUES(?1,'body','log_capture',?2,?3,'now','now')",
                params![id, kind, project_id],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO meetings(item_id,started_at,status) VALUES('m1','now','complete')",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO tasks(item_id) VALUES('n1')", [])
            .unwrap();
        c.execute(
            "INSERT INTO item_tags(item_id,tag) VALUES('n1','important')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO item_events(id,item_id,event_type,created_at)
             VALUES('ev1','n1','created','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO recordings(id,created_at,file_path,project_id)
             VALUES('r1',0,'/tmp/r1.mp4','p1'),('r2',0,'/tmp/r2.mp4','p2')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_sessions(id,name,project_id,created_at,updated_at)
             VALUES('c1','Delete','p1','now','now'),
                   ('c2','Keep','p2','now','now'),
                   ('c3','Scoped delete',NULL,'now','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_session_scopes(session_id,scope_kind,scope_id,created_at)
             VALUES('c3','project','p1','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO chat_messages(id,session_id,role,content,created_at)
             VALUES('msg1','c1','user','assigned','now'),
                   ('msg2','c3','user','scoped','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO item_session_links(item_id,session_id,created_at)
             VALUES('n1','c1','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO meeting_artifacts(
                id,kind,meeting_id,project_id,title,content,created_at,updated_at
             ) VALUES('a1','meeting_recap','m1','p1','Recap','Body','now','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO project_tag_jobs(item_id,status,created_at,updated_at,target)
             VALUES('n1','pending','now','now','item'),('r1','pending','now','now','recording')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO embeddings(
                id,source_kind,source_id,passage_idx,passage_text,vec,dim,
                model_id,project_id,captured_at,content_hash,created_at
             ) VALUES('e1','item','n1',0,'body',X'00',1,'test','p1','now','hash','now')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO embedding_index_state(source_kind,source_id,content_hash,model_id,indexed_at)
             VALUES('item','n1','hash','test','now')",
            [],
        )
        .unwrap();

        delete_project(&mut c, "p1", None, true).unwrap();

        assert!(get_project(&c, "p1").unwrap().is_none());
        assert!(get_project(&c, "p2").unwrap().is_some());
        for (table, expected) in [
            ("items", 1_i64),
            ("recordings", 1),
            ("chat_sessions", 1),
            ("chat_messages", 0),
            ("chat_session_scopes", 0),
            ("meetings", 0),
            ("tasks", 0),
            ("item_tags", 0),
            ("item_events", 0),
            ("item_session_links", 0),
            ("meeting_artifacts", 0),
            ("project_tag_jobs", 0),
            ("embeddings", 0),
            ("embedding_index_state", 0),
        ] {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count: i64 = c.query_row(&sql, [], |row| row.get(0)).unwrap();
            assert_eq!(count, expected, "unexpected row count for {table}");
        }
    }
}
