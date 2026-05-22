pub mod asr;
pub mod audio;
pub mod calendar;
pub mod classifier;
pub mod commands;
pub mod coordinator;
pub mod daily_summary;
pub mod meeting;
pub mod screenrec;
mod util;
pub mod db;
pub mod event_log;
pub mod input;
pub mod llm;
pub mod overlay;
pub mod permissions;
pub mod settings;
pub(crate) mod temporal;
pub mod ui;
pub mod updater;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use tauri::{Emitter, Listener, Manager};
use tracing::{info, warn};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::EnvFilter;

use crate::asr::pipeline::AsrPipeline;
use crate::asr::registry;
use crate::commands::{
    apply_update_and_restart, archive_project, cancel_log_capture, chat_with_memory, complete_task,
    confirm_log_capture, count_items, count_items_for_project, create_chat_session, create_project, delete_chat_session, delete_item,
    delete_llm_model, delete_speech_model, diagnostics_log_dir, diagnostics_open_log_folder,
    diagnostics_recent_log, dismiss_update, download_llm_model, download_speech_model,
    ensure_pipeline_started_from_handle, get_active_llm_model_id, get_active_speech_model_id,
    get_asr_unload_secs, get_audio_feedback_enabled, get_custom_words, get_default_filler_words,
    get_filler_removal_enabled, get_filler_words, get_llm_unload_secs, get_log_capture_binding,
    get_action_binding, update_action_binding, get_trigger_word_routing_enabled,
    set_trigger_word_routing_enabled, get_action_trigger_word, set_action_trigger_word,
    get_mute_while_recording, get_onboarding_completed, get_voice_at_cursor_binding,
    get_item, is_pipeline_running, list_chat_sessions, list_items, list_llm_models, list_projects, list_speech_models,
    list_tags_for_item, list_tasks, load_chat_messages, open_accessibility_settings, open_microphone_settings,
    open_calendar_settings, open_screen_recording_settings, permissions_status,
    prompt_accessibility_access, prompt_calendar_access, rename_chat_session,
    rename_project, request_microphone_access, request_screen_recording_access,
    reset_onboarding_and_quit, reset_tcc_and_quit, restore_item, search_items, set_active_llm_model,
    set_active_speech_model, set_audio_feedback_enabled, set_custom_words,
    set_asr_unload_secs, set_filler_removal_enabled, set_filler_words, set_llm_unload_secs, set_mute_while_recording,
    set_onboarding_completed, set_rebinding, set_task_deadline, show_main_window, start_pipeline,
    test_llm_inference, unarchive_project, uncomplete_task, undo_log_capture, update_item,
    update_log_capture_binding, update_voice_at_cursor_binding, get_auto_file_enabled,
    set_auto_file_enabled, get_auto_file_threshold, set_auto_file_threshold,
    list_item_events, list_sessions_for_item, list_claude_sessions, load_claude_session,
    get_dashboard_stats,
    get_app_launcher_enabled,
    set_app_launcher_enabled,
    get_action_counter,
    reset_action_counter,
    get_common_actions,
    start_screen_recording,
    stop_screen_recording,
    is_screen_recording,
    list_recordings,
    delete_recording,
    reveal_recording,
    list_screen_sources,
    get_screenrec_audio_prefs,
    set_screenrec_audio_prefs,
    open_screenrec_setup,
    AppState,
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

    // ORT runs CPU-only. We dropped `ort-coreml` after measuring that CoreML
    // only accepted ~30% of model ops and added a ~50s first-run graph
    // compilation cost — net regression. Pin CpuOnly explicitly so any
    // accidental future re-enabling of `ort-coreml` doesn't silently change
    // runtime behavior.
    use transcribe_rs::accel::{set_ort_accelerator, OrtAccelerator};
    set_ort_accelerator(OrtAccelerator::CpuOnly);
    info!(accelerator = %OrtAccelerator::CpuOnly, "ORT accelerator selected");

    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Intercept the close button: hide the window instead of
                    // destroying it so the app keeps running in the menu bar.
                    api.prevent_close();
                    let _ = window.hide();
                    crate::ui::dock::set_dock_visible(false);
                }
            }
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            permissions_status,
            open_microphone_settings,
            open_accessibility_settings,
            open_screen_recording_settings,
            open_calendar_settings,
            request_microphone_access,
            prompt_accessibility_access,
            request_screen_recording_access,
            prompt_calendar_access,
            get_voice_at_cursor_binding,
            update_voice_at_cursor_binding,
            get_log_capture_binding,
            update_log_capture_binding,
            get_action_binding,
            update_action_binding,
            get_trigger_word_routing_enabled,
            set_trigger_word_routing_enabled,
            get_action_trigger_word,
            set_action_trigger_word,
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
            get_item,
            search_items,
            delete_item,
            count_items,
            list_llm_models,
            download_llm_model,
            get_active_llm_model_id,
            set_active_llm_model,
            delete_llm_model,
            test_llm_inference,
            chat_with_memory,
            create_chat_session,
            list_chat_sessions,
            load_chat_messages,
            delete_chat_session,
            rename_chat_session,
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
            reset_tcc_and_quit,
            get_audio_feedback_enabled,
            set_audio_feedback_enabled,
            get_mute_while_recording,
            set_mute_while_recording,
            get_filler_removal_enabled,
            set_filler_removal_enabled,
            get_filler_words,
            set_filler_words,
            get_custom_words,
            set_custom_words,
            get_default_filler_words,
            get_onboarding_completed,
            set_onboarding_completed,
            get_llm_unload_secs,
            set_llm_unload_secs,
            get_asr_unload_secs,
            set_asr_unload_secs,
            show_main_window,
            diagnostics_log_dir,
            diagnostics_open_log_folder,
            diagnostics_recent_log,
            apply_update_and_restart,
            dismiss_update,
            set_rebinding,
            undo_log_capture,
            get_auto_file_enabled,
            set_auto_file_enabled,
            get_auto_file_threshold,
            set_auto_file_threshold,
            list_item_events,
            list_sessions_for_item,
            list_claude_sessions,
            load_claude_session,
            get_dashboard_stats,
            commands::start_meeting_manual,
            commands::stop_meeting,
            commands::is_meeting_active,
            commands::get_meeting,
            commands::list_meetings,
            commands::update_meeting_notes,
            commands::rename_meeting,
            commands::delete_meeting,
            commands::get_meeting_settings,
            commands::set_meeting_summary_prompt,
            commands::set_meeting_auto_detect,
            commands::set_meeting_app_pref,
            commands::meeting_consent,
            commands::hide_consent_overlay,
            commands::meeting_clear_app_pref,
            commands::retry_meeting_summary,
            commands::retry_meeting_chunks,
            commands::set_meeting_calendar_match,
            commands::match_meeting_calendar,
            commands::list_input_devices,
            commands::get_preferred_input_device,
            commands::set_preferred_input_device,
            commands::get_recent_input_devices,
            commands::get_input_device_sort,
            commands::set_input_device_sort,
            commands::daily_summary_get,
            commands::daily_summary_list_recent,
            commands::daily_summary_regenerate,
            commands::daily_recap_settings_get,
            commands::daily_recap_settings_set,
            commands::daily_recap_notification_permission_status,
            commands::list_guide_templates,
            commands::create_guide_template,
            commands::update_guide_template,
            commands::delete_guide_template,
            commands::start_guided_session,
            commands::guide_set_mode,
            commands::guide_trigger_now,
            commands::guide_end,
            get_app_launcher_enabled,
            set_app_launcher_enabled,
            get_action_counter,
            reset_action_counter,
            get_common_actions,
            start_screen_recording,
            stop_screen_recording,
            is_screen_recording,
            list_recordings,
            delete_recording,
            reveal_recording,
            list_screen_sources,
            get_screenrec_audio_prefs,
            set_screenrec_audio_prefs,
            open_screenrec_setup,
        ])
        .setup(move |app| {
            // Tray.
            let tray = TrayHandle::install(&app.handle().clone())?;
            let tray = Arc::new(Mutex::new(tray));

            // Make the main window follow the user to whichever macOS Space
            // they're currently on when they re-open it from the tray.
            if let Some(main) = app.get_webview_window("main") {
                crate::ui::dock::enable_move_to_active_space(&main);
            }

            // Persisted settings.
            let settings = SettingsStore::load(&app.handle().clone())?;

            // One-shot log so the user (and us, when debugging) can see
            // which apps have a sticky `Always`/`Never` pref.
            let prefs_for_log = settings.meeting_app_prefs();
            if !prefs_for_log.is_empty() {
                tracing::info!(?prefs_for_log, "loaded meeting app prefs");
            }

            let initial_binding = settings.voice_at_cursor_binding();
            let binding = Arc::new(RwLock::new(initial_binding));
            let initial_log_binding = settings.log_capture_binding();
            let log_capture_binding = Arc::new(RwLock::new(initial_log_binding));
            let initial_action_binding = settings.action_binding();
            let action_binding = Arc::new(RwLock::new(initial_action_binding));

            // Migrate any legacy model dirs (renames between releases) before
            // we ask the registry which models are downloaded.
            crate::asr::downloader::migrate_legacy_model_dirs();

            // ASR pipeline. Restore the saved active model if it exists AND is
            // fully downloaded. If the saved id is missing from the registry
            // (e.g. a model was renamed between releases), fall back to any
            // downloaded model so the user doesn't have to re-download.
            let asr = Arc::new(AsrPipeline::new(std::time::Duration::from_secs(settings.asr_unload_secs())));
            {
                let saved_id = settings
                    .speech_model_id()
                    .unwrap_or_else(|| registry::default_id().to_string());
                let to_restore = registry::lookup(&saved_id)
                    .filter(|e| crate::asr::downloader::is_downloaded(e))
                    .or_else(|| {
                        registry::registry()
                            .iter()
                            .find(|e| crate::asr::downloader::is_downloaded(e))
                    });
                if let Some(entry) = to_restore {
                    info!(model = %entry.id, "restoring active speech model");
                    asr.set_active_model(entry.clone());
                } else {
                    warn!("no downloaded speech model found; pipeline will gate on download");
                }
            }

            // LLM orchestrator. Same restore-active-model dance as ASR: prefer
            // the saved id but fall back to any downloaded model if the saved
            // id is no longer in the registry (e.g. after a registry update).
            let llm = Llm::new(std::time::Duration::from_secs(settings.llm_unload_secs()));
            {
                let saved_llm_id = settings
                    .llm_model_id()
                    .unwrap_or_else(|| crate::llm::registry::default_id().to_string());
                let llm_to_restore = crate::llm::registry::lookup(&saved_llm_id)
                    .filter(|e| crate::llm::is_downloaded(e))
                    .or_else(|| {
                        crate::llm::registry::registry()
                            .iter()
                            .find(|e| crate::llm::is_downloaded(e))
                    });
                if let Some(entry) = llm_to_restore {
                    info!(model = %entry.id, "restoring active llm model");
                    llm.set_active_model(entry.clone());
                } else {
                    warn!("no downloaded llm model found; inference will gate on download");
                }
            }
            // Spawn idle-unload background tasks on Tauri's async runtime.
            {
                let llm = Arc::clone(&llm);
                tauri::async_runtime::spawn(async move {
                    llm.spawn_unloader();
                });
            }
            {
                let asr = Arc::clone(&asr);
                tauri::async_runtime::spawn(async move {
                    asr.spawn_unloader();
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

            // Sync persisted flags into the in-process atomics consumed by the
            // coordinator. Audio feedback defaults to true; mute-while-recording
            // defaults to false.
            crate::audio::feedback::set_enabled(settings.audio_feedback_enabled());
            crate::audio::mute::set_enabled(settings.mute_while_recording());

            let paused_hotkeys = Arc::new(AtomicBool::new(false));
            let rebinding = Arc::new(AtomicBool::new(false));

            // Build the MeetingManager. Requires an open Db; if Db open failed
            // upstream the meeting subsystem is unavailable.
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/EchoScribe"));
            let meeting_db = db
                .clone()
                .expect("db must be open for meeting manager");
            let meeting_manager = crate::meeting::MeetingManager::new(
                Arc::clone(&asr),
                Arc::clone(&llm),
                meeting_db,
                data_dir,
                app.handle().clone(),
            );

            // Recover orphaned meetings from a previous session crash.
            if let Some(db_ref) = db.as_ref() {
                let orphans = crate::meeting::scan_orphans(
                    &app.path()
                        .app_data_dir()
                        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/EchoScribe")),
                    db_ref,
                );
                if !orphans.is_empty() {
                    crate::meeting::finalize_orphans_as_failed(db_ref, &orphans);
                    let _ = app.emit(
                        "meetings-recovered",
                        serde_json::json!({"ids": orphans}),
                    );
                }
            }

            // Spawn the meeting detector loop (NSWorkspace polling + CoreAudio).
            // Cloning settings here is cheap (Arc-backed). The spawn returns
            // immediately and the loop tracks frontmost-app changes for life.
            crate::meeting::detector::spawn(
                Arc::clone(&meeting_manager),
                settings.clone(),
                app.handle().clone(),
            );

            let app_state = AppState {
                tray: Arc::clone(&tray),
                settings,
                binding,
                log_capture_binding,
                action_binding,
                hotkey_started: AtomicBool::new(false),
                paused_hotkeys: Arc::clone(&paused_hotkeys),
                rebinding,
                coord_tx: Mutex::new(None),
                asr: Arc::clone(&asr),
                llm: Arc::clone(&llm),
                db,
                event_log_root,
                _log_guard: Mutex::new(guard_slot.take()),
                meeting_manager,
                active_recording: std::sync::Arc::new(std::sync::Mutex::new(None)),
            };
            app.manage(app_state);

            // Daily recap scheduler — fires once per day at the user-configured hour.
            crate::daily_summary::scheduler::spawn(app.handle().clone());

            // Wire tray menu events that need access to the managed state
            // (e.g. Pause/Resume toggling). The TrayHandle exposes a
            // `bind_menu` hook called from setup so it can capture the
            // AppHandle and the paused atomic together.
            if let Ok(t) = tray.lock() {
                t.bind_menu(&app.handle().clone(), Arc::clone(&paused_hotkeys));
            }

            // Keep the tray "Start/Stop meeting" label in sync with the actual
            // MeetingManager state. The tray, the MeetingsView button, the
            // auto-detect prompt, and the hard-cap timer can all change state,
            // so we drive the label off the same events the frontend watches.
            {
                let tray_started = Arc::clone(&tray);
                app.handle().listen("meeting-started", move |_evt| {
                    if let Ok(t) = tray_started.lock() {
                        t.set_meeting_active(true);
                    }
                });
                let tray_status = Arc::clone(&tray);
                app.handle().listen("meeting-status", move |evt| {
                    // Any non-recording status means we're past the recording
                    // phase; flip the label back to "Start meeting".
                    let payload = evt.payload();
                    if payload.contains("\"transcribing\"")
                        || payload.contains("\"summarizing\"")
                        || payload.contains("\"failed\"")
                    {
                        if let Ok(t) = tray_status.lock() {
                            t.set_meeting_active(false);
                        }
                    }
                });
                let tray_complete = Arc::clone(&tray);
                app.handle().listen("meeting-complete", move |_evt| {
                    if let Ok(t) = tray_complete.lock() {
                        t.set_meeting_active(false);
                    }
                });
            }

            if let Err(e) = crate::ui::menu::install(&app.handle().clone()) {
                warn!(error = %e, "failed to install application menu");
            }

            // Create the floating recording overlay (hidden until a hotkey
            // triggers a recording).
            crate::overlay::create_recording_overlay(&app.handle().clone());
            crate::overlay::create_consent_overlay(&app.handle().clone());
            crate::overlay::create_guide_overlay(&app.handle().clone());
            crate::overlay::create_screenrec_setup(&app.handle().clone());

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

            // Spawn background update checker (polls GitHub every 24 h).
            {
                let handle = app.handle().clone();
                crate::updater::spawn_updater(handle);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // llama.cpp's Metal backend has a destructor-ordering bug: when the
            // app is quit while LLM inference is running, exit() runs C++ static
            // destructors that try to free Metal devices while a command buffer
            // is still in flight, hitting an assert in `ggml_metal_rsets_free`
            // and aborting. We bypass the destructors with `_exit` — the OS
            // reclaims memory on process exit anyway.
            if let tauri::RunEvent::Exit = event {
                #[cfg(unix)]
                unsafe {
                    libc::_exit(0);
                }
            }
        });
}
