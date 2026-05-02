use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Wry};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::asr::pipeline::AsrPipeline;
use crate::audio::recorder::Recorder;
use crate::db::items::{chrono_now_iso, Item, ItemSource, Visibility};
use crate::db::Db;
use crate::event_log::{self, EventEnvelope};
use crate::input::hotkeys::HotkeyEvent;
use crate::input::paste::paste_at_cursor;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineState {
    Idle,
    Recording,
    Processing,
}

pub type StateHandle = Arc<Mutex<PipelineState>>;

pub fn new_state_handle() -> StateHandle {
    Arc::new(Mutex::new(PipelineState::Idle))
}

/// Spawn the coordinator task. It owns a Recorder and consumes HotkeyEvents.
/// On Pressed → start recording. On Released → stop recording, run stub
/// transcription, paste the result, return to Idle.
///
/// `on_state_change` is called whenever the pipeline state changes; the UI tray
/// uses this to update its icon color.
pub fn spawn(
    mut hotkey_rx: mpsc::UnboundedReceiver<HotkeyEvent>,
    state: StateHandle,
    asr: Arc<AsrPipeline>,
    app: AppHandle<Wry>,
    db: Option<Db>,
    event_log_root: Option<PathBuf>,
    on_state_change: impl Fn(PipelineState) + 'static,
) {
    // NOTE: `Recorder` owns a `cpal::Stream`, which is `!Send`. We therefore
    // use `tokio::task::spawn_local`, which requires a `LocalSet` to be active
    // on the runtime. `commands::ensure_pipeline_started` sets up that
    // `LocalSet` on a dedicated thread.
    tokio::task::spawn_local(async move {
        let mut recorder = Recorder::new();

        while let Some(event) = hotkey_rx.recv().await {
            match event {
                HotkeyEvent::Pressed => {
                    if !transition(&state, PipelineState::Idle, PipelineState::Recording) {
                        warn!("ignored Pressed: not in Idle state");
                        continue;
                    }
                    on_state_change(PipelineState::Recording);
                    if let Err(e) = recorder.start() {
                        error!(?e, "failed to start recorder; returning to Idle");
                        force_state(&state, PipelineState::Idle);
                        on_state_change(PipelineState::Idle);
                    }
                }
                HotkeyEvent::Released => {
                    if !transition(&state, PipelineState::Recording, PipelineState::Processing) {
                        warn!("ignored Released: not in Recording state");
                        continue;
                    }
                    on_state_change(PipelineState::Processing);
                    let channels = recorder.channels();
                    let stop_result = recorder.stop();
                    match stop_result {
                        Ok((samples, sr)) => {
                            info!(samples = samples.len(), sample_rate = sr, channels, "transcribing");
                            match asr.transcribe(samples, sr, channels.max(1)).await {
                                Ok(text) if text.is_empty() => {
                                    warn!("transcription produced empty text; nothing to paste");
                                }
                                Ok(text) => {
                                    // Persist BEFORE pasting, but never let
                                    // a persistence failure block the paste —
                                    // user-visible behavior must match Phase 1.
                                    persist_capture(
                                        &text,
                                        db.as_ref(),
                                        event_log_root.as_deref(),
                                        &app,
                                    );

                                    info!(chars = text.len(), "pasting transcription");
                                    if let Err(e) = paste_at_cursor(&text) {
                                        error!(?e, "paste failed");
                                        let _ = app.emit(
                                            "asr:error",
                                            format!("Paste failed: {e}"),
                                        );
                                    }
                                }
                                Err(e) => {
                                    error!(?e, "transcription failed");
                                    let _ = app.emit(
                                        "asr:error",
                                        format!("Transcription failed: {e}"),
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            error!(?e, "recorder.stop failed");
                            let _ = app.emit("asr:error", format!("Recorder error: {e}"));
                        }
                    }
                    force_state(&state, PipelineState::Idle);
                    on_state_change(PipelineState::Idle);
                }
            }
        }
    });
}

fn transition(state: &StateHandle, from: PipelineState, to: PipelineState) -> bool {
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if *s == from {
        *s = to;
        true
    } else {
        false
    }
}

/// Insert an item row + append a `voice.captured` event to the disk log.
/// Both steps are best-effort: any failure is logged + emitted to the
/// frontend as an `asr:error` toast, but never propagates to the caller.
/// Pasting the transcription is the user's primary expectation; persistence
/// is additive.
fn persist_capture(
    text: &str,
    db: Option<&Db>,
    event_log_root: Option<&std::path::Path>,
    app: &AppHandle<Wry>,
) {
    let id = ulid::Ulid::new().to_string();
    let now = chrono_now_iso();

    if let Some(db) = db {
        let item = Item {
            id: id.clone(),
            content: text.to_string(),
            source: ItemSource::VoiceAtCursor,
            visibility: Visibility::Hidden,
            kind: None,
            project_id: None,
            captured_at: now.clone(),
            created_at: now.clone(),
            deleted_at: None,
        };
        let res = db.with_conn(|c| crate::db::items::insert_item(c, &item));
        if let Err(e) = res {
            error!(?e, "failed to persist item");
            let _ = app.emit("asr:error", format!("Persist failed: {e}"));
        }
    }

    if let Some(root) = event_log_root {
        // Truncate to first 200 chars on character boundaries (avoid panic
        // from slicing inside a multi-byte codepoint).
        let mut preview = String::with_capacity(text.len().min(200));
        for c in text.chars() {
            if preview.len() + c.len_utf8() > 200 {
                break;
            }
            preview.push(c);
        }
        let envelope = EventEnvelope {
            id: id.clone(),
            event_type: "voice.captured".to_string(),
            created_at: now,
            payload: serde_json::json!({
                "item_id": id,
                "preview": preview,
                "char_count": text.chars().count(),
            }),
        };
        if let Err(e) = event_log::append_event(root, &envelope) {
            error!(?e, "failed to append event log entry");
            let _ = app.emit("asr:error", format!("Persist failed: {e}"));
        }
    }
}

fn force_state(state: &StateHandle, to: PipelineState) {
    if let Ok(mut s) = state.lock() {
        *s = to;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_succeeds_when_state_matches() {
        let s = new_state_handle();
        assert!(transition(&s, PipelineState::Idle, PipelineState::Recording));
        assert_eq!(*s.lock().unwrap(), PipelineState::Recording);
    }

    #[test]
    fn transition_fails_when_state_mismatches() {
        let s = new_state_handle();
        assert!(!transition(&s, PipelineState::Recording, PipelineState::Processing));
        assert_eq!(*s.lock().unwrap(), PipelineState::Idle);
    }

    #[test]
    fn force_state_overrides_unconditionally() {
        let s = new_state_handle();
        force_state(&s, PipelineState::Processing);
        assert_eq!(*s.lock().unwrap(), PipelineState::Processing);
        force_state(&s, PipelineState::Idle);
        assert_eq!(*s.lock().unwrap(), PipelineState::Idle);
    }
}
