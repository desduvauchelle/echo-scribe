pub mod asr;
pub mod audio;
pub mod commands;
pub mod coordinator;
pub mod db;
pub mod event_log;
pub mod input;
pub mod llm;
pub mod permissions;
pub mod settings;
pub mod ui;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use tauri::Manager;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::asr::pipeline::AsrPipeline;
use crate::asr::registry;
use crate::commands::{
    count_items, delete_item, delete_llm_model, delete_speech_model, download_llm_model,
    download_speech_model, ensure_pipeline_started_from_handle, get_active_llm_model_id,
    get_active_speech_model_id, get_voice_at_cursor_binding, is_pipeline_running, list_items,
    list_llm_models, list_speech_models, open_accessibility_settings, open_microphone_settings,
    permissions_status, prompt_accessibility_access, request_microphone_access, search_items,
    set_active_llm_model, set_active_speech_model, start_pipeline, test_llm_inference,
    update_voice_at_cursor_binding, AppState,
};
use crate::llm::Llm;
use crate::db::Db;
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
            list_speech_models,
            download_speech_model,
            get_active_speech_model_id,
            set_active_speech_model,
            delete_speech_model,
            list_items,
            search_items,
            delete_item,
            count_items,
            list_llm_models,
            download_llm_model,
            get_active_llm_model_id,
            set_active_llm_model,
            delete_llm_model,
            test_llm_inference,
        ])
        .setup(|app| {
            // Tray.
            let tray = TrayHandle::install(&app.handle().clone())?;
            let tray = Arc::new(Mutex::new(tray));

            // Persisted settings.
            let settings = SettingsStore::load(&app.handle().clone())?;
            let initial_binding = settings.voice_at_cursor_binding();
            let binding = Arc::new(RwLock::new(initial_binding));

            // ASR pipeline. Restore the saved active model if it exists AND
            // is fully downloaded; otherwise leave the pipeline inactive
            // until the user picks (and downloads) a model in onboarding.
            let asr = Arc::new(AsrPipeline::new());
            let saved_id = settings
                .speech_model_id()
                .unwrap_or_else(|| registry::default_id().to_string());
            if let Some(entry) = registry::lookup(&saved_id) {
                if crate::asr::downloader::is_downloaded(entry) {
                    info!(model = %entry.id, "restoring active speech model");
                    asr.set_active_model(entry.clone());
                } else {
                    warn!(
                        model = %entry.id,
                        "saved speech model is not downloaded; pipeline will gate on download"
                    );
                }
            }

            // LLM orchestrator. Same restore-active-model dance as the ASR
            // pipeline: load the saved id (or the registry default), and if
            // its weights are on disk, activate it. Otherwise leave it idle
            // until the user picks/downloads a model.
            let llm = Llm::new(std::time::Duration::from_secs(5 * 60));
            let saved_llm_id = settings
                .llm_model_id()
                .unwrap_or_else(|| crate::llm::registry::default_id().to_string());
            if let Some(entry) = crate::llm::registry::lookup(&saved_llm_id) {
                if crate::llm::is_downloaded(entry) {
                    info!(model = %entry.id, "restoring active llm model");
                    llm.set_active_model(entry.clone());
                } else {
                    warn!(
                        model = %entry.id,
                        "saved llm model is not downloaded; inference will gate on download"
                    );
                }
            }
            // Spawn the idle-unload background task on Tauri's async runtime.
            {
                let llm = Arc::clone(&llm);
                tauri::async_runtime::spawn(async move {
                    llm.spawn_unloader();
                });
            }

            // Build the shared state. The CGEventTap listener and coordinator
            // are NOT spawned here — that happens via `start_pipeline` (called
            // explicitly from onboarding once permissions are green AND a
            // model is downloaded) or via `ensure_pipeline_started_from_handle`
            // below if everything is already green at startup.
            // Persistent storage. If opening fails (disk full, permissions,
            // etc.) we log and continue without persistence — the app's
            // primary job (paste-at-cursor) must keep working.
            let db = match Db::open_default() {
                Ok(db) => Some(db),
                Err(e) => {
                    warn!(error = %e, "failed to open SQLite database; persistence disabled");
                    None
                }
            };
            let event_log_root = match crate::event_log::default_root() {
                Ok(root) => Some(root),
                Err(e) => {
                    warn!(error = %e, "failed to resolve event log root; event log disabled");
                    None
                }
            };

            let app_state = AppState {
                tray,
                settings,
                binding,
                hotkey_started: AtomicBool::new(false),
                hotkey_tx: Mutex::new(None),
                asr: Arc::clone(&asr),
                llm: Arc::clone(&llm),
                db,
                event_log_root,
            };
            app.manage(app_state);

            // If permissions are already green at startup AND a model is
            // ready, auto-start the pipeline so returning users don't need to
            // click anything. Otherwise, wait for the user to grant access /
            // download a model and explicitly hit "Start Echo Scribe" in
            // onboarding.
            let perms = permissions::status();
            if perms.microphone && perms.accessibility && asr.ready() {
                info!("permissions + model ready; auto-starting pipeline");
                ensure_pipeline_started_from_handle(&app.handle().clone());
            } else {
                warn!(
                    microphone = perms.microphone,
                    accessibility = perms.accessibility,
                    model_ready = asr.ready(),
                    "pipeline preconditions not yet met; will start after onboarding"
                );
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
