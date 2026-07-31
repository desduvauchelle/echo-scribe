use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::path::BaseDirectory;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, Theme, Wry};
use tracing::{error, info, warn};

use crate::commands::AppState;
use crate::coordinator::TrayPipelineState;
use crate::power::{KeepAwakeMode, KeepAwakeStatus, KEEP_AWAKE_OPTIONS};

/// Prefix for every "Keep awake" menu item id. The suffix is the mode's
/// `storage_key`, so `keep_awake:off`, `keep_awake:indefinite`, `keep_awake:30`.
const KEEP_AWAKE_ID_PREFIX: &str = "keep_awake:";

/// Owned by the app for its full lifetime. Holds the tray icon plus the
/// menu items we need to mutate (Pause/Resume label flips between modes).
pub struct TrayHandle<R: Runtime> {
    icon: TrayIcon<R>,
    /// The Pause/Resume toggle item — relabelled when the user flips the
    /// pause state via the menu.
    pause_item: Mutex<Option<MenuItem<R>>>,
    /// Meeting actions are separate from screen recording actions. Start and
    /// Stop are enabled in opposition as the meeting state changes.
    meeting_start_item: Mutex<Option<MenuItem<R>>>,
    meeting_stop_item: Mutex<Option<MenuItem<R>>>,
    /// Screen recording has its own Start, Pause/Resume, and Stop actions.
    screenrec_start_item: Mutex<Option<MenuItem<R>>>,
    screenrec_stop_item: Mutex<Option<MenuItem<R>>>,
    /// The Pause/Resume RECORDING toggle item (distinct from the hotkey-pause
    /// item above). Hidden unless a recording is active; label flips between
    /// "Pause recording" and "Resume recording" as the sidecar pauses/resumes.
    screenrec_pause_item: Mutex<Option<MenuItem<R>>>,
    /// The "Keep awake" parent row. Relabelled to carry the current state
    /// ("Keep awake: 42m left") so it's readable without opening the submenu.
    /// `None` on platforms where `power::is_supported()` is false — there we
    /// omit the submenu entirely rather than offer a no-op.
    keep_awake_menu: Mutex<Option<Submenu<R>>>,
    /// Every keep-awake option paired with its check item, so exactly one can
    /// be ticked. Ordered `Off` first, then `KEEP_AWAKE_OPTIONS`.
    keep_awake_items: Mutex<Vec<(KeepAwakeMode, CheckMenuItem<R>)>>,
    /// Last applied pipeline state, so we can re-apply the right icon when
    /// the user toggles "Paused" on/off without losing the underlying state.
    last_state: Mutex<TrayPipelineState>,
    /// Mirrors `AppState.paused_hotkeys` for icon decisions.
    paused: Mutex<Arc<AtomicBool>>,
    /// Whether a screen recording is currently active. Independent of the
    /// pipeline `last_state` so a dictation/meeting cycle ending in Idle does
    /// not clobber the red recording icon. Takes precedence in `set_state`.
    screenrec_active: AtomicBool,
}

impl<R: Runtime> TrayHandle<R> {
    pub fn install(app: &AppHandle<R>) -> tauri::Result<TrayHandle<R>> {
        let open = MenuItem::with_id(app, "open", "Open Echo Scribe", true, None::<&str>)?;
        let meeting_start =
            MenuItem::with_id(app, "meeting_start", "Start meeting", true, None::<&str>)?;
        let meeting_stop =
            MenuItem::with_id(app, "meeting_stop", "Stop meeting", false, None::<&str>)?;
        let screenrec_start = MenuItem::with_id(
            app,
            "screenrec_start",
            "Start screen recording",
            true,
            None::<&str>,
        )?;
        let screenrec_stop = MenuItem::with_id(
            app,
            "screenrec_stop",
            "Stop screen recording",
            false,
            None::<&str>,
        )?;
        // Pause/Resume RECORDING — created DISABLED (greyed out) since no
        // recording is active at install. Tauri 2's MenuItem exposes
        // set_enabled but not per-item set_visible, so "only actionable while
        // recording" is implemented via the enabled flag: enabled + relabelled
        // in set_screenrec_active(true), disabled again on stop.
        let screenrec_pause = MenuItem::with_id(
            app,
            "screenrec_pause",
            "Pause recording",
            false,
            None::<&str>,
        )?;
        let copy_last =
            MenuItem::with_id(app, "copy_last", "Copy last transcript", true, None::<&str>)?;
        let paste_last = MenuItem::with_id(
            app,
            "paste_last",
            "Paste last transcript",
            true,
            None::<&str>,
        )?;
        let pause = MenuItem::with_id(app, "pause", "Pause hotkeys", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
        let sep1 = PredefinedMenuItem::separator(app)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        let sep3 = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Echo Scribe", true, None::<&str>)?;

        let meeting_recording_menu = Submenu::with_id_and_items(
            app,
            "meeting_recording",
            "Meeting recording",
            true,
            &[&meeting_start, &meeting_stop],
        )?;
        let screen_recording_menu = Submenu::with_id_and_items(
            app,
            "screen_recording",
            "Screen recording",
            true,
            &[&screenrec_start, &screenrec_pause, &screenrec_stop],
        )?;
        let transcript_menu = Submenu::with_id_and_items(
            app,
            "last_transcript",
            "Last transcript",
            true,
            &[&copy_last, &paste_last],
        )?;

        // "Keep awake" — a submenu of mutually-exclusive durations. Built only
        // where we can actually hold a power assertion; `keep_awake_items`
        // stays empty elsewhere and every update method no-ops.
        let (keep_awake_menu, keep_awake_items) = if crate::power::is_supported() {
            let (submenu, items) = build_keep_awake_menu(app)?;
            (Some(submenu), items)
        } else {
            info!("keep awake unavailable on this platform, omitting tray submenu");
            (None, Vec::new())
        };

        let mut menu_items: Vec<&dyn IsMenuItem<R>> = vec![
            &open,
            &sep1,
            &meeting_recording_menu,
            &screen_recording_menu,
            &transcript_menu,
            &sep2,
            &pause,
        ];
        if let Some(submenu) = &keep_awake_menu {
            menu_items.push(submenu);
        }
        menu_items.push(&settings);
        menu_items.push(&sep3);
        menu_items.push(&quit);
        let menu = Menu::with_items(app, &menu_items)?;

        let pause_for_handle = pause.clone();
        let meeting_start_for_handle = meeting_start.clone();
        let meeting_stop_for_handle = meeting_stop.clone();
        let screenrec_start_for_handle = screenrec_start.clone();
        let screenrec_stop_for_handle = screenrec_stop.clone();
        let screenrec_pause_for_handle = screenrec_pause.clone();
        let icon = TrayIconBuilder::new()
            .menu(&menu)
            .icon(load_icon(app, TrayPipelineState::Idle, false))
            .icon_as_template(true)
            .build(app)?;

        Ok(TrayHandle {
            icon,
            pause_item: Mutex::new(Some(pause_for_handle)),
            meeting_start_item: Mutex::new(Some(meeting_start_for_handle)),
            meeting_stop_item: Mutex::new(Some(meeting_stop_for_handle)),
            screenrec_start_item: Mutex::new(Some(screenrec_start_for_handle)),
            screenrec_stop_item: Mutex::new(Some(screenrec_stop_for_handle)),
            screenrec_pause_item: Mutex::new(Some(screenrec_pause_for_handle)),
            keep_awake_menu: Mutex::new(keep_awake_menu),
            keep_awake_items: Mutex::new(keep_awake_items),
            last_state: Mutex::new(TrayPipelineState::Idle),
            paused: Mutex::new(Arc::new(AtomicBool::new(false))),
            screenrec_active: AtomicBool::new(false),
        })
    }

    /// Tick exactly one option and relabel the parent row. Idempotent, and
    /// safe to call from any thread (menu mutations hop to the main thread).
    pub fn set_keep_awake(&self, status: KeepAwakeStatus) {
        let items = self
            .keep_awake_items
            .lock()
            .ok()
            .map(|g| g.clone())
            .unwrap_or_default();
        for (mode, item) in &items {
            // A timed hold ticks its own duration row; `Off` ticks only when
            // nothing is held.
            if let Err(e) = item.set_checked(*mode == status.mode) {
                warn!(?e, ?mode, "failed to update keep-awake check state");
            }
        }

        let submenu = self
            .keep_awake_menu
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(submenu) = submenu {
            if let Err(e) = submenu.set_text(status.menu_label()) {
                warn!(?e, "failed to relabel keep-awake submenu");
            }
        }
    }
}

/// Build the "Keep awake" submenu: `Off`, a separator, then every option in
/// `KEEP_AWAKE_OPTIONS`. Returns the submenu plus the (mode, item) pairs so
/// the caller can tick the active one later.
#[allow(clippy::type_complexity)]
fn build_keep_awake_menu<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<(Submenu<R>, Vec<(KeepAwakeMode, CheckMenuItem<R>)>)> {
    let mut items: Vec<(KeepAwakeMode, CheckMenuItem<R>)> = Vec::new();
    // `Off` is checked at install because nothing is held yet; the persisted
    // mode is applied afterwards by `restore_keep_awake`.
    for (mode, checked) in std::iter::once((KeepAwakeMode::Off, true))
        .chain(KEEP_AWAKE_OPTIONS.iter().map(|m| (*m, false)))
    {
        let item = CheckMenuItem::with_id(
            app,
            format!("{KEEP_AWAKE_ID_PREFIX}{}", mode.storage_key()),
            mode.menu_label(),
            true,
            checked,
            None::<&str>,
        )?;
        items.push((mode, item));
    }

    let separator = PredefinedMenuItem::separator(app)?;
    let mut refs: Vec<&dyn IsMenuItem<R>> = Vec::with_capacity(items.len() + 1);
    for (idx, (_, item)) in items.iter().enumerate() {
        // Separate the "off switch" from the durations that turn it on.
        if idx == 1 {
            refs.push(&separator);
        }
        refs.push(item);
    }

    let submenu = Submenu::with_id_and_items(app, "keep_awake", "Keep awake", true, &refs)?;
    Ok((submenu, items))
}

/// Wry-specific impl for `bind_menu` — needs concrete `AppHandle<Wry>` to
/// call overlay functions that take `&AppHandle<Wry>` directly.
impl TrayHandle<Wry> {
    /// Wire the menu-event handler. Called from `lib.rs::run` after the
    /// managed `AppState` (and its `paused_hotkeys` atomic) exists.
    pub fn bind_menu(&self, app: &AppHandle<Wry>, paused: Arc<AtomicBool>) {
        if let Ok(mut slot) = self.paused.lock() {
            *slot = Arc::clone(&paused);
        }
        // Re-clone the pause MenuItem so the closure can update its label.
        let pause_item = self
            .pause_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.clone()));
        let app_for_handler = app.clone();
        let last_state = Arc::new(Mutex::new(
            self.last_state
                .lock()
                .map(|g| *g)
                .unwrap_or(TrayPipelineState::Idle),
        ));
        let last_state_for_handler = Arc::clone(&last_state);
        let icon = self.icon.clone();
        self.icon.on_menu_event(move |_app, event| {
            match event.id().as_ref() {
                "quit" => {
                    app_for_handler.exit(0);
                }
                "open" => {
                    show_main_window(&app_for_handler);
                }
                "settings" => {
                    show_main_window(&app_for_handler);
                    let _ = app_for_handler.emit("open_settings", ());
                }
                "copy_last" => {
                    let state = app_for_handler.state::<AppState>();
                    match crate::commands::copy_last_transcript(app_for_handler.clone(), state) {
                        Ok(_) => info!("last transcript copied from tray"),
                        Err(e) => {
                            warn!(%e, "tray: copy last transcript failed");
                            let _ = app_for_handler.emit("asr:error", e);
                        }
                    }
                }
                "paste_last" => {
                    let state = app_for_handler.state::<AppState>();
                    match crate::commands::paste_last_transcript(app_for_handler.clone(), state) {
                        Ok(_) => info!("last transcript pasted from tray"),
                        Err(e) => {
                            warn!(%e, "tray: paste last transcript failed");
                            let _ = app_for_handler.emit("asr:error", e);
                        }
                    }
                }
                "meeting_start" => {
                    let app = app_for_handler.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let manager = state.meeting_manager.clone();
                        if manager.is_active().await {
                            return;
                        }
                        let start_ctx = {
                            let ctx = crate::input::focus::capture_context();
                            crate::meeting::MeetingStartContext {
                                window_title: ctx.as_ref().and_then(|c| c.window_title.clone()),
                                browser_url: ctx.as_ref().and_then(|c| c.browser_url.clone()),
                                browser_tab_title: ctx
                                    .as_ref()
                                    .and_then(|c| c.browser_tab_title.clone()),
                            }
                        };
                        match manager.clone().start(None, None, start_ctx).await {
                            Ok(id) => {
                                info!(%id, "meeting started via tray");
                                crate::meeting::detector::spawn_end_monitor(manager, None);
                            }
                            Err(e) => {
                                warn!(?e, "tray: start_meeting failed");
                                let _ = app.emit("meeting-action-error", e.to_string());
                            }
                        }
                    });
                }
                "meeting_stop" => {
                    let app = app_for_handler.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let manager = state.meeting_manager.clone();
                        if !manager.is_active().await {
                            return;
                        }
                        if let Err(e) = manager.stop_by_user().await {
                            warn!(?e, "tray: stop_meeting failed");
                            let _ = app.emit("meeting-action-error", e.to_string());
                        } else {
                            info!("meeting stopped via tray");
                        }
                    });
                }
                "screenrec_start" => {
                    let state = app_for_handler.state::<AppState>();
                    let recording = state
                        .active_recording
                        .lock()
                        .map(|g| g.is_some())
                        .unwrap_or(false);
                    if !recording {
                        crate::overlay::show_screenrec_setup(&app_for_handler);
                    }
                }
                "screenrec_stop" => {
                    let app = app_for_handler.clone();
                    let state = app.state::<AppState>();
                    let recording = state
                        .active_recording
                        .lock()
                        .map(|g| g.is_some())
                        .unwrap_or(false);
                    if recording {
                        std::thread::spawn(move || {
                            let st = app.state::<AppState>();
                            match crate::commands::stop_screen_recording_inner(&st, &app) {
                                Ok(row) => {
                                    if let Ok(t) = st.tray.lock() {
                                        t.set_screenrec_active(false);
                                    }
                                    let _ = app.emit("screenrec-changed", ());
                                    crate::commands::spawn_auto_denoise(app.clone(), row.id);
                                }
                                Err(e) => {
                                    tracing::warn!(%e, "tray stop screenrec failed");
                                }
                            }
                        });
                    }
                }
                "screenrec_pause" => {
                    // Toggle pause/resume of the ACTIVE recording (distinct from
                    // the "pause" hotkeys item below). Read the current paused
                    // state, flip it, and relabel the tray + emit the change.
                    // Off the menu thread so signalling + the mutex never block it.
                    let app = app_for_handler.clone();
                    std::thread::spawn(move || {
                        let st = app.state::<AppState>();
                        let action: Option<Result<bool, String>> = {
                            let guard = st.active_recording.lock().ok();
                            guard.and_then(|g| {
                                g.as_ref().map(|(h, _)| {
                                    if h.is_paused() {
                                        h.resume().map(|_| false) // now running
                                    } else {
                                        h.pause().map(|_| true) // now paused
                                    }
                                })
                            })
                        };
                        match action {
                            Some(Ok(now_paused)) => {
                                if let Ok(t) = st.tray.lock() {
                                    t.set_screenrec_paused(now_paused);
                                }
                                let _ = app.emit("screenrec-changed", ());
                            }
                            Some(Err(e)) => warn!(%e, "tray pause/resume recording failed"),
                            None => warn!("tray pause/resume: no active recording"),
                        }
                    });
                }
                id if id.starts_with(KEEP_AWAKE_ID_PREFIX) => {
                    let key = &id[KEEP_AWAKE_ID_PREFIX.len()..];
                    match KeepAwakeMode::from_storage_key(key) {
                        Some(mode) => {
                            // Off the menu thread: acquiring the assertion is
                            // instant but persisting the choice touches disk.
                            let app = app_for_handler.clone();
                            std::thread::spawn(move || apply_keep_awake(&app, mode));
                        }
                        None => warn!(target: "power", %key, "unknown keep-awake menu id"),
                    }
                }
                "pause" => {
                    let was_paused = paused.load(Ordering::SeqCst);
                    let now_paused = !was_paused;
                    paused.store(now_paused, Ordering::SeqCst);
                    if let Some(item) = &pause_item {
                        let label = if now_paused {
                            "Resume hotkeys"
                        } else {
                            "Pause hotkeys"
                        };
                        if let Err(e) = item.set_text(label) {
                            warn!(?e, "failed to relabel pause menu item");
                        }
                    }
                    let state = last_state_for_handler
                        .lock()
                        .map(|g| *g)
                        .unwrap_or(TrayPipelineState::Idle);
                    let img = load_icon(&app_for_handler, state, now_paused);
                    if let Err(e) = icon.set_icon(Some(img)) {
                        warn!(?e, "failed to update tray icon after pause toggle");
                    }
                    info!(now_paused, "hotkeys pause toggled via tray");
                }
                _ => {}
            }
        });
    }

    /// Enable only the meeting action that is currently valid. Idempotent.
    /// Called from event listeners in `lib.rs` so the label tracks the true
    /// `MeetingManager` state regardless of who started/stopped the meeting
    /// (tray, MeetingsView button, auto-detect, hard-cap).
    pub fn set_meeting_active(&self, active: bool) {
        let start_item = self
            .meeting_start_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(item) = start_item {
            if let Err(e) = item.set_enabled(!active) {
                warn!(?e, "failed to update start meeting menu item");
            }
        }
        let stop_item = self
            .meeting_stop_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(item) = stop_item {
            if let Err(e) = item.set_enabled(active) {
                warn!(?e, "failed to update stop meeting menu item");
            }
        }
    }

    /// Enable the screen recording actions that are currently valid and flip
    /// the tray icon to red (Recording) or back to Idle.
    pub fn set_screenrec_active(&self, active: bool) {
        self.screenrec_active.store(active, Ordering::SeqCst);
        let start_item = self
            .screenrec_start_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(item) = start_item {
            if let Err(e) = item.set_enabled(!active) {
                warn!(?e, "failed to update start screen recording menu item");
            }
        }
        let stop_item = self
            .screenrec_stop_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(item) = stop_item {
            if let Err(e) = item.set_enabled(active) {
                warn!(?e, "failed to update stop screen recording menu item");
            }
        }
        // Enable/disable the Pause recording item alongside the recording state,
        // and reset its label to "Pause recording" whenever a recording starts
        // (a fresh recording is never paused). Greyed out when idle.
        let pause_item = self
            .screenrec_pause_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.clone()));
        if let Some(item) = pause_item {
            if let Err(e) = item.set_enabled(active) {
                warn!(?e, "failed to toggle screenrec pause item enabled state");
            }
            if active {
                if let Err(e) = item.set_text("Pause recording") {
                    warn!(?e, "failed to reset screenrec pause item label");
                }
            }
        }
        // Re-apply the icon. When turning ON, set_state honors screenrec_active
        // and forces Recording. When turning OFF, the flag is now false so the
        // icon reverts to the pipeline's current last_state. Read last_state and
        // drop its guard BEFORE calling set_state (which re-locks last_state) to
        // avoid a deadlock.
        let base = self
            .last_state
            .lock()
            .map(|g| *g)
            .unwrap_or(TrayPipelineState::Idle);
        self.set_state(base);
    }

    /// Relabel the Pause/Resume recording item to reflect the sidecar's paused
    /// state. `paused == true` → "Resume recording"; `false` → "Pause
    /// recording". Idempotent. Called from the tray handler and can be called
    /// from command paths if pause is ever triggered from the frontend.
    pub fn set_screenrec_paused(&self, paused: bool) {
        let item = self
            .screenrec_pause_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.clone()));
        if let Some(item) = item {
            let label = if paused {
                "Resume recording"
            } else {
                "Pause recording"
            };
            if let Err(e) = item.set_text(label) {
                warn!(?e, "failed to relabel screenrec pause item");
            }
        }
    }

    pub fn set_state(&self, state: TrayPipelineState) {
        if let Ok(mut g) = self.last_state.lock() {
            *g = state;
        }
        let paused = self
            .paused
            .lock()
            .ok()
            .map(|g| g.load(Ordering::SeqCst))
            .unwrap_or(false);
        // A live screen recording forces the red Recording icon regardless of
        // the pipeline state, so a dictation/meeting cycle ending in Idle does
        // not turn the icon idle while recording continues.
        let effective = if self.screenrec_active.load(Ordering::SeqCst) {
            TrayPipelineState::Recording
        } else {
            state
        };
        let app = self.icon.app_handle();
        let img = load_icon(app, effective, paused);
        if let Err(e) = self.icon.set_icon(Some(img)) {
            warn!(?e, "failed to update tray icon");
        }
    }
}

/// How often the ticker re-reads the keep-awake state. Also the worst-case
/// lateness of a timed hold's release, since `KeepAwake::status()` is what
/// actually expires it.
const KEEP_AWAKE_TICK: std::time::Duration = std::time::Duration::from_secs(10);

/// Engage/release keep awake, sync the menu to the result, and persist the
/// choice. Blocking (it saves settings) — call from a worker thread.
pub fn apply_keep_awake(app: &AppHandle<Wry>, mode: KeepAwakeMode) {
    let state = app.state::<AppState>();
    match state.keep_awake.set(mode) {
        Ok(status) => {
            if let Ok(t) = state.tray.lock() {
                t.set_keep_awake(status);
            }
            if let Err(e) = state.settings.set_keep_awake_mode(mode) {
                // The hold itself is live; only the memory of it is lost.
                warn!(target: "power", %e, ?mode, "failed to persist keep-awake mode");
            }
            info!(target: "power", ?mode, "keep awake set");
        }
        Err(e) => {
            error!(target: "power", %e, ?mode, "failed to change keep awake");
            // Re-sync the menu to the real state so the tick mark never
            // claims a hold we don't actually have.
            if let Ok(t) = state.tray.lock() {
                t.set_keep_awake(state.keep_awake.status());
            }
            let _ = app.emit(
                "asr:error",
                "Couldn't change Keep awake. See Settings → Diagnostics → logs for details."
                    .to_string(),
            );
        }
    }
}

/// Re-engage a persisted *indefinite* hold at launch and sync the menu.
///
/// A timed hold is deliberately not restored — its countdown belonged to the
/// previous session — but we still reset the store to `Off` so the menu and
/// the persisted value agree.
pub fn restore_keep_awake(app: &AppHandle<Wry>) {
    if !crate::power::is_supported() {
        return;
    }
    let state = app.state::<AppState>();
    match state.settings.keep_awake_mode() {
        KeepAwakeMode::Off => {}
        KeepAwakeMode::Indefinite => {
            info!(target: "power", "restoring indefinite keep awake from settings");
            apply_keep_awake(app, KeepAwakeMode::Indefinite);
        }
        KeepAwakeMode::Minutes(m) => {
            info!(
                target: "power",
                minutes = m,
                "not restoring timed keep awake — timed holds end with the session"
            );
            apply_keep_awake(app, KeepAwakeMode::Off);
        }
    }
}

/// Keep the "Keep awake: 42m left" label live, and — because
/// `KeepAwake::status()` expires a lapsed hold as a side effect — actually end
/// timed sessions. One ticker for the life of the app; a no-op read when off.
pub fn spawn_keep_awake_ticker(app: AppHandle<Wry>) {
    if !crate::power::is_supported() {
        return;
    }
    std::thread::spawn(move || {
        // Seed from the live state (an indefinite hold may already have been
        // restored) so the first tick isn't reported as a transition.
        let seed = app.state::<AppState>().keep_awake.status();
        let mut last_mode = seed.mode;
        let mut last_label = seed.menu_label();
        loop {
            std::thread::sleep(KEEP_AWAKE_TICK);
            let state = app.state::<AppState>();
            // Reads and expires in one step — this call is what ends a lapsed
            // timed hold, so don't call it twice per tick.
            let status = state.keep_awake.status();

            // Mirror an expiry into the store, so a restart doesn't think a
            // finished session is still the user's selection.
            if !last_mode.is_off() && status.mode.is_off() {
                if let Err(e) = state.settings.set_keep_awake_mode(KeepAwakeMode::Off) {
                    warn!(target: "power", %e, "failed to persist keep-awake expiry");
                }
            }
            last_mode = status.mode;

            let label = status.menu_label();
            if label != last_label {
                if let Ok(t) = state.tray.lock() {
                    t.set_keep_awake(status);
                }
                last_label = label;
            }
        }
    });
}

/// Bring the main window to the foreground (creating it if necessary). The
/// frontend listens for the `open_settings` event and routes itself when
/// triggered from the tray menu.
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    crate::ui::dock::set_dock_visible(true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        warn!("no main window to show from tray");
    }
}

/// Resolve the bundled PNG for the current state + system theme. Paused
/// reuses the idle glyph — template mode lets the OS handle visual muting,
/// and the menu label flip to "Resume hotkeys" already signals state.
fn load_icon<R: Runtime>(
    app: &AppHandle<R>,
    state: TrayPipelineState,
    paused: bool,
) -> Image<'static> {
    let dark_menu_bar = matches!(
        app.get_webview_window("main").and_then(|w| w.theme().ok()),
        Some(Theme::Dark)
    ) || app.get_webview_window("main").is_none();

    let effective_state = if paused {
        TrayPipelineState::Idle
    } else {
        state
    };

    let path = match (effective_state, dark_menu_bar) {
        (TrayPipelineState::Idle, true) => "resources/tray_idle.png",
        (TrayPipelineState::Idle, false) => "resources/tray_idle_dark.png",
        (TrayPipelineState::Recording, true) => "resources/tray_recording.png",
        (TrayPipelineState::Recording, false) => "resources/tray_recording_dark.png",
        (TrayPipelineState::Transcribing, true) => "resources/tray_transcribing.png",
        (TrayPipelineState::Transcribing, false) => "resources/tray_transcribing_dark.png",
        (TrayPipelineState::Thinking, true) => "resources/tray_thinking.png",
        (TrayPipelineState::Thinking, false) => "resources/tray_thinking_dark.png",
    };

    match app.path().resolve(path, BaseDirectory::Resource) {
        Ok(resolved) => match Image::from_path(&resolved) {
            Ok(img) => img,
            Err(e) => {
                warn!(
                    ?e,
                    ?resolved,
                    "failed to load tray icon, falling back to solid"
                );
                fallback_icon()
            }
        },
        Err(e) => {
            warn!(
                ?e,
                "failed to resolve tray icon path, falling back to solid"
            );
            fallback_icon()
        }
    }
}

/// Last-resort placeholder if a bundled PNG can't be loaded — keeps the
/// tray icon visible instead of vanishing.
fn fallback_icon() -> Image<'static> {
    let size = 16u32;
    let mut buf = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        buf.extend_from_slice(&[120, 120, 120, 255]);
    }
    let leaked: &'static [u8] = Box::leak(buf.into_boxed_slice());
    Image::new(leaked, size, size)
}
