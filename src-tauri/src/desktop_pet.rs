// Independent of recording overlays: toggling the companion never changes capture state.
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

static SIZE: AtomicU8 = AtomicU8::new(0);
static LEVELS: std::sync::Mutex<Option<(std::time::Instant, [f32; 16])>> =
    std::sync::Mutex::new(None);

pub fn update_levels(levels: &[f32]) {
    let mut normalized = [0.0; 16];
    for (out, value) in normalized.iter_mut().zip(levels) {
        *out = if value.is_finite() {
            value.clamp(0.0, 1.0)
        } else {
            0.0
        };
    }
    if let Ok(mut current) = LEVELS.lock() {
        *current = Some((std::time::Instant::now(), normalized));
    }
}

fn recent_levels() -> [f32; 16] {
    LEVELS
        .lock()
        .ok()
        .and_then(|current| {
            current.as_ref().and_then(|(time, levels)| {
                (time.elapsed() < std::time::Duration::from_millis(300)).then_some(*levels)
            })
        })
        .unwrap_or([0.0; 16])
}

static LISTENING: AtomicBool = AtomicBool::new(false);
pub const SIZES: [&str; 3] = ["Small", "Medium", "Large"];

pub fn size_index() -> u8 {
    SIZE.load(Ordering::Relaxed)
}

fn dimensions(size: u8) -> (f64, f64) {
    match size {
        1 => (140.0, 156.0),
        2 => (180.0, 200.0),
        _ => (100.0, 112.0),
    }
}

const PET_SCREEN_MARGIN: i64 = 24;

/// Keep a dragged pet on its current display while that display exists. If it
/// disappears, restore the pet to its default corner on the primary display.
fn recovered_pet_position(
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
    let overlap = |&(ax, ay, aw, ah): &(i32, i32, u32, u32)| {
        let left = x.max(i64::from(ax));
        let top = y.max(i64::from(ay));
        let right = (x + w).min(i64::from(ax) + i64::from(aw));
        let bottom = (y + h).min(i64::from(ay) + i64::from(ah));
        (right - left).max(0) * (bottom - top).max(0)
    };
    let area = areas.iter().max_by_key(|area| overlap(area))?;
    let &(ax, ay, aw, ah) = if overlap(area) > 0 {
        area
    } else {
        areas.first()?
    };
    let (ax, ay, aw, ah) = (i64::from(ax), i64::from(ay), i64::from(aw), i64::from(ah));
    let (next_x, next_y) = if overlap(area) > 0 {
        (
            x.clamp(ax, ax + (aw - w).max(0)),
            y.clamp(ay, ay + (ah - h).max(0)),
        )
    } else {
        (
            ax + (aw - w - PET_SCREEN_MARGIN).max(0),
            ay + (ah - h - PET_SCREEN_MARGIN).max(0),
        )
    };
    Some((next_x as i32, next_y as i32))
}

fn keep_pet_visible(window: &tauri::WebviewWindow<Wry>) -> bool {
    let (Ok(position), Ok(size), Ok(mut monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return false;
    };
    if let Ok(Some(primary)) = window.primary_monitor() {
        monitors.sort_by_key(|monitor| monitor.position() != primary.position());
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
        recovered_pet_position((position.x, position.y), (size.width, size.height), &areas)
    {
        return window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .is_ok();
    }
    false
}

#[cfg(test)]
mod pet_display_position_tests {
    use super::recovered_pet_position as recover;

    #[test]
    fn preserves_a_dragged_pet_on_a_connected_secondary_display() {
        assert_eq!(
            recover(
                (-180, 700),
                (100, 112),
                &[(0, 24, 1440, 876), (-1200, 0, 1200, 900)]
            ),
            None
        );
    }

    #[test]
    fn unplugged_display_restores_pet_to_primary_corner() {
        assert_eq!(
            recover((-180, 700), (100, 112), &[(0, 24, 1440, 876)]),
            Some((1316, 764))
        );
    }

    #[test]
    fn resized_display_clamps_pet_into_its_work_area() {
        assert_eq!(
            recover((1350, 800), (100, 112), &[(0, 24, 1400, 800)]),
            Some((1300, 712))
        );
    }

    #[test]
    fn no_display_waits_for_a_later_recovery_attempt() {
        assert_eq!(recover((0, 0), (100, 112), &[]), None);
    }
}

pub fn restore_size(size: u8) {
    SIZE.store(size.min(2), Ordering::Relaxed);
}

pub fn recording_is_active(
    pipeline: crate::coordinator::TrayPipelineState,
    meeting: bool,
    screenrec: bool,
    paused: bool,
) -> bool {
    pipeline == crate::coordinator::TrayPipelineState::Recording
        || meeting
        || (screenrec && !paused)
}

pub fn set_listening(listening: bool) {
    LISTENING.store(listening, Ordering::Relaxed);
}

pub fn set_size(app: &AppHandle<Wry>, size: u8) -> Result<(), String> {
    if size > 2 {
        return Err("Unknown pet size".into());
    }
    let _guard = TOGGLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window("desktop_pet") {
        let (width, height) = dimensions(size);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        keep_pet_visible(&window);
        let _ = sync_daily_focus_bubble(app);
        crate::overlay::reposition_visible_toasts(app);
    }
    SIZE.store(size, Ordering::Relaxed);
    app.state::<crate::commands::AppState>()
        .settings
        .set_desktop_pet_size(size)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("desktop-pet-size-changed", size);
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_get_size(window: tauri::WebviewWindow<Wry>) -> Result<u8, String> {
    if window.label() != "main" {
        return Err("Only Settings can read pet size".into());
    }
    Ok(size_index())
}

#[tauri::command]
pub async fn desktop_pet_set_size(
    window: tauri::WebviewWindow<Wry>,
    size: u8,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only Settings can change pet size".into());
    }
    set_size(window.app_handle(), size)
}

fn persist_visibility(app: &AppHandle<Wry>, visible: bool) -> tauri::Result<()> {
    app.state::<crate::commands::AppState>()
        .settings
        .set_desktop_pet_visible(visible)
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))
}

pub fn hide(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let _guard = TOGGLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    hide_locked(app)?;
    persist_visibility(app, false)
}

fn hide_locked(app: &AppHandle<Wry>) -> tauri::Result<()> {
    if let Some(bubble) = app.get_webview_window("desktop_pet_focus") {
        bubble.destroy()?;
    }
    if let Some(window) = app.get_webview_window("desktop_pet") {
        window.destroy()?;
        crate::overlay::reposition_visible_toasts(app);
    }
    Ok(())
}

static TOGGLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn toggle(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let _guard = TOGGLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let visible = match app.get_webview_window("desktop_pet") {
        Some(window) => !window.is_visible()?,
        None => true,
    };
    if visible {
        show_locked(app)?;
    } else {
        // Destroy stops the webview's animation/pointer polling immediately.
        hide_locked(app)?;
    }
    persist_visibility(app, visible)
}

/// Restore without toggling or overwriting the saved preference on launch failure.
/// Run off the main thread, like the tray's other webview operations.
pub fn restore_visibility(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let _guard = TOGGLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if app.state::<crate::commands::AppState>().settings.desktop_pet_visible() {
        show_locked(app)?;
    }
    Ok(())
}

fn show_locked(app: &AppHandle<Wry>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("desktop_pet") {
        keep_pet_visible(&window);
        window.show()?;
        sync_daily_focus_bubble(app)?;
        crate::overlay::reposition_visible_toasts(app);
        return Ok(());
    }
    let (width, height) = dimensions(size_index());
    let window = tauri::webview::WebviewWindowBuilder::new(
        app,
        "desktop_pet",
        tauri::WebviewUrl::App("src/desktop-pet/index.html".into()),
    )
    .title("Tucky desktop pet")
    .inner_size(width, height)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .accept_first_mouse(true)
    .focusable(false)
    .focused(false)
    .visible(false)
    .closable(false)
    .build()?;
    if let Some(monitor) = window.primary_monitor()? {
        let area = monitor.work_area();
        let size = window.outer_size()?;
        window.set_position(tauri::PhysicalPosition::new(
            area.position.x
                + (area.size.width as i32 - size.width as i32 - PET_SCREEN_MARGIN as i32).max(0),
            area.position.y
                + (area.size.height as i32 - size.height as i32 - PET_SCREEN_MARGIN as i32).max(0),
        ))?;
    }
    window.show()?;
    sync_daily_focus_bubble(app)?;
    crate::overlay::reposition_visible_toasts(app);
    // Recheck even without a move event: unplugging a display may leave a
    // window at its old coordinates until the next polling pass.
    std::thread::spawn(move || {
        let mut previous = None;
        let mut last_note_check = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if window.is_visible().is_err() {
                break;
            }
            let recovered = keep_pet_visible(&window);
            let position = window.outer_position().ok();
            if recovered || (position.is_some() && position != previous) {
                crate::overlay::reposition_visible_toasts(window.app_handle());
            }
            if recovered || position != previous || last_note_check.elapsed() >= std::time::Duration::from_secs(30) {
                let _ = sync_daily_focus_bubble(window.app_handle());
                last_note_check = std::time::Instant::now();
            }
            previous = position;
        }
    });
    Ok(())
}

fn focus_bubble_content(db: &crate::db::Db, day: &str) -> Result<(bool, bool), crate::db::DbError> {
    db.with_conn(|conn| Ok((
        crate::db::daily_focus_notes::get(conn, day)?.is_some(),
        crate::db::tasks::list_focus_tasks(conn)?.iter().any(|task| task.completed_at.is_none()),
    )))
}

/// A separate window keeps the note and focus tasks beside the pet without
/// changing its drag area or taking space from the dashboard.
pub fn sync_daily_focus_bubble(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let pet = app.get_webview_window("desktop_pet");
    let state = app.state::<crate::commands::AppState>();
    let settings = &state.settings;
    let focus_visible = settings.desktop_pet_focus_visible();
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let (has_note, has_tasks) = state.db.as_ref()
        .and_then(|db| focus_bubble_content(db, &day).ok())
        .unwrap_or((false, false));
    let has_note = has_note && settings.morning_focus_enabled();
    if pet.as_ref().and_then(|w| w.is_visible().ok()) != Some(true) || (!has_note && !has_tasks) || !focus_visible {
        if let Some(bubble) = app.get_webview_window("desktop_pet_focus") { bubble.destroy()?; }
        return Ok(());
    }
    // Card size plus the transparent insets the notice column expects
    // — see `speech-bubble.css`. Preserve the visible card dimensions.
    let (card_width, card_height) = if has_tasks { (311.0, 208.0) } else { (291.0, 148.0) };
    let (width, height) = settings.desktop_pet_focus_size().unwrap_or((
        card_width + crate::notice_column::BUBBLE_WIDTH_INSET,
        card_height + crate::notice_column::BUBBLE_HEIGHT_INSET,
    ));
    let bubble = if let Some(bubble) = app.get_webview_window("desktop_pet_focus") { bubble } else {
        tauri::webview::WebviewWindowBuilder::new(
            app, "desktop_pet_focus", tauri::WebviewUrl::App("src/desktop-pet/focus.html".into()),
        )
        .title("Today's focus")
        .inner_size(width, height)
        .min_inner_size(280.0, 200.0)
        .max_inner_size(720.0, 700.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .closable(false)
        .build()?
    };
    // Keep a user-resized window as it is. New windows restore the saved size.
    crate::notice_column::relayout(app, Some("desktop_pet_focus"));
    bubble.show()?;
    Ok(())
}

pub fn set_focus_visible(app: &AppHandle<Wry>, visible: bool) -> Result<(), String> {
    app.state::<crate::commands::AppState>().settings
        .set_desktop_pet_focus_visible(visible).map_err(|e| e.to_string())?;
    sync_daily_focus_bubble(app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_pet_focus_set_visible(window: tauri::WebviewWindow<Wry>, visible: bool) -> Result<(), String> {
    if window.label() != "desktop_pet_focus" {
        return Err("Only the pet focus bubble can hide itself".into());
    }
    set_focus_visible(window.app_handle(), visible)
}

#[tauri::command]
pub fn desktop_pet_focus_save_size(window: tauri::WebviewWindow<Wry>) -> Result<(), String> {
    if window.label() != "desktop_pet_focus" { return Err("Only the focus bubble can save its size".into()); }
    let size = window.inner_size().map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    window.app_handle().state::<crate::commands::AppState>().settings
        .set_desktop_pet_focus_size(size.width, size.height).map_err(|e| e.to_string())?;
    crate::notice_column::relayout(window.app_handle(), None);
    Ok(())
}

fn focus_size(width: f64, height: f64) -> Result<tauri::LogicalSize<f64>, String> {
    if !width.is_finite() || !height.is_finite() {
        return Err("Focus size must be finite".into());
    }
    Ok(tauri::LogicalSize::new(width.clamp(280.0, 720.0), height.clamp(200.0, 700.0)))
}

/// macOS does not support the native resize-drag API, so the corner handle
/// sends its desired size as the pointer moves. The notice column keeps the
/// bottom-right edge anchored beside the pet.
#[tauri::command]
pub fn desktop_pet_focus_resize(window: tauri::WebviewWindow<Wry>, width: f64, height: f64) -> Result<(), String> {
    if window.label() != "desktop_pet_focus" { return Err("Only the focus bubble can resize itself".into()); }
    window.set_size(focus_size(width, height)?).map_err(|e| e.to_string())?;
    crate::notice_column::relayout(window.app_handle(), None);
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_focus_sync(window: tauri::WebviewWindow<Wry>) -> Result<(), String> {
    if window.label() != "desktop_pet_focus" { return Err("Only the focus bubble can refresh itself".into()); }
    sync_daily_focus_bubble(window.app_handle()).map_err(|e| e.to_string())
}

/// The pet alone can access its relative pointer and the public recording indicator.
#[derive(serde::Serialize)]
pub struct PetState {
    pointer: Option<(f64, f64)>,
    listening: bool,
    levels: [f32; 16],
}

#[tauri::command]
pub fn desktop_pet_state(window: tauri::WebviewWindow<Wry>) -> Result<PetState, String> {
    if window.label() != "desktop_pet" {
        return Err("Only the desktop pet can read its state".into());
    }
    let pointer = (|| {
        let cursor = window.cursor_position().ok()?;
        let origin = window.inner_position().ok()?;
        let scale = window.scale_factor().ok()?;
        Some((
            (cursor.x - origin.x as f64) / scale,
            (cursor.y - origin.y as f64) / scale,
        ))
    })();
    Ok(PetState {
        pointer,
        listening: LISTENING.load(Ordering::Relaxed),
        levels: if LISTENING.load(Ordering::Relaxed) {
            recent_levels()
        } else {
            [0.0; 16]
        },
    })
}

/// A native context menu stays readable even at the smallest pet size.
#[tauri::command]
pub fn desktop_pet_context_menu(window: tauri::WebviewWindow<Wry>) -> Result<(), String> {
    if window.label() != "desktop_pet" {
        return Err("Only the desktop pet can open its menu".into());
    }
    let hide = MenuItem::with_id(
        window.app_handle(),
        "desktop_pet_hide",
        "Hide pet",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let choices: Vec<CheckMenuItem<Wry>> = SIZES
        .iter()
        .enumerate()
        .map(|(i, label)| {
            CheckMenuItem::with_id(
                window.app_handle(),
                format!("desktop_pet_size:{i}"),
                *label,
                true,
                size_index() == i as u8,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()
        .map_err(|e| e.to_string())?;
    let refs: Vec<&dyn IsMenuItem<Wry>> =
        choices.iter().map(|c| c as &dyn IsMenuItem<Wry>).collect();
    let sizes = Submenu::with_items(window.app_handle(), "Pet size", true, &refs)
        .map_err(|e| e.to_string())?;
    let focus = CheckMenuItem::with_id(
        window.app_handle(), "desktop_pet_focus_toggle", "Show today's focus", true,
        window.app_handle().state::<crate::commands::AppState>().settings.desktop_pet_focus_visible(),
        None::<&str>,
    ).map_err(|e| e.to_string())?;
    let cancel = MenuItem::with_id(
        window.app_handle(), "desktop_pet_cancel", "Cancel recording",
        crate::overlay::pet_replaces_recording_widget(), None::<&str>,
    ).map_err(|e| e.to_string())?;
    let menu =
        Menu::with_items(window.app_handle(), &[&cancel, &sizes, &focus, &hide]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_resize_clamps_and_rejects_invalid_dimensions() {
        let size = focus_size(900.0, 100.0).unwrap();
        assert_eq!((size.width, size.height), (720.0, 200.0));
        assert!(focus_size(f64::NAN, 300.0).is_err());
    }
    #[test]
    fn bubble_content_detects_note_or_focus_tasks() {
        let db = crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap();
        let day = "2026-09-25";
        assert_eq!(focus_bubble_content(&db, day).unwrap(), (false, false));
        db.with_conn(|conn| { crate::db::daily_focus_notes::save(conn, day, "Finish the release")?; Ok(()) }).unwrap();
        assert_eq!(focus_bubble_content(&db, day).unwrap(), (true, false));
        db.with_conn(|conn| { crate::db::tasks::add_focus_task(conn, None, "Call the customer", "user")?; Ok(()) }).unwrap();
        assert_eq!(focus_bubble_content(&db, day).unwrap(), (true, true));
        assert_eq!(focus_bubble_content(&db, "2026-09-26").unwrap(), (false, true));
        db.with_conn(|conn| {
            let id = crate::db::tasks::list_focus_tasks(conn)?[0].item.id.clone();
            crate::db::tasks::complete_task(conn, &id, "2026-09-25T12:00:00Z")?;
            Ok(())
        }).unwrap();
        assert_eq!(focus_bubble_content(&db, day).unwrap(), (true, false));
        assert_eq!(focus_bubble_content(&db, "2026-09-26").unwrap(), (false, false));
    }
    #[test]
    fn audio_meter_sanitizes_input_and_expires_stale_levels() {
        update_levels(&[0.5, f32::NAN, -1.0, 2.0]);
        let levels = recent_levels();
        assert_eq!(&levels[..5], &[0.5, 0.0, 0.0, 1.0, 0.0]);
        *LEVELS.lock().unwrap() = Some((
            std::time::Instant::now() - std::time::Duration::from_secs(1),
            levels,
        ));
        assert_eq!(recent_levels(), [0.0; 16]);
    }

    #[test]
    fn headphones_follow_active_capture_not_processing() {
        use crate::coordinator::TrayPipelineState::*;
        assert!(recording_is_active(Recording, false, false, false));
        assert!(recording_is_active(Thinking, true, false, false));
        assert!(recording_is_active(Idle, false, true, false));
        assert!(!recording_is_active(Idle, false, true, true));
        assert!(!recording_is_active(Transcribing, false, false, false));
        assert!(!recording_is_active(Thinking, false, false, false));
        assert!(!recording_is_active(Idle, false, false, false));
    }

    #[test]
    fn default_pet_is_smaller_and_sizes_increase() {
        assert_eq!(dimensions(0), (100.0, 112.0));
        assert!(dimensions(0).0 < dimensions(1).0);
        assert!(dimensions(1).0 < dimensions(2).0);
        assert_eq!(dimensions(2), (180.0, 200.0));
        assert_eq!(dimensions(255), dimensions(0));
    }
}
