use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Runtime};
use tracing::warn;

use crate::coordinator::TrayPipelineState;

pub struct TrayHandle<R: Runtime> {
    icon: TrayIcon<R>,
}

impl<R: Runtime> TrayHandle<R> {
    pub fn install(app: &AppHandle<R>) -> tauri::Result<TrayHandle<R>> {
        let quit = MenuItem::with_id(app, "quit", "Quit Echo Scribe", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&quit])?;

        let icon = TrayIconBuilder::new()
            .menu(&menu)
            .icon(idle_icon())
            .on_menu_event(|app, event| {
                if event.id().as_ref() == "quit" {
                    app.exit(0);
                }
            })
            .build(app)?;

        Ok(TrayHandle { icon })
    }

    pub fn set_state(&self, state: TrayPipelineState) {
        let img = match state {
            TrayPipelineState::Idle => idle_icon(),
            TrayPipelineState::Recording => recording_icon(),
            TrayPipelineState::Processing => processing_icon(),
        };
        if let Err(e) = self.icon.set_icon(Some(img)) {
            warn!(?e, "failed to update tray icon");
        }
    }
}

/// Solid-color 16x16 RGBA icon. Phase 0 uses flat colors as placeholders;
/// Phase 6 swaps these for designed assets. The buffer is leaked into
/// 'static memory because tray icons live for the full app lifetime — there
/// are exactly three of these and no need to free them.
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
