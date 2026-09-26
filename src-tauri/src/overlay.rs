use std::sync::atomic::{AtomicU32, Ordering};
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tracing::{debug, error, info, warn};

// Invalidate pending fade-out callbacks whenever the shared pill changes.
static RECORDING_OVERLAY_REVISION: AtomicU32 = AtomicU32::new(0);

fn complete_recording_overlay_hide(revision: u32, hide: impl FnOnce()) {
    if RECORDING_OVERLAY_REVISION.load(Ordering::SeqCst) == revision {
        hide();
    }
}

#[cfg(test)]
mod recording_overlay_cleanup_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn restored_meeting_invalidates_pending_dictation_fade() {
        let hidden = Cell::new(false);
        let fade = RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
        complete_recording_overlay_hide(fade, || hidden.set(true));
        assert!(hidden.get(), "an unchanged fade should hide the widget");

        hidden.set(false);
        // Restoring the meeting (or starting a new dictation) advances revision.
        RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst);
        complete_recording_overlay_hide(fade, || hidden.set(true));
        assert!(
            !hidden.get(),
            "stale dictation fade hid the restored meeting"
        );
    }
}

#[cfg(test)]
mod recording_widget_visibility_tests {
    use super::recording_widget_visible;

    #[test]
    fn companion_bubble_replaces_voice_widget_but_preserves_meeting_controls() {
        assert!(!recording_widget_visible(0, false));
        for state in [1, 2, 3] { assert!(recording_widget_visible(state, false)); }
        assert!(!recording_widget_visible(1, true));
        assert!(!recording_widget_visible(2, true));
        assert!(recording_widget_visible(3, true));
    }
}

const OVERLAY_WIDTH: f64 = 160.0;
const STATUS_OVERLAY_WIDTH: f64 = 240.0;
const MEETING_OVERLAY_WIDTH: f64 = 320.0;
const OVERLAY_HEIGHT: f64 = 48.0;
const STATUS_OVERLAY_HEIGHT: f64 = 64.0;
const ACTIVITY_BUBBLE_WIDTH: f64 = 300.0;
const ACTIVITY_BUBBLE_HEIGHT: f64 = 76.0;
const ACTIVITY_BUBBLE_GAP: i32 = 10;
/// Distance from the bottom of the screen.
const OVERLAY_BOTTOM_OFFSET: f64 = 80.0;

/// Consent overlay (meeting consent prompt) dimensions.
const CONSENT_OVERLAY_WIDTH: f64 = 520.0;
const CONSENT_OVERLAY_HEIGHT: f64 = 96.0;

/// Granola-style meeting-start toast dimensions and screen-edge spacing.
const MEETING_TOAST_WIDTH: f64 = 370.0;
const MEETING_TOAST_HEIGHT: f64 = 90.0;
/// Voice-action confirmation toast dimensions ("Keeping your Mac awake for
/// 2 hours" etc.). Slimmer than the meeting toast — icon + two text lines.
const ACTION_TOAST_WIDTH: f64 = 320.0;
const ACTION_TOAST_HEIGHT: f64 = 82.0;
/// Vertical gap between the action toast and the pill / agent toast below it.
const ACTION_TOAST_STACK_GAP: f64 = 10.0;
const CUSTOM_TOAST_RIGHT_MARGIN: f64 = 20.0;
/// Leave room for one ordinary macOS notification banner. The supported
/// notification APIs do not expose other apps' live banner geometry, so a
/// reserved slot is more reliable than trying to screen-scrape Notification
/// Center or depend on private Accessibility structure.
const CUSTOM_TOAST_TOP_MARGIN: f64 = 148.0;
const PET_TOAST_GAP: i64 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ToastRect {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

impl ToastRect {
    fn right(self) -> i64 {
        self.x + self.width
    }
    fn bottom(self) -> i64 {
        self.y + self.height
    }
    fn overlaps(self, other: Self) -> bool {
        self.x < other.right()
            && self.right() > other.x
            && self.y < other.bottom()
            && self.bottom() > other.y
    }
    fn fits(self, area: Self) -> bool {
        self.x >= area.x
            && self.y >= area.y
            && self.right() <= area.right()
            && self.bottom() <= area.bottom()
    }
}

fn choose_pet_toast_position(
    pet: ToastRect,
    size: (i64, i64),
    area: ToastRect,
    obstacles: &[ToastRect],
) -> Option<(i32, i32)> {
    let (width, height) = size;
    if width > area.width || height > area.height {
        return None;
    }
    let centered_y = (pet.y + (pet.height - height) / 2).clamp(area.y, area.bottom() - height);
    let centered_x = (pet.x + (pet.width - width) / 2).clamp(area.x, area.right() - width);
    let mut candidates = vec![
        (pet.x - width - PET_TOAST_GAP, centered_y),
        (centered_x, pet.y - height - PET_TOAST_GAP),
        (pet.right() + PET_TOAST_GAP, centered_y),
        (centered_x, pet.bottom() + PET_TOAST_GAP),
    ];
    // Stack beside existing notices if all four immediate slots are occupied.
    for obstacle in obstacles {
        candidates.push((centered_x, obstacle.y - height - PET_TOAST_GAP));
        candidates.push((centered_x, obstacle.bottom() + PET_TOAST_GAP));
        candidates.push((obstacle.x - width - PET_TOAST_GAP, centered_y));
        candidates.push((obstacle.right() + PET_TOAST_GAP, centered_y));
    }
    candidates.into_iter().find_map(|(x, y)| {
        let rect = ToastRect {
            x,
            y,
            width,
            height,
        };
        (rect.fits(area) && !rect.overlaps(pet) && obstacles.iter().all(|other| !rect.overlaps(*other)))
            .then_some((x as i32, y as i32))
    })
}

fn window_rect(window: &tauri::WebviewWindow<Wry>) -> Option<ToastRect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(ToastRect {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: i64::from(size.width),
        height: i64::from(size.height),
    })
}

pub(crate) fn toast_position_near_pet(
    app_handle: &AppHandle<Wry>,
    toast: &tauri::WebviewWindow<Wry>,
) -> Option<tauri::PhysicalPosition<i32>> {
    let pet = app_handle.get_webview_window("desktop_pet")?;
    if !pet.is_visible().ok()? {
        return None;
    }
    let pet_rect = window_rect(&pet)?;
    let toast_size = window_rect(toast)?;
    let monitor = pet.current_monitor().ok().flatten()?;
    let work = monitor.work_area();
    let area = ToastRect {
        x: i64::from(work.position.x),
        y: i64::from(work.position.y),
        width: i64::from(work.size.width),
        height: i64::from(work.size.height),
    };
    let obstacles: Vec<_> = [
        "recording_overlay",
        "action_toast",
        "meeting_start_toast",
        "consent_overlay",
        "agent_toast",
        "activity_bubble",
        "desktop_pet_focus",
    ]
    .into_iter()
    .filter(|label| *label != toast.label())
    .filter_map(|label| app_handle.get_webview_window(label))
    .filter(|window| window.is_visible().unwrap_or(false))
    .filter_map(|window| window_rect(&window))
    .collect();
    choose_pet_toast_position(
        pet_rect,
        (toast_size.width, toast_size.height),
        area,
        &obstacles,
    )
    .map(|(x, y)| tauri::PhysicalPosition::new(x, y))
}

fn position_meeting_toast(app_handle: &AppHandle<Wry>, toast: &tauri::WebviewWindow<Wry>) {
    if let Some(position) = toast_position_near_pet(app_handle, toast) {
        let _ = toast.set_position(tauri::Position::Physical(position));
    } else if let Some(position) = toast_position_above_widget(app_handle, toast) {
        let _ = toast.set_position(position);
    } else if let Some((x, y)) = calculate_meeting_toast_position(app_handle) {
        let _ = toast.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    }
}

fn position_action_toast(app_handle: &AppHandle<Wry>, toast: &tauri::WebviewWindow<Wry>) {
    if let Some(position) = toast_position_near_pet(app_handle, toast) {
        let _ = toast.set_position(tauri::Position::Physical(position));
    } else if let Some(position) = toast_position_above_widget(app_handle, toast) {
        let _ = toast.set_position(position);
    } else if let Some((x, y)) = calculate_action_toast_position(app_handle) {
        let _ = toast.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    }
}

fn toast_position_above_widget(
    app: &AppHandle<Wry>, toast: &tauri::WebviewWindow<Wry>,
) -> Option<tauri::PhysicalPosition<i32>> {
    let widget = app.get_webview_window("recording_overlay")?;
    let widget_rect = window_rect(&widget)?;
    let anchor = app.get_webview_window("activity_bubble")
        .filter(|bubble| bubble.label() != toast.label() && bubble.is_visible().unwrap_or(false))
        .and_then(|bubble| window_rect(&bubble))
        .unwrap_or(widget_rect);
    let toast_rect = window_rect(toast)?;
    let monitor = widget.current_monitor().ok().flatten()?;
    let work = monitor.work_area();
    let area = ToastRect {
        x: i64::from(work.position.x), y: i64::from(work.position.y),
        width: i64::from(work.size.width), height: i64::from(work.size.height),
    };
    let (x, y) = choose_widget_bubble_position(anchor, (toast_rect.width, toast_rect.height), area)?;
    Some(tauri::PhysicalPosition::new(x, y))
}

fn choose_widget_bubble_position(anchor: ToastRect, size: (i64, i64), area: ToastRect) -> Option<(i32, i32)> {
    let (width, height) = size;
    if width > area.width || height > area.height { return None; }
    let x = (anchor.x + (anchor.width - width) / 2).clamp(area.x, area.right() - width);
    let above = anchor.y - height - i64::from(ACTIVITY_BUBBLE_GAP);
    let below = anchor.bottom() + i64::from(ACTIVITY_BUBBLE_GAP);
    let y = if above >= area.y { above }
        else if below + height <= area.bottom() { below }
        else { return None };
    Some((x as i32, y as i32))
}

// 0: idle, 1: microphone waveform, 2: progress, 3: meeting controls.
static OVERLAY_PRESENTATION: AtomicU32 = AtomicU32::new(0);
static PRE_PET_POSITION: std::sync::Mutex<Option<tauri::PhysicalPosition<i32>>> =
    std::sync::Mutex::new(None);

fn recording_widget_visible(presentation: u32, pet_visible: bool) -> bool {
    presentation != 0 && (!pet_visible || presentation == 3)
}

pub(crate) fn pet_replaces_recording_widget() -> bool {
    OVERLAY_PRESENTATION.load(Ordering::SeqCst) == 1
}

fn sync_recording_widget(app: &AppHandle<Wry>) {
    let Some(window) = app.get_webview_window("recording_overlay") else { return; };
    let pet_visible = app.get_webview_window("desktop_pet")
        .is_some_and(|pet| pet.is_visible().unwrap_or(false));
    let bubble_visible = app.get_webview_window("activity_bubble")
        .is_some_and(|bubble| bubble.is_visible().unwrap_or(false));
    let presentation = OVERLAY_PRESENTATION.load(Ordering::SeqCst);
    if !recording_widget_visible(presentation, pet_visible && bubble_visible) {
        if presentation != 0 { let _ = window.hide(); }
        return;
    }
    if let Some(position) = toast_position_near_pet(app, &window) {
        if let Ok(mut previous) = PRE_PET_POSITION.lock() {
            if previous.is_none() { *previous = window.outer_position().ok(); }
        }
        let _ = window.set_position(position);
    } else if !pet_visible {
        if let Ok(mut previous) = PRE_PET_POSITION.lock() {
            if let Some(position) = previous.take() {
                let _ = window.set_position(position);
                keep_recording_overlay_visible(&window);
            }
        }
    }
    let _ = window.show();
    let _ = window.set_always_on_top(true);
}

fn position_consent_overlay(app: &AppHandle<Wry>, window: &tauri::WebviewWindow<Wry>) {
    if let Some(position) = toast_position_near_pet(app, window) {
        let _ = window.set_position(position);
    } else if let Some((x, y)) = calculate_consent_overlay_position(app) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Reflow short-lived notices when the pet or recording pill moves or changes size.
pub(crate) fn reposition_visible_toasts(app_handle: &AppHandle<Wry>) {
    sync_recording_widget(app_handle);
    if let Some(bubble) = app_handle.get_webview_window("activity_bubble") {
        if bubble.is_visible().unwrap_or(false) {
            position_activity_bubble(app_handle, &bubble);
        }
    }
    crate::agent_toast::reposition(app_handle);
    if let Some(window) = app_handle.get_webview_window("consent_overlay") {
        if window.is_visible().unwrap_or(false) {
            position_consent_overlay(app_handle, &window);
        }
    }
    if let Some(toast) = app_handle.get_webview_window("meeting_start_toast") {
        if toast.is_visible().unwrap_or(false) {
            position_meeting_toast(app_handle, &toast);
        }
    }
    if let Some(toast) = app_handle.get_webview_window("action_toast") {
        if toast.is_visible().unwrap_or(false) {
            position_action_toast(app_handle, &toast);
        }
    }
}

pub fn create_activity_bubble(app: &AppHandle<Wry>) {
    if app.get_webview_window("activity_bubble").is_some() { return; }
    if let Err(e) = WebviewWindowBuilder::new(
        app, "activity_bubble", tauri::WebviewUrl::App("src/activity-bubble/index.html".into()),
    )
    .title("Tucky status")
    .inner_size(ACTIVITY_BUBBLE_WIDTH, ACTIVITY_BUBBLE_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focusable(false)
    .focused(false)
    .visible(false)
    .closable(false)
    .build() {
        warn!(?e, "activity bubble creation failed");
    }
}

fn position_activity_bubble(app: &AppHandle<Wry>, bubble: &tauri::WebviewWindow<Wry>) -> &'static str {
    if let Some(position) = toast_position_near_pet(app, bubble) {
        let placement = app.get_webview_window("desktop_pet")
            .and_then(|pet| window_rect(&pet))
            .and_then(|pet| window_rect(bubble).map(|size| {
                let placed = ToastRect { x: i64::from(position.x), y: i64::from(position.y), ..size };
                activity_bubble_pointer(placed, pet)
            }))
            .unwrap_or("bottom");
        let _ = bubble.set_position(position);
        let _ = bubble.emit("activity-bubble-placement", placement);
        return placement;
    }
    if let Some(position) = toast_position_above_widget(app, bubble) {
        let placement = app.get_webview_window("recording_overlay")
            .and_then(|widget| window_rect(&widget))
            .and_then(|widget| window_rect(bubble).map(|size| {
                let placed = ToastRect { x: i64::from(position.x), y: i64::from(position.y), ..size };
                activity_bubble_pointer(placed, widget)
            }))
            .unwrap_or("bottom");
        let _ = bubble.set_position(position);
        let _ = bubble.emit("activity-bubble-placement", placement);
        return placement;
    }
    let _ = bubble.emit("activity-bubble-placement", "bottom");
    "bottom"
}

fn activity_bubble_pointer(bubble: ToastRect, pet: ToastRect) -> &'static str {
    if bubble.right() <= pet.x { "right" }
    else if bubble.x >= pet.right() { "left" }
    else if bubble.bottom() <= pet.y { "bottom" }
    else if bubble.y >= pet.bottom() { "top" }
    else { "bottom" }
}

fn show_activity_bubble(app: &AppHandle<Wry>, mode: &str, label: Option<&str>) {
    if app.get_webview_window("activity_bubble").is_none() { create_activity_bubble(app); }
    let Some(bubble) = app.get_webview_window("activity_bubble") else { return; };
    let placement = position_activity_bubble(app, &bubble);
    if let Err(error) = bubble.show() {
        warn!(?error, "activity bubble show failed");
        return;
    }
    if let Some(focus) = app.get_webview_window("desktop_pet_focus") { let _ = focus.destroy(); }
    let _ = bubble.set_always_on_top(true);
    let _ = bubble.emit("show-activity-bubble", serde_json::json!({ "mode": mode, "label": label, "placement": placement }));
}

fn hide_activity_bubble(app: &AppHandle<Wry>) {
    if let Some(bubble) = app.get_webview_window("activity_bubble") { let _ = bubble.hide(); }
    let _ = crate::desktop_pet::sync_daily_focus_bubble(app);
}

#[cfg(test)]
mod pet_toast_position_tests {
    use super::{activity_bubble_pointer, choose_pet_toast_position as choose, ToastRect as Rect};

    #[test]
    fn bubble_pointer_tracks_which_side_faces_the_pet() {
        let pet = Rect { x: 400, y: 300, width: 100, height: 112 };
        assert_eq!(activity_bubble_pointer(Rect { x: 88, y: 310, width: 300, height: 76 }, pet), "right");
        assert_eq!(activity_bubble_pointer(Rect { x: 512, y: 310, width: 300, height: 76 }, pet), "left");
        assert_eq!(activity_bubble_pointer(Rect { x: 300, y: 212, width: 300, height: 76 }, pet), "bottom");
        assert_eq!(activity_bubble_pointer(Rect { x: 300, y: 424, width: 300, height: 76 }, pet), "top");
    }

    #[test]
    fn prefers_left_of_pet_and_avoids_recording_overlay() {
        let area = Rect {
            x: 0,
            y: 24,
            width: 1440,
            height: 876,
        };
        let pet = Rect {
            x: 1300,
            y: 760,
            width: 100,
            height: 112,
        };
        assert_eq!(choose(pet, (310, 64), area, &[]), Some((978, 784)));
        let recording = Rect {
            x: 960,
            y: 780,
            width: 160,
            height: 48,
        };
        assert_eq!(
            choose(pet, (310, 64), area, &[recording]),
            Some((1130, 684))
        );
    }

    #[test]
    fn crowded_pet_stacks_notices_without_covering_pet_or_other_cards() {
        let area = Rect { x: -1200, y: 0, width: 1200, height: 900 };
        let pet = Rect { x: -200, y: 750, width: 100, height: 112 };
        let left = Rect { x: -572, y: 646, width: 360, height: 216 };
        let above = Rect { x: -350, y: 418, width: 350, height: 216 };
        let obstacles = [left, above];
        let (x, y) = choose(pet, (360, 104), area, &obstacles).expect("stacked position");
        let result = Rect { x: x.into(), y: y.into(), width: 360, height: 104 };
        assert!(result.fits(area));
        assert!(!result.overlaps(pet));
        assert!(obstacles.iter().all(|other| !result.overlaps(*other)));
    }

    #[test]
    fn avoids_another_toast_and_handles_no_space() {
        let area = Rect {
            x: 0,
            y: 24,
            width: 500,
            height: 300,
        };
        let pet = Rect {
            x: 390,
            y: 230,
            width: 100,
            height: 80,
        };
        let other = Rect {
            x: 120,
            y: 220,
            width: 260,
            height: 72,
        };
        assert_eq!(choose(pet, (260, 64), area, &[other]), Some((240, 154)));
        assert_eq!(choose(pet, (600, 64), area, &[]), None);
    }
}

#[cfg(test)]
mod widget_bubble_position_tests {
    use super::{choose_widget_bubble_position as place, ToastRect as Rect};

    #[test]
    fn centers_above_widget_and_stays_inside_secondary_display() {
        let area = Rect { x: -1440, y: 24, width: 1440, height: 876 };
        let widget = Rect { x: -800, y: 790, width: 160, height: 48 };
        assert_eq!(place(widget, (300, 76), area), Some((-870, 704)));
    }

    #[test]
    fn moves_below_widget_when_there_is_no_space_above() {
        let area = Rect { x: 0, y: 24, width: 800, height: 600 };
        let widget = Rect { x: 320, y: 40, width: 160, height: 48 };
        assert_eq!(place(widget, (300, 76), area), Some((250, 98)));
    }
}

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
        Ok(window) => {
            debug!("recording overlay window created (hidden)");
            // Check even without a move event: unplugging a display does not
            // reliably move its windows. Wait for a settled position so a drag
            // can cross the gap between displays without snapping back.
            std::thread::spawn(move || {
                let mut previous = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let Ok(visible) = window.is_visible() else {
                        break;
                    };
                    if !visible {
                        previous = None;
                        continue;
                    }
                    let position = window.outer_position().ok();
                    if position.is_some() && position == previous {
                        keep_recording_overlay_visible(&window);
                    } else if position.is_some() && position != previous {
                        reposition_visible_toasts(window.app_handle());
                    }
                    previous = position;
                }
            });
        }
        Err(e) => {
            error!("failed to create recording overlay window: {}", e);
        }
    }
}

/// Returns (x, y) for the notification-safe top-right placement of the
/// consent overlay.
fn calculate_consent_overlay_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;

    let x = monitor_x + monitor_width - CONSENT_OVERLAY_WIDTH - CUSTOM_TOAST_RIGHT_MARGIN;
    let y = monitor_y + CUSTOM_TOAST_TOP_MARGIN;
    Some((x, y))
}

/// Returns (x, y) for top-right placement of the meeting-start toast. The
/// larger top margin keeps it clear of the macOS menu bar while still feeling
/// attached to the meeting window underneath it.
fn calculate_meeting_toast_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let monitor = app_handle.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let monitor_x = monitor.position().x as f64 / scale;
    let monitor_y = monitor.position().y as f64 / scale;
    let monitor_width = monitor.size().width as f64 / scale;

    let x = monitor_x + monitor_width - MEETING_TOAST_WIDTH - CUSTOM_TOAST_RIGHT_MARGIN;
    let y = monitor_y + CUSTOM_TOAST_TOP_MARGIN;
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

/// Physical coordinates throughout: never mix logical origins from displays
/// with different scale factors.
fn recovered_overlay_position(
    position: (i32, i32),
    size: (u32, u32),
    areas: &[(i32, i32, u32, u32)],
) -> Option<(i32, i32)> {
    let (x, y) = (i64::from(position.0), i64::from(position.1));
    let (w, h) = (i64::from(size.0), i64::from(size.1));
    if areas.iter().any(|&(ax, ay, aw, ah)| {
        x >= i64::from(ax)
            && y >= i64::from(ay)
            && x + w <= i64::from(ax) + i64::from(aw)
            && y + h <= i64::from(ay) + i64::from(ah)
    }) {
        return None;
    }
    // Prefer the display with the greatest overlap, otherwise the primary
    // display (ordered first by the caller).
    let area = areas.iter().max_by_key(|&&(ax, ay, aw, ah)| {
        let overlap_x = (x + w).min(i64::from(ax) + i64::from(aw)) - x.max(i64::from(ax));
        let overlap_y = (y + h).min(i64::from(ay) + i64::from(ah)) - y.max(i64::from(ay));
        overlap_x.max(0) * overlap_y.max(0)
    })?;
    let overlaps = x < i64::from(area.0) + i64::from(area.2)
        && x + w > i64::from(area.0)
        && y < i64::from(area.1) + i64::from(area.3)
        && y + h > i64::from(area.1);
    let &(ax, ay, aw, ah) = if overlaps { area } else { areas.first()? };
    let (ax, ay, aw, ah) = (i64::from(ax), i64::from(ay), i64::from(aw), i64::from(ah));
    let target = if overlaps {
        (
            x.clamp(ax, ax + (aw - w).max(0)),
            y.clamp(ay, ay + (ah - h).max(0)),
        )
    } else {
        (ax + (aw - w).max(0) / 2, ay + (ah - h).max(0) / 2)
    };
    Some((target.0 as i32, target.1 as i32))
}

pub(crate) fn keep_recording_overlay_visible(window: &tauri::WebviewWindow<Wry>) {
    let (Ok(position), Ok(size), Ok(mut monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    if let Ok(Some(primary)) = window.primary_monitor() {
        monitors.sort_by_key(|m| m.position() != primary.position());
    }
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            (
                area.position.x,
                area.position.y,
                area.size.width,
                area.size.height,
            )
        })
        .collect();
    if let Some((x, y)) =
        recovered_overlay_position((position.x, position.y), (size.width, size.height), &areas)
    {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg(test)]
mod recording_overlay_position_tests {
    use super::recovered_overlay_position as recover;
    #[test]
    fn preserves_secondary_display_and_negative_coordinates() {
        assert_eq!(
            recover(
                (-1000, 100),
                (640, 128),
                &[(0, 48, 2880, 1700), (-1920, 0, 1920, 1080)]
            ),
            None
        );
    }
    #[test]
    fn unplugged_display_recenters_in_primary_work_area() {
        assert_eq!(
            recover((-1900, 100), (640, 128), &[(0, 48, 2880, 1700)]),
            Some((1120, 834))
        );
    }
    #[test]
    fn resizing_clamps_full_widget_inside_work_area() {
        assert_eq!(
            recover((1800, 1000), (320, 64), &[(0, 24, 1920, 1016)]),
            Some((1600, 976))
        );
    }
    #[test]
    fn avoids_menu_bar_and_handles_no_displays() {
        assert_eq!(
            recover((100, 0), (240, 64), &[(0, 24, 1920, 1016)]),
            Some((100, 24))
        );
        assert_eq!(recover((0, 0), (240, 64), &[]), None);
    }
}

/// Keep the pill's visual center in place when capture changes to a wider
/// status or meeting state, including after the user has dragged it.
fn resize_overlay_around_center(overlay: &tauri::WebviewWindow<Wry>, width: f64, height: f64) {
    let previous = overlay.outer_position().ok().zip(overlay.outer_size().ok());
    if overlay
        .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
        .is_err()
    {
        return;
    }
    if let (Some((position, old_size)), Ok(new_size)) = (previous, overlay.outer_size()) {
        if old_size != new_size {
            let x = position.x + (old_size.width as i32 - new_size.width as i32) / 2;
            let y = position.y + (old_size.height as i32 - new_size.height as i32) / 2;
            let _ = overlay.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

fn show_overlay_state(app_handle: &AppHandle<Wry>, state: &str) {
    OVERLAY_PRESENTATION.store(1, Ordering::SeqCst);
    RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst);
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        resize_overlay_around_center(&overlay, OVERLAY_WIDTH, OVERLAY_HEIGHT);
        keep_recording_overlay_visible(&overlay);
        // The overlay must never become the key window — if it does, Cmd+V
        // lands here instead of the user's target app. On macOS, showing a
        // window can make it key even if it was created with focused(false).
        // Re-asserting always_on_top after show uses orderFront internally
        // which avoids makeKeyAndOrderFront semantics.
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit("show-overlay", state);
        show_activity_bubble(app_handle, state, None);
        reposition_visible_toasts(app_handle);
    }
}

fn show_status_overlay_state(app_handle: &AppHandle<Wry>, state: &str) {
    OVERLAY_PRESENTATION.store(2, Ordering::SeqCst);
    RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst);
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        resize_overlay_around_center(&overlay, STATUS_OVERLAY_WIDTH, STATUS_OVERLAY_HEIGHT);
        keep_recording_overlay_visible(&overlay);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit("show-overlay", state);
        show_activity_bubble(app_handle, state, None);
        reposition_visible_toasts(app_handle);
    }
}

/// Show the overlay in meeting mode with the detected app name.
/// Emits a JSON object payload (vs. the plain-string payload for the other
/// modes) so the frontend can pick up the contextual app name.
pub fn show_meeting_overlay(app_handle: &AppHandle<Wry>, detected_app_name: Option<&str>) {
    OVERLAY_PRESENTATION.store(3, Ordering::SeqCst);
    RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst);
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        resize_overlay_around_center(&overlay, MEETING_OVERLAY_WIDTH, STATUS_OVERLAY_HEIGHT);
        keep_recording_overlay_visible(&overlay);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit(
            "show-overlay",
            serde_json::json!({
                "mode": "meeting",
                "app_name": detected_app_name,
            }),
        );
        reposition_visible_toasts(app_handle);
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
    show_status_overlay_state(app_handle, "transcribing");
}

/// Switches the overlay to a generic "processing" state with a custom label
/// (e.g. "Processing…", "Filing note…", "Formatting…"). Same visuals as
/// the transcribing state — pulsing text, no waveform, no icon swap — but
/// the label tells the user which downstream step is currently running.
pub fn show_processing_overlay(app_handle: &AppHandle<Wry>, label: &str) {
    OVERLAY_PRESENTATION.store(2, Ordering::SeqCst);
    RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst);
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        resize_overlay_around_center(&overlay, STATUS_OVERLAY_WIDTH, STATUS_OVERLAY_HEIGHT);
        keep_recording_overlay_visible(&overlay);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.emit(
            "show-overlay",
            serde_json::json!({
                "mode": "processing",
                "label": label,
            }),
        );
        show_activity_bubble(app_handle, "processing", Some(label));
        reposition_visible_toasts(app_handle);
    }
}

/// Hides the overlay with a fade-out delay so the CSS animation can play.
pub fn hide_recording_overlay(app_handle: &AppHandle<Wry>) {
    OVERLAY_PRESENTATION.store(0, Ordering::SeqCst);
    hide_activity_bubble(app_handle);
    let revision = RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        let _ = overlay.emit("hide-overlay", ());
        let app = app_handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            // Check when the native operation runs, not before queueing it.
            let _ = app.run_on_main_thread(move || {
                complete_recording_overlay_hide(revision, || {
                    let _ = overlay.hide();
                });
            });
        });
    }
}

/// Hides the overlay immediately without the fade-out animation.
/// Used before pasting so the always-on-top overlay doesn't interfere
/// with focus restore and Cmd+V delivery to the target app.
pub fn hide_recording_overlay_now(app_handle: &AppHandle<Wry>) {
    OVERLAY_PRESENTATION.store(0, Ordering::SeqCst);
    hide_activity_bubble(app_handle);
    RECORDING_OVERLAY_REVISION.fetch_add(1, Ordering::SeqCst);
    if let Some(overlay) = app_handle.get_webview_window("recording_overlay") {
        let _ = overlay.hide();
    }
}

/// Creates the consent overlay window (hidden by default).
///
/// The consent overlay is a small always-on-top card at the top-right
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
        position_consent_overlay(app_handle, &overlay);
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

/// Creates the custom meeting-start toast window (hidden by default). It is
/// separate from the persistent recording pill so the toast can disappear
/// without implying that meeting capture stopped.
pub fn create_meeting_start_toast(app_handle: &AppHandle<Wry>) {
    if app_handle
        .get_webview_window("meeting_start_toast")
        .is_some()
    {
        return;
    }
    let (x, y) = match calculate_meeting_toast_position(app_handle) {
        Some(pos) => pos,
        None => {
            debug!("failed to determine meeting toast position; skipping creation");
            return;
        }
    };

    match WebviewWindowBuilder::new(
        app_handle,
        "meeting_start_toast",
        tauri::WebviewUrl::App("src/meeting-toast/index.html".into()),
    )
    .title("Meeting started")
    .position(x, y)
    .inner_size(MEETING_TOAST_WIDTH, MEETING_TOAST_HEIGHT)
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
        Ok(_) => debug!("meeting-start toast window created (hidden)"),
        Err(e) => error!("failed to create meeting-start toast window: {}", e),
    }
}

/// Shows the meeting-start toast and sends it the detected application name.
/// Repositioning on every show handles display changes between meetings.
pub fn show_meeting_start_toast(app_handle: &AppHandle<Wry>, detected_app_name: Option<&str>) {
    // A consent choice can start recording while the Ask window is still
    // fading. Replace it atomically so two custom meeting toasts never stack
    // in the same reserved slot.
    hide_consent_overlay(app_handle);
    if app_handle
        .get_webview_window("meeting_start_toast")
        .is_none()
    {
        create_meeting_start_toast(app_handle);
    }
    if let Some(toast) = app_handle.get_webview_window("meeting_start_toast") {
        position_meeting_toast(app_handle, &toast);
        if let Err(e) = toast.show() {
            warn!(?e, "meeting-start toast show failed");
        }
        // Showing a window may make it key on macOS. Reasserting the window
        // level keeps the toast visible without taking keyboard focus.
        let _ = toast.set_always_on_top(true);
        if let Err(e) = toast.emit(
            "show-meeting-toast",
            serde_json::json!({ "app_name": detected_app_name }),
        ) {
            warn!(?e, "show-meeting-toast emit failed");
        }
    }
}

/// Immediately dismisses a still-visible start toast, for example when the
/// user stops a meeting before the toast's normal timeout.
pub fn hide_meeting_start_toast(app_handle: &AppHandle<Wry>) {
    if let Some(toast) = app_handle.get_webview_window("meeting_start_toast") {
        let _ = toast.emit("hide-meeting-toast", ());
        let _ = toast.hide();
    }
}

/// Bottom-center, just above the recording pill — the same spot the user's
/// eyes are on after speaking a command. Uses the pill's live rect when it's
/// on screen, otherwise where the pill would sit. Stacks above the agent
/// toast when that card is showing so the two never overlap.
fn calculate_action_toast_position(app_handle: &AppHandle<Wry>) -> Option<(f64, f64)> {
    let visible_rect = |label: &str| {
        let w = app_handle.get_webview_window(label)?;
        if !w.is_visible().unwrap_or(false) {
            return None;
        }
        let (pos, size, scale) = (
            w.outer_position().ok()?,
            w.outer_size().ok()?,
            w.scale_factor().ok()?,
        );
        Some((
            pos.x as f64 / scale,
            pos.y as f64 / scale,
            size.width as f64 / scale,
        ))
    };

    let (center_x, mut bottom) = match visible_rect("recording_overlay") {
        Some((x, y, w)) => (x + w / 2.0, y),
        None => {
            let (x, y) = calculate_overlay_position(app_handle, ACTION_TOAST_WIDTH)?;
            (x + ACTION_TOAST_WIDTH / 2.0, y)
        }
    };
    if let Some((_, agent_top, _)) = visible_rect("agent_toast") {
        bottom = bottom.min(agent_top);
    }
    let y = bottom - ACTION_TOAST_STACK_GAP - ACTION_TOAST_HEIGHT;
    Some((center_x - ACTION_TOAST_WIDTH / 2.0, y))
}

/// Creates the voice-action confirmation toast window (hidden by default).
/// Same chrome-less always-on-top recipe as the meeting-start toast.
pub fn create_action_toast(app_handle: &AppHandle<Wry>) {
    if app_handle.get_webview_window("action_toast").is_some() {
        return;
    }
    let (x, y) = match calculate_action_toast_position(app_handle) {
        Some(pos) => pos,
        None => {
            debug!("failed to determine action toast position; skipping creation");
            return;
        }
    };

    match WebviewWindowBuilder::new(
        app_handle,
        "action_toast",
        tauri::WebviewUrl::App("src/action-toast/index.html".into()),
    )
    .title("Action")
    .position(x, y)
    .inner_size(ACTION_TOAST_WIDTH, ACTION_TOAST_HEIGHT)
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
        Ok(_) => debug!("action toast window created (hidden)"),
        Err(e) => error!("failed to create action toast window: {}", e),
    }
}

/// Shows the voice-action confirmation toast: "the command you spoke was
/// actually executed". `kind` is the ActionCommand action_type (drives the
/// icon in the frontend), `message` is the human confirmation line returned
/// by `execute_action`. Safe to call from any thread — window creation and
/// show hop to the main thread. The toast auto-dismisses in the frontend.
pub fn show_action_toast(app_handle: &AppHandle<Wry>, kind: &str, message: &str) {
    let app = app_handle.clone();
    let payload = serde_json::json!({ "kind": kind, "message": message });
    let result = app_handle.run_on_main_thread(move || {
        if app.get_webview_window("action_toast").is_none() {
            create_action_toast(&app);
        }
        let Some(toast) = app.get_webview_window("action_toast") else {
            warn!("action toast window unavailable; confirmation not shown");
            return;
        };
        position_action_toast(&app, &toast);
        if let Err(e) = toast.show() {
            warn!(?e, "action toast show failed");
        }
        // Showing may make it key on macOS; reassert level without stealing
        // keyboard focus (same dance as the meeting toast).
        let _ = toast.set_always_on_top(true);
        if let Err(e) = toast.emit("show-action-toast", payload) {
            warn!(?e, "show-action-toast emit failed");
        }
    });
    if let Err(e) = result {
        warn!(?e, "failed to dispatch action toast to main thread");
    }
}

/// Sends audio level data to the overlay window for waveform visualization.
pub fn emit_levels(app_handle: &AppHandle<Wry>, levels: &[f32]) {
    crate::desktop_pet::update_levels(levels);
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
            let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: wd,
                height: ht,
            }));
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

    let (x, y) =
        calculate_center_position(app_handle, SCREENREC_SETUP_WIDTH, SCREENREC_SETUP_HEIGHT)
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
        if let Some((x, y)) =
            calculate_center_position(app_handle, SCREENREC_SETUP_WIDTH, SCREENREC_SETUP_HEIGHT)
        {
            let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = w.show();
        // Re-assert always_on_top after show (mirrors the overlay pattern — showing
        // a window can promote it to key; orderFront semantics avoid makeKeyAndOrderFront).
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        // Tell the (persistent, hide-don't-destroy) page it's on screen again —
        // it gates the camera pre-warm on this, since its mount effect only
        // runs once at app startup.
        if let Err(e) = w.emit("screenrec-setup-shown", ()) {
            tracing::warn!(target: "screenrec", ?e, "screenrec-setup-shown emit failed");
        }
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
pub fn hide_camera_preview<R: Runtime>(app_handle: &AppHandle<R>) {
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
        "That display is no longer available. Reopen the recording setup and pick a display again."
            .to_string()
    })?;
    if app_handle.get_webview_window("area_picker").is_none() {
        create_area_picker(app_handle);
    }
    let w_handle = app_handle
        .get_webview_window("area_picker")
        .ok_or_else(|| "area picker window missing after create".to_string())?;
    let _ = w_handle.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    let _ = w_handle.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: w,
        height: h,
    }));
    // Pick mode needs the mouse: undo the click-through that frame mode
    // (`show_area_frame`) may have left on the same window.
    if let Err(e) = w_handle.set_ignore_cursor_events(false) {
        warn!(target: "screenrec", ?e, "area_picker set_ignore_cursor_events(false) failed");
    }
    if let Err(e) = w_handle.show() {
        error!(target: "screenrec", ?e, "area_picker show failed");
    }
    let _ = w_handle.set_always_on_top(true);
    let _ = w_handle.set_focus();
    LAST_AREA_PICKER_DISPLAY.store(display_id, Ordering::Relaxed);
    if let Err(e) = w_handle.emit(
        "area-picker-start",
        serde_json::json!({ "display_id": display_id, "origin_x": x, "origin_y": y, "width": w, "height": h }),
    ) {
        warn!(target: "screenrec", ?e, "area-picker-start emit failed");
    }
    info!(target: "screenrec", display_id, x, y, w, h, "area picker shown");
    Ok(())
}

/// The display the picker was last shown on (`show_area_picker`), so a
/// confirm can switch the SAME window into frame mode in place without the
/// page having to echo the display id back. 0 = never shown.
static LAST_AREA_PICKER_DISPLAY: AtomicU32 = AtomicU32::new(0);

pub fn last_area_picker_display() -> Option<u32> {
    match LAST_AREA_PICKER_DISPLAY.load(Ordering::Relaxed) {
        0 => None,
        id => Some(id),
    }
}

/// Re-shows the area-picker window in **frame mode**: a passive, click-through
/// overlay covering `display_id` that dims everything OUTSIDE `rect` (GLOBAL
/// points) and leaves the rect itself clear, so the user can see exactly
/// which part of the screen is being captured — after confirming a selection
/// and for the whole recording. It never takes the mouse
/// (`set_ignore_cursor_events(true)`) or keyboard focus, and the sidecar's
/// display capture excludes Tucky's own windows, so it does not appear in the
/// recording. The setup window and camera self-view are re-fronted afterwards
/// so the frame never covers them. Hidden by `hide_area_picker` (recording
/// stop, setup dismiss, source-kind change).
pub fn show_area_frame(
    app_handle: &AppHandle<Wry>,
    display_id: u32,
    rect: [f64; 4],
) -> Result<(), String> {
    let (x, y, w, h) = crate::screenrec::display_bounds(display_id).ok_or_else(|| {
        error!(target: "screenrec", display_id, "show_area_frame: display not found");
        "That display is no longer available. Reopen the recording setup and pick a display again."
            .to_string()
    })?;
    if app_handle.get_webview_window("area_picker").is_none() {
        create_area_picker(app_handle);
    }
    let w_handle = app_handle
        .get_webview_window("area_picker")
        .ok_or_else(|| "area picker window missing after create".to_string())?;
    let _ = w_handle.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    let _ = w_handle.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: w,
        height: h,
    }));
    if let Err(e) = w_handle.set_ignore_cursor_events(true) {
        // Without click-through the frame would swallow every click on the
        // display for the whole recording — log loudly, but still show it.
        error!(target: "screenrec", ?e, "area_frame set_ignore_cursor_events(true) failed");
    }
    if let Err(e) = w_handle.show() {
        error!(target: "screenrec", ?e, "area_frame show failed");
    }
    let _ = w_handle.set_always_on_top(true);
    if let Err(e) = w_handle.emit(
        "area-picker-frame",
        serde_json::json!({
            "display_id": display_id,
            "origin_x": x, "origin_y": y, "width": w, "height": h,
            "rect": rect,
        }),
    ) {
        warn!(target: "screenrec", ?e, "area-picker-frame emit failed");
    }
    // `show()` ordered the frame in front of every other floating window,
    // including ours. Re-front the ones the user still needs on top of it
    // (show() on an already-visible window is an order-front on macOS).
    for label in ["camera_preview", "screenrec_setup"] {
        if let Some(other) = app_handle.get_webview_window(label) {
            if other.is_visible().unwrap_or(false) {
                let _ = other.show();
                if label == "screenrec_setup" {
                    let _ = other.set_focus();
                }
            }
        }
    }
    info!(target: "screenrec", display_id, ?rect, "area frame shown");
    Ok(())
}

/// Hides the area picker unconditionally. Safe to call on every path
/// (confirm, Esc-cancel, re-select, setup-window close) — no-op if the
/// window was never created or is already hidden.
pub fn hide_area_picker<R: Runtime>(app_handle: &AppHandle<R>) {
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
pub fn show_countdown(
    app_handle: &AppHandle<Wry>,
    display_id: u32,
    seconds: u32,
) -> Result<(), String> {
    let (dx, dy, dw, dh) = crate::screenrec::display_bounds(display_id).ok_or_else(|| {
        error!(target: "screenrec", display_id, "show_countdown: display not found");
        "That display is no longer available. Reopen the recording setup and pick a display again."
            .to_string()
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
pub fn hide_countdown<R: Runtime>(app_handle: &AppHandle<R>) {
    if let Some(w) = app_handle.get_webview_window("countdown") {
        let _ = w.emit("countdown-stop", ());
        let _ = w.hide();
    }
}

/// Tears down every temporary surface owned by the recording setup window.
/// The title-bar close button is handled natively, so it must use the same
/// cleanup policy as the setup page's Cancel button instead of only hiding the
/// parent window and leaving the pre-warmed camera stream floating.
pub fn dismiss_screenrec_setup_overlays<R: Runtime>(app_handle: &AppHandle<R>) {
    let mut closer = AppOverlayCloser { app_handle };
    dismiss_screenrec_setup_overlays_with(&mut closer);
}

trait ScreenrecSetupOverlayCloser {
    fn hide_area_picker(&mut self);
    fn hide_countdown(&mut self);
    fn hide_camera_preview(&mut self);
}

struct AppOverlayCloser<'a, R: Runtime> {
    app_handle: &'a AppHandle<R>,
}

impl<R: Runtime> ScreenrecSetupOverlayCloser for AppOverlayCloser<'_, R> {
    fn hide_area_picker(&mut self) {
        hide_area_picker(self.app_handle);
    }

    fn hide_countdown(&mut self) {
        hide_countdown(self.app_handle);
    }

    fn hide_camera_preview(&mut self) {
        hide_camera_preview(self.app_handle);
    }
}

fn dismiss_screenrec_setup_overlays_with(closer: &mut impl ScreenrecSetupOverlayCloser) {
    closer.hide_area_picker();
    closer.hide_countdown();
    closer.hide_camera_preview();
}

#[cfg(test)]
mod screenrec_setup_close_tests {
    use super::*;

    #[derive(Default)]
    struct RecordedClosures {
        area_picker: bool,
        countdown: bool,
        camera_preview: bool,
    }

    impl ScreenrecSetupOverlayCloser for RecordedClosures {
        fn hide_area_picker(&mut self) {
            self.area_picker = true;
        }

        fn hide_countdown(&mut self) {
            self.countdown = true;
        }

        fn hide_camera_preview(&mut self) {
            self.camera_preview = true;
        }
    }

    #[test]
    fn dismissing_setup_hides_every_pre_record_overlay() {
        let mut closed = RecordedClosures::default();

        dismiss_screenrec_setup_overlays_with(&mut closed);

        assert!(closed.area_picker, "area picker should be hidden");
        assert!(closed.countdown, "countdown should be hidden");
        assert!(closed.camera_preview, "camera preview should be hidden");
    }
}

#[cfg(test)]
mod pet_recording_presentation_tests {
    use super::recording_widget_visible;

    #[test]
    fn pet_replaces_waveform_and_progress_but_keeps_meeting_controls() {
        assert!(!recording_widget_visible(1, true));
        assert!(!recording_widget_visible(2, true));
        assert!(recording_widget_visible(3, true));
        assert!(!recording_widget_visible(0, true));
    }

    #[test]
    fn hiding_pet_during_capture_restores_waveform() {
        assert!(recording_widget_visible(1, false));
        assert!(recording_widget_visible(2, false));
        assert!(!recording_widget_visible(0, false));
    }
}
