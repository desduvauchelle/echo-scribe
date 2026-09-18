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
        crate::overlay::keep_recording_overlay_visible(&window);
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

pub fn hide(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let _guard = TOGGLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window("desktop_pet") {
        window.destroy()?;
    }
    Ok(())
}

static TOGGLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn toggle(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let _guard = TOGGLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window("desktop_pet") {
        if window.is_visible()? {
            // Destroy stops the webview's animation/pointer polling immediately.
            return window.destroy();
        }
        return window.show();
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
            area.position.x + (area.size.width as i32 - size.width as i32 - 24).max(0),
            area.position.y + (area.size.height as i32 - size.height as i32 - 24).max(0),
        ))?;
    }
    window.show()?;
    // Reuse the existing tested physical-coordinate monitor recovery.
    std::thread::spawn(move || {
        let mut previous = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if window.is_visible().is_err() {
                break;
            }
            let position = window.outer_position().ok();
            if position.is_some() && position == previous {
                crate::overlay::keep_recording_overlay_visible(&window);
            }
            previous = position;
        }
    });
    Ok(())
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
    let menu =
        Menu::with_items(window.app_handle(), &[&sizes, &hide]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
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
