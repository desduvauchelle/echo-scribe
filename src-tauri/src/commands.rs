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
use crate::db::{self, Db, Item, Visibility};
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

    spawn_listener(Arc::clone(&state.binding), vac_tx);
    spawn_listener(Arc::clone(&state.log_capture_binding), lc_tx);

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
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn uncomplete_task(state: State<'_, AppState>, item_id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::tasks::uncomplete_task(c, &item_id))
        .map_err(|e| e.to_string())
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
        max_tokens: 128,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };
    state.llm.generate(req).await.map_err(|e| e.to_string())
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
}
