use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, Wry};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::asr::pipeline::AsrPipeline;
use crate::audio::feedback::{self, Sfx};
use crate::audio::recorder::Recorder;
use crate::classifier::{self, Classification};
use crate::db::items::{chrono_now_iso, Item, ItemSource, Visibility};
use crate::db::Db;
use crate::event_log::{self, EventEnvelope};
use crate::input::focus::{self, FocusContext};
use crate::input::hotkeys::HotkeyEvent;
use crate::input::paste::paste_at_cursor;
use crate::llm::Llm;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    VoiceAtCursor,
    LogCapture,
    /// Reserved for Phase 4+: cancel an in-flight capture (e.g. via Esc).
    /// Currently a no-op stub — the wiring is in place but we don't bind it
    /// to anything yet.
    #[allow(dead_code)]
    Cancel,
}

#[derive(Debug, Clone)]
pub enum CoordinatorMsg {
    Hotkey(Action, HotkeyEvent),
    /// User accepted the LogCapture overlay; persist with the supplied fields.
    /// `content` is the (possibly user-edited) transcript.
    ConfirmLogCapture {
        content: String,
        kind: crate::db::items::ItemKind,
        project_id: Option<String>,
        new_project_name: Option<String>,
        tags: Vec<String>,
        deadline_iso: Option<String>,
        reply: tokio::sync::mpsc::UnboundedSender<Result<String, String>>,
    },
    /// User rejected the LogCapture overlay; discard the buffered transcript.
    CancelLogCapture,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineState {
    Idle,
    Recording(Action),
    Processing(Action),
    AwaitingConfirmation,
}

impl PipelineState {
    /// Tray icon color. We collapse Recording/Processing to the legacy
    /// `Recording`/`Processing` colors regardless of which action triggered
    /// it; AwaitingConfirmation reuses the Processing tint (it's still
    /// a "working on it" state from the user's perspective).
    pub fn tray_state(&self) -> TrayPipelineState {
        match self {
            PipelineState::Idle => TrayPipelineState::Idle,
            PipelineState::Recording(_) => TrayPipelineState::Recording,
            PipelineState::Processing(_) | PipelineState::AwaitingConfirmation => {
                TrayPipelineState::Processing
            }
        }
    }
}

/// Subset of pipeline state that the tray cares about (no payloads).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayPipelineState {
    Idle,
    Recording,
    Processing,
}

pub type StateHandle = Arc<Mutex<PipelineState>>;

pub fn new_state_handle() -> StateHandle {
    Arc::new(Mutex::new(PipelineState::Idle))
}

/// Spawn the coordinator. It owns a Recorder and consumes [`CoordinatorMsg`]s
/// from the multiplexed channel. The two hotkey listeners feed into this
/// channel via a small adapter (see `commands.rs::ensure_pipeline_started`).
///
/// State machine:
/// ```text
/// Idle
///   → (VoiceAtCursor, Pressed) → Recording(VoiceAtCursor)
///       → (VoiceAtCursor, Released) → Processing(VoiceAtCursor)
///           → transcribe + persist hidden + paste → Idle
///   → (LogCapture, Pressed) → Recording(LogCapture) [emit log_capture:recording_started]
///       → (LogCapture, Released) → Processing(LogCapture)
///           → transcribe + classify [emit log_capture:classification_ready]
///               → (auto-file shortcut: high confidence + existing project → persist + emit
///                  log_capture:auto_filed → Idle, skipping AwaitingConfirmation)
///               → AwaitingConfirmation
///                   → ConfirmLogCapture → persist visible → Idle
///                   → CancelLogCapture → discard → Idle
/// ```
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    mut rx: mpsc::UnboundedReceiver<CoordinatorMsg>,
    state: StateHandle,
    asr: Arc<AsrPipeline>,
    llm: Arc<Llm>,
    app: AppHandle<Wry>,
    db: Option<Db>,
    event_log_root: Option<PathBuf>,
    paused: Arc<AtomicBool>,
    on_state_change: impl Fn(TrayPipelineState) + 'static,
) {
    // NOTE: `Recorder` owns a `cpal::Stream`, which is `!Send`. We therefore
    // use `tokio::task::spawn_local`, which requires a `LocalSet` to be active
    // on the runtime. `commands::ensure_pipeline_started` sets up that
    // `LocalSet` on a dedicated thread.
    tokio::task::spawn_local(async move {
        let mut recorder = Recorder::new();
        // Frontmost-app snapshot taken at hotkey-press time. We restore it
        // before synthesizing Cmd+V so the paste lands in whichever app the
        // user was in when they started talking — even if our recording
        // overlay (a sibling window in this same process) momentarily stole
        // key-window status. Without this, dictating into our own chat input
        // fails because opening the overlay drops first-responder.
        let mut pending_context: Option<FocusContext> = None;

        // Set up audio level callback to feed the overlay waveform.
        {
            let app_for_levels = app.clone();
            recorder.set_level_callback(move |levels| {
                crate::overlay::emit_levels(&app_for_levels, &levels);
            });
        }

        while let Some(msg) = rx.recv().await {
            match msg {
                CoordinatorMsg::Hotkey(action, HotkeyEvent::Pressed) => {
                    if paused.load(Ordering::SeqCst) {
                        info!(?action, "hotkey Pressed dropped: paused via tray");
                        continue;
                    }

                    // Mid-recording upgrade: if LogCapture fires while
                    // VoiceAtCursor is already recording, promote the
                    // in-progress recording to LogCapture without restarting
                    // the recorder. The user pressed Option to start talking,
                    // then pressed / to signal "this should be a log entry".
                    if action == Action::LogCapture {
                        let upgraded = {
                            let mut s = state.lock().unwrap();
                            if *s == PipelineState::Recording(Action::VoiceAtCursor) {
                                *s = PipelineState::Recording(Action::LogCapture);
                                true
                            } else {
                                false
                            }
                        };
                        if upgraded {
                            info!("upgraded in-progress VoiceAtCursor recording to LogCapture");
                            let _ = app.emit("log_capture:recording_started", ());
                            crate::overlay::show_log_recording_overlay(&app);
                            continue;
                        }
                    }

                    if !transition_from_idle_to_recording(&state, action) {
                        warn!(?action, "ignored Pressed: not in Idle state");
                        continue;
                    }
                    // Snapshot the frontmost app *before* we touch any UI —
                    // showing the overlay can shift key-window status away
                    // from the user's text field.
                    pending_context = focus::capture_context();
                    if let Some(s) = &pending_context {
                        info!(pid = s.pid, bundle = ?s.bundle_id, app = ?s.app_name, "captured frontmost app");
                    }
                    on_state_change(TrayPipelineState::Recording);
                    crate::audio::mute::on_recording_start();
                    feedback::play(Sfx::Start);
                    crate::overlay::show_recording_overlay(&app);
                    if matches!(action, Action::LogCapture) {
                        let _ = app.emit("log_capture:recording_started", ());
                    }
                    if let Err(e) = recorder.start() {
                        error!(?e, ?action, "failed to start recorder; returning to Idle");
                        crate::overlay::hide_recording_overlay(&app);
                        force_state(&state, PipelineState::Idle);
                        on_state_change(TrayPipelineState::Idle);
                        if matches!(action, Action::LogCapture) {
                            let _ = app.emit("log_capture:cancelled", ());
                        }
                    } else {
                        // Recording started — pre-load the ASR engine in the
                        // background so it's warm by the time the user releases.
                        asr.warm_up();
                    }
                }
                CoordinatorMsg::Hotkey(action, HotkeyEvent::Released) => {
                    if paused.load(Ordering::SeqCst) {
                        // Drop the released event too — keep state consistent.
                        info!(?action, "hotkey Released dropped: paused via tray");
                        continue;
                    }
                    if !transition_from_recording_to_processing(&state, action) {
                        warn!(?action, "ignored Released: not Recording for this action");
                        continue;
                    }
                    on_state_change(TrayPipelineState::Processing);
                    crate::audio::mute::on_recording_stop();
                    feedback::play(Sfx::Stop);
                    crate::overlay::show_transcribing_overlay(&app);
                    let channels = recorder.channels();
                    let stop_result = recorder.stop();
                    match stop_result {
                        Ok((samples, sr)) => {
                            info!(
                                samples = samples.len(),
                                sample_rate = sr,
                                channels,
                                ?action,
                                "transcribing"
                            );
                            match asr.transcribe(samples, sr, channels.max(1)).await {
                                Ok(text) if text.is_empty() => {
                                    warn!("transcription produced empty text; nothing to do");
                                    if matches!(action, Action::LogCapture) {
                                        let _ = app.emit(
                                            "log_capture:classification_ready",
                                            serde_json::json!({
                                                "transcript": "",
                                                "classification": null,
                                                "error": "empty transcription",
                                            }),
                                        );
                                    }
                                    crate::overlay::hide_recording_overlay(&app);
                                    force_state(&state, PipelineState::Idle);
                                    on_state_change(TrayPipelineState::Idle);
                                }
                                Ok(text) => {
                                    let text = postprocess_with_settings(&app, text);
                                    match action {
                                    Action::VoiceAtCursor => {
                                        // Phase 1 behavior: persist hidden + paste.
                                        persist_capture(
                                            &text,
                                            db.as_ref(),
                                            event_log_root.as_deref(),
                                            &app,
                                            pending_context.as_ref().and_then(serialise_context),
                                        );
                                        // Hide the overlay first so it can't
                                        // be the key window when we paste.
                                        crate::overlay::hide_recording_overlay(&app);
                                        // Re-activate the originally-frontmost
                                        // app, then give the WindowServer a
                                        // moment to re-route key focus before
                                        // we post the Cmd+V event.
                                        if let Some(snap) = pending_context.take() {
                                            let ok = focus::restore(&snap);
                                            info!(restored = ok, pid = snap.pid, "restored focus before paste");
                                            // Tell the frontend a paste is
                                            // imminent. If our own app was the
                                            // target, a registered text field
                                            // (e.g. the chat input) can re-focus
                                            // itself so the keystroke lands
                                            // there. Harmless when paste targets
                                            // an external app.
                                            let _ = app.emit("voice:paste_pending", ());
                                            std::thread::sleep(std::time::Duration::from_millis(50));
                                        }
                                        info!(chars = text.len(), "pasting transcription");
                                        if let Err(e) = paste_at_cursor(&text) {
                                            error!(?e, "paste failed");
                                            let _ =
                                                app.emit("asr:error", format!("Paste failed: {e}"));
                                        }
                                        force_state(&state, PipelineState::Idle);
                                        on_state_change(TrayPipelineState::Idle);
                                    }
                                    Action::LogCapture => {
                                        let cls = run_classifier(&llm, &text, db.as_ref(), pending_context.as_ref().map(|c| c as &_)).await;
                                        feedback::play(Sfx::Ready);
                                        crate::overlay::hide_recording_overlay(&app);

                                        // Always auto-save immediately; use classifier result when available.
                                        let (kind, project_id, tags, deadline, confidence) = match &cls {
                                            Ok(c) => (
                                                c.kind,
                                                c.project_id.clone(),
                                                c.tags.clone(),
                                                c.deadline_iso.clone(),
                                                Some(c.confidence),
                                            ),
                                            Err(e) => {
                                                warn!(?e, "classifier unavailable; saving as note with no project");
                                                (crate::db::items::ItemKind::Note, None, vec![], None, None)
                                            }
                                        };
                                        let classified_by = cls.as_ref().ok().map(|_| "ai");

                                        let project_name: Option<String> =
                                            project_id.as_deref().and_then(|pid| {
                                                db.as_ref().and_then(|db| {
                                                    db.with_conn(|conn| {
                                                        crate::db::projects::get_project(conn, pid)
                                                    })
                                                    .ok()
                                                    .flatten()
                                                    .map(|p| p.name)
                                                })
                                            });

                                        let res = persist_log_capture(
                                            &text,
                                            kind,
                                            project_id,
                                            None, // never auto-create new projects
                                            tags,
                                            deadline,
                                            confidence,
                                            classified_by,
                                            pending_context.as_ref().and_then(serialise_context),
                                            db.as_ref(),
                                            event_log_root.as_deref(),
                                        );
                                        match res {
                                            Ok(item_id) => {
                                                info!(item_id = %item_id, "auto-saved log capture");
                                                let _ = app.emit("item:created", ());
                                                notify_auto_filed(
                                                    &app,
                                                    &item_id,
                                                    project_name.as_deref(),
                                                    kind,
                                                    &text,
                                                    confidence.unwrap_or(0.0),
                                                );
                                            }
                                            Err(e) => {
                                                error!(?e, "log capture auto-save failed");
                                                let _ = app.emit("asr:error", format!("Save failed: {e}"));
                                            }
                                        }
                                        force_state(&state, PipelineState::Idle);
                                        on_state_change(TrayPipelineState::Idle);
                                    }
                                    Action::Cancel => {
                                        crate::overlay::hide_recording_overlay(&app);
                                        force_state(&state, PipelineState::Idle);
                                        on_state_change(TrayPipelineState::Idle);
                                    }
                                    }
                                }
                                Err(e) => {
                                    error!(?e, "transcription failed");
                                    let _ = app.emit(
                                        "asr:error",
                                        format!("Transcription failed: {e}"),
                                    );
                                    if matches!(action, Action::LogCapture) {
                                        let _ = app.emit(
                                            "log_capture:classification_ready",
                                            serde_json::json!({
                                                "transcript": "",
                                                "classification": null,
                                                "error": e.to_string(),
                                            }),
                                        );
                                    }
                                    crate::overlay::hide_recording_overlay(&app);
                                    force_state(&state, PipelineState::Idle);
                                    on_state_change(TrayPipelineState::Idle);
                                }
                            }
                        }
                        Err(e) => {
                            error!(?e, "recorder.stop failed");
                            let _ = app.emit("asr:error", format!("Recorder error: {e}"));
                            if matches!(action, Action::LogCapture) {
                                let _ = app.emit("log_capture:cancelled", ());
                            }
                            crate::overlay::hide_recording_overlay(&app);
                            force_state(&state, PipelineState::Idle);
                            on_state_change(TrayPipelineState::Idle);
                        }
                    }
                }
                CoordinatorMsg::ConfirmLogCapture {
                    content,
                    kind,
                    project_id,
                    new_project_name,
                    tags,
                    deadline_iso,
                    reply,
                } => {
                    let res = persist_log_capture(
                        &content,
                        kind,
                        project_id,
                        new_project_name,
                        tags,
                        deadline_iso,
                        None,
                        Some("user"),
                        None,  // no context for user-confirmed saves
                        db.as_ref(),
                        event_log_root.as_deref(),
                    );
                    match &res {
                        Ok(id) => {
                            info!(item_id = %id, "log capture persisted");
                            let _ = app.emit("item:created", ());
                        }
                        Err(e) => error!(?e, "log capture persistence failed"),
                    }
                    let _ = reply.send(res);
                    force_state(&state, PipelineState::Idle);
                    on_state_change(TrayPipelineState::Idle);
                }
                CoordinatorMsg::CancelLogCapture => {
                    let _ = app.emit("log_capture:cancelled", ());
                    force_state(&state, PipelineState::Idle);
                    on_state_change(TrayPipelineState::Idle);
                }
            }
        }
    });
}

fn transition_from_idle_to_recording(state: &StateHandle, action: Action) -> bool {
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if matches!(*s, PipelineState::Idle) {
        *s = PipelineState::Recording(action);
        true
    } else {
        false
    }
}

fn transition_from_recording_to_processing(state: &StateHandle, action: Action) -> bool {
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if let PipelineState::Recording(current) = &*s {
        if *current == action {
            *s = PipelineState::Processing(action);
            return true;
        }
    }
    false
}

fn force_state(state: &StateHandle, to: PipelineState) {
    if let Ok(mut s) = state.lock() {
        *s = to;
    }
}

/// Serialise a `FocusContext` to a compact JSON string for storage.
fn serialise_context(ctx: &crate::input::focus::FocusContext) -> Option<String> {
    serde_json::to_string(&serde_json::json!({
        "app_name":     ctx.app_name,
        "window_title": ctx.window_title,
        "browser_url":  ctx.browser_url,
        "bundle_id":    ctx.bundle_id,
    }))
    .ok()
}

/// Insert an item row + append a `voice.captured` event to the disk log.
/// Best-effort, see Phase 1 docs.
fn persist_capture(
    text: &str,
    db: Option<&Db>,
    event_log_root: Option<&std::path::Path>,
    app: &AppHandle<Wry>,
    capture_context: Option<String>,
) {
    let id = ulid::Ulid::new().to_string();
    let now = chrono_now_iso();

    if let Some(db) = db {
        let item = Item {
            id: id.clone(),
            content: text.to_string(),
            source: ItemSource::VoiceAtCursor,
            visibility: Visibility::Hidden,
            kind: None,
            project_id: None,
            captured_at: now.clone(),
            created_at: now.clone(),
            deleted_at: None,
            confidence: None,
            classified_by: None,
            capture_context,
        };
        let res = db.with_conn(|c| crate::db::items::insert_item(c, &item));
        match res {
            Ok(_) => {
                let id_for_event = id.clone();
                let _ = db.with_conn(|c| {
                    crate::db::events::insert_event(c, &id_for_event, "created", Some("via voice_at_cursor"))
                });
                let _ = app.emit("item:created", ());
            }
            Err(e) => {
                error!(?e, "failed to persist item");
                let _ = app.emit("asr:error", format!("Persist failed: {e}"));
            }
        }
    }

    if let Some(root) = event_log_root {
        let preview = preview_first_chars(text, 200);
        let envelope = EventEnvelope {
            id: id.clone(),
            event_type: "voice.captured".to_string(),
            created_at: now,
            payload: serde_json::json!({
                "item_id": id,
                "preview": preview,
                "char_count": text.chars().count(),
            }),
        };
        if let Err(e) = event_log::append_event(root, &envelope) {
            error!(?e, "failed to append event log entry");
            let _ = app.emit("asr:error", format!("Persist failed: {e}"));
        }
    }
}

fn preview_first_chars(text: &str, max_bytes: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_bytes));
    for c in text.chars() {
        if out.len() + c.len_utf8() > max_bytes {
            break;
        }
        out.push(c);
    }
    out
}

/// Apply the user-configured filler-removal + custom-word passes. Looks up
/// the latest settings via the managed `AppState` so toggles take effect on
/// the next transcription without restarting the pipeline.
fn postprocess_with_settings(app: &AppHandle<Wry>, text: String) -> String {
    let state = match app.try_state::<crate::commands::AppState>() {
        Some(s) => s,
        None => return text,
    };
    let fillers = if state.settings.filler_removal_enabled() {
        state.settings.filler_words()
    } else {
        Vec::new()
    };
    let custom = state.settings.custom_words();
    if fillers.is_empty() && custom.is_empty() {
        return text;
    }
    crate::asr::postprocess::postprocess(&text, &fillers, &custom)
}

/// Run the classifier with light context (existing projects + last 5 items).
async fn run_classifier(
    llm: &Llm,
    transcript: &str,
    db: Option<&Db>,
    focus: Option<&crate::input::focus::FocusContext>,
) -> Result<Classification, classifier::ClassifierError> {
    if !llm.ready() {
        return Err(classifier::ClassifierError::Parse(
            "no llm model is active".into(),
        ));
    }
    let (projects, recents) = match db {
        Some(db) => db
            .with_conn(|c| {
                let projects = crate::db::projects::list_projects(c, false)?;
                let recents = crate::db::items::list_items(c, None, None, 5, 0)?;
                Ok::<_, crate::db::DbError>((projects, recents))
            })
            .unwrap_or_else(|e| {
                warn!(?e, "failed to load classifier context; using empty");
                (Vec::new(), Vec::new())
            }),
        None => (Vec::new(), Vec::new()),
    };
    let now = crate::db::items::chrono_now_iso();
    let dow = classifier::dow_from_iso(&now);
    classifier::classify(llm, transcript, &projects, &recents, &now, dow, focus).await
}

/// Returns true when the classification meets the user's auto-file criteria:
/// auto-file enabled, confidence ≥ threshold, an existing project matched,
/// and the LLM did NOT propose a new project. New-project proposals always
/// require the review overlay, regardless of confidence.
fn should_auto_file(
    cls: &Classification,
    enabled: bool,
    threshold: f32,
) -> bool {
    enabled
        && cls.project_id.is_some()
        && cls.new_project_name.is_none()
        && cls.confidence >= threshold
}

/// Emit the in-app toast event AND, when the main window is not visible,
/// fire an OS notification so the user sees what was filed. When
/// `project_name` is `None` (lookup failed because the DB is unavailable or
/// the project was deleted), the in-app event still fires with `"Unknown"`
/// in its payload but the OS notification is skipped.
fn notify_auto_filed(
    app: &AppHandle<Wry>,
    item_id: &str,
    project_name: Option<&str>,
    kind: crate::db::items::ItemKind,
    content: &str,
    confidence: f32,
) {
    let preview = preview_first_chars(content, 120);
    let display_name = project_name.unwrap_or("Unknown");
    let payload = serde_json::json!({
        "item_id": item_id,
        "project_name": display_name,
        "kind": kind.as_str(),
        "preview": preview,
        "confidence": confidence,
    });
    let _ = app.emit("log_capture:auto_filed", payload);

    // If the main window isn't visible, the user won't see the in-app toast.
    // Fall back to an OS notification (no Undo button — the user can open
    // the app to find/edit/delete the item).
    let main_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !main_visible {
        let Some(name) = project_name else {
            warn!(
                "auto-filed item has no resolvable project name; skipping OS notification"
            );
            return;
        };
        use tauri_plugin_notification::NotificationExt;
        let kind_label = match kind {
            crate::db::items::ItemKind::Task => "Task",
            crate::db::items::ItemKind::Note => "Note",
        };
        let title = format!("Filed to {name}");
        let body = format!("{kind_label}: {preview}");
        if let Err(e) = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            warn!(?e, "failed to show OS notification for auto-file");
        }
    }
}

/// Persist a confirmed LogCapture as a Visible item, plus tags/task row, plus
/// a `log.captured` event-log envelope. Returns the new item id on success.
#[allow(clippy::too_many_arguments)]
fn persist_log_capture(
    content: &str,
    kind: crate::db::items::ItemKind,
    project_id: Option<String>,
    new_project_name: Option<String>,
    tags: Vec<String>,
    deadline_iso: Option<String>,
    confidence: Option<f32>,
    classified_by: Option<&str>,
    capture_context: Option<String>,
    db: Option<&Db>,
    event_log_root: Option<&std::path::Path>,
) -> Result<String, String> {
    let id = ulid::Ulid::new().to_string();
    let now = chrono_now_iso();

    let db = db.ok_or_else(|| "database not available".to_string())?;

    // Resolve project id: if `new_project_name` is set, create the project
    // and use its id. Otherwise use the supplied (validated) project_id, if
    // any.
    let final_project_id: Option<String> = if let Some(name) = new_project_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let pid = ulid::Ulid::new().to_string();
        let proj = crate::db::projects::Project {
            id: pid.clone(),
            name: name.to_string(),
            created_at: now.clone(),
            archived_at: None,
        };
        db.with_conn(|c| crate::db::projects::insert_project(c, &proj))
            .map_err(|e| format!("create project: {e}"))?;
        Some(pid)
    } else {
        project_id
    };

    let item = Item {
        id: id.clone(),
        content: content.to_string(),
        source: ItemSource::LogCapture,
        visibility: Visibility::Visible,
        kind: Some(kind),
        project_id: final_project_id.clone(),
        captured_at: now.clone(),
        created_at: now.clone(),
        deleted_at: None,
        confidence,
        classified_by: classified_by.map(|s| s.to_string()),
        capture_context,
    };

    db.with_conn(|c| crate::db::items::insert_item(c, &item))
        .map_err(|e| format!("insert item: {e}"))?;

    // Record lifecycle event.
    {
        let detail = format!("via log_capture as {}", kind.as_str());
        let id_for_event = id.clone();
        let _ = db.with_conn(move |c| {
            crate::db::events::insert_event(c, &id_for_event, "created", Some(&detail))
        });
        if let Some(ref pid) = final_project_id {
            let id_for_event = id.clone();
            let pid_clone = pid.clone();
            let _ = db.with_conn(move |c| {
                crate::db::events::insert_event(
                    c,
                    &id_for_event,
                    "project_assigned",
                    Some(&pid_clone),
                )
            });
        }
    }

    // Tags.
    if !tags.is_empty() {
        let tags_clone = tags.clone();
        let id_clone = id.clone();
        db.with_conn(move |c| {
            for t in &tags_clone {
                c.execute(
                    "INSERT OR IGNORE INTO item_tags(item_id, tag) VALUES(?1, ?2)",
                    rusqlite::params![id_clone, t],
                )?;
            }
            Ok(())
        })
        .map_err(|e| format!("insert tags: {e}"))?;
    }

    // Task row, only for tasks.
    if matches!(kind, crate::db::items::ItemKind::Task) {
        let task = crate::db::tasks::Task {
            item_id: id.clone(),
            deadline: deadline_iso.clone(),
            completed_at: None,
        };
        db.with_conn(|c| crate::db::tasks::upsert_task(c, &task))
            .map_err(|e| format!("upsert task: {e}"))?;
    }

    // Event log.
    if let Some(root) = event_log_root {
        let preview = preview_first_chars(content, 200);
        let envelope = EventEnvelope {
            id: id.clone(),
            event_type: "log.captured".to_string(),
            created_at: now,
            payload: serde_json::json!({
                "item_id": id,
                "kind": kind.as_str(),
                "project_id": final_project_id,
                "tags": tags,
                "deadline_iso": deadline_iso,
                "preview": preview,
                "char_count": content.chars().count(),
            }),
        };
        if let Err(e) = event_log::append_event(root, &envelope) {
            // Don't roll back the DB row — the event log is additive history.
            warn!(?e, "failed to append log.captured event");
        }
    }

    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_to_recording_transition() {
        let s = new_state_handle();
        assert!(transition_from_idle_to_recording(&s, Action::VoiceAtCursor));
        assert_eq!(*s.lock().unwrap(), PipelineState::Recording(Action::VoiceAtCursor));
    }

    #[test]
    fn idle_to_recording_rejects_when_busy() {
        let s = new_state_handle();
        force_state(&s, PipelineState::Recording(Action::VoiceAtCursor));
        assert!(!transition_from_idle_to_recording(&s, Action::LogCapture));
    }

    #[test]
    fn recording_to_processing_only_for_matching_action() {
        let s = new_state_handle();
        force_state(&s, PipelineState::Recording(Action::VoiceAtCursor));
        // Mismatched action is rejected.
        assert!(!transition_from_recording_to_processing(&s, Action::LogCapture));
        // Matching action succeeds.
        assert!(transition_from_recording_to_processing(&s, Action::VoiceAtCursor));
        assert_eq!(
            *s.lock().unwrap(),
            PipelineState::Processing(Action::VoiceAtCursor)
        );
    }

    #[test]
    fn force_state_overrides_unconditionally() {
        let s = new_state_handle();
        force_state(&s, PipelineState::Processing(Action::LogCapture));
        assert_eq!(
            *s.lock().unwrap(),
            PipelineState::Processing(Action::LogCapture)
        );
        force_state(&s, PipelineState::Idle);
        assert_eq!(*s.lock().unwrap(), PipelineState::Idle);
    }

    #[test]
    fn tray_state_collapses_actions() {
        assert_eq!(PipelineState::Idle.tray_state(), TrayPipelineState::Idle);
        assert_eq!(
            PipelineState::Recording(Action::LogCapture).tray_state(),
            TrayPipelineState::Recording
        );
        assert_eq!(
            PipelineState::Processing(Action::VoiceAtCursor).tray_state(),
            TrayPipelineState::Processing
        );
        assert_eq!(
            PipelineState::AwaitingConfirmation.tray_state(),
            TrayPipelineState::Processing
        );
    }
}

#[cfg(test)]
mod auto_file_tests {
    use super::*;
    use crate::db::items::ItemKind;

    fn cls(confidence: f32, project_id: Option<&str>, new_name: Option<&str>) -> Classification {
        Classification {
            kind: ItemKind::Note,
            project_id: project_id.map(|s| s.to_string()),
            new_project_name: new_name.map(|s| s.to_string()),
            tags: vec![],
            deadline_iso: None,
            confidence,
        }
    }

    #[test]
    fn auto_files_when_confident_and_existing_project() {
        assert!(should_auto_file(&cls(0.9, Some("p1"), None), true, 0.75));
    }

    #[test]
    fn refuses_when_disabled() {
        assert!(!should_auto_file(&cls(0.9, Some("p1"), None), false, 0.75));
    }

    #[test]
    fn refuses_below_threshold() {
        assert!(!should_auto_file(&cls(0.7, Some("p1"), None), true, 0.75));
    }

    #[test]
    fn refuses_when_no_project() {
        assert!(!should_auto_file(&cls(0.95, None, None), true, 0.75));
    }

    #[test]
    fn refuses_when_new_project_proposed() {
        assert!(!should_auto_file(
            &cls(0.95, None, Some("New Project")),
            true,
            0.75
        ));
    }

    #[test]
    fn boundary_at_threshold_is_inclusive() {
        assert!(should_auto_file(&cls(0.75, Some("p1"), None), true, 0.75));
    }
}
