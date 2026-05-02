use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::audio::recorder::Recorder;
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
    on_state_change: impl Fn(PipelineState) + 'static,
) {
    // NOTE: `Recorder` owns a `cpal::Stream`, which is `!Send`. We therefore
    // use `tokio::task::spawn_local`, which requires a `LocalSet` to be active
    // on the runtime. Task 12 (lib.rs wiring) is responsible for setting up
    // that `LocalSet`.
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
                    let stop_result = recorder.stop();
                    match stop_result {
                        Ok((samples, sr)) => {
                            info!(samples = samples.len(), sample_rate = sr, "transcribing (stub)");
                            // Phase 0: hardcoded transcription.
                            let text = "hello world";
                            if let Err(e) = paste_at_cursor(text) {
                                error!(?e, "paste failed");
                            }
                        }
                        Err(e) => error!(?e, "recorder.stop failed"),
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
