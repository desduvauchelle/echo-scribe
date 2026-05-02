pub mod audio;
pub mod coordinator;
pub mod input;
pub mod ui;

use std::sync::{Arc, Mutex};
use std::thread;

use rdev::Key;
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::coordinator::{new_state_handle, PipelineState};
use crate::input::binding::Binding;
use crate::input::hotkeys::{spawn_listener, HotkeyEvent};
use crate::ui::tray::TrayHandle;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    info!("starting Echo Scribe Phase 0");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Install the tray and share it across threads via Arc<Mutex>.
            let tray = TrayHandle::install(&app.handle().clone())?;
            let tray = Arc::new(Mutex::new(tray));

            // Channel from rdev listener thread to coordinator thread.
            let (hotkey_tx, hotkey_rx) = mpsc::unbounded_channel::<HotkeyEvent>();

            // Default voice-at-cursor binding: Right Control as a single key.
            let default_binding = Binding::single(Key::ControlRight);
            spawn_listener(default_binding, hotkey_tx);

            // Coordinator state.
            let state = new_state_handle();
            let tray_for_state = Arc::clone(&tray);

            // The coordinator owns a Recorder which holds a !Send cpal::Stream,
            // so we cannot use tokio::spawn from Tauri's main runtime. Instead,
            // dedicate a thread with its own current-thread runtime + LocalSet.
            thread::spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        error!(?e, "failed to build coordinator runtime");
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.spawn_local(async move {
                    coordinator::spawn(hotkey_rx, state, move |new_state: PipelineState| {
                        if let Ok(t) = tray_for_state.lock() {
                            t.set_state(new_state);
                        }
                    });
                });
                rt.block_on(local);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
