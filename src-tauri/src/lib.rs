pub mod audio;
pub mod commands;
pub mod coordinator;
pub mod input;
pub mod permissions;
pub mod settings;
pub mod ui;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use tauri::Manager;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::commands::{
    ensure_pipeline_started_from_handle, get_voice_at_cursor_binding, is_pipeline_running,
    open_accessibility_settings, open_microphone_settings, permissions_status,
    prompt_accessibility_access, request_microphone_access, start_pipeline,
    update_voice_at_cursor_binding, AppState,
};
use crate::settings::SettingsStore;
use crate::ui::tray::TrayHandle;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    info!("starting Echo Scribe Phase 0");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            permissions_status,
            open_microphone_settings,
            open_accessibility_settings,
            request_microphone_access,
            prompt_accessibility_access,
            get_voice_at_cursor_binding,
            update_voice_at_cursor_binding,
            start_pipeline,
            is_pipeline_running,
        ])
        .setup(|app| {
            // Tray.
            let tray = TrayHandle::install(&app.handle().clone())?;
            let tray = Arc::new(Mutex::new(tray));

            // Persisted settings.
            let settings = SettingsStore::load(&app.handle().clone())?;
            let initial_binding = settings.voice_at_cursor_binding();
            let binding = Arc::new(RwLock::new(initial_binding));

            // Build the shared state. The rdev listener and coordinator are
            // NOT spawned here — that happens via `start_pipeline` (called
            // explicitly from onboarding once permissions are green) or via
            // `ensure_pipeline_started_from_handle` below if permissions are
            // already green at startup.
            let app_state = AppState {
                tray,
                settings,
                binding,
                hotkey_started: AtomicBool::new(false),
                hotkey_tx: Mutex::new(None),
            };
            app.manage(app_state);

            // If permissions are already green at startup, auto-start the
            // pipeline so returning users don't need to click anything.
            // Otherwise, wait for the user to grant access and explicitly
            // hit "Start Echo Scribe" in onboarding.
            let perms = permissions::status();
            if perms.microphone && perms.accessibility {
                info!("permissions already green; auto-starting pipeline");
                ensure_pipeline_started_from_handle(&app.handle().clone());
            } else {
                warn!(
                    microphone = perms.microphone,
                    accessibility = perms.accessibility,
                    "permissions not yet granted; pipeline will start after onboarding"
                );
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
