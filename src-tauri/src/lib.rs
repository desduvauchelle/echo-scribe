pub mod asr;
pub mod audio;
pub mod classifier;
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
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::EnvFilter;

use crate::asr::pipeline::AsrPipeline;
use crate::asr::registry;
use crate::commands::{
    archive_project, cancel_log_capture, complete_task, confirm_log_capture, count_items,
    count_items_for_project, create_project, delete_item, delete_llm_model, delete_speech_model,
    diagnostics_log_dir, diagnostics_recent_log, download_llm_model, download_speech_model,
    ensure_pipeline_started_from_handle, get_active_llm_model_id, get_active_speech_model_id,
    get_audio_feedback_enabled, get_log_capture_binding, get_onboarding_completed,
    get_voice_at_cursor_binding, is_pipeline_running, list_items, list_llm_models, list_projects,
    list_speech_models, list_tags_for_item, list_tasks, open_accessibility_settings,
    open_microphone_settings, permissions_status, prompt_accessibility_access, rename_project,
    request_microphone_access, reset_onboarding_and_quit, restore_item, search_items,
    set_active_llm_model, set_active_speech_model, set_audio_feedback_enabled,
    set_onboarding_completed, set_task_deadline, show_main_window, start_pipeline,
    test_llm_inference, unarchive_project, uncomplete_task, update_item, update_log_capture_binding,
    update_voice_at_cursor_binding, AppState,
};
use crate::llm::Llm;
use crate::db::Db;
use crate::settings::SettingsStore;
use crate::ui::tray::TrayHandle;

/// Resolve the directory crash logs are rotated into. Public so that the
/// `diagnostics_log_dir` Tauri command (Settings → Diagnostics) can return
/// the same path the appender writes to.
pub fn log_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join("Library/Logs/EchoScribe"))
        .unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_dir_resolves_under_library_logs_when_home_present() {
        // We can't easily mock `dirs::home_dir()`, but on the host where
        // this test runs there *is* a home dir, so the path must end with
        // "Library/Logs/EchoScribe" and contain the user's home prefix.
        let p = log_dir();
        let s = p.to_string_lossy();
        if let Some(home) = dirs::home_dir() {
            assert!(
                s.starts_with(home.to_string_lossy().as_ref()),
                "log dir {s} should sit under home {}",
                home.display()
            );
            assert!(s.ends_with("Library/Logs/EchoScribe"), "got {s}");
        } else {
            // No home dir on this host: we fall back to the temp dir.
            assert_eq!(p, std::env::temp_dir());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dir = log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("warning: failed to create log dir {}: {e}", dir.display());
    }
    let file_appender = tracing_appender::rolling::daily(&dir, "echo-scribe.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(file_writer.and(std::io::stdout))
        .init();

    // The non-blocking appender's worker thread shuts down when its guard is
    // dropped — which would silently swallow log lines on graceful exit.
    // Stash the guard in `AppState` so it lives for the full process; if we
    // miss attaching it (early panic during setup) we leak it as a fallback.
    let mut guard_slot: Option<WorkerGuard> = Some(guard);

    info!(log_dir = %dir.display(), "starting Echo Scribe Phase 6");

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
            get_log_capture_binding,
            update_log_capture_binding,
            confirm_log_capture,
            cancel_log_capture,
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
            list_projects,
            create_project,
            rename_project,
            archive_project,
            unarchive_project,
            count_items_for_project,
            list_tasks,
            complete_task,
            uncomplete_task,
            set_task_deadline,
            update_item,
            restore_item,
            list_tags_for_item,
            reset_onboarding_and_quit,
            get_audio_feedback_enabled,
            set_audio_feedback_enabled,
            get_onboarding_completed,
            set_onboarding_completed,
            show_main_window,
            diagnostics_log_dir,
            diagnostics_recent_log,
        ])
        .setup(move |app| {
            // Tray.
            let tray = TrayHandle::install(&app.handle().clone())?;
            let tray = Arc::new(Mutex::new(tray));

            // Persisted settings.
            let settings = SettingsStore::load(&app.handle().clone())?;
            let initial_binding = settings.voice_at_cursor_binding();
            let binding = Arc::new(RwLock::new(initial_binding));
            let initial_log_binding = settings.log_capture_binding();
            let log_capture_binding = Arc::new(RwLock::new(initial_log_binding));

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

            // Sync the persisted audio-feedback flag into the in-process
            // atomic so coordinator playback reflects user preferences from
            // launch (defaults true on a fresh install).
            crate::audio::feedback::set_enabled(settings.audio_feedback_enabled());

            let paused_hotkeys = Arc::new(AtomicBool::new(false));

            let app_state = AppState {
                tray: Arc::clone(&tray),
                settings,
                binding,
                log_capture_binding,
                hotkey_started: AtomicBool::new(false),
                paused_hotkeys: Arc::clone(&paused_hotkeys),
                coord_tx: Mutex::new(None),
                asr: Arc::clone(&asr),
                llm: Arc::clone(&llm),
                db,
                event_log_root,
                _log_guard: Mutex::new(guard_slot.take()),
            };
            app.manage(app_state);

            // Wire tray menu events that need access to the managed state
            // (e.g. Pause/Resume toggling). The TrayHandle exposes a
            // `bind_menu` hook called from setup so it can capture the
            // AppHandle and the paused atomic together.
            if let Ok(t) = tray.lock() {
                t.bind_menu(&app.handle().clone(), Arc::clone(&paused_hotkeys));
            }

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
