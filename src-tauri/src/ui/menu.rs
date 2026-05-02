//! Native macOS app menu bar.
//!
//! Provides the standard set of items expected from a Mac app — App menu
//! (About, Settings, Hide, Quit), Edit (so Undo/Cut/Copy/Paste keyboard
//! shortcuts work in text inputs), View (Refresh), and Window. Custom items
//! emit Tauri events the frontend listens for.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::warn;

const APP_NAME: &str = "Echo Scribe";

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let about_meta = AboutMetadata {
        name: Some(APP_NAME.into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    };

    let settings = MenuItem::with_id(
        app,
        "menu:settings",
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let app_submenu = Submenu::with_items(
        app,
        APP_NAME,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(APP_NAME), Some(about_meta))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let refresh = MenuItem::with_id(app, "menu:refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;
    let view_submenu = Submenu::with_items(app, "View", true, &[&refresh])?;

    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_submenu, &edit_submenu, &view_submenu, &window_submenu],
    )?;
    app.set_menu(menu)?;

    let handle = app.clone();
    app.on_menu_event(move |_app, event| match event.id().as_ref() {
        "menu:settings" => {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Err(e) = handle.emit("open_settings", ()) {
                warn!(?e, "failed to emit open_settings");
            }
        }
        "menu:refresh" => {
            if let Err(e) = handle.emit("app:refresh", ()) {
                warn!(?e, "failed to emit app:refresh");
            }
        }
        _ => {}
    });

    Ok(())
}
