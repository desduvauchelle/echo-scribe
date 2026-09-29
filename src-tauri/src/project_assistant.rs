//! Native project tools shared by the spoken command and project assistant UI.
use crate::{
    commands::{self, AppState},
    db::{
        self,
        items::{Item, ItemKind, ItemSource},
        projects::{Project, ProjectFolder, ProjectPatch},
    },
    llm::project_agent::{self, Executor, Report, Source, ToolFuture, ToolResult},
    project_files,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static LAST_REPORT: Mutex<Option<Report>> = Mutex::new(None);
struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn get_project(app: &AppHandle, id: &str) -> Result<Project, String> {
    let state = app.state::<AppState>();
    state
        .db
        .as_ref()
        .ok_or("Project storage is unavailable.")?
        .with_conn(|c| db::projects::get_project(c, id))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            // Hand the model the real IDs so it doesn't burn its step budget
            // guessing (a rename once took 7 misses before list_projects).
            let known = state
                .db
                .as_ref()
                .and_then(|db| db.with_conn(|c| db::projects::list_projects(c, true)).ok())
                .unwrap_or_default()
                .iter()
                .take(50)
                .map(|p| json!({"id": p.id, "name": p.name}))
                .collect::<Vec<_>>();
            format!("Project not found. Use one of these project IDs: {}", json!(known))
        })
}
fn field<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing {key}."))
}
fn clip(value: Option<&str>) -> String {
    value.unwrap_or("").chars().take(2000).collect()
}
fn folder_name(folder: &ProjectFolder) -> String {
    std::path::Path::new(&folder.path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn project_data(project: &Project) -> Value {
    json!({"id":project.id,"name":project.name,"description":clip(project.description.as_deref()),
        "purpose":clip(project.purpose.as_deref()),"instructions":clip(project.instructions.as_deref()),"archived":project.archived_at.is_some(),
        "folders":project.reference_folders.iter().map(|f| json!({"id":f.id,"name":folder_name(f),"available":project_files::folder_root(f).is_ok()})).collect::<Vec<_>>()})
}
fn changed(app: &AppHandle, data: Value, message: String) -> ToolResult {
    tracing::info!(target: "project_agent", "project changed");
    let _ = app.emit("projects:changed", ());
    ToolResult {
        data,
        change: Some(message),
        sources: vec![],
    }
}

fn item_changed(app: &AppHandle, data: Value, message: String, created: bool) -> ToolResult {
    tracing::info!(target: "project_agent", created, "project item changed");
    if created {
        let _ = app.emit("item:created", ());
    } else {
        let _ = app.emit("app:refresh", ());
    }
    ToolResult {
        data,
        change: Some(message),
        sources: vec![],
    }
}

fn item_content(args: &Value) -> Result<&str, String> {
    field(args, "content").and_then(|content| {
        let content = content.trim();
        if content.is_empty() || content.len() > 12_000 {
            Err("Item text must contain 1 to 12,000 bytes.".into())
        } else {
            Ok(content)
        }
    })
}

fn require_stored_project_item(
    database: &db::Db,
    project_id: &str,
    item_id: &str,
    kind: ItemKind,
) -> Result<Item, String> {
    database
        .with_conn(|conn| {
            Ok(db::items::get_item(conn, item_id)?.filter(|item| item.deleted_at.is_none()))
        })
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Item not found.".to_string())
        .and_then(|item| {
            if item.project_id.as_deref() == Some(project_id) && item.kind == Some(kind) {
                Ok(item)
            } else {
                Err(format!(
                    "That {} does not belong to the selected project.",
                    kind.as_str()
                ))
            }
        })
}

fn create_project_item(
    conn: &rusqlite::Connection,
    project_id: &str,
    content: &str,
    kind: ItemKind,
    deadline: Option<&str>,
) -> Result<Item, db::DbError> {
    let now = db::items::chrono_now_iso();
    let item = Item {
        id: ulid::Ulid::new().to_string(),
        content: content.to_string(),
        source: ItemSource::LogCapture,
        kind: Some(kind),
        project_id: Some(project_id.to_string()),
        captured_at: now.clone(),
        created_at: now,
        deleted_at: None,
        confidence: Some(1.0),
        classified_by: Some("project_agent".into()),
        capture_context: None,
        importance: None,
    };
    db::items::insert_item(conn, &item)?;
    db::events::insert_event(conn, &item.id, "created", Some("via project_agent"))?;
    db::events::insert_event(conn, &item.id, "project_assigned", Some(project_id))?;
    if kind == ItemKind::Task {
        db::tasks::upsert_task(
            conn,
            &db::tasks::Task {
                item_id: item.id.clone(),
                deadline: deadline.map(str::to_string),
                completed_at: None,
            },
        )?;
    }
    Ok(item)
}

/// A spoken task referring to "this" uses the text selected when recording
/// began. Only these requests may consume the selection snapshot.
pub fn is_selected_task_request(request: &str) -> bool {
    let words = request
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let has_task = words.iter().any(|word| matches!(word.as_str(), "task" | "todo"));
    let wants_creation = words.iter().any(|word| matches!(word.as_str(), "create" | "add" | "make" | "save"));
    let refers_to_selection = words.windows(2).any(|pair| {
        matches!(pair, [a, b] if matches!(a.as_str(), "for" | "from" | "about" | "using") && b == "this")
    }) || words.windows(2).any(|pair| matches!(pair, [a, b] if a == "selected" && b == "text"));
    wants_creation && has_task && refers_to_selection
}

fn project_for_spoken_task<'a>(request: &str, projects: &'a [Project]) -> Result<&'a Project, String> {
    let spoken = format!(" {} ", request.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>().join(" "));
    let matches = projects.iter().filter(|project| {
        let name = project.name.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>().join(" ");
        !name.is_empty() && [
            format!(" project {name} "),
            format!(" in {name} "),
            format!(" to {name} "),
            format!(" for {name} "),
            format!(" and {name} "),
        ].iter().any(|phrase| spoken.contains(phrase))
    }).collect::<Vec<_>>();
    match matches.as_slice() {
        [project] => Ok(project),
        [] => Err("I couldn't identify a project by name. Say its exact name after ‘project’.".into()),
        _ => Err("I found more than one project name in that request. Please name one project.".into()),
    }
}

/// File highlighted text exactly as a task, without asking the language model
/// to rewrite or interpret text copied from another app.
pub fn create_task_from_selection(app: &AppHandle, request: &str, selected_text: &str) -> Result<String, String> {
    let content = selected_text.trim();
    if content.is_empty() || content.len() > 12_000 {
        return Err("Select task text between 1 and 12,000 bytes.".into());
    }
    let state = app.state::<AppState>();
    let database = state.db.as_ref().ok_or("Project storage is unavailable.")?;
    let projects = database.with_conn(|conn| db::projects::list_projects(conn, false))
        .map_err(|error| error.to_string())?;
    let project = project_for_spoken_task(request, &projects)?;
    let item = database.with_conn(|conn| create_project_item(conn, &project.id, content, ItemKind::Task, None))
        .map_err(|error| error.to_string())?;
    crate::export::try_export_item(database, &item, state.settings.export_confidence_threshold());
    let message = format!("Created task in ‘{}’: {}", project.name, content.chars().take(100).collect::<String>());
    item_changed(app, json!({"id":item.id,"project_id":project.id,"kind":"task"}), message.clone(), true);
    Ok(message)
}

#[tauri::command]
pub async fn pick_reference_folders(app: AppHandle) -> Result<Vec<ProjectFolder>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose project reference folders")
        .pick_folders(move |paths| {
            let _ = tx.send(
                paths
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|p| {
                        p.as_path().map(|p| ProjectFolder {
                            id: ulid::Ulid::new().to_string(),
                            path: p.to_string_lossy().into_owned(),
                        })
                    })
                    .collect::<Vec<_>>(),
            );
        });
    let folders = rx
        .await
        .map_err(|_| "The folder chooser closed unexpectedly. Try again.".to_string())?;
    tracing::info!(target: "project_files", count = folders.len(), "reference folder chooser completed");
    project_files::validate_folders(folders, &[])
}

#[tauri::command]
pub fn reference_folder_status(folders: Vec<ProjectFolder>) -> Vec<Value> {
    folders
        .iter()
        .take(12)
        .map(|f| json!({"id":f.id,"available":project_files::folder_root(f).is_ok()}))
        .collect()
}

#[tauri::command]
pub fn reveal_project_reference(
    app: AppHandle,
    project_id: String,
    folder_id: String,
    path: Option<String>,
) -> Result<(), String> {
    let project = get_project(&app, &project_id)?;
    let folder = project
        .reference_folders
        .iter()
        .find(|f| f.id == folder_id)
        .ok_or("Folder is no longer linked.")?;
    let target = match path {
        Some(path) => project_files::resolve_file(folder, &path)?,
        None => project_files::folder_root(folder)?,
    };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&target)
        .status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", target.display()))
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open")
        .arg(target.parent().unwrap_or(&target))
        .status();
    match result {
        Ok(status) if status.success() => Ok(()),
        other => {
            tracing::warn!(target: "project_files", result = ?other, "could not reveal reference");
            Err("Couldn't show that reference in the file manager.".into())
        }
    }
}

struct NativeTools(AppHandle);
impl Executor for NativeTools {
    fn execute<'a>(&'a self, tool: &'a str, args: Value) -> ToolFuture<'a> {
        Box::pin(async move {
            let app = &self.0;
            if CANCELLED.load(Ordering::SeqCst) {
                return Err("Stopped.".into());
            }
            if tool == "list_projects" {
                let state = app.state::<AppState>();
                let projects = state
                    .db
                    .as_ref()
                    .ok_or("Project storage is unavailable.")?
                    .with_conn(|c| db::projects::list_projects(c, true))
                    .map_err(|e| e.to_string())?;
                return Ok(ToolResult::data(
                    json!({"projects":projects.iter().take(100).map(|p| json!({"id":p.id,"name":p.name,"archived":p.archived_at.is_some()})).collect::<Vec<_>>(),"truncated":projects.len()>100}),
                ));
            }
            if tool == "create_project" {
                validate_edit_args(&args, false)?;
                let input: commands::CreateProjectInput = serde_json::from_value(args)
                    .map_err(|_| "Invalid project fields.".to_string())?;
                let project = commands::create_project(app.state::<AppState>(), input)?;
                return Ok(changed(
                    app,
                    project_data(&project),
                    format!("Created project ‘{}’.", project.name),
                ));
            }
            if tool == "get_today_focus_note" || tool == "set_today_focus_note" {
                let local_date = chrono::Local::now().format("%Y-%m-%d").to_string();
                let state = app.state::<AppState>();
                if tool == "get_today_focus_note" {
                    let note = commands::get_daily_focus_note(state, local_date.clone())?;
                    return Ok(ToolResult::data(json!({"local_date":local_date,"note":note})));
                }
                let content = field(&args, "content")?.to_string();
                let note = commands::save_daily_focus_note(app.clone(), state, local_date, content)?;
                return Ok(ToolResult {
                    data: json!(note),
                    change: Some(if note.content.is_empty() {
                        "Cleared today's focus note.".into()
                    } else {
                        "Updated today's focus note.".into()
                    }),
                    sources: vec![],
                });
            }
            // Unknown tool names never reach any storage or filesystem operation.
            if !matches!(
                tool,
                "get_project"
                    | "update_project"
                    | "archive_project"
                    | "unarchive_project"
                    | "list_project_items"
                    | "create_task"
                    | "create_note"
                    | "update_task"
                    | "update_note"
                    | "complete_task"
                    | "reopen_task"
                    | "set_focus"
                    | "delete_focus_task"
                    | "link_folders"
                    | "unlink_folder"
                    | "search_files"
                    | "read_file"
                    | "search_notes"
            ) {
                return Err("Unknown project tool.".into());
            }
            let id = field(&args, "project_id")?;
            let project = get_project(app, id)?;
            match tool {
                "get_project" => Ok(ToolResult::data(project_data(&project))),
                "list_project_items" => {
                    let kind = match args.get("kind").and_then(Value::as_str) {
                        None => None,
                        Some("task") => Some("task"),
                        Some("note") => Some("note"),
                        Some(_) => return Err("kind must be task or note.".into()),
                    };
                    let include_completed = args
                        .get("include_completed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let focus_only = args
                        .get("focus_only")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let state = app.state::<AppState>();
                    let items = state
                        .db
                        .as_ref()
                        .ok_or("Project storage is unavailable.")?
                        .with_conn(|conn| {
                            let items = db::items::list_items(conn, Some(id), kind, 100, 0)?;
                            let mut output = Vec::new();
                            for item in items {
                                let task = if item.kind == Some(ItemKind::Task) {
                                    db::tasks::get_task(conn, &item.id)?
                                } else {
                                    None
                                };
                                let completed = task
                                    .as_ref()
                                    .and_then(|task| task.completed_at.as_ref())
                                    .is_some();
                                if !include_completed && completed {
                                    continue;
                                }
                                let focus = item.kind == Some(ItemKind::Task)
                                    && db::tasks::is_focus_task(conn, &item.id)?;
                                if focus_only && !focus {
                                    continue;
                                }
                                output.push(json!({
                                    "id": item.id,
                                    "content": item.content,
                                    "kind": item.kind.map(|kind| kind.as_str()),
                                    "deadline_iso": task.as_ref().and_then(|task| task.deadline.as_deref()),
                                    "completed": completed,
                                    "focus": focus,
                                }));
                            }
                            Ok(output)
                        })
                        .map_err(|e| e.to_string())?;
                    Ok(ToolResult::data(json!({"items": items})))
                }
                "create_task" | "create_note" => {
                    let content = item_content(&args)?;
                    let kind = if tool == "create_task" {
                        ItemKind::Task
                    } else {
                        ItemKind::Note
                    };
                    let deadline = args.get("deadline_iso").and_then(Value::as_str);
                    if kind == ItemKind::Note && args.get("deadline_iso").is_some() {
                        return Err("Notes cannot have deadlines.".into());
                    }
                    let focus = args.get("focus").and_then(Value::as_bool).unwrap_or(false);
                    if kind == ItemKind::Note && focus {
                        return Err("Only tasks can be focus items.".into());
                    }
                    let state = app.state::<AppState>();
                    let item = state
                        .db
                        .as_ref()
                        .ok_or("Project storage is unavailable.")?
                        .with_conn(|conn| {
                            let item = create_project_item(conn, id, content, kind, deadline)?;
                            if focus {
                                db::tasks::set_focus(conn, &item.id, true)?;
                            }
                            Ok(item)
                        })
                        .map_err(|e| e.to_string())?;
                    if focus {
                        tracing::info!(target: "focus", item_id = %item.id, "project agent added focus task");
                        let _ = app.emit("focus:changed", ());
                    }
                    if let Some(database) = state.db.as_ref() {
                        crate::export::try_export_item(
                            database,
                            &item,
                            state.settings.export_confidence_threshold(),
                        );
                    }
                    Ok(item_changed(
                        app,
                        json!({"id":item.id,"project_id":id,"kind":kind.as_str()}),
                        format!(
                            "Created {} in ‘{}’: {}",
                            if focus { "focus task" } else { kind.as_str() },
                            project.name,
                            content
                        ),
                        true,
                    ))
                }
                "update_task" | "update_note" => {
                    let item_id = field(&args, "item_id")?;
                    let content = item_content(&args)?;
                    let kind = if tool == "update_task" {
                        ItemKind::Task
                    } else {
                        ItemKind::Note
                    };
                    let state = app.state::<AppState>();
                    let database = state.db.as_ref().ok_or("Project storage is unavailable.")?;
                    require_stored_project_item(database, id, item_id, kind)?;
                    database
                        .with_conn(|conn| {
                            db::items::update_item(conn, item_id, Some(content), None, None, None)?;
                            db::events::insert_event(conn, item_id, "content_edited", None)?;
                            if kind == ItemKind::Task && args.get("deadline_iso").is_some() {
                                let deadline = args.get("deadline_iso").and_then(Value::as_str);
                                db::tasks::set_deadline(conn, item_id, deadline)?;
                            }
                            Ok(())
                        })
                        .map_err(|e| e.to_string())?;
                    if let Ok(Some(item)) =
                        database.with_conn(|conn| db::items::get_item(conn, item_id))
                    {
                        crate::export::try_export_item(
                            database,
                            &item,
                            state.settings.export_confidence_threshold(),
                        );
                    }
                    Ok(item_changed(
                        app,
                        json!({"id":item_id,"project_id":id,"kind":kind.as_str()}),
                        format!(
                            "Updated {} in ‘{}’: {}",
                            kind.as_str(),
                            project.name,
                            content
                        ),
                        false,
                    ))
                }
                "complete_task" | "reopen_task" => {
                    let item_id = field(&args, "item_id")?;
                    let state = app.state::<AppState>();
                    let database = state.db.as_ref().ok_or("Project storage is unavailable.")?;
                    require_stored_project_item(database, id, item_id, ItemKind::Task)?;
                    database
                        .with_conn(|conn| {
                            if tool == "complete_task" {
                                db::tasks::complete_task(
                                    conn,
                                    item_id,
                                    &db::items::chrono_now_iso(),
                                )?;
                                db::events::insert_event(conn, item_id, "completed", None)?;
                            } else {
                                db::tasks::uncomplete_task(conn, item_id)?;
                                db::events::insert_event(conn, item_id, "uncompleted", None)?;
                            }
                            Ok(())
                        })
                        .map_err(|e| e.to_string())?;
                    let verb = if tool == "complete_task" {
                        "Completed"
                    } else {
                        "Reopened"
                    };
                    Ok(item_changed(
                        app,
                        json!({"id":item_id,"project_id":id,"completed":tool == "complete_task"}),
                        format!("{verb} task in ‘{}’.", project.name),
                        false,
                    ))
                }
                "set_focus" | "delete_focus_task" => {
                    let item_id = field(&args, "item_id")?;
                    let state = app.state::<AppState>();
                    let database = state.db.as_ref().ok_or("Project storage is unavailable.")?;
                    let item = require_stored_project_item(database, id, item_id, ItemKind::Task)?;
                    let message = if tool == "set_focus" {
                        let focus = args
                            .get("focus")
                            .and_then(Value::as_bool)
                            .ok_or("Missing focus (true or false).")?;
                        database
                            .with_conn(|conn| db::tasks::set_focus(conn, item_id, focus))
                            .map_err(|e| e.to_string())?;
                        if focus {
                            format!("Moved to focus in ‘{}’: {}", project.name, item.content)
                        } else {
                            format!("Removed from focus in ‘{}’: {}", project.name, item.content)
                        }
                    } else {
                        let is_focus = database
                            .with_conn(|conn| db::tasks::is_focus_task(conn, item_id))
                            .map_err(|e| e.to_string())?;
                        if !is_focus {
                            return Err("That task is not a focus task; only focus tasks can be deleted.".into());
                        }
                        database
                            .with_conn(|conn| {
                                db::items::soft_delete_item(conn, item_id)?;
                                db::events::insert_event(conn, item_id, "deleted", Some("focus"))
                            })
                            .map_err(|e| e.to_string())?;
                        format!("Deleted focus task in ‘{}’: {}", project.name, item.content)
                    };
                    tracing::info!(target: "focus", tool, item_id, "project agent changed focus task");
                    let _ = app.emit("focus:changed", ());
                    Ok(item_changed(
                        app,
                        json!({"id":item_id,"project_id":id}),
                        message,
                        false,
                    ))
                }
                "update_project" => {
                    validate_edit_args(&args, true)?;
                    let patch: ProjectPatch = serde_json::from_value(args.clone())
                        .map_err(|_| "Invalid project fields.".to_string())?;
                    let updated = commands::update_project(
                        app.state::<AppState>(),
                        commands::UpdateProjectInput {
                            id: id.into(),
                            patch,
                        },
                    )?;
                    Ok(changed(
                        app,
                        project_data(&updated),
                        format!("Updated project ‘{}’.", updated.name),
                    ))
                }
                "archive_project" | "unarchive_project" => {
                    if tool == "archive_project" {
                        commands::archive_project(app.state::<AppState>(), id.into())?;
                    } else {
                        commands::unarchive_project(app.state::<AppState>(), id.into())?;
                    }
                    Ok(changed(
                        app,
                        json!({"ok":true}),
                        format!(
                            "{} project ‘{}’.",
                            if tool == "archive_project" {
                                "Archived"
                            } else {
                                "Restored"
                            },
                            project.name
                        ),
                    ))
                }
                "link_folders" => {
                    let selected = pick_reference_folders(app.clone()).await?;
                    if CANCELLED.load(Ordering::SeqCst) {
                        return Err("Stopped; selected folders were not linked.".into());
                    }
                    if selected.is_empty() {
                        return Ok(ToolResult::data(
                            json!({"cancelled":true,"message":"The user cancelled. No folders were linked."}),
                        ));
                    }
                    // Re-read after the chooser closes to preserve intervening UI edits.
                    let current = get_project(app, id)?;
                    let before = current.reference_folders.len();
                    let mut folders = current.reference_folders;
                    folders.extend(selected);
                    let updated = commands::update_project(
                        app.state::<AppState>(),
                        commands::UpdateProjectInput {
                            id: id.into(),
                            patch: ProjectPatch {
                                reference_folders: Some(folders),
                                ..Default::default()
                            },
                        },
                    )?;
                    let count = updated.reference_folders.len().saturating_sub(before);
                    if count == 0 {
                        return Ok(ToolResult::data(
                            json!({"message":"These folders were already linked."}),
                        ));
                    }
                    Ok(changed(
                        app,
                        project_data(&updated),
                        format!("Linked {count} reference folder(s) to ‘{}’.", updated.name),
                    ))
                }
                "unlink_folder" => {
                    let folder_id = field(&args, "folder_id")?;
                    let folder = project
                        .reference_folders
                        .iter()
                        .find(|f| f.id == folder_id)
                        .ok_or("Folder is no longer linked.")?;
                    let name = folder_name(folder);
                    let folders = project
                        .reference_folders
                        .into_iter()
                        .filter(|f| f.id != folder_id)
                        .collect();
                    let updated = commands::update_project(
                        app.state::<AppState>(),
                        commands::UpdateProjectInput {
                            id: id.into(),
                            patch: ProjectPatch {
                                reference_folders: Some(folders),
                                ..Default::default()
                            },
                        },
                    )?;
                    Ok(changed(
                        app,
                        project_data(&updated),
                        format!("Unlinked ‘{name}’. Its files were left in place."),
                    ))
                }
                "search_files" | "read_file" => {
                    let folder_id = field(&args, "folder_id")?;
                    let folder = project
                        .reference_folders
                        .iter()
                        .find(|f| f.id == folder_id)
                        .ok_or("Folder is not linked to this project.")?
                        .clone();
                    let query = args
                        .get("query")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let path = args
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let start = args
                        .get("start_line")
                        .and_then(Value::as_u64)
                        .unwrap_or(1)
                        .min(1_000_000) as usize;
                    let search = tool == "search_files";
                    let (data, excerpts) =
                        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
                            if search {
                                let result = project_files::search_folder(&folder, &query)?;
                                Ok((json!(result), result.matches))
                            } else {
                                let result = project_files::read_file(&folder, &path, start)?;
                                Ok((json!(result), vec![result]))
                            }
                        })
                        .await
                        .map_err(|_| "Couldn't read project references.".to_string())??;
                    let sources = excerpts
                        .iter()
                        .map(|e| Source {
                            number: 0,
                            project_id: id.into(),
                            folder_id: Some(e.folder_id.clone()),
                            path: Some(e.path.clone()),
                            item_id: None,
                            line: e.start_line,
                            label: format!("{} — {}:{}", project.name, e.path, e.start_line),
                        })
                        .collect();
                    Ok(ToolResult {
                        data,
                        sources,
                        change: None,
                    })
                }
                "search_notes" => {
                    let query = field(&args, "query")?;
                    // Treat model text as literal search terms, not FTS syntax.
                    let query = query
                        .split_whitespace()
                        .take(12)
                        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
                        .collect::<Vec<_>>()
                        .join(" OR ");
                    let state = app.state::<AppState>();
                    let items = state
                        .db
                        .as_ref()
                        .ok_or("Project storage is unavailable.")?
                        .with_conn(|c| db::search::search_items_for_project(c, &query, Some(id), 8))
                        .map_err(|e| e.to_string())?;
                    let sources = items
                        .iter()
                        .map(|item| Source {
                            number: 0,
                            project_id: id.into(),
                            folder_id: None,
                            path: None,
                            item_id: Some(item.id.clone()),
                            line: 0,
                            label: format!("{} — saved note, {}", project.name, item.captured_at),
                        })
                        .collect();
                    Ok(ToolResult { data: json!(items.iter().map(|i| json!({"id":i.id,"content":i.content.chars().take(1800).collect::<String>(),"captured_at":i.captured_at})).collect::<Vec<_>>()), sources, change: None })
                }
                _ => unreachable!(),
            }
        })
    }
}

fn validate_edit_args(args: &Value, update: bool) -> Result<(), String> {
    let object = args
        .as_object()
        .ok_or("Project fields must be an object.")?;
    for (key, value) in object {
        if !(matches!(
            key.as_str(),
            "name" | "description" | "purpose" | "instructions"
        ) || (update && key == "project_id"))
        {
            return Err(format!("The project tool cannot edit {key}."));
        }
        if !(value.is_null() || value.as_str().is_some_and(|s| s.len() <= 4000)) {
            return Err("Project fields must be text of at most 4,000 bytes.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_project_assistant_report() -> Option<Report> {
    LAST_REPORT.lock().ok().and_then(|r| r.clone())
}

#[tauri::command]
pub fn stop_project_assistant() {
    CANCELLED.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn run_project_assistant(app: AppHandle, request: String) -> Result<Report, String> {
    run_request(app, request, false).await
}

/// Spoken "Tucky, …" project request. If the main window is already in front the
/// report dialog shows progress as before; otherwise the app stays in the
/// background and a toast near the pet shows progress + result.
pub async fn run_spoken_request(app: AppHandle, request: String) -> Result<Report, String> {
    let in_front = app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
    });
    tracing::info!(target: "project_agent", in_front, "spoken project request");
    run_request(app, request, !in_front).await
}

async fn run_request(app: AppHandle, request: String, headless: bool) -> Result<Report, String> {
    let request = request.trim();
    if request.is_empty() || request.len() > 4000 {
        return Err("Enter a request of up to 4,000 bytes.".into());
    }
    RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Tucky is already handling a project request.".to_string())?;
    let _guard = RunGuard;
    CANCELLED.store(false, Ordering::SeqCst);
    if headless {
        // The agent toast owns progress and the eventual result. Retire the
        // capture pill before showing it so one request has one visible status.
        crate::overlay::hide_recording_overlay_now(&app);
        crate::agent_toast::show(&app);
    } else {
        commands::show_main_window(app.clone())?;
    }
    // Headless runs use their own event so the hidden main window doesn't pop
    // its dialog open behind the user's back.
    let event = if headless {
        "agent-toast:report"
    } else {
        "project-assistant:report"
    };
    let llm = app.state::<AppState>().llm.clone();
    tracing::info!(target: "project_agent", "project request started");
    let report = project_agent::run(
        llm.as_ref(),
        &NativeTools(app.clone()),
        request,
        &CANCELLED,
        |report| {
            if let Ok(mut last) = LAST_REPORT.lock() {
                *last = Some(report.clone());
            }
            let _ = app.emit(event, report);
        },
    )
    .await;
    tracing::info!(target: "project_agent", status = %report.status, changes = report.changes.len(), sources = report.sources.len(), "project request finished");
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn selected_task_intent_requires_a_task_and_selection_reference() {
        assert!(is_selected_task_request("create a task for this for the project LiveCase"));
        assert!(is_selected_task_request("add a task from the selected text in LiveCase"));
        assert!(!is_selected_task_request("add a task to LiveCase to review the proposal"));
        assert!(!is_selected_task_request("create a note for this in LiveCase"));
        assert!(!is_selected_task_request("delete the task for this in LiveCase"));
    }

    #[test]
    fn spoken_selected_task_resolves_one_existing_project() {
        let projects = vec![
            Project { id: "livecase".into(), name: "LiveCase".into(), ..Default::default() },
            Project { id: "tucky".into(), name: "Tucky".into(), ..Default::default() },
        ];
        assert_eq!(project_for_spoken_task("create a task for this for the project LiveCase", &projects).unwrap().id, "livecase");
        assert!(project_for_spoken_task("create a task for this for the project Unknown", &projects).is_err());
        assert!(project_for_spoken_task("create a task for this in LiveCase and Tucky", &projects).is_err());
    }

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        db::schema::run_migrations(&mut conn).unwrap();
        db::projects::insert_project(
            &conn,
            &Project {
                id: "livecase".into(),
                name: "LiveCase".into(),
                created_at: "2026-09-14T00:00:00Z".into(),
                archived_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        conn
    }

    #[test]
    fn model_cannot_grant_itself_paths_or_export_access() {
        assert!(validate_edit_args(
            &json!({"name":"Website","reference_folders":[{"path":"/"}]}),
            false
        )
        .is_err());
        assert!(
            validate_edit_args(&json!({"project_id":"p1","export_folder":"/tmp"}), true).is_err()
        );
        assert!(
            validate_edit_args(&json!({"project_id":"p1","purpose":"Launch website"}), true)
                .is_ok()
        );
    }

    #[test]
    fn project_agent_items_persist_with_kind_project_and_task_state() {
        let conn = fresh();
        let task = create_project_item(
            &conn,
            "livecase",
            "Finish the pipeline on Zendesk",
            ItemKind::Task,
            None,
        )
        .unwrap();
        let note = create_project_item(
            &conn,
            "livecase",
            "Zendesk pipeline decision",
            ItemKind::Note,
            None,
        )
        .unwrap();

        assert_eq!(task.project_id.as_deref(), Some("livecase"));
        assert_eq!(task.kind, Some(ItemKind::Task));
        assert!(db::tasks::get_task(&conn, &task.id).unwrap().is_some());
        assert_eq!(note.project_id.as_deref(), Some("livecase"));
        assert_eq!(note.kind, Some(ItemKind::Note));
        assert!(db::tasks::get_task(&conn, &note.id).unwrap().is_none());
    }
}
