//! Tauri commands for the post-meeting debrief card: confirm the meeting's
//! project and participants, and accept / skip LLM-suggested follow-ups.
//!
//! Tasks are only ever created here, on explicit user accept — never
//! automatically from a meeting. Every mutation emits
//! `meeting-debrief-updated` with `{"meetingId": ...}`. Errors: full detail
//! goes to the log (`target: "debrief"`), the UI gets a short message.

use tauri::{AppHandle, Emitter, State};
use tracing::{info, warn};

use crate::commands::AppState;
use crate::db::meeting_debrief::{self, AcceptOutcome, AddParticipantOutcome, MeetingDebrief};
use crate::db::Db;

const DEBRIEF_WINDOW_DAYS: i64 = 14;
const DEBRIEF_LIMIT: u32 = 5;

fn db(state: &AppState) -> Result<&Db, String> {
    state.db.as_ref().ok_or_else(|| {
        warn!(target: "debrief", "database not available");
        "Database isn't available right now.".to_string()
    })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn emit_updated(app: &AppHandle, meeting_id: &str) {
    if let Err(e) = app.emit(
        "meeting-debrief-updated",
        serde_json::json!({ "meetingId": meeting_id }),
    ) {
        warn!(target: "debrief", meeting_id, error = %e, "emit meeting-debrief-updated failed");
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn list_pending_debriefs(state: State<'_, AppState>) -> Result<Vec<MeetingDebrief>, String> {
    let db = db(&state)?;
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(DEBRIEF_WINDOW_DAYS)).to_rfc3339();
    db.with_conn(|c| meeting_debrief::list_pending_debriefs(c, &cutoff, DEBRIEF_LIMIT))
        .map_err(|e| {
            warn!(target: "debrief", error = %e, "list_pending_debriefs failed");
            "Couldn't load meeting debriefs.".to_string()
        })
}

#[tauri::command]
pub fn accept_meeting_task_suggestion(
    app: AppHandle,
    state: State<'_, AppState>,
    suggestion_id: String,
    text: String,
    assignee_person_id: Option<String>,
    project_id: Option<String>,
    deadline: Option<String>,
) -> Result<String, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        warn!(target: "debrief", suggestion_id, "accept rejected: empty text");
        return Err("A task needs some text.".into());
    }
    let assignee = non_empty(assignee_person_id);
    let project = non_empty(project_id);
    let deadline = non_empty(deadline);
    let db = db(&state)?;
    let now = now_iso();
    let outcome = db
        .with_conn(|c| {
            meeting_debrief::accept_suggestion(
                c,
                &suggestion_id,
                &text,
                assignee.as_deref(),
                project.as_deref(),
                deadline.as_deref(),
                &now,
            )
        })
        .map_err(|e| {
            warn!(target: "debrief", suggestion_id, error = %e, "accept suggestion failed");
            "Couldn't add that task.".to_string()
        })?;
    match outcome {
        AcceptOutcome::Created {
            item_id,
            meeting_id,
        } => {
            info!(
                target: "debrief",
                suggestion_id,
                meeting_id,
                item_id,
                assigned = assignee.is_some(),
                has_project = project.is_some(),
                has_deadline = deadline.is_some(),
                "accepted task suggestion"
            );
            emit_updated(&app, &meeting_id);
            Ok(item_id)
        }
        AcceptOutcome::NotFound => {
            warn!(target: "debrief", suggestion_id, "accept: suggestion not found");
            Err("That suggestion no longer exists.".into())
        }
        AcceptOutcome::NotPending(status) => {
            warn!(target: "debrief", suggestion_id, status, "accept: suggestion not pending");
            Err("That suggestion was already handled.".into())
        }
    }
}

#[tauri::command]
pub fn dismiss_meeting_task_suggestion(
    app: AppHandle,
    state: State<'_, AppState>,
    suggestion_id: String,
) -> Result<(), String> {
    let db = db(&state)?;
    let now = now_iso();
    let meeting_id = db
        .with_conn(|c| meeting_debrief::dismiss_suggestion(c, &suggestion_id, &now))
        .map_err(|e| {
            warn!(target: "debrief", suggestion_id, error = %e, "dismiss suggestion failed");
            "Couldn't skip that suggestion.".to_string()
        })?;
    match meeting_id {
        Some(mid) => {
            info!(target: "debrief", suggestion_id, meeting_id = %mid, "dismissed task suggestion");
            emit_updated(&app, &mid);
            Ok(())
        }
        None => {
            warn!(target: "debrief", suggestion_id, "dismiss: no pending suggestion with that id");
            Err("That suggestion was already handled.".into())
        }
    }
}

#[tauri::command]
pub fn set_meeting_project(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let project = non_empty(project_id);
    let db = db(&state)?;
    let n = db
        .with_conn(|c| meeting_debrief::set_meeting_project(c, &meeting_id, project.as_deref()))
        .map_err(|e| {
            warn!(target: "debrief", meeting_id, project_id = ?project, error = %e, "set meeting project failed");
            "Couldn't change the meeting's project.".to_string()
        })?;
    if n == 0 {
        warn!(target: "debrief", meeting_id, "set meeting project: meeting not found");
        return Err("That meeting no longer exists.".into());
    }
    info!(target: "debrief", meeting_id, project_id = ?project, "set meeting project");
    emit_updated(&app, &meeting_id);
    Ok(())
}

#[tauri::command]
pub fn add_meeting_participant(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    person_id: String,
) -> Result<(), String> {
    let db = db(&state)?;
    let now = now_iso();
    let outcome = db
        .with_conn(|c| meeting_debrief::add_participant(c, &meeting_id, &person_id, &now))
        .map_err(|e| {
            warn!(target: "debrief", meeting_id, person_id, error = %e, "add participant failed");
            "Couldn't add that person to the meeting.".to_string()
        })?;
    match outcome {
        AddParticipantOutcome::Added => {
            info!(target: "debrief", meeting_id, person_id, "added meeting participant");
            emit_updated(&app, &meeting_id);
            Ok(())
        }
        AddParticipantOutcome::AlreadyPresent => {
            info!(target: "debrief", meeting_id, person_id, "participant already present; no-op");
            Ok(())
        }
        AddParticipantOutcome::PersonNotFound => {
            warn!(target: "debrief", meeting_id, person_id, "add participant: person not found");
            Err("That person no longer exists.".into())
        }
    }
}

#[tauri::command]
pub fn remove_meeting_participant(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    speaker_key: String,
) -> Result<(), String> {
    let db = db(&state)?;
    let n = db
        .with_conn(|c| meeting_debrief::remove_participant(c, &meeting_id, &speaker_key))
        .map_err(|e| {
            warn!(target: "debrief", meeting_id, speaker_key, error = %e, "remove participant failed");
            "Couldn't remove that person from the meeting.".to_string()
        })?;
    info!(target: "debrief", meeting_id, speaker_key, removed = n, "removed meeting participant");
    emit_updated(&app, &meeting_id);
    Ok(())
}

#[tauri::command]
pub fn complete_meeting_debrief(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    status: String,
) -> Result<(), String> {
    if !matches!(status.as_str(), "done" | "dismissed") {
        warn!(target: "debrief", meeting_id, status, "complete debrief: invalid status");
        return Err("Invalid debrief status.".into());
    }
    let db = db(&state)?;
    let now = now_iso();
    let n = db
        .with_conn(|c| meeting_debrief::complete_debrief(c, &meeting_id, &status, &now))
        .map_err(|e| {
            warn!(target: "debrief", meeting_id, status, error = %e, "complete debrief failed");
            "Couldn't close the meeting debrief.".to_string()
        })?;
    if n == 0 {
        warn!(target: "debrief", meeting_id, "complete debrief: meeting not found");
        return Err("That meeting no longer exists.".into());
    }
    info!(target: "debrief", meeting_id, status, "completed meeting debrief");
    emit_updated(&app, &meeting_id);
    Ok(())
}

#[tauri::command]
pub fn set_task_assignee(
    state: State<'_, AppState>,
    item_id: String,
    person_id: Option<String>,
) -> Result<(), String> {
    let person = non_empty(person_id);
    let db = db(&state)?;
    let n = db
        .with_conn(|c| meeting_debrief::set_task_assignee(c, &item_id, person.as_deref()))
        .map_err(|e| {
            warn!(target: "debrief", item_id, person_id = ?person, error = %e, "set task assignee failed");
            "Couldn't change who the task is assigned to.".to_string()
        })?;
    if n == 0 {
        warn!(target: "debrief", item_id, "set task assignee: item is not a task");
        return Err("That task no longer exists.".into());
    }
    info!(target: "debrief", item_id, assigned = person.is_some(), "set task assignee");
    Ok(())
}
