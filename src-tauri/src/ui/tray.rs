use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::{info, warn};

use crate::coordinator::TrayPipelineState;

/// Owned by the app for its full lifetime. Holds the tray icon plus the
/// menu items we need to mutate (Pause/Resume label flips between modes).
pub struct TrayHandle<R: Runtime> {
    icon: TrayIcon<R>,
    /// The Pause/Resume toggle item — relabelled when the user flips the
    /// pause state via the menu.
    pause_item: Mutex<Option<MenuItem<R>>>,
    /// Last applied pipeline state, so we can re-apply the right icon when
    /// the user toggles "Paused" on/off without losing the underlying state.
    last_state: Mutex<TrayPipelineState>,
    /// Mirrors `AppState.paused_hotkeys` for icon decisions.
    paused: Mutex<Arc<AtomicBool>>,
}

impl<R: Runtime> TrayHandle<R> {
    pub fn install(app: &AppHandle<R>) -> tauri::Result<TrayHandle<R>> {
        let open = MenuItem::with_id(app, "open", "Open Echo Scribe", true, None::<&str>)?;
        let pause = MenuItem::with_id(app, "pause", "Pause hotkeys", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
        let sep1 = PredefinedMenuItem::separator(app)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Echo Scribe", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[&open, &sep1, &pause, &settings, &sep2, &quit],
        )?;

        let pause_for_handle = pause.clone();
        let icon = TrayIconBuilder::new()
            .menu(&menu)
            .icon(idle_icon())
            .build(app)?;

        Ok(TrayHandle {
            icon,
            pause_item: Mutex::new(Some(pause_for_handle)),
            last_state: Mutex::new(TrayPipelineState::Idle),
            paused: Mutex::new(Arc::new(AtomicBool::new(false))),
        })
    }

    /// Wire the menu-event handler. Called from `lib.rs::run` after the
    /// managed `AppState` (and its `paused_hotkeys` atomic) exists.
    pub fn bind_menu(&self, app: &AppHandle<R>, paused: Arc<AtomicBool>) {
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
                    // Re-apply the icon: when paused we tint everything to
                    // the "muted" gray so the menu bar reflects the state.
                    let state = last_state_for_handler
                        .lock()
                        .map(|g| *g)
                        .unwrap_or(TrayPipelineState::Idle);
                    let img = icon_for(state, now_paused);
                    if let Err(e) = icon.set_icon(Some(img)) {
                        warn!(?e, "failed to update tray icon after pause toggle");
                    }
                    info!(now_paused, "hotkeys pause toggled via tray");
                }
                _ => {}
            }
        });
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
        let img = icon_for(state, paused);
        if let Err(e) = self.icon.set_icon(Some(img)) {
            warn!(?e, "failed to update tray icon");
        }
    }
}

/// Bring the main window to the foreground (creating it if necessary). The
/// frontend listens for the `open_settings` event and routes itself when
/// triggered from the tray menu.
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        warn!("no main window to show from tray");
    }
}

/// Map a (state, paused) pair to the right tray icon. When paused, every
/// state collapses to a darker-gray "muted" tint so the menu bar reflects
/// that hotkeys are off — independent of whether the coordinator is mid-run.
fn icon_for(state: TrayPipelineState, paused: bool) -> Image<'static> {
    if paused {
        return paused_icon();
    }
    match state {
        TrayPipelineState::Idle => idle_icon(),
        TrayPipelineState::Recording => recording_icon(),
        TrayPipelineState::Processing => processing_icon(),
    }
}

/// Solid-color 16x16 RGBA icon. Phase 0 uses flat colors as placeholders;
/// Phase 6 swaps these for designed assets. The buffer is leaked into
/// 'static memory because tray icons live for the full app lifetime — there
/// are exactly four of these (one per state + paused) and no need to free
/// them.
fn solid_color_icon(r: u8, g: u8, b: u8) -> Image<'static> {
    let size = 16u32;
    let mut buf = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        buf.extend_from_slice(&[r, g, b, 255]);
    }
    let leaked: &'static [u8] = Box::leak(buf.into_boxed_slice());
    Image::new(leaked, size, size)
}

fn idle_icon() -> Image<'static> {
    solid_color_icon(120, 120, 120)
}
fn recording_icon() -> Image<'static> {
    solid_color_icon(220, 50, 50)
}
fn processing_icon() -> Image<'static> {
    solid_color_icon(220, 180, 50)
}
fn paused_icon() -> Image<'static> {
    solid_color_icon(60, 60, 60)
}
