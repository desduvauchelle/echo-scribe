use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, Theme, Wry};
use tracing::{info, warn};

use crate::commands::AppState;
use crate::coordinator::TrayPipelineState;

/// Owned by the app for its full lifetime. Holds the tray icon plus the
/// menu items we need to mutate (Pause/Resume label flips between modes).
pub struct TrayHandle<R: Runtime> {
    icon: TrayIcon<R>,
    /// The Pause/Resume toggle item — relabelled when the user flips the
    /// pause state via the menu.
    pause_item: Mutex<Option<MenuItem<R>>>,
    /// The Start/Stop meeting toggle item — relabelled when a meeting begins
    /// or ends (via tray, MeetingsView button, auto-detect, or hard-cap).
    meeting_item: Mutex<Option<MenuItem<R>>>,
    /// The Start/Stop screen recording toggle item — relabelled when a
    /// screen recording begins or ends.
    screenrec_item: Mutex<Option<MenuItem<R>>>,
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
        let meeting =
            MenuItem::with_id(app, "meeting", "Start meeting", true, None::<&str>)?;
        let screenrec =
            MenuItem::with_id(app, "screenrec", "Start screen recording", true, None::<&str>)?;
        let pause = MenuItem::with_id(app, "pause", "Pause hotkeys", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
        let sep1 = PredefinedMenuItem::separator(app)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Echo Scribe", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[&open, &sep1, &meeting, &screenrec, &pause, &settings, &sep2, &quit],
        )?;

        let pause_for_handle = pause.clone();
        let meeting_for_handle = meeting.clone();
        let screenrec_for_handle = screenrec.clone();
        let icon = TrayIconBuilder::new()
            .menu(&menu)
            .icon(load_icon(app, TrayPipelineState::Idle, false))
            .icon_as_template(true)
            .build(app)?;

        Ok(TrayHandle {
            icon,
            pause_item: Mutex::new(Some(pause_for_handle)),
            meeting_item: Mutex::new(Some(meeting_for_handle)),
            screenrec_item: Mutex::new(Some(screenrec_for_handle)),
            last_state: Mutex::new(TrayPipelineState::Idle),
            paused: Mutex::new(Arc::new(AtomicBool::new(false))),
            screenrec_active: AtomicBool::new(false),
        })
    }

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
            self.last_state.lock().map(|g| *g).unwrap_or(TrayPipelineState::Idle),
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
                "meeting" => {
                    let app = app_for_handler.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let manager = state.meeting_manager.clone();
                        if manager.is_active().await {
                            if let Err(e) = manager.stop().await {
                                warn!(?e, "tray: stop_meeting failed");
                                let _ = app.emit(
                                    "meeting-action-error",
                                    e.to_string(),
                                );
                            } else {
                                info!("meeting stopped via tray");
                            }
                        } else {
                            let start_ctx = {
                                let ctx = crate::input::focus::capture_context();
                                crate::meeting::MeetingStartContext {
                                    window_title: ctx.as_ref().and_then(|c| c.window_title.clone()),
                                    browser_url: ctx.as_ref().and_then(|c| c.browser_url.clone()),
                                    browser_tab_title: ctx
                                        .as_ref()
                                        .and_then(|c| c.browser_tab_title.clone()),
                                    calendar_match: None,
                                    guide_template: None,
                                }
                            };
                            match manager.clone().start(None, None, start_ctx).await {
                                Ok(id) => {
                                    info!(%id, "meeting started via tray");
                                    crate::meeting::detector::spawn_end_monitor(manager, None);
                                }
                                Err(e) => {
                                    warn!(?e, "tray: start_meeting failed");
                                    let _ = app.emit(
                                        "meeting-action-error",
                                        e.to_string(),
                                    );
                                }
                            }
                        }
                    });
                }
                "screenrec" => {
                    let app = app_for_handler.clone();
                    let state = app.state::<AppState>();
                    let recording = state
                        .active_recording
                        .lock()
                        .map(|g| g.is_some())
                        .unwrap_or(false);
                    if recording {
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            let st = app2.state::<AppState>();
                            match crate::commands::stop_screen_recording_inner(&st) {
                                Ok(_) => {
                                    if let Ok(t) = st.tray.lock() {
                                        t.set_screenrec_active(false);
                                    }
                                    let _ = app2.emit("screenrec-changed", ());
                                }
                                Err(e) => {
                                    tracing::warn!(%e, "tray stop screenrec failed");
                                }
                            }
                        });
                    } else {
                        crate::overlay::show_screenrec_setup(&app);
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

    /// Update the "Start meeting" / "Stop meeting" label. Idempotent.
    /// Called from event listeners in `lib.rs` so the label tracks the true
    /// `MeetingManager` state regardless of who started/stopped the meeting
    /// (tray, MeetingsView button, auto-detect, hard-cap).
    pub fn set_meeting_active(&self, active: bool) {
        let item = self
            .meeting_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.clone()));
        if let Some(item) = item {
            let label = if active { "Stop meeting" } else { "Start meeting" };
            if let Err(e) = item.set_text(label) {
                warn!(?e, "failed to relabel meeting menu item");
            }
        }
    }

    /// Update the "Start screen recording" / "Stop screen recording" label
    /// and flip the tray icon to red (Recording) or back to Idle.
    pub fn set_screenrec_active(&self, active: bool) {
        self.screenrec_active.store(active, Ordering::SeqCst);
        let item = self
            .screenrec_item
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.clone()));
        if let Some(item) = item {
            let label = if active { "Stop screen recording" } else { "Start screen recording" };
            if let Err(e) = item.set_text(label) {
                warn!(?e, "failed to relabel screenrec menu item");
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
        (TrayPipelineState::Processing, true) => "resources/tray_transcribing.png",
        (TrayPipelineState::Processing, false) => "resources/tray_transcribing_dark.png",
    };

    match app.path().resolve(path, BaseDirectory::Resource) {
        Ok(resolved) => match Image::from_path(&resolved) {
            Ok(img) => img,
            Err(e) => {
                warn!(?e, ?resolved, "failed to load tray icon, falling back to solid");
                fallback_icon()
            }
        },
        Err(e) => {
            warn!(?e, "failed to resolve tray icon path, falling back to solid");
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
