use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri::webview::WebviewWindowBuilder;
use tracing::{debug, error, info, warn};

const OVERLAY_WIDTH: f64 = 172.0;
const MEETING_OVERLAY_WIDTH: f64 = 236.0;
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
    let (x, y) = match calculate_overlay_position(app_handle, OVERLAY_WIDTH) {
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

/// Returns (x, y) in logical coordinates for bottom-center placement of a
/// pill with the given logical `width`.
fn calculate_overlay_position(app_handle: &AppHandle<Wry>, width: f64) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;
    let monitor_height = monitor.size().height as f64 / scale;

    let x = monitor_x + (monitor_width - width) / 2.0;
    let y = monitor_y + monitor_height - OVERLAY_HEIGHT - OVERLAY_BOTTOM_OFFSET;
    Some((x, y))
}

fn show_overlay_state(app_handle: &AppHandle<Wry>, state: &str) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        // Re-position in case the user moved monitors.
        if let Some((x, y)) = calculate_overlay_position(app_handle, OVERLAY_WIDTH) {
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = overlay.show();
        let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }));
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
        if let Some((x, y)) = calculate_overlay_position(app_handle, MEETING_OVERLAY_WIDTH) {
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = overlay.show();
        let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: MEETING_OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }));
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

/// Switches the overlay to a generic "processing" state with a custom label
/// (e.g. "Processing…", "Filing note…", "Formatting…"). Same visuals as
/// the transcribing state — pulsing text, no waveform, no icon swap — but
/// the label tells the user which downstream step is currently running.
pub fn show_processing_overlay(app_handle: &AppHandle<Wry>, label: &str) {
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        if let Some((x, y)) = calculate_overlay_position(app_handle, OVERLAY_WIDTH) {
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = overlay.show();
        let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }));
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit(
            "show-overlay",
            serde_json::json!({
                "mode": "processing",
                "label": label,
            }),
        );
    }
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

const HUD_MIN_WIDTH: f64 = 300.0;
const HUD_MIN_HEIGHT: f64 = 240.0;
const HUD_DEFAULT_WIDTH: f64 = 340.0;
const HUD_DEFAULT_HEIGHT: f64 = 440.0;
/// Vertical gap (logical px) between the recording pill's top edge and the
/// HUD's bottom edge in the default position.
const HUD_GAP_ABOVE_RECORDING: f64 = 12.0;

/// Default slot: bottom-center, just above the recording pill.
fn calculate_hud_default_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let x = ((logical_w - HUD_DEFAULT_WIDTH) / 2.0).max(0.0);
    let recording_top = logical_h - OVERLAY_HEIGHT - OVERLAY_BOTTOM_OFFSET;
    let y = (recording_top - HUD_GAP_ABOVE_RECORDING - HUD_DEFAULT_HEIGHT).max(0.0);
    Some((x, y))
}

/// The user's persisted HUD frame, if it's still (mostly) on the primary
/// monitor. A stale frame from an unplugged display must not strand the
/// HUD off-screen — in that case fall back to the default slot.
fn restored_hud_frame(app_handle: &AppHandle<Wry>) -> Option<(f64, f64, f64, f64)> {
    let settings = crate::settings::SettingsStore::load(app_handle).ok()?;
    let v = settings.guide_overlay_frame()?;
    let x = v.get("x")?.as_f64()?;
    let y = v.get("y")?.as_f64()?;
    let w = v.get("w")?.as_f64()?.max(HUD_MIN_WIDTH);
    let h = v.get("h")?.as_f64()?.max(HUD_MIN_HEIGHT);
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let mw = monitor.size().width as f64 / scale;
    let mh = monitor.size().height as f64 / scale;
    let on_screen = x > -w + 40.0 && x < mw - 40.0 && y >= 0.0 && y < mh - 40.0;
    if !on_screen {
        tracing::info!(target: "hud", x, y, "persisted HUD frame off-screen; using default position");
        return None;
    }
    Some((x, y, w, h))
}

/// Build the Meeting HUD webview window (hidden). Keeps the historical
/// window label "guide_overlay" so capabilities/default.json (and therefore
/// TCC state) is untouched. Idempotent.
pub fn create_meeting_hud(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("guide_overlay").is_some() {
        tracing::info!(target: "hud", "meeting HUD already exists; skipping create");
        return;
    }
    let (x, y, w, h) = restored_hud_frame(app_handle)
        .or_else(|| {
            calculate_hud_default_position(app_handle)
                .map(|(x, y)| (x, y, HUD_DEFAULT_WIDTH, HUD_DEFAULT_HEIGHT))
        })
        .unwrap_or((200.0, 200.0, HUD_DEFAULT_WIDTH, HUD_DEFAULT_HEIGHT));
    match WebviewWindowBuilder::new(
        app_handle,
        "guide_overlay",
        tauri::WebviewUrl::App("src/meeting-hud/index.html".into()),
    )
    .title("Meeting HUD")
    .position(x, y)
    .inner_size(w, h)
    .min_inner_size(HUD_MIN_WIDTH, HUD_MIN_HEIGHT)
    .resizable(true)
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
        Ok(_) => tracing::info!(target: "hud", "meeting HUD window created (hidden)"),
        Err(e) => tracing::error!(target: "hud", ?e, "failed to create meeting HUD window"),
    }
}

/// Show the Meeting HUD, restoring the user's last frame (or the default
/// above-pill slot), and tell the frontend which section to focus
/// ("transcript" | "guides").
pub fn show_meeting_hud(app_handle: &AppHandle<Wry>, focus: Option<&str>) {
    if app_handle.get_webview_window("guide_overlay").is_none() {
        tracing::warn!(target: "hud", "show_meeting_hud: window missing — building now");
        create_meeting_hud(app_handle);
    }
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        if let Some((x, y, wd, ht)) = restored_hud_frame(app_handle) {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize { width: wd, height: ht }));
        } else if let Some((x, y)) = calculate_hud_default_position(app_handle) {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        if let Err(e) = w.show() {
            tracing::error!(target: "hud", ?e, "meeting HUD show failed");
        }
        // Never let the HUD become key (same rationale as recording_overlay).
        let _ = w.set_always_on_top(true);
        if let Some(f) = focus {
            if let Err(e) = w.emit("hud-focus", serde_json::json!({ "focus": f })) {
                tracing::warn!(target: "hud", ?e, "hud-focus emit failed");
            }
        }
    }
}

pub fn hide_meeting_hud(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        let _ = w.hide();
    }
}

/// Emit `guide-init` to the HUD so a newly-attached guide renders its shell
/// before the first LLM cycle completes.
pub fn emit_guide_init(app_handle: &AppHandle<Wry>, payload: serde_json::Value) {
    if let Some(w) = app_handle.get_webview_window("guide_overlay") {
        if let Err(e) = w.emit("guide-init", payload) {
            tracing::error!(target: "hud", ?e, "guide-init emit failed");
        }
    } else {
        let _ = app_handle.emit("guide-init", payload);
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

// ---------------------------------------------------------------------------
// Live camera self-view (floating mirror while recording)
// ---------------------------------------------------------------------------

const CAMERA_PREVIEW_WIDTH: f64 = 240.0;
const CAMERA_PREVIEW_HEIGHT: f64 = 180.0;
/// Margin from the screen's bottom-right corner for the default placement.
const CAMERA_PREVIEW_MARGIN: f64 = 24.0;

/// Default self-view placement: bottom-right of the primary monitor, above the
/// recording pill's corner. The window is draggable, so this is only the
/// starting position each time recording begins.
fn calculate_camera_preview_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;
    let monitor_height = monitor.size().height as f64 / scale;
    let x = monitor_x + monitor_width - CAMERA_PREVIEW_WIDTH - CAMERA_PREVIEW_MARGIN;
    let y = monitor_y + monitor_height - CAMERA_PREVIEW_HEIGHT - CAMERA_PREVIEW_MARGIN;
    Some((x, y))
}

/// Creates the camera self-view window (hidden by default).
///
/// A small (240×180) frameless, transparent, always-on-top, draggable window
/// that mirrors the chosen webcam via `getUserMedia`. It never appears in
/// display recordings — ScreenCaptureKit's display filter excludes every window
/// owned by our bundle id (`excludingApplications`, see screenrec/main.swift) —
/// and window captures only ever contain the single targeted window, so the
/// self-view is invisible to captures of any kind.
///
/// Camera access at the WKWebView layer is granted automatically: wry's
/// `WKUIDelegate` answers `requestMediaCapturePermission` with
/// `WKPermissionDecision::Grant` (wry 0.55.0
/// `src/wkwebview/class/wry_web_view_ui_delegate.rs:136`). The webview holding
/// the camera concurrently with the sidecar's `AVCaptureSession` is fine —
/// macOS allows multi-client access to the same camera.
pub fn create_camera_preview(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("camera_preview").is_some() {
        debug!("camera_preview window already exists; skipping create");
        return;
    }
    let (x, y) = calculate_camera_preview_position(app_handle).unwrap_or((200.0, 200.0));

    match WebviewWindowBuilder::new(
        app_handle,
        "camera_preview",
        tauri::WebviewUrl::App("src/camera-preview/index.html".into()),
    )
    .title("Camera")
    .position(x, y)
    .inner_size(CAMERA_PREVIEW_WIDTH, CAMERA_PREVIEW_HEIGHT)
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
        Ok(_) => debug!("camera_preview window created (hidden)"),
        Err(e) => error!("failed to create camera_preview window: {}", e),
    }
}

/// Shows the self-view and tells the page which camera to mirror.
///
/// `camera_name` is the AVFoundation `localizedName` (what `--list-cameras`
/// returns as `name`). The page matches it against a `MediaDeviceInfo.label`
/// from `enumerateDevices()` — WebKit's `deviceId` is a per-origin salted hash
/// that does NOT equal the AVFoundation `uniqueID`, so label matching is the
/// only bridge available. It's fragile: if two cameras share a label, or the
/// OS localizes the name differently at the WebKit layer, the match can pick
/// the wrong device or fall back to the default camera. That mismatch only
/// affects the on-screen preview — the sidecar still records the correct device
/// by `uniqueID` — so it degrades to "preview shows a different camera than the
/// one being recorded", never to a broken recording.
pub fn show_camera_preview(app_handle: &AppHandle<Wry>, camera_name: &str) {
    if app_handle.get_webview_window("camera_preview").is_none() {
        create_camera_preview(app_handle);
    }
    if let Some(w) = app_handle.get_webview_window("camera_preview") {
        // Reset to the default corner each time (the window is draggable, but a
        // fresh recording should start from a predictable spot).
        if let Some((x, y)) = calculate_camera_preview_position(app_handle) {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = w.show();
        // Never let the self-view become key (same rationale as recording_overlay):
        // it must not steal focus / Cmd+V from the user's target app.
        let _ = w.set_always_on_top(true);
        if let Err(e) = w.emit(
            "camera-preview-start",
            serde_json::json!({ "camera_name": camera_name }),
        ) {
            tracing::warn!(target: "screenrec", ?e, "camera-preview-start emit failed");
        }
    }
}

/// Hides the self-view and tells the page to release the camera stream. Safe to
/// call unconditionally (no-op if the window was never created or is already
/// hidden) — call it on every recording-stop and error path.
pub fn hide_camera_preview(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("camera_preview") {
        // Ask the page to stop the MediaStream tracks so the camera's in-use
        // indicator clears promptly, then hide the window.
        let _ = w.emit("camera-preview-stop", ());
        let _ = w.hide();
    }
}

// ---------------------------------------------------------------------------
// Area picker (drag-to-select a screen region for "Area" source recording)
// ---------------------------------------------------------------------------
//
// Coordinate space, source of truth: `crate::screenrec::display_bounds`
// (CGDisplayBounds, keyed by the SAME id `--list-sources` / `start_screen_recording`
// use as `display_id`) returns `(x, y, w, h)` in GLOBAL POINTS with the primary
// display's top-left corner as the origin (+y down) — exactly the space the
// sidecar's `--rect` flag and recorded-events file use. Tauri's `LogicalPosition`/
// `LogicalSize` on macOS are ALSO points in that same global space (macOS bakes
// the scale factor into the physical/logical split, so "logical" == "points"
// here), so `display_bounds`'s output is passed straight into `.position()`/
// `.inner_size()` below with no further conversion. The picker webview itself
// then works in CSS px, which are 1:1 with those same logical points (no meta
// viewport scaling) — the frontend's drag rect (CSS px within the picker,
// which is sized to exactly the display's point-space frame) is therefore
// ALREADY in the display's local point space; the picker page adds the
// display's global origin (received alongside `area-picker-start`) to produce
// the final global-points rect it emits back.

/// Creates the area-picker window (hidden by default). Sized/positioned lazily
/// in `show_area_picker` since the target display isn't known until then.
pub fn create_area_picker(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("area_picker").is_some() {
        debug!("area_picker window already exists; skipping create");
        return;
    }
    match WebviewWindowBuilder::new(
        app_handle,
        "area_picker",
        tauri::WebviewUrl::App("src/area-picker/index.html".into()),
    )
    .title("Select area")
    .position(0.0, 0.0)
    .inner_size(1.0, 1.0)
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
    .focused(true)
    .visible(false)
    .build()
    {
        Ok(_) => debug!("area_picker window created (hidden)"),
        Err(e) => error!("failed to create area_picker window: {}", e),
    }
}

/// Shows the area picker sized/positioned to cover exactly `display_id`'s
/// bounds, and tells the page which display's global origin to add to its
/// local (CSS px) drag rect. Returns `Err` (friendly message, already logged)
/// if the display id no longer resolves — the caller must not show a picker
/// with stale/zero geometry.
pub fn show_area_picker(app_handle: &AppHandle<Wry>, display_id: u32) -> Result<(), String> {
    let (x, y, w, h) = crate::screenrec::display_bounds(display_id).ok_or_else(|| {
        error!(target: "screenrec", display_id, "show_area_picker: display not found");
        "That display is no longer available. Reopen the recording setup and pick a display again.".to_string()
    })?;
    if app_handle.get_webview_window("area_picker").is_none() {
        create_area_picker(app_handle);
    }
    let w_handle = app_handle
        .get_webview_window("area_picker")
        .ok_or_else(|| "area picker window missing after create".to_string())?;
    let _ = w_handle.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    let _ = w_handle.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
    if let Err(e) = w_handle.show() {
        error!(target: "screenrec", ?e, "area_picker show failed");
    }
    let _ = w_handle.set_always_on_top(true);
    let _ = w_handle.set_focus();
    if let Err(e) = w_handle.emit(
        "area-picker-start",
        serde_json::json!({ "display_id": display_id, "origin_x": x, "origin_y": y, "width": w, "height": h }),
    ) {
        warn!(target: "screenrec", ?e, "area-picker-start emit failed");
    }
    info!(target: "screenrec", display_id, x, y, w, h, "area picker shown");
    Ok(())
}

/// Hides the area picker unconditionally. Safe to call on every path
/// (confirm, Esc-cancel, re-select, setup-window close) — no-op if the
/// window was never created or is already hidden.
pub fn hide_area_picker(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("area_picker") {
        let _ = w.hide();
    }
}

// ---------------------------------------------------------------------------
// Pre-record countdown (3→2→1 overlay shown before recording starts)
// ---------------------------------------------------------------------------

const COUNTDOWN_SIZE: f64 = 160.0;

/// Creates the countdown window (hidden by default). Sized/positioned lazily
/// in `show_countdown` since the target display isn't known until then.
pub fn create_countdown(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("countdown").is_some() {
        debug!("countdown window already exists; skipping create");
        return;
    }
    match WebviewWindowBuilder::new(
        app_handle,
        "countdown",
        tauri::WebviewUrl::App("src/countdown/index.html".into()),
    )
    .title("Starting…")
    .position(0.0, 0.0)
    .inner_size(COUNTDOWN_SIZE, COUNTDOWN_SIZE)
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
    .focused(true)
    .visible(false)
    .build()
    {
        Ok(_) => debug!("countdown window created (hidden)"),
        Err(e) => error!("failed to create countdown window: {}", e),
    }
}

/// Shows the countdown window centered on `display_id`'s bounds and tells the
/// page to start ticking from `seconds`. Returns `Err` (friendly, already
/// logged) if the display id no longer resolves.
pub fn show_countdown(app_handle: &AppHandle<Wry>, display_id: u32, seconds: u32) -> Result<(), String> {
    let (dx, dy, dw, dh) = crate::screenrec::display_bounds(display_id).ok_or_else(|| {
        error!(target: "screenrec", display_id, "show_countdown: display not found");
        "That display is no longer available. Reopen the recording setup and pick a display again.".to_string()
    })?;
    if app_handle.get_webview_window("countdown").is_none() {
        create_countdown(app_handle);
    }
    let w_handle = app_handle
        .get_webview_window("countdown")
        .ok_or_else(|| "countdown window missing after create".to_string())?;
    let x = dx + (dw - COUNTDOWN_SIZE) / 2.0;
    let y = dy + (dh - COUNTDOWN_SIZE) / 2.0;
    let _ = w_handle.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    let _ = w_handle.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: COUNTDOWN_SIZE,
        height: COUNTDOWN_SIZE,
    }));
    if let Err(e) = w_handle.show() {
        error!(target: "screenrec", ?e, "countdown show failed");
    }
    let _ = w_handle.set_always_on_top(true);
    let _ = w_handle.set_focus();
    if let Err(e) = w_handle.emit("countdown-start", serde_json::json!({ "seconds": seconds })) {
        warn!(target: "screenrec", ?e, "countdown-start emit failed");
    }
    info!(target: "screenrec", display_id, seconds, "countdown shown");
    Ok(())
}

/// Hides the countdown window unconditionally. Safe to call on every path
/// (natural finish, Esc-cancel, recording-start failure) — no-op if the
/// window was never created or is already hidden.
pub fn hide_countdown(app_handle: &AppHandle<Wry>) {
    if let Some(w) = app_handle.get_webview_window("countdown") {
        let _ = w.emit("countdown-stop", ());
        let _ = w.hide();
    }
}
