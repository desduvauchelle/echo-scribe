use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri::webview::WebviewWindowBuilder;
use tracing::{debug, error};

const OVERLAY_WIDTH: f64 = 172.0;
const OVERLAY_HEIGHT: f64 = 36.0;
/// Distance from the bottom of the screen.
const OVERLAY_BOTTOM_OFFSET: f64 = 80.0;

/// Consent overlay (meeting consent prompt) dimensions.
const CONSENT_OVERLAY_WIDTH: f64 = 320.0;
const CONSENT_OVERLAY_HEIGHT: f64 = 130.0;
/// Consent overlay margin from screen edges (bottom-right corner).
const CONSENT_OVERLAY_MARGIN: f64 = 24.0;

/// Creates the recording overlay window (hidden by default).
///
/// The overlay is a small, transparent, always-on-top pill that shows
/// recording/transcribing status. It floats at the bottom-center of the
/// primary monitor.
pub fn create_recording_overlay(app_handle: &AppHandle<Wry>) {
    let (x, y) = match calculate_overlay_position(app_handle) {
        Some(pos) => pos,
        None => {
            debug!("failed to determine overlay position; skipping overlay creation");
            return;
        }
    };

    match WebviewWindowBuilder::new(
        app_handle,
        "recording_overlay",
        tauri::WebviewUrl::App("src/overlay/index.html".into()),
    )
    .title("Recording")
    .position(x, y)
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
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
        Ok(_) => {
            debug!("recording overlay window created (hidden)");
        }
        Err(e) => {
            error!("failed to create recording overlay window: {}", e);
        }
    }
}

/// Returns (x, y) for bottom-right placement of the consent overlay.
fn calculate_consent_overlay_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;
    let monitor_height = monitor.size().height as f64 / scale;

    let x = monitor_x + monitor_width - CONSENT_OVERLAY_WIDTH - CONSENT_OVERLAY_MARGIN;
    let y = monitor_y + monitor_height - CONSENT_OVERLAY_HEIGHT - CONSENT_OVERLAY_MARGIN;
    Some((x, y))
}

/// Returns (x, y) in logical coordinates for bottom-center placement.
fn calculate_overlay_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;
    let monitor_height = monitor.size().height as f64 / scale;

    let x = monitor_x + (monitor_width - OVERLAY_WIDTH) / 2.0;
    let y = monitor_y + monitor_height - OVERLAY_HEIGHT - OVERLAY_BOTTOM_OFFSET;
    Some((x, y))
}

fn show_overlay_state(app_handle: &AppHandle<Wry>, state: &str) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        // Re-position in case the user moved monitors.
        if let Some((x, y)) = calculate_overlay_position(app_handle) {
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = overlay.show();
        // The overlay must never become the key window — if it does, Cmd+V
        // lands here instead of the user's target app. On macOS, showing a
        // window can make it key even if it was created with focused(false).
        // Re-asserting always_on_top after show uses orderFront internally
        // which avoids makeKeyAndOrderFront semantics.
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit("show-overlay", state);
    }
}

/// Show the overlay in meeting mode with the detected app name.
/// Emits a JSON object payload (vs. the plain-string payload for the other
/// modes) so the frontend can pick up the contextual app name.
pub fn show_meeting_overlay(app_handle: &AppHandle<Wry>, detected_app_name: Option<&str>) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        if let Some((x, y)) = calculate_overlay_position(app_handle) {
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit(
            "show-overlay",
            serde_json::json!({
                "mode": "meeting",
                "app_name": detected_app_name,
            }),
        );
    }
}

/// Shows the overlay in "recording" state (microphone + waveform bars).
pub fn show_recording_overlay(app_handle: &AppHandle<Wry>) {
    show_overlay_state(app_handle, "recording");
}

/// Switches the overlay to "log-recording" state (pencil icon + waveform).
/// Called when a voice-at-cursor recording is upgraded to a log capture
/// mid-flight (user pressed the log-capture modifier while already recording).
pub fn show_log_recording_overlay(app_handle: &AppHandle<Wry>) {
    show_overlay_state(app_handle, "log-recording");
}

/// Switches the overlay to "action-recording" state (dedicated Action Hotkey gradient).
pub fn show_action_recording_overlay(app_handle: &AppHandle<Wry>) {
    show_overlay_state(app_handle, "action-recording");
}

/// Shows the overlay in "transcribing" state (pulsing text).
pub fn show_transcribing_overlay(app_handle: &AppHandle<Wry>) {
    show_overlay_state(app_handle, "transcribing");
}

/// Hides the overlay with a fade-out delay so the CSS animation can play.
pub fn hide_recording_overlay(app_handle: &AppHandle<Wry>) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        let _ = overlay.emit("hide-overlay", ());
        let overlay_clone = overlay.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = overlay_clone.hide();
        });
    }
}

/// Hides the overlay immediately without the fade-out animation.
/// Used before pasting so the always-on-top overlay doesn't interfere
/// with focus restore and Cmd+V delivery to the target app.
pub fn hide_recording_overlay_now(app_handle: &AppHandle<Wry>) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        let _ = overlay.hide();
    }
}

/// Creates the consent overlay window (hidden by default).
///
/// The consent overlay is a small always-on-top card at the bottom-right
/// of the primary monitor. When a meeting is detected and the user pref
/// is `Ask`, the detector calls `show_consent_overlay()` and the user
/// clicks Record / Always / Don't record. The frontend then invokes the
/// `meeting_consent` Tauri command with the chosen decision.
pub fn create_consent_overlay(app_handle: &AppHandle<Wry>) {
    let (x, y) = match calculate_consent_overlay_position(app_handle) {
        Some(pos) => pos,
        None => {
            debug!("failed to determine consent overlay position; skipping creation");
            return;
        }
    };

    match WebviewWindowBuilder::new(
        app_handle,
        "consent_overlay",
        tauri::WebviewUrl::App("src/consent-overlay/index.html".into()),
    )
    .title("Meeting Detected")
    .position(x, y)
    .inner_size(CONSENT_OVERLAY_WIDTH, CONSENT_OVERLAY_HEIGHT)
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
        Ok(_) => debug!("consent overlay window created (hidden)"),
        Err(e) => error!("failed to create consent overlay window: {}", e),
    }
}

/// Shows the consent overlay with a payload describing the detected meeting.
/// Frontend listens for `show-consent` and renders three buttons.
pub fn show_consent_overlay(app_handle: &AppHandle<Wry>, bundle_id: &str, app_name: &str) {
    if let Some(overlay) = app_handle.get_webview_window("consent_overlay") {
        if let Some((x, y)) = calculate_consent_overlay_position(app_handle) {
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = overlay.show();
        // Avoid making the overlay key (same reason as recording_overlay).
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit(
            "show-consent",
            serde_json::json!({
                "bundle_id": bundle_id,
                "app_name": app_name,
            }),
        );
    }
}

/// Hides the consent overlay immediately. Called after the user decides
/// or after the auto-dismiss timeout.
pub fn hide_consent_overlay(app_handle: &AppHandle<Wry>) {
    if let Some(overlay) = app_handle.get_webview_window("consent_overlay") {
        let _ = overlay.hide();
    }
}

/// Sends audio level data to the overlay window for waveform visualization.
pub fn emit_levels(app_handle: &AppHandle<Wry>, levels: &[f32]) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        let _ = overlay.emit("mic-level", levels);
    }
}

const GUIDE_OVERLAY_WIDTH: f64 = 280.0;
const GUIDE_OVERLAY_HEIGHT: f64 = 280.0;
/// Vertical gap (logical px) between the recording overlay's top edge and the
/// guide HUD's bottom edge. Keeps both visible without overlap.
const GUIDE_OVERLAY_GAP_ABOVE_RECORDING: f64 = 12.0;

/// Position the guide HUD just above the recording overlay (bottom-center).
/// The recording overlay's top edge sits at `logical_h - OVERLAY_HEIGHT -
/// OVERLAY_BOTTOM_OFFSET`; we place the HUD's top above that with a gap.
/// Returns LOGICAL coordinates (Tauri's `.position(x, y)` interprets them
/// as logical pixels).
fn calculate_guide_overlay_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let x = ((logical_w - GUIDE_OVERLAY_WIDTH) / 2.0).max(0.0);
    let recording_top = logical_h - OVERLAY_HEIGHT - OVERLAY_BOTTOM_OFFSET;
    let y = (recording_top - GUIDE_OVERLAY_GAP_ABOVE_RECORDING - GUIDE_OVERLAY_HEIGHT).max(0.0);
    Some((x, y))
}

/// Build the guide-overlay webview window. Idempotent (no-op if already
/// created). Mirrors `create_recording_overlay` flags: transparent,
/// decorations off, always-on-top, never focused/in-taskbar.
pub fn create_guide_overlay(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("guide_overlay").is_some() {
        tracing::info!("guide overlay already exists; skipping create");
        return;
    }
    let (x, y) = calculate_guide_overlay_position(app_handle).unwrap_or((200.0, 200.0));
    tracing::info!(x, y, "creating guide overlay window (above recording overlay)");
    match WebviewWindowBuilder::new(
        app_handle,
        "guide_overlay",
        tauri::WebviewUrl::App("src/guide-overlay/index.html".into()),
    )
    .title("Guide")
    .position(x, y)
    .inner_size(GUIDE_OVERLAY_WIDTH, GUIDE_OVERLAY_HEIGHT)
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
        Ok(_) => tracing::info!("guide overlay window created (hidden)"),
        Err(e) => tracing::error!(?e, "failed to create guide overlay window"),
    }
}

/// Show the guide HUD and emit `guide-init` so the React component can render
/// its shell (template name + goal + "waiting…" indicator) BEFORE the first
/// LLM cycle completes — otherwise the window is visible but blank-transparent
/// until the engine emits its first `guide-update`, which the user perceives
/// as the HUD "not appearing".
pub fn show_guide_overlay(
    app_handle: &AppHandle<Wry>,
    template_name: &str,
    goal: &str,
    mode: &str,
) {
    // Always re-position before showing so a previously-dragged HUD snaps back
    // to the above-recording slot for the new session.
    if let Some((x, y)) = calculate_guide_overlay_position(app_handle) {
        if let Some(w) = app_handle.get_webview_window("guide_overlay") {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
    }
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        tracing::info!(%template_name, %mode, "show_guide_overlay: showing + emitting init");
        if let Err(e) = w.show() {
            tracing::error!(?e, "guide overlay show failed");
        }
        if let Err(e) = w.set_always_on_top(true) {
            tracing::error!(?e, "guide overlay set_always_on_top failed");
        }
        let init = serde_json::json!({
            "templateName": template_name,
            "goal": goal,
            "mode": mode,
        });
        if let Err(e) = w.emit("guide-init", init) {
            tracing::error!(?e, "guide overlay emit guide-init failed");
        }
    } else {
        tracing::warn!("show_guide_overlay: window MISSING — building now");
        create_guide_overlay(app_handle);
        if let Some(w) = app_handle.get_webview_window("guide_overlay") {
            let _ = w.show();
            let _ = w.set_always_on_top(true);
            let init = serde_json::json!({
                "templateName": template_name,
                "goal": goal,
                "mode": mode,
            });
            let _ = w.emit("guide-init", init);
        } else {
            tracing::error!("guide overlay STILL missing after rebuild attempt");
        }
    }
}

pub fn hide_guide_overlay(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        let _ = w.hide();
    }
}

// ---------------------------------------------------------------------------
// Screen-recording setup window
// ---------------------------------------------------------------------------

const SCREENREC_SETUP_WIDTH: f64 = 540.0;
const SCREENREC_SETUP_HEIGHT: f64 = 680.0;

/// Returns the (x, y) logical-coordinate origin to centre a window of the
/// given logical size on the primary monitor.
fn calculate_center_position(
    app_handle: &AppHandle<Wry>,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;
    let monitor_height = monitor.size().height as f64 / scale;
    let x = monitor_x + (monitor_width - width) / 2.0;
    let y = monitor_y + (monitor_height - height) / 2.0;
    Some((x, y))
}

/// Creates the screen-recording setup window (hidden, decorated, opaque).
/// Call once at startup alongside the other `create_*_overlay` calls.
pub fn create_screenrec_setup(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("screenrec_setup").is_some() {
        debug!("screenrec_setup window already exists; skipping create");
        return;
    }

    let (x, y) = calculate_center_position(app_handle, SCREENREC_SETUP_WIDTH, SCREENREC_SETUP_HEIGHT)
        .unwrap_or((200.0, 200.0));

    match WebviewWindowBuilder::new(
        app_handle,
        "screenrec_setup",
        tauri::WebviewUrl::App("src/screenrec-setup/index.html".into()),
    )
    .title("Recording setup")
    .position(x, y)
    .inner_size(SCREENREC_SETUP_WIDTH, SCREENREC_SETUP_HEIGHT)
    .resizable(true)
    .decorations(true)
    .transparent(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(false)
    .focused(true)
    .visible(false)
    .build()
    {
        Ok(_) => {
            debug!("screenrec_setup window created (hidden)");
        }
        Err(e) => {
            error!("failed to create screenrec_setup window: {}", e);
        }
    }
}

/// Shows (and focuses) the screen-recording setup window.
/// If the window was never created, creates it first.
pub fn show_screenrec_setup(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("screenrec_setup").is_none() {
        create_screenrec_setup(app_handle);
    }
    if let Some(w) = app_handle.get_webview_window("screenrec_setup") {
        // Re-centre on show so the window lands correctly even if the user
        // moved it or changed their monitor layout since startup.
        if let Some((x, y)) = calculate_center_position(app_handle, SCREENREC_SETUP_WIDTH, SCREENREC_SETUP_HEIGHT) {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = w.show();
        // Re-assert always_on_top after show (mirrors the overlay pattern — showing
        // a window can promote it to key; orderFront semantics avoid makeKeyAndOrderFront).
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}
