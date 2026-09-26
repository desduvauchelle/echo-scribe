//! Progress toast for spoken project requests ("Tucky, add a task to …").
//!
//! When the main window isn't in front, a spoken request must not yank the app
//! forward. Instead this small always-on-top card sits near the desktop pet
//! when present, shows the request while the local model works, then the result (the
//! task/note that was created, or the answer). The frontend lives in
//! `src/agent-toast/` and listens for `agent-toast:report`.
use std::sync::Mutex;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracing::{debug, error, info, warn};

const LABEL: &str = "agent_toast";
const WIDTH: f64 = 360.0;
const DEFAULT_HEIGHT: f64 = 104.0;
const MAX_HEIGHT: f64 = 320.0;
/// Gap between the toast's bottom edge and the recording pill's top edge.
const PILL_GAP: f64 = 8.0;
/// Where the pill sits when it's hidden: its bottom offset plus its height.
const FALLBACK_BOTTOM_OFFSET: f64 = 80.0 + 64.0;

/// Logical (center-x, bottom-y) the toast grows upward from. Captured when a
/// request starts so the card stays put after the pill hides.
static ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);
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

/// Above the recording pill when it's on screen, else bottom-center of the
/// primary display where the pill would be.
fn compute_anchor(app: &AppHandle<Wry>) -> Option<(f64, f64)> {
    if let Some(pill) = app.get_webview_window("recording_overlay") {
        if pill.is_visible().unwrap_or(false) {
            if let (Ok(pos), Ok(size), Ok(scale)) =
                (pill.outer_position(), pill.outer_size(), pill.scale_factor())
            {
                let center_x = (pos.x as f64 + size.width as f64 / 2.0) / scale;
                let top = pos.y as f64 / scale;
                return Some((center_x, top - PILL_GAP));
            }
        }
    }
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let x = monitor.position().x as f64 / scale;
    let y = monitor.position().y as f64 / scale;
    let w = monitor.size().width as f64 / scale;
    let h = monitor.size().height as f64 / scale;
    Some((x + w / 2.0, y + h - FALLBACK_BOTTOM_OFFSET - PILL_GAP))
}

fn place(window: &tauri::WebviewWindow<Wry>, height: f64) {
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: WIDTH,
        height,
    }));
    if let Some(position) = crate::overlay::toast_position_near_pet(window.app_handle(), window) {
        let _ = window.set_position(position);
        return;
    }
    let Some((center_x, bottom)) = ANCHOR.lock().ok().and_then(|a| *a) else {
        return;
    };
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
        x: center_x - WIDTH / 2.0,
        y: bottom - height,
    }));
}

pub(crate) fn reposition(app: &AppHandle<Wry>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) {
            let height = HEIGHT.lock().map(|h| *h).unwrap_or(DEFAULT_HEIGHT);
            place(&window, height);
        }
    }
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
        let anchor = compute_anchor(&app2);
        if let Ok(mut a) = ANCHOR.lock() {
            *a = anchor;
        }
        let height = HEIGHT.lock().map(|h| *h).unwrap_or(DEFAULT_HEIGHT);
        place(&window, height);
        if let Err(e) = window.show() {
            warn!(target: "agent_toast", ?e, "agent toast show failed");
        }
        let _ = window.set_always_on_top(true);
        info!(target: "agent_toast", ?anchor, "agent toast shown");
    });
    if let Err(e) = result {
        warn!(target: "agent_toast", ?e, "failed to dispatch agent toast to main thread");
    }
}

/// The frontend reports its content height; grow upward from the anchor.
#[tauri::command]
pub fn resize_agent_toast(app: AppHandle, height: f64) {
    let height = height.clamp(48.0, MAX_HEIGHT);
    if let Ok(mut h) = HEIGHT.lock() {
        *h = height;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        place(&window, height);
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
