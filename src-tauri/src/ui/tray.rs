use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{
    CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::path::BaseDirectory;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tracing::{error, info, warn};

use crate::commands::AppState;
use crate::coordinator::TrayPipelineState;
use crate::power::{KeepAwakeMode, KeepAwakeStatus, KEEP_AWAKE_OPTIONS};
use crate::ui::tray_compose::{
    self, Activity, ACTIVITY_KNOCKOUT, AWAKE_KNOCKOUT, ICON_SIZE,
};

/// Prefix for every "Keep awake" menu item id. The suffix is the mode's
/// `storage_key`, so `keep_awake:off`, `keep_awake:indefinite`, `keep_awake:30`.
const KEEP_AWAKE_ID_PREFIX: &str = "keep_awake:";

/// Owned by the app for its full lifetime. Holds the tray icon plus the
/// state the menu is derived from.
///
/// The menu is REBUILT from scratch (see `menu_plan`) whenever its structure
/// changes — a live recording/meeting hoists its stop action to the top and
/// hides its start action entirely, rather than greying things out. Only the
/// keep-awake submenu is mutated in place between rebuilds, because its
/// countdown label ticks once a minute and rebuilding a menu the user may be
/// looking at would be disruptive.
pub struct TrayHandle<R: Runtime> {
    icon: TrayIcon<R>,
    /// The "Keep awake" parent row. Relabelled to carry the current state
    /// ("Keep awake: 42m left") so it's readable without opening the submenu.
    /// `None` on platforms where `power::is_supported()` is false — there we
    /// omit the submenu entirely rather than offer a no-op. Replaced with
    /// fresh handles on every menu rebuild.
    keep_awake_menu: Mutex<Option<Submenu<R>>>,
    /// Every keep-awake option paired with its check item, so exactly one can
    /// be ticked. Ordered `Off` first, then `KEEP_AWAKE_OPTIONS`. Replaced on
    /// every menu rebuild.
    keep_awake_items: Mutex<Vec<(KeepAwakeMode, CheckMenuItem<R>)>>,
    /// Last keep-awake status, so a menu rebuild can reproduce the current
    /// checkmark + parent label without reaching into `AppState`.
    keep_awake_status: Mutex<KeepAwakeStatus>,
    /// Last applied pipeline state, so we can re-apply the right icon when
    /// the user toggles "Paused" on/off without losing the underlying state.
    last_state: Mutex<TrayPipelineState>,
    /// Mirrors `AppState.paused_hotkeys` for icon decisions.
    paused: Mutex<Arc<AtomicBool>>,
    /// Whether a screen recording is currently active. Independent of the
    /// pipeline `last_state` so a dictation/meeting cycle ending in Idle does
    /// not clobber the red recording badge. Takes precedence in the icon's
    /// activity-badge priority.
    screenrec_active: AtomicBool,
    /// Whether the active screen recording is paused — drives the
    /// Pause/Resume recording label on rebuild.
    screenrec_paused: AtomicBool,
    /// Whether a meeting recording is active — shows the meeting badge while
    /// no higher-priority activity is running.
    meeting_active: AtomicBool,
    /// Whether a keep-awake power assertion is held — shows the top-right
    /// awake badge regardless of activity.
    awake_active: AtomicBool,
}

impl<R: Runtime> TrayHandle<R> {
    pub fn install(app: &AppHandle<R>) -> tauri::Result<TrayHandle<R>> {
        // Nothing is active at install; `restore_keep_awake` and the state
        // listeners rebuild with the real state right after setup.
        let initial = MenuState {
            keep_awake_supported: crate::power::is_supported(),
            ..MenuState::default()
        };
        let status = KeepAwakeStatus {
            mode: KeepAwakeMode::Off,
            remaining_secs: None,
        };
        let built = build_menu(app, &initial, &status)?;

        let icon = TrayIconBuilder::new()
            .menu(&built.menu)
            .icon(load_idle_icon(app))
            .icon_as_template(true)
            .build(app)?;

        Ok(TrayHandle {
            icon,
            keep_awake_menu: Mutex::new(built.keep_awake_menu),
            keep_awake_items: Mutex::new(built.keep_awake_items),
            keep_awake_status: Mutex::new(status),
            last_state: Mutex::new(TrayPipelineState::Idle),
            paused: Mutex::new(Arc::new(AtomicBool::new(false))),
            screenrec_active: AtomicBool::new(false),
            screenrec_paused: AtomicBool::new(false),
            meeting_active: AtomicBool::new(false),
            awake_active: AtomicBool::new(false),
        })
    }

    /// Rebuild the dropdown from current state and swap it onto the tray
    /// icon. Called whenever the menu STRUCTURE changes (recording/meeting
    /// start/stop, pause toggles) — label-only ticks (keep-awake countdown)
    /// keep mutating items in place instead. Safe from any thread; menu
    /// construction hops to the main thread internally. Do not call while
    /// holding the tray lock ON the main thread (see `bind_menu`'s pause
    /// branch).
    pub fn rebuild_menu(&self) {
        let state = MenuState {
            screenrec_active: self.screenrec_active.load(Ordering::SeqCst),
            screenrec_paused: self.screenrec_paused.load(Ordering::SeqCst),
            meeting_active: self.meeting_active.load(Ordering::SeqCst),
            hotkeys_paused: self
                .paused
                .lock()
                .ok()
                .map(|g| g.load(Ordering::SeqCst))
                .unwrap_or(false),
            keep_awake_supported: crate::power::is_supported(),
        };
        let status = self
            .keep_awake_status
            .lock()
            .map(|g| *g)
            .unwrap_or(KeepAwakeStatus {
                mode: KeepAwakeMode::Off,
                remaining_secs: None,
            });
        let app = self.icon.app_handle();
        match build_menu(app, &state, &status) {
            Ok(built) => {
                if let Err(e) = self.icon.set_menu(Some(built.menu)) {
                    warn!(target: "tray", ?e, "failed to swap tray menu");
                    return;
                }
                // Store the fresh keep-awake handles so the ticker keeps
                // relabelling the menu that is actually installed.
                if let Ok(mut g) = self.keep_awake_menu.lock() {
                    *g = built.keep_awake_menu;
                }
                if let Ok(mut g) = self.keep_awake_items.lock() {
                    *g = built.keep_awake_items;
                }
            }
            Err(e) => warn!(target: "tray", ?e, "failed to rebuild tray menu"),
        }
    }

    /// Recompute and apply the composite menu bar icon from the full current
    /// state (pipeline, screen recording, meeting, keep-awake, paused). With
    /// no badge to show, the icon reverts to the plain template logo so macOS
    /// keeps adapting it to the menu bar theme; with any badge it switches to
    /// a colored composite (template off).
    pub fn refresh_icon(&self) {
        let paused = self
            .paused
            .lock()
            .ok()
            .map(|g| g.load(Ordering::SeqCst))
            .unwrap_or(false);
        let pipeline = self
            .last_state
            .lock()
            .map(|g| *g)
            .unwrap_or(TrayPipelineState::Idle);
        let screenrec = self.screenrec_active.load(Ordering::SeqCst);
        let meeting = self.meeting_active.load(Ordering::SeqCst);
        let awake = self.awake_active.load(Ordering::SeqCst);
        let activity = tray_compose::activity_for(pipeline, screenrec, meeting, paused);

        let app = self.icon.app_handle();
        let (img, template) = if activity.is_none() && !awake {
            (load_idle_icon(app), true)
        } else {
            match compose_state_icon(app, activity, awake) {
                Some(img) => (img, false),
                // Composition failed (asset missing/corrupt) — fall back to
                // the plain template logo so the icon never vanishes. The
                // failure itself was already logged at the load site.
                None => (load_idle_icon(app), true),
            }
        };
        if let Err(e) = self.icon.set_icon(Some(img)) {
            warn!(target: "tray", ?e, "failed to update tray icon");
        }
        if let Err(e) = self.icon.set_icon_as_template(template) {
            warn!(target: "tray", ?e, template, "failed to toggle tray icon template mode");
        }
    }

    /// Tick exactly one option and relabel the parent row. Idempotent, and
    /// safe to call from any thread (menu mutations hop to the main thread).
    /// Also drives the top-right awake badge on the icon — refreshed only on
    /// an actual on/off flip, since the ticker calls this once a minute just
    /// to update the countdown label.
    pub fn set_keep_awake(&self, status: KeepAwakeStatus) {
        if let Ok(mut g) = self.keep_awake_status.lock() {
            *g = status;
        }
        let awake = !status.mode.is_off();
        if self.awake_active.swap(awake, Ordering::SeqCst) != awake {
            self.refresh_icon();
        }
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
/// `KEEP_AWAKE_OPTIONS`, with the row matching `status` ticked and the parent
/// label carrying the current state. Returns the submenu plus the
/// (mode, item) pairs so the ticker can keep mutating the live menu.
#[allow(clippy::type_complexity)]
fn build_keep_awake_menu<R: Runtime>(
    app: &AppHandle<R>,
    status: &KeepAwakeStatus,
) -> tauri::Result<(Submenu<R>, Vec<(KeepAwakeMode, CheckMenuItem<R>)>)> {
    let mut items: Vec<(KeepAwakeMode, CheckMenuItem<R>)> = Vec::new();
    for mode in std::iter::once(KeepAwakeMode::Off).chain(KEEP_AWAKE_OPTIONS.iter().copied()) {
        let item = CheckMenuItem::with_id(
            app,
            format!("{KEEP_AWAKE_ID_PREFIX}{}", mode.storage_key()),
            mode.menu_label(),
            true,
            mode == status.mode,
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

    let submenu =
        Submenu::with_id_and_items(app, "keep_awake", status.menu_label(), true, &refs)?;
    Ok((submenu, items))
}

/// The state the dropdown structure is derived from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct MenuState {
    screenrec_active: bool,
    screenrec_paused: bool,
    meeting_active: bool,
    hotkeys_paused: bool,
    keep_awake_supported: bool,
}

/// One row of the dropdown, as data. `menu_plan` is the single source of
/// truth for the menu's structure and ordering, kept pure so the logic is
/// unit-testable without a running app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuEntry {
    /// "Stop screen recording" with the red disc icon — hoisted to the top
    /// while a recording runs.
    StopScreenrec,
    /// "Pause recording" / "Resume recording", directly under its stop row.
    PauseRecording { paused: bool },
    /// "Stop meeting" with the cyan disc icon — hoisted to the top while a
    /// meeting runs.
    StopMeeting,
    Separator,
    Open,
    StartMeeting,
    StartScreenrec,
    LastTranscript,
    PauseHotkeys { paused: bool },
    KeepAwake,
    Settings,
    Quit,
}

/// Derive the dropdown rows: live activities surface their stop actions at
/// the very top (the thing you most likely opened the menu for), start
/// actions exist only while they're actually possible, and app-level rows
/// stay in a stable order below so nothing jumps around unexpectedly.
fn menu_plan(s: &MenuState) -> Vec<MenuEntry> {
    let mut plan = Vec::with_capacity(12);
    if s.screenrec_active {
        plan.push(MenuEntry::StopScreenrec);
        plan.push(MenuEntry::PauseRecording {
            paused: s.screenrec_paused,
        });
    }
    if s.meeting_active {
        plan.push(MenuEntry::StopMeeting);
    }
    if !plan.is_empty() {
        plan.push(MenuEntry::Separator);
    }
    plan.push(MenuEntry::Open);
    plan.push(MenuEntry::Separator);
    if !s.meeting_active {
        plan.push(MenuEntry::StartMeeting);
    }
    if !s.screenrec_active {
        plan.push(MenuEntry::StartScreenrec);
    }
    plan.push(MenuEntry::LastTranscript);
    plan.push(MenuEntry::Separator);
    plan.push(MenuEntry::PauseHotkeys {
        paused: s.hotkeys_paused,
    });
    if s.keep_awake_supported {
        plan.push(MenuEntry::KeepAwake);
    }
    plan.push(MenuEntry::Settings);
    plan.push(MenuEntry::Separator);
    plan.push(MenuEntry::Quit);
    plan
}

/// A freshly built dropdown plus the keep-awake handles that stay mutable
/// between rebuilds.
struct BuiltMenu<R: Runtime> {
    menu: Menu<R>,
    keep_awake_menu: Option<Submenu<R>>,
    keep_awake_items: Vec<(KeepAwakeMode, CheckMenuItem<R>)>,
}

/// Render a `menu_plan` into real menu items. Item ids are stable across
/// rebuilds — the single global menu-event handler registered in `bind_menu`
/// matches on ids, so swapped-in menus keep working without rebinding.
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &MenuState,
    keep_awake: &KeepAwakeStatus,
) -> tauri::Result<BuiltMenu<R>> {
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    let mut keep_awake_menu = None;
    let mut keep_awake_items = Vec::new();

    for entry in menu_plan(state) {
        match entry {
            MenuEntry::StopScreenrec => items.push(Box::new(IconMenuItem::with_id(
                app,
                "screenrec_stop",
                "Stop screen recording",
                true,
                menu_icon(app, "resources/menu_stop_screenrec.png"),
                None::<&str>,
            )?)),
            MenuEntry::PauseRecording { paused } => {
                let label = if paused {
                    "Resume recording"
                } else {
                    "Pause recording"
                };
                items.push(Box::new(MenuItem::with_id(
                    app,
                    "screenrec_pause",
                    label,
                    true,
                    None::<&str>,
                )?));
            }
            MenuEntry::StopMeeting => items.push(Box::new(IconMenuItem::with_id(
                app,
                "meeting_stop",
                "Stop meeting",
                true,
                menu_icon(app, "resources/menu_stop_meeting.png"),
                None::<&str>,
            )?)),
            MenuEntry::Separator => items.push(Box::new(PredefinedMenuItem::separator(app)?)),
            MenuEntry::Open => items.push(Box::new(MenuItem::with_id(
                app,
                "open",
                "Open Echo Scribe",
                true,
                None::<&str>,
            )?)),
            MenuEntry::StartMeeting => items.push(Box::new(MenuItem::with_id(
                app,
                "meeting_start",
                "Start meeting",
                true,
                None::<&str>,
            )?)),
            MenuEntry::StartScreenrec => items.push(Box::new(MenuItem::with_id(
                app,
                "screenrec_start",
                "Start screen recording",
                true,
                None::<&str>,
            )?)),
            MenuEntry::LastTranscript => {
                let copy_last = MenuItem::with_id(
                    app,
                    "copy_last",
                    "Copy last transcript",
                    true,
                    None::<&str>,
                )?;
                let paste_last = MenuItem::with_id(
                    app,
                    "paste_last",
                    "Paste last transcript",
                    true,
                    None::<&str>,
                )?;
                items.push(Box::new(Submenu::with_id_and_items(
                    app,
                    "last_transcript",
                    "Last transcript",
                    true,
                    &[&copy_last, &paste_last],
                )?));
            }
            MenuEntry::PauseHotkeys { paused } => {
                let label = if paused {
                    "Resume hotkeys"
                } else {
                    "Pause hotkeys"
                };
                items.push(Box::new(MenuItem::with_id(
                    app,
                    "pause",
                    label,
                    true,
                    None::<&str>,
                )?));
            }
            MenuEntry::KeepAwake => {
                let (submenu, ka_items) = build_keep_awake_menu(app, keep_awake)?;
                items.push(Box::new(submenu.clone()));
                keep_awake_menu = Some(submenu);
                keep_awake_items = ka_items;
            }
            MenuEntry::Settings => items.push(Box::new(MenuItem::with_id(
                app,
                "settings",
                "Settings…",
                true,
                None::<&str>,
            )?)),
            MenuEntry::Quit => items.push(Box::new(MenuItem::with_id(
                app,
                "quit",
                "Quit Echo Scribe",
                true,
                None::<&str>,
            )?)),
        }
    }

    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    Ok(BuiltMenu {
        menu,
        keep_awake_menu,
        keep_awake_items,
    })
}

/// Load a bundled PNG as a menu-item icon. macOS renders menu icons at 18pt
/// (muda scales them down), so the 64px asset stays crisp on retina. `None`
/// on failure — the item still works, it just loses its colored disc.
fn menu_icon<R: Runtime>(app: &AppHandle<R>, path: &str) -> Option<Image<'static>> {
    load_resource_rgba(app, path).map(|rgba| Image::new_owned(rgba, ICON_SIZE, ICON_SIZE))
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
        let app_for_handler = app.clone();
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
                                    // The active-recording state is torn down even on
                                    // failure (e.g. the zero-frame "nothing was
                                    // captured" path) — flip the tray back to idle,
                                    // let the UI reconcile, and surface the friendly
                                    // message as a toast.
                                    if let Ok(t) = st.tray.lock() {
                                        t.set_screenrec_active(false);
                                    }
                                    let _ = app.emit("screenrec-changed", ());
                                    let _ = app.emit(
                                        "screenrec-warning",
                                        serde_json::json!({ "message": e }),
                                    );
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
                    // Recompute the icon and the menu (its Pause/Resume label
                    // comes from the rebuild) through the handle. Off the
                    // menu thread: taking the tray lock on the main thread
                    // could deadlock against a worker that holds it while
                    // its icon/menu update dispatches back to main.
                    let app = app_for_handler.clone();
                    std::thread::spawn(move || {
                        let tray = app.state::<AppState>().tray.clone();
                        if let Ok(t) = tray.lock() {
                            t.refresh_icon();
                            t.rebuild_menu();
                        };
                    });
                    info!(now_paused, "hotkeys pause toggled via tray");
                }
                _ => {}
            }
        });
    }

    /// Show/clear the meeting badge on the icon and rebuild the dropdown
    /// ("Stop meeting" hoisted to the top while active, "Start meeting"
    /// otherwise). Idempotent. Called from event listeners in `lib.rs` so
    /// the menu tracks the true `MeetingManager` state regardless of who
    /// started/stopped the meeting (tray, MeetingsView button, auto-detect,
    /// hard-cap).
    pub fn set_meeting_active(&self, active: bool) {
        if self.meeting_active.swap(active, Ordering::SeqCst) != active {
            self.refresh_icon();
            self.rebuild_menu();
        }
    }

    /// Flip the screen recording state: updates the icon badge and rebuilds
    /// the dropdown ("Stop screen recording" + "Pause recording" hoisted to
    /// the top while recording, "Start screen recording" otherwise).
    pub fn set_screenrec_active(&self, active: bool) {
        // A fresh recording is never paused; clear the flag on every flip so
        // a stale "Resume recording" label can't survive into the next run.
        self.screenrec_paused.store(false, Ordering::SeqCst);
        self.screenrec_active.store(active, Ordering::SeqCst);
        // Re-apply the icon: turning ON forces the screen recording badge
        // (highest priority); turning OFF lets it fall back to whatever the
        // pipeline/meeting state currently is.
        self.refresh_icon();
        self.rebuild_menu();
    }

    /// Reflect the sidecar's paused state in the dropdown: the row under
    /// "Stop screen recording" reads "Resume recording" while paused,
    /// "Pause recording" while running. Idempotent.
    pub fn set_screenrec_paused(&self, paused: bool) {
        if self.screenrec_paused.swap(paused, Ordering::SeqCst) != paused {
            self.rebuild_menu();
        }
    }

    pub fn set_state(&self, state: TrayPipelineState) {
        if let Ok(mut g) = self.last_state.lock() {
            *g = state;
        }
        self.refresh_icon();
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

/// Load a bundled tray asset as raw RGBA. Returns `None` (with a log) when
/// the file is missing/corrupt or isn't the expected 64x64.
fn load_resource_rgba<R: Runtime>(app: &AppHandle<R>, path: &str) -> Option<Vec<u8>> {
    let resolved = match app.path().resolve(path, BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            warn!(target: "tray", ?e, path, "failed to resolve tray asset path");
            return None;
        }
    };
    match Image::from_path(&resolved) {
        Ok(img) if img.width() == ICON_SIZE && img.height() == ICON_SIZE => {
            Some(img.rgba().to_vec())
        }
        Ok(img) => {
            warn!(
                target: "tray",
                path,
                width = img.width(),
                height = img.height(),
                "tray asset has unexpected dimensions, skipping"
            );
            None
        }
        Err(e) => {
            warn!(target: "tray", ?e, ?resolved, "failed to load tray asset");
            None
        }
    }
}

/// Build the colored composite: brand-green logo base, a knockout hole under
/// each badge, then the badge discs on top. Rendered fresh per state change —
/// decoding three 64x64 PNGs is far below perceptibility, and state changes
/// are rare.
fn compose_state_icon<R: Runtime>(
    app: &AppHandle<R>,
    activity: Option<Activity>,
    awake: bool,
) -> Option<Image<'static>> {
    let mut base = load_resource_rgba(app, "resources/tray_logo_active.png")?;
    if activity.is_some() {
        tray_compose::punch(&mut base, ICON_SIZE, ACTIVITY_KNOCKOUT);
    }
    if awake {
        tray_compose::punch(&mut base, ICON_SIZE, AWAKE_KNOCKOUT);
    }
    if let Some(activity) = activity {
        let badge = load_resource_rgba(app, activity.badge_resource())?;
        tray_compose::over(&mut base, &badge);
    }
    if awake {
        let badge = load_resource_rgba(app, "resources/tray_badge_awake.png")?;
        tray_compose::over(&mut base, &badge);
    }
    Some(Image::new_owned(base, ICON_SIZE, ICON_SIZE))
}

/// The plain template logo shown when nothing is happening. macOS derives
/// the glyph from the alpha channel and matches it to the menu bar theme.
fn load_idle_icon<R: Runtime>(app: &AppHandle<R>) -> Image<'static> {
    match load_resource_rgba(app, "resources/tray_idle.png") {
        Some(rgba) => Image::new_owned(rgba, ICON_SIZE, ICON_SIZE),
        None => fallback_icon(),
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

#[cfg(test)]
mod menu_plan_tests {
    use super::*;

    fn idle() -> MenuState {
        MenuState {
            keep_awake_supported: true,
            ..MenuState::default()
        }
    }

    #[test]
    fn idle_menu_has_start_actions_and_no_stop_rows() {
        let plan = menu_plan(&idle());
        assert_eq!(plan[0], MenuEntry::Open, "nothing active → Open leads");
        assert!(plan.contains(&MenuEntry::StartMeeting));
        assert!(plan.contains(&MenuEntry::StartScreenrec));
        assert!(!plan.contains(&MenuEntry::StopScreenrec));
        assert!(!plan.contains(&MenuEntry::StopMeeting));
        assert!(plan.contains(&MenuEntry::KeepAwake));
        assert_eq!(plan.last(), Some(&MenuEntry::Quit));
    }

    #[test]
    fn live_screen_recording_hoists_stop_and_pause() {
        let plan = menu_plan(&MenuState {
            screenrec_active: true,
            ..idle()
        });
        assert_eq!(
            &plan[..3],
            &[
                MenuEntry::StopScreenrec,
                MenuEntry::PauseRecording { paused: false },
                MenuEntry::Separator,
            ]
        );
        assert!(!plan.contains(&MenuEntry::StartScreenrec));
        assert!(plan.contains(&MenuEntry::StartMeeting), "meeting still startable");
    }

    #[test]
    fn paused_recording_offers_resume() {
        let plan = menu_plan(&MenuState {
            screenrec_active: true,
            screenrec_paused: true,
            ..idle()
        });
        assert!(plan.contains(&MenuEntry::PauseRecording { paused: true }));
    }

    #[test]
    fn live_meeting_hoists_stop_and_hides_start() {
        let plan = menu_plan(&MenuState {
            meeting_active: true,
            ..idle()
        });
        assert_eq!(&plan[..2], &[MenuEntry::StopMeeting, MenuEntry::Separator]);
        assert!(!plan.contains(&MenuEntry::StartMeeting));
        assert!(plan.contains(&MenuEntry::StartScreenrec), "screenrec still startable");
    }

    #[test]
    fn both_active_stacks_stop_rows_with_no_start_actions() {
        let plan = menu_plan(&MenuState {
            screenrec_active: true,
            meeting_active: true,
            ..idle()
        });
        assert_eq!(
            &plan[..4],
            &[
                MenuEntry::StopScreenrec,
                MenuEntry::PauseRecording { paused: false },
                MenuEntry::StopMeeting,
                MenuEntry::Separator,
            ]
        );
        assert!(!plan.contains(&MenuEntry::StartMeeting));
        assert!(!plan.contains(&MenuEntry::StartScreenrec));
    }

    #[test]
    fn hotkeys_paused_flips_the_toggle_label() {
        let plan = menu_plan(&MenuState {
            hotkeys_paused: true,
            ..idle()
        });
        assert!(plan.contains(&MenuEntry::PauseHotkeys { paused: true }));
    }

    #[test]
    fn keep_awake_row_absent_when_unsupported() {
        let plan = menu_plan(&MenuState::default());
        assert!(!plan.contains(&MenuEntry::KeepAwake));
    }

    #[test]
    fn separators_never_double_up_or_dangle() {
        for state in [
            MenuState::default(),
            idle(),
            MenuState { screenrec_active: true, ..idle() },
            MenuState { meeting_active: true, ..idle() },
            MenuState { screenrec_active: true, meeting_active: true, ..idle() },
        ] {
            let plan = menu_plan(&state);
            assert_ne!(plan.first(), Some(&MenuEntry::Separator));
            assert_ne!(plan.last(), Some(&MenuEntry::Separator));
            for pair in plan.windows(2) {
                assert!(
                    !(pair[0] == MenuEntry::Separator && pair[1] == MenuEntry::Separator),
                    "double separator in {state:?}: {plan:?}"
                );
            }
        }
    }
}
