//! Tauri commands exposed to the frontend.
//!
//! These wire up:
//!  - permission status checks + deep links into System Settings
//!  - get/update of the user-configurable voice-at-cursor binding
//!  - explicit pipeline start (called by onboarding once permissions are green)
//!
//! The [`AppState`] container is created in [`crate::lib::run`] and managed via
//! Tauri's state container (`app.manage(...)`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{error, info};

use crate::asr::downloader::{self, DownloadProgress};
use crate::asr::pipeline::AsrPipeline;
use crate::asr::registry::{self, ModelEntry};
use crate::llm::{self, GenerateRequest, Llm, LlmDownloadProgress, LlmModelEntry};
use crate::coordinator::{self, new_state_handle, Action, CoordinatorMsg, TrayPipelineState};
use crate::db::items::{chrono_now_iso, ItemKind};
use crate::db::projects::Project;
use crate::db::tasks::TaskWithItem;
use crate::db::{self, ChatMessage, ChatSession, Db, Item, Visibility};
use crate::db::chat;
use crate::temporal::extract_date_window;
use crate::input::binding::{code_from_key, key_from_code, Binding, ModifierKind, ModifierSide, SerKey};
use crate::input::hotkeys::{spawn_listener, HotkeyEvent};
use crate::permissions::{self, MicAccessOutcome, PermissionsStatus, SettingsPane};
use crate::settings::SettingsStore;
use crate::ui::tray::TrayHandle;

/// Application-wide state shared by all Tauri commands.
///
/// `tray` is held behind an `Arc<Mutex<_>>` because tray updates fire from
/// the coordinator thread. `binding` is an `Arc<RwLock<_>>` so the rdev
/// listener thread can re-read it on every event without us having to tear
/// the listener down to change the hotkey.
pub struct AppState {
    pub tray: Arc<Mutex<TrayHandle<Wry>>>,
    pub settings: SettingsStore,
    pub binding: Arc<RwLock<Binding>>,
    pub log_capture_binding: Arc<RwLock<Binding>>,
    pub hotkey_started: AtomicBool,
    /// When `true`, the coordinator drops Pressed/Released events. Toggled
    /// from the tray menu (Pause/Resume hotkeys). The hotkey listeners stay
    /// running so the toggle is instant — only the coordinator filters.
    pub paused_hotkeys: Arc<AtomicBool>,
    /// When `true`, the CGEventTap passes all events through without swallowing
    /// or emitting. Set while the settings UI is in hotkey-capture mode so the
    /// web view's DOM receives raw key events for the rebinder.
    pub rebinding: Arc<AtomicBool>,
    /// Multiplexed channel into the coordinator. Wraps both
    /// hotkey-derived events (with their `Action` tag) and frontend
    /// confirmation messages for LogCapture. Populated on first
    /// `start_pipeline`.
    pub coord_tx: Mutex<Option<UnboundedSender<CoordinatorMsg>>>,
    pub asr: Arc<AsrPipeline>,
    pub llm: Arc<Llm>,
    /// On-disk SQLite handle. `None` only if DB initialization failed at
    /// startup (in which case persistence is disabled but Phase 1 behavior
    /// still works — paste-at-cursor must never be blocked by DB issues).
    pub db: Option<Db>,
    /// Root for the user-facing event archive (defaults to `~/EchoScribe/`).
    pub event_log_root: Option<std::path::PathBuf>,
    /// The non-blocking log appender's worker guard. Held for the lifetime
    /// of `AppState` so logs flush on graceful exit — see `lib.rs::run`.
    pub _log_guard: Mutex<Option<tracing_appender::non_blocking::WorkerGuard>>,
    pub meeting_manager: Arc<crate::meeting::MeetingManager>,
}

/// JSON-friendly mirror of [`Binding`].
///
/// `primary` is the DOM `KeyboardEvent.code` string (e.g. `"ControlRight"`).
/// We translate it to/from `rdev::Key` via [`key_from_code`] and [`code_from_key`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsBinding {
    pub primary: String,
    pub modifiers: Vec<JsModifier>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsModifier {
    /// "Control" | "Shift" | "Alt" | "Meta"
    pub kind: String,
    /// "Left" | "Right" | "Either"
    pub side: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BindingConversionError {
    #[error("unknown key code: {0}")]
    UnknownKey(String),
    #[error("unknown modifier kind: {0}")]
    UnknownModifierKind(String),
    #[error("unknown modifier side: {0}")]
    UnknownModifierSide(String),
}

impl TryFrom<JsBinding> for Binding {
    type Error = BindingConversionError;

    fn try_from(js: JsBinding) -> Result<Self, Self::Error> {
        let primary = key_from_code(&js.primary)
            .ok_or_else(|| BindingConversionError::UnknownKey(js.primary.clone()))?;
        let mut modifiers = Vec::with_capacity(js.modifiers.len());
        for m in js.modifiers {
            let kind = match m.kind.as_str() {
                "Control" => ModifierKind::Control,
                "Shift" => ModifierKind::Shift,
                "Alt" => ModifierKind::Alt,
                "Meta" => ModifierKind::Meta,
                other => {
                    return Err(BindingConversionError::UnknownModifierKind(other.to_string()))
                }
            };
            let side = match m.side.as_str() {
                "Left" => ModifierSide::Left,
                "Right" => ModifierSide::Right,
                "Either" => ModifierSide::Either,
                other => {
                    return Err(BindingConversionError::UnknownModifierSide(other.to_string()))
                }
            };
            modifiers.push((kind, side));
        }
        Ok(Binding {
            primary: SerKey(primary),
            modifiers,
        })
    }
}

impl From<Binding> for JsBinding {
    fn from(b: Binding) -> Self {
        let primary = code_from_key(b.primary.0).unwrap_or("Unknown").to_string();
        let modifiers = b
            .modifiers
            .into_iter()
            .map(|(kind, side)| JsModifier {
                kind: match kind {
                    ModifierKind::Control => "Control",
                    ModifierKind::Shift => "Shift",
                    ModifierKind::Alt => "Alt",
                    ModifierKind::Meta => "Meta",
                }
                .to_string(),
                side: match side {
                    ModifierSide::Left => "Left",
                    ModifierSide::Right => "Right",
                    ModifierSide::Either => "Either",
                }
                .to_string(),
            })
            .collect();
        JsBinding { primary, modifiers }
    }
}

// ----- Tauri commands -----

#[tauri::command]
pub fn permissions_status() -> PermissionsStatus {
    permissions::status()
}

#[tauri::command]
pub fn open_microphone_settings() -> Result<(), String> {
    permissions::open_settings(SettingsPane::Microphone).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    permissions::open_settings(SettingsPane::Accessibility).map_err(|e| e.to_string())
}

/// Trigger the macOS in-process microphone prompt (or return the cached
/// decision). Returns `true` if access is granted (now or already), `false`
/// if denied or undetermined.
#[tauri::command]
pub async fn request_microphone_access() -> Result<bool, String> {
    Ok(matches!(
        permissions::request_microphone().await,
        MicAccessOutcome::Granted
    ))
}

/// Trigger the macOS Accessibility prompt. The dialog is a side effect; the
/// returned bool is the current trust state (typically `false` on first
/// call — the user still has to flip the toggle in System Settings).
#[tauri::command]
pub fn prompt_accessibility_access() -> Result<bool, String> {
    Ok(permissions::prompt_accessibility())
}

#[tauri::command]
pub fn get_voice_at_cursor_binding(state: State<'_, AppState>) -> JsBinding {
    let b = state
        .binding
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_binding());
    b.into()
}

#[tauri::command]
pub fn update_voice_at_cursor_binding(
    state: State<'_, AppState>,
    binding: JsBinding,
) -> Result<(), String> {
    let parsed: Binding = binding.try_into().map_err(|e: BindingConversionError| e.to_string())?;
    state
        .settings
        .set_voice_at_cursor_binding(parsed.clone())
        .map_err(|e| e.to_string())?;
    let mut guard = state
        .binding
        .write()
        .map_err(|_| "binding lock poisoned".to_string())?;
    *guard = parsed;
    Ok(())
}

#[tauri::command]
pub fn get_log_capture_binding(state: State<'_, AppState>) -> JsBinding {
    let b = state
        .log_capture_binding
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_log_capture_binding());
    b.into()
}

#[tauri::command]
pub fn update_log_capture_binding(
    state: State<'_, AppState>,
    binding: JsBinding,
) -> Result<(), String> {
    let parsed: Binding = binding
        .try_into()
        .map_err(|e: BindingConversionError| e.to_string())?;
    state
        .settings
        .set_log_capture_binding(parsed.clone())
        .map_err(|e| e.to_string())?;
    let mut guard = state
        .log_capture_binding
        .write()
        .map_err(|_| "binding lock poisoned".to_string())?;
    *guard = parsed;
    Ok(())
}

/// Suspend or resume the CGEventTap listeners. Set to `true` while the
/// settings UI is in hotkey-capture mode so the web view can receive raw key
/// events without them being swallowed by the tap.
#[tauri::command]
pub fn set_rebinding(state: State<'_, AppState>, active: bool) {
    state.rebinding.store(active, Ordering::SeqCst);
}

#[tauri::command]
pub async fn confirm_log_capture(
    state: State<'_, AppState>,
    content: String,
    kind: String,
    project_id: Option<String>,
    new_project_name: Option<String>,
    tags: Vec<String>,
    deadline_iso: Option<String>,
) -> Result<String, String> {
    let kind_parsed = ItemKind::parse(&kind).ok_or_else(|| format!("invalid kind: {kind}"))?;
    let tx_clone = {
        let slot = state
            .coord_tx
            .lock()
            .map_err(|_| "coord_tx lock poisoned".to_string())?;
        slot.clone()
            .ok_or_else(|| "pipeline not started".to_string())?
    };
    let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<Result<String, String>>();
    tx_clone
        .send(CoordinatorMsg::ConfirmLogCapture {
            content,
            kind: kind_parsed,
            project_id,
            new_project_name,
            tags,
            deadline_iso,
            reply: reply_tx,
        })
        .map_err(|e| e.to_string())?;
    match reply_rx.recv().await {
        Some(res) => res,
        None => Err("coordinator dropped reply channel".into()),
    }
}

#[tauri::command]
pub fn cancel_log_capture(state: State<'_, AppState>) -> Result<(), String> {
    let slot = state
        .coord_tx
        .lock()
        .map_err(|_| "coord_tx lock poisoned".to_string())?;
    let tx = slot.as_ref().ok_or_else(|| "pipeline not started".to_string())?;
    tx.send(CoordinatorMsg::CancelLogCapture)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn start_pipeline(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if !state.asr.ready() {
        return Err("speech model not ready".to_string());
    }
    ensure_pipeline_started(&state, &app);
    Ok(())
}

// ----- Speech model commands -----

#[derive(Debug, Clone, Serialize)]
pub struct SpeechModelStatus {
    pub id: String,
    pub display_name: String,
    pub version_label: String,
    pub description: String,
    pub language_label: String,
    pub english_only: bool,
    pub accuracy_bars: u8,
    pub speed_bars: u8,
    pub size_label: String,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub active: bool,
    pub supported: bool,
}

fn model_status_for(entry: &ModelEntry, active_id: Option<&str>) -> SpeechModelStatus {
    SpeechModelStatus {
        id: entry.id.clone(),
        display_name: entry.display_name.clone(),
        version_label: entry.version_label.clone(),
        description: entry.description.clone(),
        language_label: entry.language_label.clone(),
        english_only: entry.english_only,
        accuracy_bars: entry.accuracy_bars,
        speed_bars: entry.speed_bars,
        size_label: entry.size_label.clone(),
        size_bytes: entry.size_bytes,
        downloaded: downloader::is_downloaded(entry),
        active: active_id.map(|a| a == entry.id).unwrap_or(false),
        supported: registry::is_supported(entry),
    }
}

#[tauri::command]
pub fn list_speech_models(state: State<'_, AppState>) -> Vec<SpeechModelStatus> {
    let active = state.asr.active_model_id();
    registry::registry()
        .iter()
        .map(|m| model_status_for(m, active.as_deref()))
        .collect()
}

#[tauri::command]
pub fn get_active_speech_model_id(state: State<'_, AppState>) -> String {
    state
        .asr
        .active_model_id()
        .unwrap_or_else(|| state.settings.speech_model_id().unwrap_or_default())
}

#[tauri::command]
pub fn set_active_speech_model(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let entry = registry::lookup(&id)
        .ok_or_else(|| format!("unknown speech model id: {id}"))?
        .clone();
    state
        .settings
        .set_speech_model_id(&entry.id)
        .map_err(|e| e.to_string())?;
    state.asr.set_active_model(entry);
    Ok(())
}

#[tauri::command]
pub async fn download_speech_model(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let entry = registry::lookup(&id)
        .ok_or_else(|| format!("unknown speech model id: {id}"))?
        .clone();
    let target = downloader::model_dir(&entry);
    let app_for_progress = app.clone();
    let res = downloader::download_model(&entry, &target, move |p: DownloadProgress| {
        let _ = app_for_progress.emit("speech_model:progress", &p);
    })
    .await;
    match res {
        Ok(_) => {
            // If this is the currently-active model id (or no model is active),
            // refresh the engine's active-model entry so it picks up the new
            // on-disk state without a restart.
            if state.asr.active_model_id().as_deref() == Some(entry.id.as_str()) {
                state.asr.set_active_model(entry);
            }
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_speech_model(id: String) -> Result<(), String> {
    let entry = registry::lookup(&id)
        .ok_or_else(|| format!("unknown speech model id: {id}"))?;
    let dir = downloader::model_dir(entry);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn is_pipeline_running(state: State<'_, AppState>) -> bool {
    state.hotkey_started.load(Ordering::SeqCst)
}

/// Idempotently start the rdev listener + coordinator pipeline.
///
/// On first call, creates the hotkey channel, spawns the rdev listener with
/// the shared `Arc<RwLock<Binding>>`, and spawns the coordinator on its own
/// dedicated thread + LocalSet (the coordinator owns a `!Send` `cpal::Stream`).
///
/// On subsequent calls, returns early. Callers can also poll
/// [`is_pipeline_running`] / `state.hotkey_started`.
pub fn ensure_pipeline_started(state: &AppState, app: &AppHandle) {
    if state.hotkey_started.swap(true, Ordering::SeqCst) {
        // Already started.
        return;
    }

    info!("starting voice-at-cursor + log-capture pipelines");

    // The coordinator listens on a single multiplexed channel. Each hotkey
    // listener gets its own raw HotkeyEvent channel; we spawn small adapter
    // tasks that tag the events with the right Action and forward them.
    let (coord_tx, coord_rx) = mpsc::unbounded_channel::<CoordinatorMsg>();

    if let Ok(mut slot) = state.coord_tx.lock() {
        *slot = Some(coord_tx.clone());
    }

    let (vac_tx, mut vac_rx) = mpsc::unbounded_channel::<HotkeyEvent>();
    let (lc_tx, mut lc_rx) = mpsc::unbounded_channel::<HotkeyEvent>();

    spawn_listener(Arc::clone(&state.binding), vac_tx, Arc::clone(&state.rebinding));
    spawn_listener(Arc::clone(&state.log_capture_binding), lc_tx, Arc::clone(&state.rebinding));

    // Adapter tasks: tag + forward into the coordinator channel. We use
    // `tokio::spawn` rather than a dedicated thread because these are pure
    // async pumps with no `!Send` state.
    {
        let coord_tx = coord_tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = vac_rx.recv().await {
                if coord_tx
                    .send(CoordinatorMsg::Hotkey(Action::VoiceAtCursor, ev))
                    .is_err()
                {
                    break;
                }
            }
        });
    }
    {
        let coord_tx = coord_tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = lc_rx.recv().await {
                if coord_tx
                    .send(CoordinatorMsg::Hotkey(Action::LogCapture, ev))
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    let pipeline_state = new_state_handle();
    let tray_for_state = Arc::clone(&state.tray);
    let asr = Arc::clone(&state.asr);
    let llm = Arc::clone(&state.llm);
    let db = state.db.clone();
    let event_log_root = state.event_log_root.clone();
    let paused = Arc::clone(&state.paused_hotkeys);
    let app = app.clone();

    thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                error!(?e, "failed to build coordinator runtime");
                return;
            }
        };
        let local = tokio::task::LocalSet::new();
        local.spawn_local(async move {
            coordinator::spawn(
                coord_rx,
                pipeline_state,
                asr,
                llm,
                app,
                db,
                event_log_root,
                paused,
                move |new_state: TrayPipelineState| {
                    if let Ok(t) = tray_for_state.lock() {
                        t.set_state(new_state);
                    }
                },
            );
        });
        rt.block_on(local);
    });
}

/// Convenience wrapper used by `lib.rs::run`'s setup hook to look up the
/// managed `AppState` and start the pipeline if permissions allow.
pub fn ensure_pipeline_started_from_handle(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    ensure_pipeline_started(&state, app);
}

// ----- Item store commands -----

const DEFAULT_ITEM_LIMIT: u32 = 50;
const MAX_ITEM_LIMIT: u32 = 500;

fn require_db(state: &AppState) -> Result<&Db, String> {
    state
        .db
        .as_ref()
        .ok_or_else(|| "database not available".to_string())
}

fn parse_visibility(s: Option<String>) -> Result<Option<Visibility>, String> {
    match s.as_deref() {
        None | Some("") => Ok(None),
        Some(v) => Visibility::parse(v)
            .map(Some)
            .ok_or_else(|| format!("invalid visibility: {v}")),
    }
}

fn clamp_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_ITEM_LIMIT)
        .clamp(1, MAX_ITEM_LIMIT)
}

#[tauri::command]
pub fn list_items(
    state: State<'_, AppState>,
    visibility: Option<String>,
    project_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Item>, String> {
    let db = require_db(&state)?;
    let vis = parse_visibility(visibility)?;
    let limit = clamp_limit(limit);
    let offset = offset.unwrap_or(0);
    db.with_conn(|c| db::items::list_items(c, vis, project_id.as_deref(), limit, offset))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_items(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<Item>, String> {
    let db = require_db(&state)?;
    let limit = clamp_limit(limit);
    db.with_conn(|c| db::search::search_items(c, &query, limit))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_item(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::items::soft_delete_item(c, &id))
        .map_err(|e| e.to_string())?;
    let id_for_event = id.clone();
    let _ = db.with_conn(move |c| db::events::insert_event(c, &id_for_event, "deleted", None));
    Ok(())
}

#[tauri::command]
pub fn count_items(
    state: State<'_, AppState>,
    visibility: Option<String>,
) -> Result<u32, String> {
    let db = require_db(&state)?;
    let vis = parse_visibility(visibility)?;
    db.with_conn(|c| db::items::count_items(c, vis))
        .map_err(|e| e.to_string())
}

// ----- Project commands -----

#[tauri::command]
pub fn list_projects(
    state: State<'_, AppState>,
    include_archived: bool,
) -> Result<Vec<Project>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::projects::list_projects(c, include_archived))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String) -> Result<Project, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("project name cannot be empty".into());
    }
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    let project = Project {
        id: ulid::Ulid::new().to_string(),
        name: trimmed,
        created_at: now,
        archived_at: None,
    };
    let p = project.clone();
    db.with_conn(move |c| db::projects::insert_project(c, &p))
        .map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
pub fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("project name cannot be empty".into());
    }
    let db = require_db(&state)?;
    db.with_conn(|c| db::projects::rename_project(c, &id, trimmed))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn archive_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    db.with_conn(|c| db::projects::archive_project(c, &id, &now))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unarchive_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::projects::unarchive_project(c, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn count_items_for_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<u32, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::projects::count_items_for_project(c, &id))
        .map_err(|e| e.to_string())
}

// ----- Task commands -----

#[tauri::command]
pub fn list_tasks(
    state: State<'_, AppState>,
    include_completed: bool,
    project_id: Option<String>,
) -> Result<Vec<TaskWithItem>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::tasks::list_tasks(c, include_completed, project_id.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn complete_task(state: State<'_, AppState>, item_id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    db.with_conn(|c| db::tasks::complete_task(c, &item_id, &now))
        .map_err(|e| e.to_string())?;
    let id_ev = item_id.clone();
    let _ = db.with_conn(move |c| db::events::insert_event(c, &id_ev, "completed", None));
    Ok(())
}

#[tauri::command]
pub fn uncomplete_task(state: State<'_, AppState>, item_id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::tasks::uncomplete_task(c, &item_id))
        .map_err(|e| e.to_string())?;
    let id_ev = item_id.clone();
    let _ = db.with_conn(move |c| db::events::insert_event(c, &id_ev, "uncompleted", None));
    Ok(())
}

#[tauri::command]
pub fn set_task_deadline(
    state: State<'_, AppState>,
    item_id: String,
    deadline_iso: Option<String>,
) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::tasks::set_deadline(c, &item_id, deadline_iso.as_deref()))
        .map_err(|e| e.to_string())
}

// ----- Item update / restore -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateItemArgs {
    pub id: String,
    /// `Some(text)` → update content. `None` → leave alone.
    pub content: Option<String>,
    /// Outer `None` → leave alone. `Some(None)` → clear. `Some(Some(id))` → set.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub project_id: Option<Option<String>>,
    /// `Some("note")` | `Some("task")` | `Some("")` (clear). `None` → leave alone.
    pub kind: Option<String>,
    /// `Some(vec![...])` → replace tag set. `None` → leave alone.
    pub tags: Option<Vec<String>>,
}

fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    // serde_json: a missing key → field default (Option::None). A present-but-null
    // key → Some(None). A present value → Some(Some(value)).
    Option::<T>::deserialize(deserializer).map(Some)
}

#[tauri::command]
pub fn update_item(
    state: State<'_, AppState>,
    args: UpdateItemArgs,
) -> Result<Item, String> {
    let db = require_db(&state)?;
    let kind_arg: Option<Option<ItemKind>> = match args.kind.as_deref() {
        None => None,
        Some("") => Some(None),
        Some(k) => Some(Some(
            ItemKind::parse(k).ok_or_else(|| format!("invalid kind: {k}"))?,
        )),
    };
    let id_for_db = args.id.clone();
    let content_owned = args.content.clone();
    let project_arg = args.project_id.clone();
    let tags_arg = args.tags.clone();

    db.with_conn(move |c| {
        let project_ref: Option<Option<&str>> =
            project_arg.as_ref().map(|inner| inner.as_deref());
        db::items::update_item(
            c,
            &id_for_db,
            content_owned.as_deref(),
            project_ref,
            kind_arg,
        )?;
        if let Some(tags) = &tags_arg {
            db::items::replace_tags(c, &id_for_db, tags)?;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;

    // Record lifecycle events for the changes.
    if args.content.is_some() {
        let id_ev = args.id.clone();
        let _ = db.with_conn(move |c| db::events::insert_event(c, &id_ev, "content_edited", None));
    }
    if let Some(ref kind_val) = args.kind {
        let id_ev = args.id.clone();
        let detail = if kind_val.is_empty() {
            "kind cleared".to_string()
        } else {
            format!("kind set to {kind_val}")
        };
        let _ = db.with_conn(move |c| db::events::insert_event(c, &id_ev, "kind_changed", Some(&detail)));
    }
    if let Some(ref proj) = args.project_id {
        let id_ev = args.id.clone();
        let detail = match proj {
            Some(pid) => format!("assigned to project {pid}"),
            None => "removed from project".to_string(),
        };
        let _ = db.with_conn(move |c| db::events::insert_event(c, &id_ev, "project_changed", Some(&detail)));
    }
    if args.tags.is_some() {
        let id_ev = args.id.clone();
        let _ = db.with_conn(move |c| db::events::insert_event(c, &id_ev, "tags_changed", None));
    }

    let id_for_get = args.id.clone();
    let item = db
        .with_conn(move |c| db::items::get_item(c, &id_for_get))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "item not found after update".to_string())?;
    Ok(item)
}

#[tauri::command]
pub fn restore_item(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::items::restore_item(c, &id))
        .map_err(|e| e.to_string())?;
    let id_for_event = id.clone();
    let _ = db.with_conn(move |c| db::events::insert_event(c, &id_for_event, "restored", None));
    Ok(())
}

/// Soft-delete an item that the auto-file flow created and emit `item:deleted`
/// so the frontend can drop its toast / activity feed row. Used by the "Undo"
/// button shown after a confident capture is auto-filed.
#[tauri::command]
pub fn undo_log_capture(
    item_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let db = require_db(&state)?;
    let id_for_db = item_id.clone();
    db.with_conn(move |c| db::items::soft_delete_item(c, &id_for_db))
        .map_err(|e| e.to_string())?;
    let _ = app.emit("item:deleted", item_id);
    Ok(())
}

// ----- Auto-file (confident captures) settings -----

#[tauri::command]
pub fn get_auto_file_enabled(state: State<'_, AppState>) -> bool {
    state.settings.auto_file_enabled()
}

#[tauri::command]
pub fn set_auto_file_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .settings
        .set_auto_file_enabled(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_file_threshold(state: State<'_, AppState>) -> f32 {
    state.settings.auto_file_threshold()
}

#[tauri::command]
pub fn set_auto_file_threshold(
    threshold: f32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .settings
        .set_auto_file_threshold(threshold)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tags_for_item(
    state: State<'_, AppState>,
    item_id: String,
) -> Result<Vec<String>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::items::list_tags_for_item(c, &item_id))
        .map_err(|e| e.to_string())
}

// ----- Claude Code session transcript -----

/// List available Claude Code session summaries for this project.
/// Reads from `~/.claude/projects/<project-path>/.sessions/` if it exists.
#[tauri::command]
pub fn list_claude_sessions() -> Result<Vec<ClaudeSessionSummary>, String> {
    let sessions_dir = claude_sessions_dir().ok_or("Claude sessions directory not found")?;
    if !sessions_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    let entries = std::fs::read_dir(&sessions_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() {
            continue;
        }
        // Read first and last line for timestamp/preview.
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let lines: Vec<&str> = content.lines().collect();
        if lines.is_empty() {
            continue;
        }
        let message_count = lines.len();
        // Try to extract a preview from the first user message.
        let mut preview = String::new();
        let mut timestamp = String::new();
        for line in &lines {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if timestamp.is_empty() {
                    if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
                        timestamp = ts.to_string();
                    }
                }
                if preview.is_empty() {
                    if let Some(role) = v.get("role").and_then(|r| r.as_str()) {
                        if role == "human" || role == "user" {
                            if let Some(msg) = v.get("content") {
                                let text = if let Some(s) = msg.as_str() {
                                    s.to_string()
                                } else if let Some(arr) = msg.as_array() {
                                    arr.iter()
                                        .filter_map(|item| {
                                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                                item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                                            } else {
                                                None
                                            }
                                        })
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                } else {
                                    String::new()
                                };
                                preview = text.chars().take(100).collect();
                            }
                        }
                    }
                }
                if !preview.is_empty() && !timestamp.is_empty() {
                    break;
                }
            }
        }
        summaries.push(ClaudeSessionSummary {
            session_id,
            preview,
            message_count,
            timestamp,
        });
    }
    // Sort newest first by timestamp.
    summaries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(summaries)
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionSummary {
    pub session_id: String,
    pub preview: String,
    pub message_count: usize,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionMessage {
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

/// Load the transcript for a specific Claude Code session.
#[tauri::command]
pub fn load_claude_session(session_id: String) -> Result<Vec<ClaudeSessionMessage>, String> {
    let sessions_dir = claude_sessions_dir().ok_or("Claude sessions directory not found")?;
    let path = sessions_dir.join(format!("{session_id}.jsonl"));
    if !path.is_file() {
        return Err(format!("session file not found: {session_id}"));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    for line in content.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            let role = v
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("unknown")
                .to_string();
            let timestamp = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            // Extract text content.
            let text = if let Some(content) = v.get("content") {
                if let Some(s) = content.as_str() {
                    s.to_string()
                } else if let Some(arr) = content.as_array() {
                    arr.iter()
                        .filter_map(|item| {
                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            if !text.is_empty() {
                messages.push(ClaudeSessionMessage {
                    role,
                    content: text,
                    timestamp,
                });
            }
        }
    }
    Ok(messages)
}

/// Locate the Claude Code sessions directory for this project.
fn claude_sessions_dir() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    // Claude Code stores sessions at ~/.claude/projects/<encoded-path>/.sessions/
    // The project path is the current working directory encoded with dashes.
    let cwd = std::env::current_dir().ok()?;
    let cwd_str = cwd.to_string_lossy();
    // Claude encodes the path by replacing '/' with '-' and prepending '-'.
    let encoded = cwd_str.replace('/', "-");
    let sessions = home
        .join(".claude")
        .join("projects")
        .join(&encoded)
        .join(".sessions");
    if sessions.is_dir() {
        return Some(sessions);
    }
    // Fallback: scan all project dirs for one that matches our working directory.
    let projects_dir = home.join(".claude").join("projects");
    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let sessions_path = entry.path().join(".sessions");
            if sessions_path.is_dir() {
                return Some(sessions_path);
            }
        }
    }
    None
}

// ----- Reset onboarding -----

#[tauri::command]
pub async fn reset_onboarding_and_quit(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;
    store.clear();
    store.save().map_err(|e| e.to_string())?;
    // Spawn a delayed exit so the command's reply has time to flush.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        handle.exit(0);
    });
    Ok(())
}

// ----- Reset TCC permissions -----

/// Run `tccutil reset` for Microphone + Accessibility against this app's
/// bundle id, then quit the app. macOS keeps TCC grants attached to the
/// running process, so the user must relaunch to be re-prompted.
///
/// Equivalent to the manual `tccutil reset Microphone com.echoscribe.app` +
/// `tccutil reset Accessibility com.echoscribe.app` flow documented in
/// CLAUDE.md, but exposed in the UI so the user doesn't need a terminal.
#[tauri::command]
pub async fn reset_tcc_and_quit(app: AppHandle) -> Result<(), String> {
    use std::process::Command;
    const BUNDLE_ID: &str = "com.echoscribe.app";
    info!(bundle = BUNDLE_ID, "reset_tcc_and_quit invoked");
    for service in ["Microphone", "Accessibility"] {
        let output = Command::new("/usr/bin/tccutil")
            .args(["reset", service, BUNDLE_ID])
            .output()
            .map_err(|e| {
                error!(?e, service, "failed to spawn tccutil");
                format!("failed to run tccutil for {service}: {e}")
            })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        info!(
            service,
            status = %output.status,
            stdout = %stdout.trim(),
            stderr = %stderr.trim(),
            "tccutil reset result"
        );
        if !output.status.success() {
            return Err(format!(
                "tccutil reset {service} failed: {} (stderr: {})",
                output.status,
                stderr.trim()
            ));
        }
    }
    info!("tcc reset complete; scheduling app exit");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        handle.exit(0);
    });
    Ok(())
}

// ----- LLM model commands -----

#[derive(Debug, Clone, Serialize)]
pub struct LlmModelStatus {
    pub id: String,
    pub display_name: String,
    pub family: String,
    pub size_label: String,
    pub size_bytes: u64,
    pub context_length: u32,
    pub downloaded: bool,
    pub active: bool,
    pub supported: bool,
}

fn llm_status_for(entry: &LlmModelEntry, active_id: Option<&str>) -> LlmModelStatus {
    LlmModelStatus {
        id: entry.id.clone(),
        display_name: entry.display_name.clone(),
        family: entry.family.clone(),
        size_label: entry.size_label.clone(),
        size_bytes: entry.size_bytes,
        context_length: entry.context_length,
        downloaded: llm::is_downloaded(entry),
        active: active_id.map(|a| a == entry.id).unwrap_or(false),
        supported: llm::registry::is_supported(entry),
    }
}

#[tauri::command]
pub fn list_llm_models(state: State<'_, AppState>) -> Vec<LlmModelStatus> {
    let active = state.llm.active_model_id();
    llm::registry::registry()
        .iter()
        .map(|m| llm_status_for(m, active.as_deref()))
        .collect()
}

#[tauri::command]
pub fn get_active_llm_model_id(state: State<'_, AppState>) -> String {
    state
        .llm
        .active_model_id()
        .unwrap_or_else(|| state.settings.llm_model_id().unwrap_or_default())
}

#[tauri::command]
pub fn set_active_llm_model(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let entry = llm::registry::lookup(&id)
        .ok_or_else(|| format!("unknown llm model id: {id}"))?
        .clone();
    state
        .settings
        .set_llm_model_id(&entry.id)
        .map_err(|e| e.to_string())?;
    state.llm.set_active_model(entry);
    Ok(())
}

#[tauri::command]
pub async fn download_llm_model(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let entry = llm::registry::lookup(&id)
        .ok_or_else(|| format!("unknown llm model id: {id}"))?
        .clone();
    let target = llm::model_dir(&entry);
    let app_for_progress = app.clone();
    let res = llm::downloader::download_model(&entry, &target, move |p: LlmDownloadProgress| {
        let _ = app_for_progress.emit("llm_model:progress", &p);
    })
    .await;
    match res {
        Ok(_) => {
            // Refresh active entry if this id is the active one, so the
            // engine picks up the new on-disk state on the next generate.
            if state.llm.active_model_id().as_deref() == Some(entry.id.as_str()) {
                state.llm.set_active_model(entry);
            }
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_llm_model(id: String) -> Result<(), String> {
    let entry = llm::registry::lookup(&id)
        .ok_or_else(|| format!("unknown llm model id: {id}"))?;
    let dir = llm::model_dir(entry);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ----- Settings flags: audio feedback + onboarding completion -----

#[tauri::command]
pub fn get_audio_feedback_enabled(state: State<'_, AppState>) -> bool {
    state.settings.audio_feedback_enabled()
}

#[tauri::command]
pub fn set_audio_feedback_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .settings
        .set_audio_feedback_enabled(enabled)
        .map_err(|e| e.to_string())?;
    crate::audio::feedback::set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn get_mute_while_recording(state: State<'_, AppState>) -> bool {
    state.settings.mute_while_recording()
}

#[tauri::command]
pub fn set_mute_while_recording(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .settings
        .set_mute_while_recording(enabled)
        .map_err(|e| e.to_string())?;
    crate::audio::mute::set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn get_filler_removal_enabled(state: State<'_, AppState>) -> bool {
    state.settings.filler_removal_enabled()
}

#[tauri::command]
pub fn set_filler_removal_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .settings
        .set_filler_removal_enabled(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_filler_words(state: State<'_, AppState>) -> Vec<String> {
    state.settings.filler_words()
}

#[tauri::command]
pub fn set_filler_words(state: State<'_, AppState>, words: Vec<String>) -> Result<(), String> {
    state
        .settings
        .set_filler_words(words)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_custom_words(state: State<'_, AppState>) -> Vec<String> {
    state.settings.custom_words()
}

#[tauri::command]
pub fn set_custom_words(state: State<'_, AppState>, words: Vec<String>) -> Result<(), String> {
    state
        .settings
        .set_custom_words(words)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_default_filler_words() -> Vec<String> {
    crate::asr::postprocess::DEFAULT_FILLERS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[tauri::command]
pub fn get_onboarding_completed(state: State<'_, AppState>) -> bool {
    state.settings.onboarding_completed()
}

#[tauri::command]
pub fn set_onboarding_completed(
    state: State<'_, AppState>,
    completed: bool,
) -> Result<(), String> {
    state
        .settings
        .set_onboarding_completed(completed)
        .map_err(|e| e.to_string())
}

// ----- Tray-driven UI events -----

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    crate::ui::dock::set_dock_visible(true);
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        let _ = w.unminimize();
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ----- Diagnostics -----

#[tauri::command]
pub fn diagnostics_log_dir() -> String {
    crate::log_dir().to_string_lossy().to_string()
}

/// Reveal the log folder in Finder (macOS) — uses the `open(1)` binary so we
/// don't need the shell plugin's allow-list. On other platforms this is a
/// best-effort no-op that returns Ok.
#[tauri::command]
pub fn diagnostics_open_log_folder() -> Result<(), String> {
    let dir = crate::log_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(&dir)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("open exited with {status}"));
        }
    }
    Ok(())
}

/// Read the last `max_lines` lines of today's log file. Returns an empty
/// string if no log file exists yet.
#[tauri::command]
pub fn diagnostics_recent_log(max_lines: Option<usize>) -> Result<String, String> {
    let max = max_lines.unwrap_or(200).min(2000);
    let dir = crate::log_dir();
    let today = chrono_today_for_filename();
    let path = dir.join(format!("echo-scribe.log.{today}"));
    if !path.exists() {
        // Daily appender uses .{YYYY-MM-DD}; if today's hasn't rolled yet the
        // file may also exist as "echo-scribe.log". Try both.
        let alt = dir.join("echo-scribe.log");
        if !alt.exists() {
            return Ok(String::new());
        }
        return tail_file(&alt, max);
    }
    tail_file(&path, max)
}

/// Locale-independent UTC date for tracing-appender's file suffix.
fn chrono_today_for_filename() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // tracing-appender uses local time for daily rotation; we approximate by
    // formatting the UTC date — close enough for filename guessing, and we
    // also fall back to the un-suffixed file. Use the chrono-style format
    // manually to avoid pulling in a chrono dep.
    let days = now / 86_400;
    // Days since Unix epoch -> calendar date via the civil-from-days
    // algorithm (Howard Hinnant). Returns YYYY-MM-DD.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Applies the staged update by writing a helper shell script, launching it
/// detached, then exiting the process. The helper swaps the .app bundle while
/// the process is gone, strips quarantine, and relaunches the app.
#[tauri::command]
pub fn apply_update_and_restart() {
    crate::updater::launch_update_helper();
}

/// Persists the dismissed version so the update banner doesn't reappear for it.
#[tauri::command]
pub fn dismiss_update(state: State<'_, AppState>, version: String) {
    if let Err(e) = state.settings.set_dismissed_update_version(&version) {
        tracing::error!(error = %e, "failed to persist dismissed update version");
    }
}

fn tail_file(path: &std::path::Path, max_lines: usize) -> Result<String, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    Ok(lines[start..].join("\n"))
}

#[tauri::command]
pub async fn test_llm_inference(
    state: State<'_, AppState>,
    prompt: String,
) -> Result<String, String> {
    if !state.llm.ready() {
        return Err("llm not ready".to_string());
    }
    let req = GenerateRequest {
        system: Some("You are a concise assistant. Reply briefly.".into()),
        user: prompt,
        history: Vec::new(),
        max_tokens: 128,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };
    state.llm.generate(req).await.map_err(|e| e.to_string())
}

// ----- Chat session management -----

#[tauri::command]
pub fn create_chat_session(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<ChatSession, String> {
    let db = require_db(&state)?;
    let id = ulid::Ulid::new().to_string();
    db.with_conn(|c| chat::insert_session(c, &id, "New Chat", project_id.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chat_sessions(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<ChatSession>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::list_sessions(c, project_id.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_chat_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::load_messages(c, &session_id, 20))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::delete_session(c, &session_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_chat_session(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| chat::rename_session(c, &session_id, &name))
        .map_err(|e| e.to_string())
}

// ----- Item events & session links -----

#[tauri::command]
pub fn list_item_events(
    state: State<'_, AppState>,
    item_id: String,
) -> Result<Vec<db::events::ItemEvent>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::events::list_events_for_item(c, &item_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_sessions_for_item(
    state: State<'_, AppState>,
    item_id: String,
) -> Result<Vec<ChatSession>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::events::list_sessions_for_item(c, &item_id))
        .map_err(|e| e.to_string())
}

// ----- Memory chat -----

/// Extract FTS5-safe keywords from a natural-language message.
///
/// Keeps words of 4+ chars, strips non-alphanumeric chars, quotes each word
/// to prevent FTS5 syntax errors, and caps at 6 keywords joined with OR.
/// Returns an empty string when no usable keywords remain.
#[derive(serde::Serialize, Clone)]
pub struct ContextSource {
    pub date: String,
    pub kind: String,
    pub content: String,
}

#[derive(serde::Serialize)]
pub struct ChatReply {
    pub reply: String,
    pub sources: Vec<ContextSource>,
}

pub(crate) fn build_rag_query(message: &str) -> String {
    let keywords: Vec<String> = message
        .split_whitespace()
        .filter(|w| w.len() >= 4)
        .map(|w| {
            let clean: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
            clean
        })
        .filter(|w| w.len() >= 4)
        .map(|w| format!("\"{}\"", w))
        .take(6)
        .collect();
    keywords.join(" OR ")
}

#[tauri::command]
pub async fn chat_with_memory(
    state: State<'_, AppState>,
    session_id: String,
    message: String,
    project_id: Option<String>,
) -> Result<ChatReply, String> {
    if !state.llm.ready() {
        return Ok(ChatReply {
            reply: "No local AI model is loaded. Please download one in Settings → AI Model.".to_string(),
            sources: Vec::new(),
        });
    }

    let db = require_db(&state)?;

    // Persist the user message.
    db.with_conn(|c| chat::insert_message(c, &session_id, "user", &message))
        .map_err(|e| e.to_string())?;

    // Check if this is the first message (session still has placeholder name).
    let is_new = db
        .with_conn(|c| chat::list_sessions(c, None))
        .unwrap_or_default()
        .iter()
        .find(|s| s.id == session_id)
        .map(|s| s.name == "New Chat")
        .unwrap_or(false);

    // Compute current time for temporal parsing and system prompt.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let now_iso = crate::db::items::chrono_now_iso();
    let today_str = &now_iso[..10];

    // FTS5 retrieval with optional temporal window.
    let date_window = extract_date_window(&message, now_secs);
    let sources: Vec<ContextSource> = {
        let rag_query = build_rag_query(&message);
        if rag_query.is_empty() {
            Vec::new()
        } else {
            let (from, to) = match &date_window {
                Some((f, t)) => (Some(f.as_str()), Some(t.as_str())),
                None => (None, None),
            };
            let raw_items = db.with_conn(|c| {
                db::search::search_items_with_date_window(
                    c,
                    &rag_query,
                    from,
                    to,
                    project_id.as_deref(),
                    6,
                )
            })
            .unwrap_or_default();
            let mut out = Vec::with_capacity(raw_items.len());
            for item in raw_items {
                // Record that this item was referenced in this session.
                let iid = item.id.clone();
                let sid = session_id.clone();
                let _ = db.with_conn(move |c| db::events::link_item_to_session(c, &iid, &sid));
                let kind = item.kind.as_ref().map(|k| k.as_str()).unwrap_or("note").to_string();
                let date = item.captured_at[..10.min(item.captured_at.len())].to_string();
                out.push(ContextSource { date, kind, content: item.content });
            }
            out
        }
    };

    let temporal_note = if date_window.is_some() && sources.is_empty() {
        " No captures were found for the requested time period — do not guess or invent content."
    } else {
        ""
    };

    let system = if sources.is_empty() {
        format!(
            "You are a helpful assistant built into Echo Scribe, a voice note and task capture app. \
             Today is {today_str}. \
             No relevant notes were found for this question.{temporal_note} \
             Do not invent or fabricate any captures or activities. \
             If the user is asking what they did or said, tell them no matching captures were found."
        )
    } else {
        let context_lines: Vec<String> = sources
            .iter()
            .map(|s| format!("[{}] ({}): {}", s.date, s.kind, s.content))
            .collect();
        format!(
            "You are a helpful assistant built into Echo Scribe. \
             Today is {today_str}. \
             Here are the user's relevant notes and captures:\n\n---\n{}\n---\n\n\
             Answer based only on these notes. \
             Do not invent or add content beyond what is shown above. \
             If the notes don't address the question, say so explicitly.",
            context_lines.join("\n")
        )
    };

    // Load history from DB (last 20 messages), excluding the one just inserted.
    let history_msgs = db
        .with_conn(|c| chat::load_messages(c, &session_id, 20))
        .unwrap_or_default();
    let hist: Vec<(String, String)> = history_msgs
        .into_iter()
        .rev()
        .skip(1)
        .rev()
        .map(|m| (m.role, m.content))
        .collect();

    let req = GenerateRequest {
        system: Some(system),
        user: message.clone(),
        history: hist,
        max_tokens: 512,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };

    let reply = state.llm.generate(req).await.map_err(|e| e.to_string())?;

    // Persist the assistant reply and touch the session.
    db.with_conn(|c| chat::insert_message(c, &session_id, "assistant", &reply))
        .map_err(|e| e.to_string())?;
    db.with_conn(|c| chat::touch_session(c, &session_id))
        .map_err(|e| e.to_string())?;

    // Auto-rename on first message: truncate user message to 50 chars.
    if is_new {
        let auto_name: String = message.chars().take(50).collect();
        let _ = db.with_conn(|c| chat::rename_session(c, &session_id, &auto_name));
    }

    Ok(ChatReply { reply, sources })
}

#[tauri::command]
pub fn get_llm_unload_secs(state: State<'_, AppState>) -> u64 {
    state.settings.llm_unload_secs()
}

#[tauri::command]
pub fn set_llm_unload_secs(
    state: State<'_, AppState>,
    secs: u64,
) -> Result<(), String> {
    state
        .settings
        .set_llm_unload_secs(secs)
        .map_err(|e| e.to_string())?;
    state
        .llm
        .set_unload_timeout(std::time::Duration::from_secs(secs));
    Ok(())
}

#[tauri::command]
pub fn get_asr_unload_secs(state: State<'_, AppState>) -> u64 {
    state.settings.asr_unload_secs()
}

#[tauri::command]
pub fn set_asr_unload_secs(
    state: State<'_, AppState>,
    secs: u64,
) -> Result<(), String> {
    state
        .settings
        .set_asr_unload_secs(secs)
        .map_err(|e| e.to_string())?;
    state
        .asr
        .set_unload_timeout(std::time::Duration::from_secs(secs));
    Ok(())
}

// ----- Dashboard analytics -----

#[tauri::command]
pub fn get_dashboard_stats(state: State<'_, AppState>) -> Result<db::stats::DashboardStats, String> {
    let db = require_db(&state)?;
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    db.with_conn(|c| db::stats::dashboard_stats(c, now))
        .map_err(|e| e.to_string())
}

// ============================================================================
// Meetings
// ============================================================================

#[tauri::command]
pub async fn start_meeting_manual(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .meeting_manager
        .clone()
        .start(None, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_meeting(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .meeting_manager
        .stop()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn is_meeting_active(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.meeting_manager.is_active().await)
}

#[tauri::command]
pub fn get_meeting(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<crate::db::meetings::MeetingRow>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| crate::db::meetings::get_meeting(conn, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_meetings(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::db::meetings::MeetingRow>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(|conn| crate::db::meetings::list_meetings(conn))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_meeting_notes(
    state: tauri::State<'_, AppState>,
    id: String,
    notes: String,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| crate::db::meetings::update_user_notes(conn, &id, &notes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_meeting(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| {
        conn.execute(
            "UPDATE items SET content = ?1 WHERE id = ?2 AND kind = 'meeting'",
            rusqlite::params![title, id],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meeting_settings(state: tauri::State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "auto_detect": state.settings.meeting_auto_detect(),
        "app_prefs": state.settings.meeting_app_prefs(),
        "soft_warn_min": state.settings.meeting_soft_warn_min(),
        "hard_cap_min": state.settings.meeting_hard_cap_min(),
    })
}

#[tauri::command]
pub fn set_meeting_auto_detect(
    state: tauri::State<'_, AppState>,
    on: bool,
) -> Result<(), String> {
    state
        .settings
        .set_meeting_auto_detect(on)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_meeting_app_pref(
    state: tauri::State<'_, AppState>,
    bundle_id: String,
    pref: crate::settings::MeetingAppPref,
) -> Result<(), String> {
    let mut prefs = state.settings.meeting_app_prefs();
    prefs.insert(bundle_id, pref);
    state
        .settings
        .set_meeting_app_prefs(&prefs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_meeting(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| {
        crate::db::meetings::delete_meeting(conn, &id)?;
        conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rdev::Key;

    #[test]
    fn key_from_code_handles_known_and_unknown_codes() {
        assert_eq!(key_from_code("ControlRight"), Some(Key::ControlRight));
        assert_eq!(key_from_code("KeyA"), Some(Key::KeyA));
        assert_eq!(key_from_code("Digit0"), Some(Key::Num0));
        assert_eq!(key_from_code("F12"), Some(Key::F12));
        assert_eq!(key_from_code("AltLeft"), Some(Key::Alt));
        assert_eq!(key_from_code("AltRight"), Some(Key::AltGr));
        assert_eq!(key_from_code("Enter"), Some(Key::Return));
        // Unknown codes return None.
        assert_eq!(key_from_code(""), None);
        assert_eq!(key_from_code("NotARealCode"), None);
        assert_eq!(key_from_code("F30"), None);
    }

    #[test]
    fn js_binding_round_trips_through_binding() {
        // single-key
        let single = Binding::single(Key::ControlRight);
        let js: JsBinding = single.clone().into();
        assert_eq!(js.primary, "ControlRight");
        assert!(js.modifiers.is_empty());
        let back: Binding = js.try_into().expect("should convert back");
        assert_eq!(back, single);

        // combo with modifier
        let combo = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        let js: JsBinding = combo.clone().into();
        assert_eq!(js.primary, "KeyL");
        assert_eq!(js.modifiers.len(), 1);
        assert_eq!(js.modifiers[0].kind, "Meta");
        assert_eq!(js.modifiers[0].side, "Right");
        let back: Binding = js.try_into().expect("should convert back");
        assert_eq!(back, combo);
    }

    #[test]
    fn js_binding_rejects_unknown_key() {
        let js = JsBinding {
            primary: "BogusCode".to_string(),
            modifiers: vec![],
        };
        let err = Binding::try_from(js).unwrap_err();
        assert!(matches!(err, BindingConversionError::UnknownKey(_)));
    }

    #[test]
    fn build_rag_query_extracts_long_words() {
        let q = build_rag_query("what did I say about the project meeting yesterday");
        assert!(q.contains("\"about\"") || q.contains("\"project\"") || q.contains("\"meeting\"") || q.contains("\"yesterday\""));
        assert!(!q.contains("\"did\""));
        assert!(!q.contains("\"the\""));
    }

    #[test]
    fn build_rag_query_returns_empty_for_short_message() {
        assert_eq!(build_rag_query("hi"), "");
        assert_eq!(build_rag_query("ok go"), "");
    }

    #[test]
    fn build_rag_query_strips_punctuation() {
        let q = build_rag_query("meeting! project?");
        assert!(q.contains("\"meeting\""));
        assert!(q.contains("\"project\""));
    }
}
