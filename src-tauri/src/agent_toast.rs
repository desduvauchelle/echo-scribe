//! Progress toast for spoken project requests ("Tucky, add a task to …").
//!
//! When the main window isn't in front, a spoken request must not yank the app
//! forward. Instead this small always-on-top card sits near the desktop pet
//! when present (else above the recording pill; see `notice_column`), shows the request while the local model works, then the result (the
//! task/note that was created, or the answer). The frontend lives in
//! `src/agent-toast/` and listens for `agent-toast:report`.
use std::sync::Mutex;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracing::{debug, error, info, warn};

const LABEL: &str = "agent_toast";
const WIDTH: f64 = 348.0 + crate::notice_column::BUBBLE_WIDTH_INSET;
const DEFAULT_HEIGHT: f64 = 82.0 + crate::notice_column::BUBBLE_HEIGHT_INSET;
const MAX_HEIGHT: f64 = 298.0 + crate::notice_column::BUBBLE_HEIGHT_INSET;
static HEIGHT: Mutex<f64> = Mutex::new(DEFAULT_HEIGHT);

pub fn create(app: &AppHandle<Wry>) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    match WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("src/agent-toast/index.html".into()),
    )
    .title("Tucky")
    .inner_size(WIDTH, DEFAULT_HEIGHT)
    .resizable(false)
    .shadow(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .accept_first_mouse(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .focused(false)
    .visible(false)
    .build()
    {
        Ok(_) => debug!(target: "agent_toast", "agent toast window created (hidden)"),
        Err(e) => error!(target: "agent_toast", error = %e, "failed to create agent toast window"),
    }
}

/// Size to the reported card height; the notice column keeps the bottom edge
/// fixed (above the pet, or above the recording pill) so growth only moves the top.
fn place(window: &tauri::WebviewWindow<Wry>, height: f64, showing: bool) {
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: WIDTH,
        height,
    }));
    crate::notice_column::relayout(window.app_handle(), showing.then_some(LABEL));
}

/// Show the toast for a new request. Safe from any thread.
pub fn show(app: &AppHandle<Wry>) {
    let app2 = app.clone();
    let result = app.run_on_main_thread(move || {
        if app2.get_webview_window(LABEL).is_none() {
            create(&app2);
        }
        let Some(window) = app2.get_webview_window(LABEL) else {
            warn!(target: "agent_toast", "agent toast window unavailable; progress not shown");
            return;
        };
        crate::notice_column::note_shown(&app2, LABEL);
        let height = HEIGHT.lock().map(|h| *h).unwrap_or(DEFAULT_HEIGHT);
        place(&window, height, true);
        if let Err(e) = window.show() {
            warn!(target: "agent_toast", ?e, "agent toast show failed");
        }
        let _ = window.set_always_on_top(true);
        info!(target: "agent_toast", "agent toast shown");
    });
    if let Err(e) = result {
        warn!(target: "agent_toast", ?e, "failed to dispatch agent toast to main thread");
    }
}

/// The frontend reports its content height; grow upward from the anchor.
#[tauri::command]
pub fn resize_agent_toast(app: AppHandle, height: f64) {
    let height = height.clamp(26.0 + crate::notice_column::BUBBLE_HEIGHT_INSET, MAX_HEIGHT);
    if let Ok(mut h) = HEIGHT.lock() {
        *h = height;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        place(&window, height, false);
    }
}

/// "Open" on the toast: bring the app forward with the full report dialog.
#[tauri::command]
pub fn open_project_assistant_report(app: AppHandle) -> Result<(), String> {
    crate::commands::show_main_window(app.clone())?;
    if let Err(e) = app.emit_to("main", "project-assistant:open-report", ()) {
        warn!(target: "agent_toast", ?e, "failed to ask main window to open report");
    }
    Ok(())
}
