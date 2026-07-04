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
use crate::coordinator::{self, Action, CoordinatorMsg, StateHandle, TrayPipelineState};
use crate::db::chat;
use crate::db::items::{chrono_now_iso, ItemKind};
use crate::db::projects::{Project, ProjectPatch};
use crate::db::tasks::TaskWithItem;
use crate::db::{self, ChatMessage, ChatSession, Db, Item};
use crate::input::binding::{
    code_from_key, key_from_code, Binding, ModifierKind, ModifierSide, SerKey,
};
use crate::input::hotkeys::{spawn_listener, HotkeyEvent};
use crate::llm::{self, rag, GenerateRequest, Llm, LlmDownloadProgress, LlmModelEntry};
use crate::permissions::{self, MicAccessOutcome, PermissionsStatus, SettingsPane};
use crate::settings::SettingsStore;
use crate::temporal::extract_date_window;
use crate::ui::tray::TrayHandle;

/// Metadata captured at recording-start time so `stop_screen_recording` can
/// persist the correct source/audio info without re-deriving it.
pub struct RecordingMeta {
    pub source_label: String,
    pub has_mic: bool,
    pub has_sysaudio: bool,
}

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
    pub action_binding: Arc<RwLock<Binding>>,
    pub edit_selection_binding: Arc<RwLock<Binding>>,
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
    pub pipeline_state: StateHandle,
    pub asr: Arc<AsrPipeline>,
    pub llm: Arc<Llm>,
    pub embedder: Arc<crate::embed::Embedder>,
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
    pub active_recording: std::sync::Arc<
        std::sync::Mutex<Option<(crate::screenrec::ScreenrecHandle, RecordingMeta)>>,
    >,
}

#[tauri::command]
pub fn platform_capabilities() -> crate::platform::Capabilities {
    crate::platform::Capabilities::current()
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
                    return Err(BindingConversionError::UnknownModifierKind(
                        other.to_string(),
                    ))
                }
            };
            let side = match m.side.as_str() {
                "Left" => ModifierSide::Left,
                "Right" => ModifierSide::Right,
                "Either" => ModifierSide::Either,
                other => {
                    return Err(BindingConversionError::UnknownModifierSide(
                        other.to_string(),
                    ))
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

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    permissions::open_settings(SettingsPane::ScreenCapture).map_err(|e| e.to_string())
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

/// Trigger the macOS Screen Recording prompt (or return the cached
/// decision). Backs the ScreenCaptureKit-driven "other person" audio
/// track in meetings.
#[tauri::command]
pub fn request_screen_recording_access() -> Result<bool, String> {
    Ok(permissions::request_screen_recording())
}

/// Trigger the macOS Calendar prompt by spawning the calmatch sidecar.
/// Returns the resulting grant. Used by Onboarding + Settings.
#[tauri::command]
pub async fn prompt_calendar_access() -> Result<bool, String> {
    Ok(permissions::prompt_calendars().await)
}

#[tauri::command]
pub fn open_calendar_settings() -> Result<(), String> {
    permissions::open_settings(SettingsPane::Calendars).map_err(|e| e.to_string())
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
    let parsed: Binding = binding
        .try_into()
        .map_err(|e: BindingConversionError| e.to_string())?;
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
pub fn get_action_binding(state: State<'_, AppState>) -> JsBinding {
    let b = state
        .action_binding
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_action_binding());
    b.into()
}

#[tauri::command]
pub fn update_action_binding(state: State<'_, AppState>, binding: JsBinding) -> Result<(), String> {
    let parsed: Binding = binding
        .try_into()
        .map_err(|e: BindingConversionError| e.to_string())?;
    state
        .settings
        .set_action_binding(parsed.clone())
        .map_err(|e| e.to_string())?;
    let mut guard = state
        .action_binding
        .write()
        .map_err(|_| "action_binding lock poisoned".to_string())?;
    *guard = parsed;
    Ok(())
}

#[tauri::command]
pub fn get_edit_selection_binding(state: State<'_, AppState>) -> JsBinding {
    let b = state
        .edit_selection_binding
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_edit_selection_binding());
    b.into()
}

#[tauri::command]
pub fn update_edit_selection_binding(
    state: State<'_, AppState>,
    binding: JsBinding,
) -> Result<(), String> {
    let parsed: Binding = binding
        .try_into()
        .map_err(|e: BindingConversionError| e.to_string())?;
    state
        .settings
        .set_edit_selection_binding(parsed.clone())
        .map_err(|e| e.to_string())?;
    let mut guard = state
        .edit_selection_binding
        .write()
        .map_err(|_| "edit_selection_binding lock poisoned".to_string())?;
    *guard = parsed;
    Ok(())
}

#[tauri::command]
pub fn get_trigger_word_routing_enabled(state: State<'_, AppState>) -> bool {
    state.settings.trigger_word_routing_enabled()
}

#[tauri::command]
pub fn set_trigger_word_routing_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .settings
        .set_trigger_word_routing_enabled(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_action_trigger_word(state: State<'_, AppState>) -> String {
    state.settings.action_trigger_word()
}

#[tauri::command]
pub fn set_action_trigger_word(state: State<'_, AppState>, word: String) -> Result<(), String> {
    state
        .settings
        .set_action_trigger_word(&word)
        .map_err(|e| e.to_string())
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
    let tx = slot
        .as_ref()
        .ok_or_else(|| "pipeline not started".to_string())?;
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
pub fn set_active_speech_model(state: State<'_, AppState>, id: String) -> Result<(), String> {
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
    let entry = registry::lookup(&id).ok_or_else(|| format!("unknown speech model id: {id}"))?;
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
    let (ac_tx, mut ac_rx) = mpsc::unbounded_channel::<HotkeyEvent>();
    let (es_tx, mut es_rx) = mpsc::unbounded_channel::<HotkeyEvent>();

    spawn_listener(Arc::clone(&state.binding), vac_tx, Arc::clone(&state.rebinding));
    spawn_listener(Arc::clone(&state.log_capture_binding), lc_tx, Arc::clone(&state.rebinding));
    spawn_listener(Arc::clone(&state.action_binding), ac_tx, Arc::clone(&state.rebinding));
    spawn_listener(Arc::clone(&state.edit_selection_binding), es_tx, Arc::clone(&state.rebinding));

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
    {
        let coord_tx = coord_tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = ac_rx.recv().await {
                if coord_tx
                    .send(CoordinatorMsg::Hotkey(Action::ActionCommand, ev))
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
            while let Some(ev) = es_rx.recv().await {
                if coord_tx
                    .send(CoordinatorMsg::Hotkey(Action::EditSelection, ev))
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    let pipeline_state = Arc::clone(&state.pipeline_state);
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

fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_ITEM_LIMIT).clamp(1, MAX_ITEM_LIMIT)
}

#[tauri::command]
pub fn list_items(
    state: State<'_, AppState>,
    project_id: Option<String>,
    kind: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Item>, String> {
    let db = require_db(&state)?;
    let limit = clamp_limit(limit);
    let offset = offset.unwrap_or(0);
    db.with_conn(|c| {
        db::items::list_items(c, project_id.as_deref(), kind.as_deref(), limit, offset)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_item(state: State<'_, AppState>, id: String) -> Result<Option<Item>, String> {
    let db = require_db(&state)?;
    db.with_conn(move |c| db::items::get_item(c, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_items(
    state: State<'_, AppState>,
    query: String,
    kind: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<Item>, String> {
    let db = require_db(&state)?;
    let limit = clamp_limit(limit);
    db.with_conn(|c| db::search::search_items(c, &query, kind.as_deref(), limit))
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
pub fn count_items(state: State<'_, AppState>) -> Result<u32, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| db::items::count_items(c))
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ActivityExportOutcome {
    pub path: String,
    pub count: u32,
}

const EXPORT_FRIENDLY_ERR: &str = "Export failed. See Settings → Diagnostics → logs for details.";

/// Export all activity (transcriptions, notes, tasks, meetings) captured at or
/// after `since` (ISO-8601 UTC; `None` = all time) as one Markdown or CSV file
/// in the user's Downloads folder, then reveal it in Finder.
#[tauri::command]
pub fn export_activity(
    state: State<'_, AppState>,
    app: AppHandle,
    since: Option<String>,
    format: String,
    range_label: Option<String>,
) -> Result<ActivityExportOutcome, String> {
    use crate::export::activity::{render_csv, render_markdown, ActivityEntry};
    use std::collections::HashMap;

    let ext = match format.as_str() {
        "markdown" => "md",
        "csv" => "csv",
        other => {
            error!(target: "export", format = %other, "export_activity: unknown format");
            return Err(EXPORT_FRIENDLY_ERR.into());
        }
    };

    let db = require_db(&state)?;
    let items = db
        .with_conn(|c| db::items::list_items_since(c, since.as_deref()))
        .map_err(|e| {
            error!(target: "export", error = %e, "export_activity: item query failed");
            EXPORT_FRIENDLY_ERR.to_string()
        })?;

    // Resolve project names once per unique id.
    let mut project_names: HashMap<String, String> = HashMap::new();
    for item in &items {
        let Some(pid) = item.project_id.as_deref() else {
            continue;
        };
        if project_names.contains_key(pid) {
            continue;
        }
        let name = db
            .with_conn(|c| db::projects::get_project(c, pid))
            .ok()
            .flatten()
            .map(|p| p.name);
        if let Some(name) = name {
            project_names.insert(pid.to_string(), name);
        }
    }

    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        // Meeting record = source 'meeting' with no parsed kind (the kind
        // column stores 'meeting'); meeting-derived tasks keep kind = task.
        let meeting =
            if matches!(item.source, db::items::ItemSource::Meeting) && item.kind.is_none() {
                let id = item.id.clone();
                db.with_conn(move |c| db::meetings::get_meeting(c, &id))
                    .ok()
                    .flatten()
            } else {
                None
            };
        let project_name = item
            .project_id
            .as_deref()
            .and_then(|pid| project_names.get(pid).cloned());
        entries.push(ActivityEntry {
            item,
            project_name,
            meeting,
        });
    }

    let now = chrono_now_iso();
    let label = range_label.unwrap_or_else(|| "All time".to_string());
    let body = match ext {
        "csv" => render_csv(&entries),
        _ => render_markdown(&entries, &label, &now),
    };

    let dir = app.path().download_dir().map_err(|e| {
        error!(target: "export", error = %e, "export_activity: no Downloads dir");
        EXPORT_FRIENDLY_ERR.to_string()
    })?;
    // "2026-06-11T18:04:21Z" → "2026-06-11-1804"
    let stamp = format!(
        "{}-{}{}",
        now.get(0..10).unwrap_or("0000-00-00"),
        now.get(11..13).unwrap_or("00"),
        now.get(14..16).unwrap_or("00"),
    );
    let path = dir.join(format!("echo-scribe-activity-{stamp}.{ext}"));
    std::fs::write(&path, &body).map_err(|e| {
        error!(
            target: "export",
            path = %path.display(),
            error = %e,
            "export_activity: write failed"
        );
        EXPORT_FRIENDLY_ERR.to_string()
    })?;

    info!(
        target: "export",
        path = %path.display(),
        count = entries.len(),
        format = %format,
        since = since.as_deref().unwrap_or("(all time)"),
        "exported activity"
    );

    // Best-effort reveal in Finder; the export itself already succeeded.
    let _ = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn();

    Ok(ActivityExportOutcome {
        path: path.to_string_lossy().into_owned(),
        count: entries.len() as u32,
    })
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

#[derive(Debug, Default, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
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
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
}

fn normalize_keywords(kws: Vec<String>) -> Vec<String> {
    normalize_string_list(kws, true)
}

fn normalize_string_list(values: Vec<String>, lowercase: bool) -> Vec<String> {
    use std::collections::BTreeSet;
    values
        .into_iter()
        .map(|v| {
            let t = v.trim();
            if lowercase {
                t.to_lowercase()
            } else {
                t.to_string()
            }
        })
        .filter(|k| !k.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    input: CreateProjectInput,
) -> Result<Project, String> {
    let trimmed = input.name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Project name cannot be empty.".into());
    }
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    let project = Project {
        id: ulid::Ulid::new().to_string(),
        name: trimmed,
        created_at: now.clone(),
        archived_at: None,
        description: input.description.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }),
        keywords: normalize_keywords(input.keywords.unwrap_or_default()),
        color: input.color.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }),
        emoji: input.emoji.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }),
        updated_at: Some(now),
        export_folder: None,
        routing_aliases: normalize_string_list(input.routing_aliases.unwrap_or_default(), true),
        routing_app_hints: normalize_string_list(
            input.routing_app_hints.unwrap_or_default(),
            false,
        ),
        routing_url_hints: normalize_string_list(input.routing_url_hints.unwrap_or_default(), true),
        routing_window_hints: normalize_string_list(
            input.routing_window_hints.unwrap_or_default(),
            true,
        ),
        routing_positive_examples: normalize_string_list(
            input.routing_positive_examples.unwrap_or_default(),
            false,
        ),
        routing_negative_examples: normalize_string_list(
            input.routing_negative_examples.unwrap_or_default(),
            false,
        ),
    };
    let p = project.clone();
    db.with_conn(move |c| db::projects::insert_project(c, &p))
        .map_err(|e| {
            error!(target: "projects", error = %e, name = %project.name, "create_project failed");
            "Couldn't create project. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    info!(target: "projects", id = %project.id, name = %project.name, "created project");
    Ok(project)
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectInput {
    pub id: String,
    #[serde(flatten)]
    pub patch: ProjectPatch,
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    input: UpdateProjectInput,
) -> Result<Project, String> {
    let db = require_db(&state)?;
    let now = chrono_now_iso();

    // Normalize incoming patch before persisting: trim strings, lowercase
    // + dedupe keywords. Validation: reject empty/whitespace name (UI also
    // guards, but defend the boundary).
    let mut patch = input.patch.clone();
    if let Some(n) = &patch.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() {
            return Err("Project name cannot be empty.".into());
        }
        patch.name = Some(trimmed);
    }
    if let Some(Some(desc)) = &patch.description {
        let trimmed = desc.trim().to_string();
        patch.description = if trimmed.is_empty() {
            Some(None)
        } else {
            Some(Some(trimmed))
        };
    }
    if let Some(Some(color)) = &patch.color {
        let trimmed = color.trim().to_string();
        patch.color = if trimmed.is_empty() {
            Some(None)
        } else {
            Some(Some(trimmed))
        };
    }
    if let Some(Some(emoji)) = &patch.emoji {
        let trimmed = emoji.trim().to_string();
        patch.emoji = if trimmed.is_empty() {
            Some(None)
        } else {
            Some(Some(trimmed))
        };
    }
    if let Some(kws) = patch.keywords {
        patch.keywords = Some(normalize_keywords(kws));
    }
    if let Some(v) = patch.routing_aliases {
        patch.routing_aliases = Some(normalize_string_list(v, true));
    }
    if let Some(v) = patch.routing_app_hints {
        patch.routing_app_hints = Some(normalize_string_list(v, false));
    }
    if let Some(v) = patch.routing_url_hints {
        patch.routing_url_hints = Some(normalize_string_list(v, true));
    }
    if let Some(v) = patch.routing_window_hints {
        patch.routing_window_hints = Some(normalize_string_list(v, true));
    }
    if let Some(v) = patch.routing_positive_examples {
        patch.routing_positive_examples = Some(normalize_string_list(v, false));
    }
    if let Some(v) = patch.routing_negative_examples {
        patch.routing_negative_examples = Some(normalize_string_list(v, false));
    }

    let id = input.id.clone();
    let id_for_log = id.clone();
    db.with_conn(move |c| db::projects::update_project(c, &id, &patch, &now))
        .map_err(|e| {
            error!(target: "projects", error = %e, id = %id_for_log, "update_project failed");
            "Couldn't update project. See Settings → Diagnostics → logs for details.".to_string()
        })?;

    let id2 = input.id.clone();
    let project = db
        .with_conn(move |c| db::projects::get_project(c, &id2))
        .map_err(|e| {
            error!(target: "projects", error = %e, "update_project: re-read failed");
            "Couldn't read updated project. See logs.".to_string()
        })?
        .ok_or_else(|| "Project not found after update.".to_string())?;

    info!(target: "projects", id = %project.id, name = %project.name, "updated project");
    Ok(project)
}

#[tauri::command]
pub fn rename_project(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    // Kept as a thin shim over update_project so existing callers keep
    // working. New UI should call update_project directly.
    let patch = ProjectPatch {
        name: Some(name),
        ..Default::default()
    };
    let _ = update_project(state, UpdateProjectInput { id, patch })?;
    Ok(())
}

#[tauri::command]
pub fn archive_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    let id_for_log = id.clone();
    db.with_conn(move |c| db::projects::archive_project(c, &id, &now))
        .map_err(|e| {
            error!(target: "projects", error = %e, id = %id_for_log, "archive_project failed");
            "Couldn't archive project. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    info!(target: "projects", id = %id_for_log, "archived project");
    Ok(())
}

#[tauri::command]
pub fn unarchive_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    let id_for_log = id.clone();
    db.with_conn(move |c| db::projects::unarchive_project(c, &id))
        .map_err(|e| {
            error!(target: "projects", error = %e, id = %id_for_log, "unarchive_project failed");
            "Couldn't unarchive project. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    info!(target: "projects", id = %id_for_log, "unarchived project");
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    state: State<'_, AppState>,
    id: String,
    reassign_to: Option<String>,
) -> Result<(), String> {
    let db = require_db(&state)?;
    let id_for_log = id.clone();
    let reassign_for_log = reassign_to.clone();
    db.with_conn_mut(move |c| db::projects::delete_project(c, &id, reassign_to.as_deref()))
        .map_err(|e| {
            error!(
                target: "projects",
                error = %e,
                id = %id_for_log,
                reassign_to = ?reassign_for_log,
                "delete_project failed"
            );
            "Couldn't delete project. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    info!(
        target: "projects",
        id = %id_for_log,
        reassign_to = ?reassign_for_log,
        "deleted project"
    );
    Ok(())
}

#[tauri::command]
pub fn count_items_for_project(state: State<'_, AppState>, id: String) -> Result<u32, String> {
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
pub fn update_item(state: State<'_, AppState>, args: UpdateItemArgs) -> Result<Item, String> {
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
        let project_ref: Option<Option<&str>> = project_arg.as_ref().map(|inner| inner.as_deref());
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
        let _ = db
            .with_conn(move |c| db::events::insert_event(c, &id_ev, "kind_changed", Some(&detail)));
    }
    if let Some(ref proj) = args.project_id {
        let id_ev = args.id.clone();
        let detail = match proj {
            Some(pid) => format!("assigned to project {pid}"),
            None => "removed from project".to_string(),
        };
        let _ = db.with_conn(move |c| {
            db::events::insert_event(c, &id_ev, "project_changed", Some(&detail))
        });
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

    // Re-export markdown if the item is routed to a project with an
    // export_folder. Stable filename → overwrite. `try_export_item` is
    // a noop for items that don't qualify (no folder, below threshold,
    // unsupported kind such as the meeting record itself).
    let threshold = state.settings.export_confidence_threshold();
    crate::export::try_export_item(&db, &item, threshold);

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
pub fn set_auto_file_enabled(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
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
pub fn set_auto_file_threshold(threshold: f32, state: State<'_, AppState>) -> Result<(), String> {
    state
        .settings
        .set_auto_file_threshold(threshold)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_export_confidence_threshold(state: State<'_, AppState>) -> f32 {
    state.settings.export_confidence_threshold()
}

#[tauri::command]
pub fn set_export_confidence_threshold(
    threshold: f32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .settings
        .set_export_confidence_threshold(threshold)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectTaggerStatus {
    pub enabled: bool,
    pub pending: u32,
    pub deferred: u32,
    pub done: u32,
    pub failed: u32,
    pub llm_ready: bool,
    pub deterministic_batch_size: u32,
    pub interval_minutes: u64,
}

#[tauri::command]
pub fn get_project_auto_tagging_enabled(state: State<'_, AppState>) -> bool {
    state.settings.project_auto_tagging_enabled()
}

#[tauri::command]
pub fn set_project_auto_tagging_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .settings
        .set_project_auto_tagging_enabled(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_tagger_status(state: State<'_, AppState>) -> Result<ProjectTaggerStatus, String> {
    let db = require_db(&state)?;
    let counts = db
        .with_conn(crate::db::project_tag_jobs::counts)
        .map_err(|e| e.to_string())?;
    Ok(ProjectTaggerStatus {
        enabled: state.settings.project_auto_tagging_enabled(),
        pending: counts.pending,
        deferred: counts.deferred,
        done: counts.done,
        failed: counts.failed,
        llm_ready: state.llm.ready(),
        deterministic_batch_size: state.settings.project_auto_tagging_batch_size(),
        interval_minutes: state.settings.project_auto_tagging_interval_minutes(),
    })
}

#[tauri::command]
pub fn project_tagger_backfill(
    state: State<'_, AppState>,
    source: Option<String>,
    limit: Option<u32>,
) -> Result<u32, String> {
    let db = require_db(&state)?;
    let source = match source.as_deref() {
        None | Some("voice_at_cursor") => Some(crate::db::items::ItemSource::VoiceAtCursor),
        Some("log_capture") => Some(crate::db::items::ItemSource::LogCapture),
        Some("meeting") => Some(crate::db::items::ItemSource::Meeting),
        Some(other) => return Err(format!("invalid source: {other}")),
    };
    let now = chrono_now_iso();
    db.with_conn(|c| {
        crate::db::project_tag_jobs::enqueue_backfill(c, source, limit.unwrap_or(500), &now)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_project_tagger_deterministic_once(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<crate::project_tagger::ProjectTaggerRunSummary, String> {
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    db.with_conn(|c| {
        crate::project_tagger::run_deterministic_batch(
            c,
            limit.unwrap_or_else(|| state.settings.project_auto_tagging_batch_size()),
            &now,
        )
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_project_tagger_llm_once(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<crate::project_tagger::ProjectTaggerRunSummary, String> {
    if !state.llm.ready() {
        return Err("No local AI model is ready for project tagging.".into());
    }
    let db = require_db(&state)?.clone();
    let llm = Arc::clone(&state.llm);
    let now = chrono_now_iso();
    let dow = crate::classifier::dow_from_iso(&now).to_string();
    let limit = limit.unwrap_or_else(|| state.settings.project_auto_tagging_batch_size());
    crate::project_tagger::run_llm_batch_db(&db, llm.as_ref(), limit, &now, &dow)
        .await
        .map_err(|e| e.to_string())
}

/// Open a native folder picker and return the chosen absolute path. Returns
/// `None` if the user cancels.
#[tauri::command]
pub async fn pick_export_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose export folder")
        .pick_folder(move |path| {
            let s = path.and_then(|p| p.as_path().map(|pp| pp.to_string_lossy().into_owned()));
            let _ = tx.send(s);
        });
    rx.await.map_err(|e| e.to_string())
}

/// Backfill: re-export every non-deleted item + meeting for a project to its
/// configured folder. No-op when the project has no folder set. Returns the
/// number of files written. Skips items below the confidence threshold the same
/// way the live hooks do; meetings always export when a folder is set.
#[tauri::command]
pub fn export_project_backfill(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<u32, String> {
    let db = require_db(&state)?;
    let settings = state.settings.clone();
    let threshold = settings.export_confidence_threshold();
    crate::export::backfill_project(&db, &project_id, threshold).map_err(|e| {
        tracing::error!(target: "export", error = %e, project = %project_id, "backfill failed");
        "Backfill failed. See Settings → Diagnostics → logs for details.".to_string()
    })
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
                                            if item.get("type").and_then(|t| t.as_str())
                                                == Some("text")
                                            {
                                                item.get("text")
                                                    .and_then(|t| t.as_str())
                                                    .map(|s| s.to_string())
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
                                item.get("text")
                                    .and_then(|t| t.as_str())
                                    .map(|s| s.to_string())
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
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
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

/// Run `tccutil reset` for Microphone + Accessibility + ScreenCapture
/// against this app's bundle id, then quit the app. macOS keeps TCC grants
/// attached to the running process, so the user must relaunch to be
/// re-prompted.
///
/// Equivalent to the manual `tccutil reset Microphone com.echoscribe.app`
/// + `tccutil reset Accessibility com.echoscribe.app` + `tccutil reset
/// ScreenCapture com.echoscribe.app` flow documented in CLAUDE.md, but
/// exposed in the UI so the user doesn't need a terminal.
#[tauri::command]
pub async fn reset_tcc_and_quit(app: AppHandle) -> Result<(), String> {
    use std::process::Command;
    const BUNDLE_ID: &str = "com.echoscribe.app";
    info!(bundle = BUNDLE_ID, "reset_tcc_and_quit invoked");
    for service in ["Microphone", "Accessibility", "ScreenCapture"] {
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
    /// Bytes currently on disk for this model (includes any `.partial`).
    pub disk_bytes: u64,
    /// Dir has bytes on disk but the model isn't fully downloaded — an
    /// interrupted/orphaned download the user can reclaim.
    pub incomplete: bool,
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
        disk_bytes: llm::disk_bytes(entry),
        incomplete: llm::has_incomplete_download(entry),
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
    let entry = llm::registry::lookup(&id).ok_or_else(|| format!("unknown llm model id: {id}"))?;
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
pub fn set_audio_feedback_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
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
pub fn set_mute_while_recording(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
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
pub fn set_filler_removal_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
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
pub fn set_onboarding_completed(state: State<'_, AppState>, completed: bool) -> Result<(), String> {
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
        n_ctx: None,
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
pub fn delete_chat_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
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
            reply: "No local AI model is loaded. Please download one in Settings → AI Model."
                .to_string(),
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

    // FTS5 retrieval, then chunked re-ranking. FTS finds the right items; rag
    // selects the most relevant passages within them under a token budget.
    let terms = rag::query_terms(&message);
    let date_window = extract_date_window(&message, now_secs);

    // Load history first so retrieval can be budgeted against its token cost.
    let history_msgs = db
        .with_conn(|c| chat::load_messages(c, &session_id, (rag::HISTORY_TURNS + 1) as u32))
        .unwrap_or_default();
    let hist: Vec<(String, String)> = history_msgs
        .into_iter()
        .rev()
        .skip(1) // drop the just-inserted current user message
        .rev()
        .map(|m| (m.role, m.content))
        .collect();
    let history_tokens: usize = hist.iter().map(|(_, c)| rag::estimate_tokens(c)).sum();
    let chunk_budget = rag::CONTEXT_BUDGET_TOKENS
        .saturating_sub(history_tokens)
        .max(rag::MIN_CHUNK_BUDGET_TOKENS);

    let chunks: Vec<rag::Chunk> = {
        let rag_query = build_rag_query(&message);
        if rag_query.is_empty() {
            Vec::new()
        } else {
            let (from, to) = match &date_window {
                Some((f, t)) => (Some(f.as_str()), Some(t.as_str())),
                None => (None, None),
            };
            let raw_items = db
                .with_conn(|c| {
                    db::search::search_items_with_date_window(
                        c,
                        &rag_query,
                        from,
                        to,
                        project_id.as_deref(),
                        rag::FTS_ITEM_LIMIT,
                    )
                })
                .unwrap_or_default();

            let item_sources: Vec<rag::ChunkSource> = raw_items
                .iter()
                .map(|item| {
                    let kind = item
                        .kind
                        .as_ref()
                        .map(|k| k.as_str())
                        .unwrap_or("note")
                        .to_string();
                    let date = item.captured_at[..10.min(item.captured_at.len())].to_string();
                    rag::ChunkSource {
                        item_id: item.id.clone(),
                        date,
                        kind,
                        content: item.content.clone(),
                    }
                })
                .collect();

            rag::build_context_chunks(&item_sources, &terms, chunk_budget)
        }
    };

    // Record which items actually contributed context to this session.
    {
        let mut linked = std::collections::HashSet::new();
        for ch in &chunks {
            if linked.insert(ch.item_id.clone()) {
                let iid = ch.item_id.clone();
                let sid = session_id.clone();
                let _ = db.with_conn(move |c| db::events::link_item_to_session(c, &iid, &sid));
            }
        }
    }

    // One source row per distinct item, joining its selected chunks for display.
    let sources: Vec<ContextSource> = {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for ch in &chunks {
            if seen.insert(ch.item_id.clone()) {
                let joined: Vec<String> = chunks
                    .iter()
                    .filter(|c| c.item_id == ch.item_id)
                    .map(|c| c.content.clone())
                    .collect();
                out.push(ContextSource {
                    date: ch.date.clone(),
                    kind: ch.kind.clone(),
                    content: joined.join("\n…\n"),
                });
            }
        }
        out
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
        let context_lines: Vec<String> = chunks
            .iter()
            .map(|c| format!("[{}] ({}): {}", c.date, c.kind, c.content))
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

    let req = GenerateRequest {
        system: Some(system),
        user: message.clone(),
        history: hist,
        max_tokens: 512,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
        n_ctx: Some(rag::CHAT_N_CTX),
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
pub fn set_llm_unload_secs(state: State<'_, AppState>, secs: u64) -> Result<(), String> {
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
pub fn set_asr_unload_secs(state: State<'_, AppState>, secs: u64) -> Result<(), String> {
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
pub fn get_dashboard_stats(
    state: State<'_, AppState>,
) -> Result<db::stats::DashboardStats, String> {
    let db = require_db(&state)?;
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Local UTC offset (east-positive seconds) so day boundaries use local
    // midnight, not UTC midnight. See db::stats::dashboard_stats.
    let tz_offset_secs = chrono::Local::now().offset().local_minus_utc() as i64;
    db.with_conn(|c| db::stats::dashboard_stats(c, now, tz_offset_secs))
        .map_err(|e| e.to_string())
}

// ============================================================================
// Meetings
// ============================================================================

#[tauri::command]
pub async fn start_meeting_manual(state: tauri::State<'_, AppState>) -> Result<String, String> {
    // Capture frontmost context so manual-start meetings also get the
    // window-title / URL / tab-title hint in the synthesis prompt.
    let start_context = capture_meeting_start_context();
    let id = state
        .meeting_manager
        .clone()
        .start(None, None, start_context)
        .await
        .map_err(|e| e.to_string())?;
    // Spawn end-monitor so the meeting auto-stops when mic goes silent.
    crate::meeting::detector::spawn_end_monitor(state.meeting_manager.clone(), None);
    Ok(id)
}

/// Snapshot the frontmost window/URL/tab to feed the meeting synthesis prompt.
/// Best-effort; returns an empty context when AX/AppleScript fails or the app
/// is non-macOS.
fn capture_meeting_start_context() -> crate::meeting::MeetingStartContext {
    let ctx = crate::input::focus::capture_context();
    // calendar_match is filled in by MeetingManager::start once we have an
    // anchor timestamp — the capture site only knows app/window context.
    crate::meeting::MeetingStartContext {
        window_title: ctx.as_ref().and_then(|c| c.window_title.clone()),
        browser_url: ctx.as_ref().and_then(|c| c.browser_url.clone()),
        browser_tab_title: ctx.as_ref().and_then(|c| c.browser_tab_title.clone()),
        calendar_match: None,
    }
}

/// Start a manually-triggered guided session: a normal meeting recording
/// with an immutable snapshot of the chosen guide template frozen onto the
/// meeting row. The live HUD/guidance loop is Plan B2 — this only attaches
/// the template so the session is reviewable later.
#[tauri::command]
pub async fn start_guided_session(
    state: tauri::State<'_, AppState>,
    template_id: String,
) -> Result<String, String> {
    let db = require_db(&state)?;
    let tid = template_id.clone();
    let template = db
        .with_conn(move |c| crate::db::guide_templates::get_template(c, &tid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("guide template {template_id} not found"))?;

    let start_context = capture_meeting_start_context();

    let id = state
        .meeting_manager
        .clone()
        .start(None, None, start_context)
        .await
        .map_err(|e| e.to_string())?;
    state.meeting_manager.attach_guide(template).await?;

    crate::meeting::detector::spawn_end_monitor(state.meeting_manager.clone(), None);
    Ok(id)
}

#[tauri::command]
pub async fn attach_guide(
    state: tauri::State<'_, AppState>,
    template_id: String,
) -> Result<String, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let tid = template_id.clone();
    let template = db
        .with_conn(move |c| crate::db::guide_templates::get_template(c, &tid))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("guide template {template_id} not found"))?;
    state.meeting_manager.attach_guide(template).await
}

#[tauri::command]
pub async fn detach_guide(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.meeting_manager.detach_guide(&session_id).await
}

#[tauri::command]
pub async fn get_live_transcript(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::meeting::Segment>, String> {
    Ok(state.meeting_manager.transcript_snapshot().await)
}

#[tauri::command]
pub async fn get_active_guides(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.meeting_manager.active_guides_snapshot().await)
}

#[tauri::command]
pub fn show_meeting_hud(app: tauri::AppHandle, focus: Option<String>) {
    crate::overlay::show_meeting_hud(&app, focus.as_deref());
}

/// Persist the HUD's logical frame so the next show restores the user's
/// size/position instead of snapping back to the default slot.
#[tauri::command]
pub fn save_hud_frame(
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    state
        .settings
        .set_guide_overlay_frame(serde_json::json!({ "x": x, "y": y, "w": w, "h": h }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn guide_set_mode(
    state: tauri::State<'_, AppState>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    let m = crate::meeting::guidance::Mode::parse(&mode)
        .ok_or_else(|| format!("unknown guide mode: {mode}"))?;
    if let Some(engine) = state.meeting_manager.guide_engine_by_id(&session_id).await {
        engine.set_mode(m);
    }
    // Persist as the default for future sessions even if the engine is gone.
    state
        .settings
        .set_guide_overlay_mode(m)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn guide_trigger_now(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    match state.meeting_manager.guide_engine_by_id(&session_id).await {
        Some(engine) => {
            engine.fire_cycle();
            Ok(())
        }
        None => Err("no active guide session".into()),
    }
}

#[tauri::command]
pub async fn stop_meeting(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state
        .meeting_manager
        .stop()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn is_meeting_active(state: tauri::State<'_, AppState>) -> Result<bool, String> {
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
pub async fn meeting_consent(
    state: tauri::State<'_, AppState>,
    bundle_id: String,
    app_name: String,
    decision: String, // "always" | "once" | "never"
) -> Result<Option<String>, String> {
    use crate::settings::MeetingAppPref;
    let mut prefs = state.settings.meeting_app_prefs();
    match decision.as_str() {
        "always" => {
            // Start the meeting first; only persist the `Always` pref if
            // the start succeeds, so a transient AsrNotReady doesn't leave
            // a sticky pref the user never confirmed worked.
            let bundle_for_monitor = bundle_id.clone();
            let id = state
                .meeting_manager
                .clone()
                .start(
                    Some(bundle_id.clone()),
                    Some(app_name),
                    capture_meeting_start_context(),
                )
                .await
                .map_err(|e| e.to_string())?;
            // Window-based end detection (the auto-start path spawns this; the
            // consent path must too, or these meetings rely solely on the
            // inactivity backstop / hard cap to stop).
            crate::meeting::detector::spawn_end_monitor(
                state.meeting_manager.clone(),
                Some(bundle_for_monitor),
            );
            prefs.insert(bundle_id, MeetingAppPref::Always);
            state
                .settings
                .set_meeting_app_prefs(&prefs)
                .map_err(|e| e.to_string())?;
            Ok(Some(id))
        }
        "once" => {
            let bundle_for_monitor = bundle_id.clone();
            let id = state
                .meeting_manager
                .clone()
                .start(
                    Some(bundle_id),
                    Some(app_name),
                    capture_meeting_start_context(),
                )
                .await
                .map_err(|e| e.to_string())?;
            crate::meeting::detector::spawn_end_monitor(
                state.meeting_manager.clone(),
                Some(bundle_for_monitor),
            );
            Ok(Some(id))
        }
        "never" => {
            prefs.insert(bundle_id, MeetingAppPref::Never);
            state
                .settings
                .set_meeting_app_prefs(&prefs)
                .map_err(|e| e.to_string())?;
            Ok(None)
        }
        _ => Err("invalid decision".into()),
    }
}

#[tauri::command]
pub async fn hide_consent_overlay(app_handle: tauri::AppHandle) -> Result<(), String> {
    crate::overlay::hide_consent_overlay(&app_handle);
    Ok(())
}

#[tauri::command]
pub async fn meeting_clear_app_pref(
    state: tauri::State<'_, AppState>,
    bundle_id: String,
) -> Result<(), String> {
    let mut prefs = state.settings.meeting_app_prefs();
    prefs.remove(&bundle_id);
    state
        .settings
        .set_meeting_app_prefs(&prefs)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meeting_settings(state: tauri::State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "auto_detect": state.settings.meeting_auto_detect(),
        "app_prefs": state.settings.meeting_app_prefs(),
        "soft_warn_min": state.settings.meeting_soft_warn_min(),
        "hard_cap_min": state.settings.meeting_hard_cap_min(),
        "summary_prompt": state.settings.meeting_summary_prompt(),
    })
}

#[tauri::command]
pub fn set_meeting_summary_prompt(
    state: tauri::State<'_, AppState>,
    prompt: String,
) -> Result<(), String> {
    state
        .settings
        .set_meeting_summary_prompt(&prompt)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_meeting_auto_detect(state: tauri::State<'_, AppState>, on: bool) -> Result<(), String> {
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
pub async fn retry_meeting_summary(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .meeting_manager
        .retry_summary(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_meeting_chunks(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state
        .meeting_manager
        .retry_chunks(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Override the calendar match for a meeting (or clear it). Passing
/// `None` for `r#match` removes the snapshot; passing a `CalendarMatch`
/// object persists it on the row. The caller is expected to follow up
/// with `retry_meeting_summary` to regenerate with the new context.
#[tauri::command]
pub async fn set_meeting_calendar_match(
    state: tauri::State<'_, AppState>,
    id: String,
    r#match: Option<crate::calendar::CalendarMatch>,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let json = r#match
        .as_ref()
        .map(|m| serde_json::to_string(m).unwrap_or_default());
    let id_owned = id.clone();
    db.with_conn(move |conn| {
        crate::db::meetings::update_calendar_match(conn, &id_owned, json.as_deref())
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Probe the user's calendar for events around a given window. Used by
/// the meeting detail UI to populate "Wrong match?" alternatives that
/// weren't in the original ranked candidates. Returns the best match
/// plus next-ranked candidates (or `null` if nothing overlaps).
#[tauri::command]
pub async fn match_meeting_calendar(
    iso_start: String,
    iso_end: String,
    conf_hint: Option<String>,
) -> Result<Option<crate::calendar::MatchOutcome>, String> {
    crate::calendar::match_meeting(&iso_start, &iso_end, conf_hint.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_meeting(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| {
        crate::db::meetings::delete_meeting(conn, &id)?;
        conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

// ----- Input device selection -----

#[tauri::command]
pub fn list_input_devices() -> Vec<crate::audio::devices::InputDevice> {
    crate::audio::devices::list_input_devices()
}

#[tauri::command]
pub fn get_preferred_input_device(state: State<'_, AppState>) -> Option<String> {
    state.settings.preferred_input_device()
}

/// Persist the user's preferred input device. Pass `null` to clear (use system default).
/// Selecting a device also bumps it to the top of the recent-devices MRU list.
#[tauri::command]
pub fn set_preferred_input_device(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<(), String> {
    state
        .settings
        .set_preferred_input_device(name.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_input_devices(state: State<'_, AppState>) -> Vec<String> {
    state.settings.recent_input_devices()
}

#[tauri::command]
pub fn get_input_device_sort(state: State<'_, AppState>) -> String {
    match state.settings.input_device_sort() {
        crate::settings::InputDeviceSort::LastUsed => "last_used".to_string(),
        crate::settings::InputDeviceSort::Alphabetical => "alphabetical".to_string(),
    }
}

#[tauri::command]
pub fn set_input_device_sort(state: State<'_, AppState>, sort: String) -> Result<(), String> {
    let parsed = match sort.as_str() {
        "last_used" => crate::settings::InputDeviceSort::LastUsed,
        "alphabetical" => crate::settings::InputDeviceSort::Alphabetical,
        other => return Err(format!("unknown sort '{other}'")),
    };
    state
        .settings
        .set_input_device_sort(parsed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_launcher_enabled(state: State<'_, AppState>) -> bool {
    state.settings.app_launcher_enabled()
}

#[tauri::command]
pub fn set_app_launcher_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state
        .settings
        .set_app_launcher_enabled(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_action_counter(state: State<'_, AppState>) -> u32 {
    state.settings.action_counter()
}

#[tauri::command]
pub fn reset_action_counter(state: State<'_, AppState>) -> Result<(), String> {
    state
        .settings
        .set_action_counter(0)
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct CommonActionTemplate {
    pub category: String,
    pub description: String,
    pub voice_phrases: Vec<String>,
}

#[tauri::command]
pub fn get_common_actions() -> Vec<CommonActionTemplate> {
    vec![
        CommonActionTemplate {
            category: "Applications".to_string(),
            description: "Launch standard macOS applications or workspace web apps".to_string(),
            voice_phrases: vec![
                "open Slack".to_string(),
                "launch Safari".to_string(),
                "open Growthinator".to_string(),
                "launch LiveCase".to_string(),
            ],
        },
        CommonActionTemplate {
            category: "Emails".to_string(),
            description: "Draft emails inside the system default client prefilled".to_string(),
            voice_phrases: vec![
                "email denis about Growthinator saying tests passed".to_string(),
                "email John about meeting saying I will be there".to_string(),
            ],
        },
        CommonActionTemplate {
            category: "Web Browsing".to_string(),
            description: "Navigate directly to websites in your default browser".to_string(),
            voice_phrases: vec!["open google".to_string(), "go to github.com".to_string()],
        },
        CommonActionTemplate {
            category: "Persistent Counter".to_string(),
            description: "Increment, query, or reset the app action stats".to_string(),
            voice_phrases: vec![
                "increment counter".to_string(),
                "what is the count".to_string(),
                "reset action count".to_string(),
            ],
        },
    ]
}

#[tauri::command]
pub fn get_format_templates(state: State<'_, AppState>) -> Vec<crate::settings::FormatTemplate> {
    state.settings.format_templates()
}

#[tauri::command]
pub fn set_format_templates(
    state: State<'_, AppState>,
    templates: Vec<crate::settings::FormatTemplate>,
) -> Result<(), String> {
    state
        .settings
        .set_format_templates(&templates)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------

// Daily recap commands
// ---------------------------------------------------------------------------

use crate::daily_summary::{generate_for_date, DEFAULT_LLM_MODEL_ID};
use crate::db::daily_summaries::{self as daily_summaries_db, DailySummaryRow, SummaryStatus};

#[derive(serde::Serialize)]
pub struct DailySummaryDto {
    pub date: String,
    pub generated_at: String,
    pub status: String,
    pub narrative: String,
    pub sections: serde_json::Value,
    pub source_meeting_ids: Vec<String>,
    pub source_item_ids: Vec<String>,
    pub model_version: String,
}

fn to_dto(row: DailySummaryRow) -> DailySummaryDto {
    DailySummaryDto {
        date: row.date,
        generated_at: row.generated_at,
        status: match row.status {
            SummaryStatus::Generated => "generated".into(),
            SummaryStatus::SkippedEmpty => "skipped_empty".into(),
            SummaryStatus::Failed => "failed".into(),
        },
        narrative: row.narrative,
        sections: serde_json::from_str(&row.sections_json)
            .unwrap_or(serde_json::Value::Object(Default::default())),
        source_meeting_ids: serde_json::from_str(&row.source_meeting_ids_json).unwrap_or_default(),
        source_item_ids: serde_json::from_str(&row.source_item_ids_json).unwrap_or_default(),
        model_version: row.model_version,
    }
}

#[tauri::command]
pub fn daily_summary_get(
    state: State<'_, AppState>,
    date: String,
) -> Result<Option<DailySummaryDto>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let row = db
        .with_conn(|conn| daily_summaries_db::get(conn, &date).map_err(crate::db::DbError::from))
        .map_err(|e| format!("{e:?}"))?;
    Ok(row.map(to_dto))
}

#[tauri::command]
pub fn daily_summary_list_recent(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<DailySummaryDto>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    let rows = db
        .with_conn(|conn| {
            daily_summaries_db::list_recent(conn, limit).map_err(crate::db::DbError::from)
        })
        .map_err(|e| format!("{e:?}"))?;
    Ok(rows.into_iter().map(to_dto).collect())
}

#[tauri::command]
pub async fn daily_summary_regenerate(
    state: State<'_, AppState>,
    date: String,
) -> Result<DailySummaryDto, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?.clone();
    let llm = state.llm.clone();
    generate_for_date(&db, &llm, &date, DEFAULT_LLM_MODEL_ID)
        .await
        .map_err(|e| format!("{e:?}"))?;
    let row = db
        .with_conn(|conn| daily_summaries_db::get(conn, &date).map_err(crate::db::DbError::from))
        .map_err(|e| format!("{e:?}"))?
        .ok_or_else(|| "row missing after generate".to_string())?;
    Ok(to_dto(row))
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DailyRecapSettings {
    pub enabled: bool,
    pub deliver_hour: u8,
    pub include_weekends: bool,
}

#[tauri::command]
pub fn daily_recap_settings_get(state: State<'_, AppState>) -> DailyRecapSettings {
    DailyRecapSettings {
        enabled: state.settings.daily_recap_enabled(),
        deliver_hour: state.settings.daily_recap_deliver_hour(),
        include_weekends: state.settings.daily_recap_include_weekends(),
    }
}

#[tauri::command]
pub fn daily_recap_notification_permission_status(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let state = app
        .notification()
        .permission_state()
        .map_err(|e| e.to_string())?;
    Ok(matches!(state, PermissionState::Granted))
}

#[tauri::command]
pub fn daily_recap_settings_set(
    state: State<'_, AppState>,
    settings: DailyRecapSettings,
) -> Result<(), String> {
    state
        .settings
        .set_daily_recap_enabled(settings.enabled)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_daily_recap_deliver_hour(settings.deliver_hour)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_daily_recap_include_weekends(settings.include_weekends)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Guide templates
// ============================================================================

#[tauri::command]
pub fn list_guide_templates(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::guide_templates::GuideTemplate>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| crate::db::guide_templates::list_templates(c))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_guide_template(
    state: State<'_, AppState>,
    name: String,
    description: String,
    goal: String,
    notes: String,
) -> Result<crate::db::guide_templates::GuideTemplate, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("template name cannot be empty".into());
    }
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    let t = crate::db::guide_templates::GuideTemplate {
        id: ulid::Ulid::new().to_string(),
        name: trimmed,
        description,
        goal,
        notes,
        created_at: now.clone(),
        updated_at: now,
    };
    let t2 = t.clone();
    db.with_conn(move |c| crate::db::guide_templates::insert_template(c, &t2))
        .map_err(|e| e.to_string())?;
    Ok(t)
}

#[tauri::command]
pub fn update_guide_template(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    goal: String,
    notes: String,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("template name cannot be empty".into());
    }
    let db = require_db(&state)?;
    let now = chrono_now_iso();
    db.with_conn(move |c| {
        crate::db::guide_templates::update_template(
            c,
            &id,
            &trimmed,
            &description,
            &goal,
            &notes,
            &now,
        )
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_guide_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(move |c| crate::db::guide_templates::delete_template(c, &id))
        .map_err(|e| e.to_string())
}

// ----- Screen recording commands -----

#[tauri::command]
pub fn start_screen_recording(
    state: State<'_, AppState>,
    app: AppHandle,
    display_id: Option<u32>,
    window_id: Option<u32>,
    mic_device: Option<String>,
    sysaudio: bool,
    source_label: String,
) -> Result<(), String> {
    let mut guard = state
        .active_recording
        .lock()
        .map_err(|_| "lock poisoned".to_string())?;
    if guard.is_some() {
        return Err("a recording is already in progress".into());
    }
    let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
    let id = format!(
        "rec-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let out_path = dir.join(format!("{id}.mp4"));
    let params = crate::screenrec::RecordParams {
        display_id,
        window_id,
        mic_device: mic_device.clone(),
        sysaudio,
    };
    let handle = crate::screenrec::ScreenrecHandle::start(out_path, params)?;
    let meta = RecordingMeta {
        source_label,
        has_mic: mic_device.is_some(),
        has_sysaudio: sysaudio,
    };
    *guard = Some((handle, meta));
    // Flip tray icon to red and update menu label.
    if let Ok(t) = state.tray.lock() {
        t.set_screenrec_active(true);
    }
    // Notify the frontend so RecordingsView refreshes.
    let _ = app.emit("screenrec-changed", ());
    Ok(())
}

#[tauri::command]
pub fn is_screen_recording(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state
        .active_recording
        .lock()
        .map_err(|_| "lock poisoned".to_string())?;
    Ok(guard.is_some())
}

/// Non-command inner implementation so the tray can reuse stop logic without
/// going through a `#[tauri::command]` wrapper (which requires `State<'_>`).
pub fn stop_screen_recording_inner(
    state: &AppState,
) -> Result<crate::db::recordings::RecordingRow, String> {
    let (handle, meta) = {
        let mut guard = state
            .active_recording
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        guard.take().ok_or("no recording in progress")?
    };
    let info = handle.stop()?;
    let id = std::path::Path::new(&info.path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("rec-unknown")
        .to_string();
    let row = crate::db::recordings::RecordingRow {
        id,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64,
        file_path: info.path.clone(),
        duration_ms: Some(info.dur_ms),
        width: Some(info.width),
        height: Some(info.height),
        size_bytes: Some(info.size),
        source_label: Some(meta.source_label),
        has_mic: meta.has_mic,
        has_sysaudio: meta.has_sysaudio,
        thumb_path: if info.thumb.is_empty() {
            None
        } else {
            Some(info.thumb)
        },
        drive_file_id: None,
        drive_link: None,
        upload_status: "none".into(),
        upload_error: None,
        exports: "[]".into(),
        title: None,
        transcript: None,
        denoised_path: None,
    };
    let db = state
        .db
        .as_ref()
        .ok_or_else(|| "database not available".to_string())?;
    db.with_conn(|c| crate::db::recordings::insert(c, &row))
        .map_err(|e| e.to_string())?;
    // Flip tray icon back to idle.
    if let Ok(t) = state.tray.lock() {
        t.set_screenrec_active(false);
    }
    Ok(row)
}

#[tauri::command]
pub fn stop_screen_recording(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::db::recordings::RecordingRow, String> {
    let row = stop_screen_recording_inner(&state)?;
    // Notify the frontend so RecordingsView refreshes.
    let _ = app.emit("screenrec-changed", ());
    spawn_auto_denoise(app, row.id.clone());
    Ok(row)
}

/// Run denoise as a background task; logs but never surfaces errors to the
/// caller (recording stop already succeeded — auto-cleanup is best-effort).
pub(crate) fn spawn_auto_denoise(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_denoise(app, id.clone()).await {
            tracing::warn!(target: "denoise", recording_id = %id, %e, "auto-denoise after recording stop failed");
        }
    });
}

#[tauri::command]
pub fn list_recordings(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::recordings::RecordingRow>, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| crate::db::recordings::list(c))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_recording(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    let row = db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?;
    if let Some(row) = row {
        let _ = std::fs::remove_file(&row.file_path);
        if let Some(thumb) = &row.thumb_path {
            let _ = std::fs::remove_file(thumb);
        }
    }
    db.with_conn(|c| crate::db::recordings::delete(c, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_recording(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let db = require_db(&state)?;
    db.with_conn(|c| crate::db::recordings::rename(c, &id, title.trim()))
        .map_err(|e| e.to_string())
}

/// Transcribe a recording's audio on demand and cache the result in the DB.
/// Emits `transcribe-progress` events `{ id, pct }` while running.
#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    // Look up the mp4 path, dropping the DB borrow before any await.
    let mp4: std::path::PathBuf = {
        let db = require_db(&state)?;
        let row = db
            .with_conn(|c| crate::db::recordings::get(c, &id))
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "recording not found".to_string())?;
        std::path::PathBuf::from(row.file_path)
    };
    if !mp4.exists() {
        return Err("recording file is missing on disk".into());
    }

    // Require a downloaded ASR model up front for a clear message.
    if !state.asr.ready() {
        return Err("Download a transcription model first".into());
    }

    // Extract audio to a temp WAV in the recordings dir.
    let wav = crate::screenrec::recordings_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{id}.transcribe.wav"));
    let mp4_for_blocking = mp4.clone();
    let wav_for_blocking = wav.clone();
    let extract = tokio::task::spawn_blocking(move || {
        crate::screenrec::extract_audio(&mp4_for_blocking, &wav_for_blocking)
    })
    .await
    .map_err(|_| "extraction task panicked".to_string())?;
    if let Err(e) = extract {
        let _ = std::fs::remove_file(&wav);
        if e == "no_audio" {
            return Err("Recording has no audio".into());
        }
        return Err(e);
    }

    // Load + transcribe in ~60s windows, emitting progress.
    let (samples, rate, channels) = match AsrPipeline::load_wav_16k_mono_int16(&wav) {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::remove_file(&wav);
            return Err(e.to_string());
        }
    };
    let asr = std::sync::Arc::clone(&state.asr);
    let app_for_progress = app.clone();
    let id_for_progress = id.clone();
    let text = asr
        .transcribe_long(samples, rate, channels, move |pct| {
            let _ = app_for_progress.emit(
                "transcribe-progress",
                serde_json::json!({ "id": id_for_progress, "pct": pct }),
            );
        })
        .await
        .map_err(|e| e.to_string());

    // Always clean up the temp WAV.
    let _ = std::fs::remove_file(&wav);
    let text = text?;

    // Persist (re-borrow DB after the awaits).
    {
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::set_transcript(c, &id, &text))
            .map_err(|e| e.to_string())?;
    }

    Ok(text)
}

/// Denoise auto-runs after `stop_screen_recording`; the cleaned file replaces
/// the original so there's no UI toggle to maintain. Kept as a const so a
/// future regression that needs to compare original vs. cleaned can flip it.
const DELETE_ORIGINAL_AFTER_DENOISE: bool = true;

/// Denoise a recording's audio and mux it into a new cleaned MP4.
/// Emits `denoise-progress` events `{ id, pct }` while running.
/// Used by the `denoise_recording` command and by the auto-denoise spawned
/// after `stop_screen_recording` (both command and tray paths).
pub(crate) async fn run_denoise(app: AppHandle, id: String) -> Result<(), String> {
    // Look up the original mp4 path; drop the DB borrow before any await.
    let orig: std::path::PathBuf = {
        let state = app.state::<AppState>();
        let db = require_db(&state)?;
        let row = db
            .with_conn(|c| crate::db::recordings::get(c, &id))
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "recording not found".to_string())?;
        std::path::PathBuf::from(row.file_path)
    };
    if !orig.exists() {
        return Err("recording file is missing on disk".into());
    }

    let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
    let src_wav = dir.join(format!("{id}.dn-src.wav"));
    let out_wav = dir.join(format!("{id}.dn-out.wav"));
    let clean_mp4 = dir.join(format!("{id}.cleaned.mp4"));

    let cleanup = |extra: Option<&std::path::Path>| {
        let _ = std::fs::remove_file(&src_wav);
        let _ = std::fs::remove_file(&out_wav);
        if let Some(p) = extra {
            let _ = std::fs::remove_file(p);
        }
    };

    // 1. Extract 48kHz mono audio.
    let orig_c = orig.clone();
    let src_wav_c = src_wav.clone();
    let extract = tokio::task::spawn_blocking(move || {
        crate::screenrec::extract_audio_at(&orig_c, &src_wav_c, 48_000)
    })
    .await
    .map_err(|_| "extraction task panicked".to_string())?;
    if let Err(e) = extract {
        cleanup(None);
        if e == "no_audio" {
            return Err("Recording has no audio".into());
        }
        return Err(e);
    }

    // 2. Denoise (progress emitted per frame batch).
    let app_p = app.clone();
    let id_p = id.clone();
    let src_wav_c = src_wav.clone();
    let out_wav_c = out_wav.clone();
    let denoise = tokio::task::spawn_blocking(move || {
        crate::denoise::denoise_wav(&src_wav_c, &out_wav_c, move |pct| {
            let _ = app_p.emit(
                "denoise-progress",
                serde_json::json!({ "id": id_p, "pct": pct }),
            );
        })
    })
    .await
    .map_err(|_| "denoise task panicked".to_string())?;
    if let Err(e) = denoise {
        cleanup(None);
        return Err(e.to_string());
    }

    // 3. Mux cleaned audio + original video → new mp4.
    let orig_c = orig.clone();
    let out_wav_c = out_wav.clone();
    let clean_mp4_c = clean_mp4.clone();
    let mux = tokio::task::spawn_blocking(move || {
        crate::screenrec::mux_audio(&orig_c, &out_wav_c, &clean_mp4_c)
    })
    .await
    .map_err(|_| "mux task panicked".to_string())?;
    if let Err(e) = mux {
        cleanup(Some(&clean_mp4));
        return Err(e);
    }

    // 4. Verify output before any DB / destructive step.
    match std::fs::metadata(&clean_mp4) {
        Ok(m) if m.len() > 0 => {}
        _ => {
            cleanup(Some(&clean_mp4));
            return Err("denoise produced an empty file".into());
        }
    }

    let clean_str = clean_mp4.to_string_lossy().to_string();

    // 5. Record the cleaned path.
    {
        let state = app.state::<AppState>();
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::set_denoised_path(c, &id, Some(&clean_str)))
            .map_err(|e| e.to_string())?;
    }

    // 6. Optionally drop the original and promote the cleaned file.
    if DELETE_ORIGINAL_AFTER_DENOISE {
        let _ = std::fs::remove_file(&orig);
        let state = app.state::<AppState>();
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::promote_denoised(c, &id, &clean_str))
            .map_err(|e| e.to_string())?;
    }

    cleanup(None); // remove temp wavs; keep clean_mp4
    Ok(())
}

/// Manual denoise trigger. Auto-denoise after stop covers the common case; this
/// stays available for re-cleaning if the user needs it.
#[tauri::command]
pub async fn denoise_recording(app: AppHandle, id: String) -> Result<(), String> {
    run_denoise(app, id).await
}

#[tauri::command]
pub fn reveal_recording(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = require_db(&state)?;
    let row = db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or("recording not found")?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(&row.file_path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Transcode a recording to `quality` ("1080"|"720"|"480"), store the output
/// next to the source as `<stem>-<quality>.mp4`, and merge it into the row's
/// `exports` JSON (replacing any prior export of the same quality). Returns the
/// updated row.
#[tauri::command]
pub fn export_recording(
    state: State<'_, AppState>,
    id: String,
    quality: String,
) -> Result<crate::db::recordings::RecordingRow, String> {
    let db = require_db(&state)?;
    let row = db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or("recording not found")?;
    let src = std::path::PathBuf::from(&row.file_path);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("rec")
        .to_string();
    let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
    let out = dir.join(format!("{stem}-{quality}.mp4"));

    let done = crate::screenrec::export(&src, &out, &quality)?;

    let mut exports: Vec<serde_json::Value> =
        serde_json::from_str(&row.exports).unwrap_or_default();
    exports.retain(|e| e.get("quality").and_then(|q| q.as_str()) != Some(quality.as_str()));
    exports.push(serde_json::json!({
        "quality": quality,
        "path": done.path,
        "size": done.size,
    }));
    let exports_json = serde_json::to_string(&exports).map_err(|e| e.to_string())?;
    db.with_conn(|c| crate::db::recordings::update_exports(c, &id, &exports_json))
        .map_err(|e| e.to_string())?;
    db.with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "recording vanished".to_string())
}

#[tauri::command]
pub fn open_screenrec_setup(app: AppHandle) -> Result<(), String> {
    crate::overlay::show_screenrec_setup(&app);
    Ok(())
}

#[tauri::command]
pub fn list_screen_sources() -> Result<crate::screenrec::Sources, String> {
    crate::screenrec::list_sources()
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ScreenrecAudioPrefs {
    pub sysaudio: bool,
    pub mic_enabled: bool,
    pub mic_device: String,
}

#[tauri::command]
pub fn get_screenrec_audio_prefs(
    state: State<'_, AppState>,
) -> Result<ScreenrecAudioPrefs, String> {
    Ok(ScreenrecAudioPrefs {
        sysaudio: state.settings.screenrec_sysaudio(),
        mic_enabled: state.settings.screenrec_mic_enabled(),
        mic_device: state.settings.screenrec_mic_device(),
    })
}

#[tauri::command]
pub fn set_screenrec_audio_prefs(
    state: State<'_, AppState>,
    prefs: ScreenrecAudioPrefs,
) -> Result<(), String> {
    state
        .settings
        .set_screenrec_sysaudio(prefs.sysaudio)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_screenrec_mic_enabled(prefs.mic_enabled)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_screenrec_mic_device(prefs.mic_device)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ----- Drive commands -----

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DriveStatus {
    pub connected: bool,
    pub email: Option<String>,
}

#[tauri::command]
pub fn drive_status(state: State<'_, AppState>) -> DriveStatus {
    DriveStatus {
        connected: crate::screenrec::drive::load_refresh_token().is_some(),
        email: state.settings.drive_account_email(),
    }
}

#[tauri::command]
pub async fn drive_connect(state: State<'_, AppState>) -> Result<DriveStatus, String> {
    // Extract owned creds BEFORE awaiting so no State borrow crosses .await.
    let (cid, csecret) = crate::screenrec::drive::effective_client(
        &state.settings.drive_client_id(),
        &state.settings.drive_client_secret(),
    );
    let email = match crate::screenrec::drive::connect(&cid, &csecret).await {
        Ok(e) => e,
        Err(e) => {
            error!(target: "drive", error = %e, "Drive connect failed");
            return Err(
                "Couldn't connect to Google Drive. See Settings → Diagnostics → logs for details."
                    .into(),
            );
        }
    };
    state
        .settings
        .set_drive_account_email(email.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(DriveStatus {
        connected: true,
        email,
    })
}

#[tauri::command]
pub fn drive_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    crate::screenrec::drive::delete_refresh_token()?;
    state
        .settings
        .set_drive_account_email(None)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_drive_folder_id(None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_drive_client_id(state: State<'_, AppState>) -> String {
    state.settings.drive_client_id()
}

#[tauri::command]
pub fn set_drive_client_credentials(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    state
        .settings
        .set_drive_client_id(&client_id)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_drive_client_secret(&client_secret)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DrivePrefs {
    pub folder_name: String,
    pub make_public: bool,
}

#[tauri::command]
pub fn get_drive_prefs(state: State<'_, AppState>) -> DrivePrefs {
    DrivePrefs {
        folder_name: state.settings.drive_folder_name(),
        make_public: state.settings.drive_make_public(),
    }
}

#[tauri::command]
pub fn set_drive_prefs(
    state: State<'_, AppState>,
    folder_name: String,
    make_public: bool,
) -> Result<(), String> {
    let prev = state.settings.drive_folder_name();
    state
        .settings
        .set_drive_folder_name(&folder_name)
        .map_err(|e| e.to_string())?;
    state
        .settings
        .set_drive_make_public(make_public)
        .map_err(|e| e.to_string())?;
    // Folder renamed → drop the cached id so the next upload resolves/creates it.
    if prev != folder_name {
        state
            .settings
            .set_drive_folder_id(None)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Upload a recording at `quality` ("original"|"1080"|"720"|"480") to Drive and
/// return the updated row (with `drive_link`). Non-"original" exports first.
#[tauri::command]
pub async fn upload_recording(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    quality: String,
    make_public: Option<bool>,
) -> Result<crate::db::recordings::RecordingRow, String> {
    // Gather everything needed from State up front (owned values), mirroring
    // how transcribe_recording handles the Db handle across awaits.
    let row = {
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::get(c, &id))
            .map_err(|e| e.to_string())?
            .ok_or("recording not found")?
    };
    let (cid, csecret) = crate::screenrec::drive::effective_client(
        &state.settings.drive_client_id(),
        &state.settings.drive_client_secret(),
    );
    let existing_folder: Option<String> = state.settings.drive_folder_id();
    let folder_name = state.settings.drive_folder_name();
    // Per-video override; falls back to the Settings default when not specified.
    let make_public = make_public.unwrap_or_else(|| state.settings.drive_make_public());

    // Mark uploading and notify UI.
    {
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::update_upload_status(c, &id, "uploading", None))
            .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("screenrec-changed", ());

    // Resolve the file to upload (export first if a quality preset was chosen).
    let upload_path: std::path::PathBuf = if quality == "original" {
        std::path::PathBuf::from(&row.file_path)
    } else {
        let src = std::path::PathBuf::from(&row.file_path);
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("rec")
            .to_string();
        let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
        let out = dir.join(format!("{stem}-{quality}.mp4"));
        let q = quality.clone();
        let out2 = out.clone();
        tokio::task::spawn_blocking(move || crate::screenrec::export(&src, &out2, &q))
            .await
            .map_err(|e| e.to_string())??;
        out
    };
    let upload_name = upload_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("recording.mp4")
        .to_string();

    // Drive sequence: refresh token → ensure folder → upload → share → get link.
    // Returns (file_id, link, folder_to_persist) where folder_to_persist is Some
    // only when we created a new folder (so we can cache it in settings).
    let drive_result: Result<(String, String, Option<String>), String> = async {
        let access = crate::screenrec::drive::refresh_access_token(&cid, &csecret).await?;
        let (folder, folder_to_persist) = match existing_folder {
            Some(f) => (f, None),
            None => {
                let f = crate::screenrec::drive::ensure_folder(&access, &folder_name).await?;
                let persist = Some(f.clone());
                (f, persist)
            }
        };
        let file_id =
            crate::screenrec::drive::upload_resumable(&access, &folder, &upload_path, &upload_name)
                .await?;
        info!(target: "drive", file_id = %file_id, make_public, "setting file visibility");
        if make_public {
            crate::screenrec::drive::make_anyone_reader(&access, &file_id).await?;
        }
        let link = crate::screenrec::drive::web_view_link(&access, &file_id).await?;
        Ok((file_id, link, folder_to_persist))
    }
    .await;

    match drive_result {
        Ok((file_id, link, folder_to_persist)) => {
            // Persist the newly-created folder id so future uploads reuse it.
            if let Some(ref folder_id) = folder_to_persist {
                state
                    .settings
                    .set_drive_folder_id(Some(folder_id.as_str()))
                    .map_err(|e| e.to_string())?;
            }
            {
                let db = require_db(&state)?;
                db.with_conn(|c| crate::db::recordings::update_drive_link(c, &id, &file_id, &link))
                    .map_err(|e| e.to_string())?;
            }
        }
        Err(e) => {
            // Full technical detail to the log; a short, friendly message to the UI.
            error!(target: "drive", error = %e, "Drive upload failed");
            let friendly = "Upload to Drive failed. See Settings → Diagnostics → logs for details.";
            {
                let db = require_db(&state)?;
                db.with_conn(|c| {
                    crate::db::recordings::update_upload_status(c, &id, "error", Some(friendly))
                })
                .map_err(|e| e.to_string())?;
            }
            let _ = app.emit("screenrec-changed", ());
            return Err(friendly.into());
        }
    }
    let _ = app.emit("screenrec-changed", ());
    let db = require_db(&state)?;
    db.with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "recording vanished".to_string())
}

/// Download the embedding model (user-triggered). Emits
/// `embed-model-download-progress` events; the background indexer picks up
/// once the file exists on disk.
#[tauri::command]
pub async fn download_embedding_model(app: AppHandle) -> Result<(), String> {
    let entry = crate::embed::catalog::model();
    let dir = crate::llm::downloader::model_dir(entry);
    let app_for_cb = app.clone();
    crate::llm::downloader::download_model(entry, &dir, move |p| {
        let _ = app_for_cb.emit("embed-model-download-progress", p);
    })
    .await
    .map_err(|e| {
        tracing::error!(target: "embed", error = %e, "embedding model download failed");
        "Embedding model download failed. See Settings → Diagnostics → logs for details.".to_string()
    })?;
    tracing::info!(target: "embed", "embedding model downloaded");
    Ok(())
}

#[derive(serde::Serialize)]
pub struct EmbeddingIndexStatus {
    pub model_downloaded: bool,
    pub embeddings: i64,
    pub indexed_sources: i64,
    pub total_sources: i64,
}

/// Report embedding-index progress for the Settings UI / chat banner.
#[tauri::command]
pub fn embedding_index_status(
    state: State<'_, AppState>,
) -> Result<EmbeddingIndexStatus, String> {
    let db = require_db(&state)?;
    db.with_conn(|c| {
        let embeddings = crate::db::embeddings::count_embeddings(c)?;
        let indexed_sources = crate::db::embeddings::count_indexed_sources(c)?;
        let docs = crate::chat_memory::source::collect_source_docs(c)?;
        Ok(EmbeddingIndexStatus {
            model_downloaded: crate::embed::catalog::is_downloaded(),
            embeddings,
            indexed_sources,
            total_sources: docs.len() as i64,
        })
    })
    .map_err(|e: crate::db::DbError| {
        tracing::error!(target: "embed", error = %e, "embedding_index_status failed");
        "Could not read index status.".to_string()
    })
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
        assert!(
            q.contains("\"about\"")
                || q.contains("\"project\"")
                || q.contains("\"meeting\"")
                || q.contains("\"yesterday\"")
        );
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
