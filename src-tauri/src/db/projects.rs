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

/// Hard-delete a project. Items pointing at it are first either reassigned
/// to `reassign_to` (if `Some`) or detached (`project_id = NULL`).
/// Wrapped in a transaction so a failed FK cleanup never orphans rows.
pub fn delete_project(
    conn: &mut Connection,
    id: &str,
    reassign_to: Option<&str>,
) -> Result<(), DbError> {
    let tx = conn.transaction()?;
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
        }
        _ => {
            tx.execute(
                "UPDATE items SET project_id = NULL WHERE project_id = ?1",
                params![id],
            )?;
            tx.execute(
                "UPDATE chat_sessions SET project_id = NULL WHERE project_id = ?1",
                params![id],
            )?;
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
        delete_project(&mut c, "p1", Some("p2")).unwrap();
        assert!(get_project(&c, "p1").unwrap().is_none());
        let pid: Option<String> = c
            .query_row("SELECT project_id FROM items WHERE id = 'i1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pid.as_deref(), Some("p2"));
    }

    #[test]
    fn delete_project_detaches_items_when_no_reassign() {
        let mut c = fresh();
        insert_project(&c, &make("p1", "Solo")).unwrap();
        c.execute(
            "INSERT INTO items(id, content, source, project_id, captured_at, created_at)
             VALUES('i1','hi','log_capture','p1','2026-05-01T00:00:00Z','2026-05-01T00:00:00Z')",
            [],
        )
        .unwrap();
        delete_project(&mut c, "p1", None).unwrap();
        assert!(get_project(&c, "p1").unwrap().is_none());
        let pid: Option<String> = c
            .query_row("SELECT project_id FROM items WHERE id = 'i1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(pid, None);
    }
}
