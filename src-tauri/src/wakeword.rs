//! Opt-in wake-word listening, owned by the same coordinator as dictation.
//! Idle audio has a three-second RAM limit. Only an acoustic wake followed by
//! a verified transcript can reach the command router; no ambient text is saved.
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as sync, Arc};
use std::time::{Duration, Instant, SystemTime};

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::audio::recorder::Recorder;
use crate::commands::AppState;
use crate::coordinator::{Action, PipelineState};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WakeStatus {
    pub enabled: bool,
    pub state: String,
    pub message: String,
}

impl Default for WakeStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            state: "off".into(),
            message: "Wake word is off".into(),
        }
    }
}

pub fn publish(app: &tauri::AppHandle, state: &str, message: &str) {
    let s = app.state::<AppState>();
    let status = if s.settings.wake_word_enabled() {
        WakeStatus {
            enabled: true,
            state: state.into(),
            message: message.into(),
        }
    } else {
        WakeStatus::default()
    };
    if let Ok(mut current) = s.wake_status.lock() {
        if *current == status {
            return;
        }
        *current = status.clone();
    }
    let _ = app.emit("wakeword:status", &status);
    // Menu mutation hops to the main thread. Keep the IPC handler free, and
    // read the latest status under the tray lock so old updates cannot win.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        if let Ok(tray) = s.tray.lock() {
            let status = s.wake_status.lock().ok().map(|value| value.clone());
            if let Some(status) = status {
                tray.set_wake_status(&status);
            }
        };
    });
}

pub fn paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if !cfg!(target_os = "macos") {
        return Err("Wake-word listening is available on macOS".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundled = exe
        .parent()
        .ok_or("Cannot find Tucky")?
        .join("tucky-wakeword");
    let triple = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    };
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("tucky-wakeword-{triple}"));
    let binary = if bundled.is_file() {
        bundled
    } else if cfg!(debug_assertions) {
        dev
    } else {
        bundled
    };
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/wakeword");
    let model = if resources.join("encoder.onnx").is_file() {
        resources
    } else if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/wakeword")
    } else {
        resources
    };
    if !binary.is_file()
        || [
            "encoder.onnx",
            "decoder.onnx",
            "joiner.onnx",
            "tokens.txt",
            "keywords.txt",
        ]
        .iter()
        .any(|f| !model.join(f).is_file())
    {
        return Err("Wake-word files are missing. Reinstall this version of Tucky.".into());
    }
    Ok((binary, model))
}

struct AudioChunk {
    mono: Vec<f32>,
    rate: u32,
}

struct Detector {
    child: Child,
    audio: mpsc::Sender<AudioChunk>,
    events: mpsc::Receiver<String>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    ready: bool,
    started: Instant,
}

impl Detector {
    fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        let (binary, model) = paths(app)?;
        let mut child = Command::new(binary)
            .arg(model)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut input = child.stdin.take().ok_or("Wake detector has no input")?;
        let output = child.stdout.take().ok_or("Wake detector has no output")?;
        let (audio, mut frames) = mpsc::channel::<AudioChunk>(32);
        let (events, receiver) = mpsc::channel(8);
        let failed = events.clone();
        let writer = tokio::spawn(async move {
            while let Some(frame) = frames.recv().await {
                let mut bytes = Vec::with_capacity(8 + frame.mono.len() * 4);
                bytes.extend_from_slice(&frame.rate.to_le_bytes());
                bytes.extend_from_slice(&(frame.mono.len() as u32).to_le_bytes());
                for sample in frame.mono {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
                if !matches!(
                    tokio::time::timeout(Duration::from_millis(250), input.write_all(&bytes)).await,
                    Ok(Ok(()))
                ) {
                    let _ = failed.send("error".into()).await;
                    break;
                }
            }
        });
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if events.send(line).await.is_err() {
                    return;
                }
            }
            let _ = events.send("error".into()).await;
        });
        Ok(Self {
            child,
            audio,
            events: receiver,
            tasks: vec![writer, reader],
            ready: false,
            started: Instant::now(),
        })
    }
}

impl Drop for Detector {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        let _ = self.child.start_kill();
    }
}

/// Endpoint decisions are based on audio duration, independent of callback size.
#[derive(Default)]
struct Endpoint {
    elapsed: f64,
    last_voice: f64,
    heard_request: bool,
}
impl Endpoint {
    fn feed(&mut self, samples: &[f32], rate: u32) -> bool {
        self.elapsed += samples.len() as f64 / rate.max(1) as f64;
        let rms = (samples.iter().map(|x| x * x).sum::<f32>() / samples.len().max(1) as f32).sqrt();
        // The start cue is ~90 ms. Do not mistake it for the request.
        if self.elapsed > 0.2 && rms > 0.006 {
            self.last_voice = self.elapsed;
            self.heard_request = true;
        }
        self.finished()
    }
    fn finished(&self) -> bool {
        self.elapsed >= 30.0
            || if self.heard_request {
                self.elapsed >= 0.8 && self.elapsed - self.last_voice >= 1.2
            } else {
                self.elapsed >= 5.0
            }
    }
}

pub enum Tick {
    None,
    Wake,
    Finish,
    Cancel,
}

#[derive(Debug, PartialEq, Eq)]
enum Gate {
    Listen,
    Pause,
    Cancel,
}

fn gate(enabled: bool, suspended: bool, pipeline: &PipelineState) -> Gate {
    let capturing = *pipeline == PipelineState::Recording(Action::WakeCommand);
    if !enabled || suspended || (!capturing && *pipeline != PipelineState::Idle) {
        if capturing {
            Gate::Cancel
        } else {
            Gate::Pause
        }
    } else {
        Gate::Listen
    }
}

#[derive(Default)]
pub struct Listener {
    detector: Option<Detector>,
    chunks: Option<sync::Receiver<AudioChunk>>,
    overflow: Arc<AtomicBool>,
    endpoint: Option<Endpoint>,
    preferred: Option<String>,
    next_retry: Option<Instant>,
    last_audio: Option<Instant>,
    last_tick: Option<SystemTime>,
    last_device_check: Option<Instant>,
}

impl Listener {
    pub fn owns_recorder(&self) -> bool {
        self.chunks.is_some()
    }

    pub fn stop(&mut self, recorder: &mut Recorder) {
        if self.owns_recorder() {
            recorder.discard();
        }
        self.detector = None;
        self.chunks = None;
        self.endpoint = None;
        recorder.set_chunk_callback(None);
        recorder.set_buffer_limit_secs(0);
        recorder.set_levels_enabled(true);
    }

    pub fn promote(&mut self, recorder: &Recorder) {
        self.detector = None;
        self.endpoint = Some(Endpoint::default());
        // Includes three seconds of pre-roll so immediate commands lose no words.
        recorder.set_buffer_limit_secs(34);
        recorder.set_levels_enabled(true);
    }

    pub fn finish(&mut self, recorder: &mut Recorder) {
        self.detector = None;
        self.chunks = None;
        self.endpoint = None;
        recorder.set_chunk_callback(None);
        recorder.set_buffer_limit_secs(0);
        recorder.set_levels_enabled(true);
    }

    pub async fn tick(
        &mut self,
        app: &tauri::AppHandle,
        recorder: &mut Recorder,
        pipeline: &PipelineState,
    ) -> Tick {
        let s = app.state::<AppState>();
        let enabled = s.settings.wake_word_enabled();
        let capturing = *pipeline == PipelineState::Recording(Action::WakeCommand);
        let preferred = s.settings.preferred_input_device();
        let suspended = !enabled
            || s.paused_hotkeys.load(Ordering::SeqCst)
            || !s.settings.app_launcher_enabled()
            || s.asr.is_busy()
            || !s.asr.ready()
            || s.active_recording
                .lock()
                .map(|r| r.is_some())
                .unwrap_or(true)
            || s.meeting_manager.is_active().await;
        let now = Instant::now();
        // Wall time includes system sleep on macOS; monotonic Instant is used
        // for ordinary timeouts but need not advance while the Mac sleeps.
        let gap = self
            .last_tick
            .replace(SystemTime::now())
            .is_some_and(|last| {
                last.elapsed()
                    .map_or(true, |elapsed| elapsed > Duration::from_secs(2))
            });
        let decision = gate(
            enabled,
            suspended || gap || (self.owns_recorder() && self.preferred != preferred),
            pipeline,
        );
        if decision != Gate::Listen {
            self.stop(recorder);
            self.next_retry = None;
            publish(
                app,
                if enabled { "paused" } else { "off" },
                if enabled {
                    "Paused while Tucky is busy"
                } else {
                    "Wake word is off"
                },
            );
            return if decision == Gate::Cancel {
                Tick::Cancel
            } else {
                Tick::None
            };
        }
        if self.next_retry.is_some_and(|retry| now < retry) {
            return Tick::None;
        }
        if self.owns_recorder()
            && preferred.is_none()
            && self
                .last_device_check
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(1))
        {
            self.last_device_check = Some(now);
            let default_name = cpal::default_host()
                .default_input_device()
                .and_then(|device| device.name().ok());
            if default_name.as_deref() != recorder.active_device_name() {
                self.stop(recorder);
                publish(app, "starting", "Switching to your current microphone…");
                return if capturing { Tick::Cancel } else { Tick::None };
            }
        }
        let result = self.poll(app, recorder, capturing, preferred);
        match result {
            Ok(tick) => tick,
            Err(error) => {
                self.stop(recorder);
                self.next_retry = Some(now + Duration::from_secs(5));
                publish(app, "error", &error);
                tracing::warn!(target: "wakeword", %error, "wake listener paused");
                if capturing {
                    Tick::Cancel
                } else {
                    Tick::None
                }
            }
        }
    }

    fn poll(
        &mut self,
        app: &tauri::AppHandle,
        recorder: &mut Recorder,
        capturing: bool,
        preferred: Option<String>,
    ) -> Result<Tick, String> {
        if !capturing && self.detector.is_none() {
            self.detector = Some(Detector::start(app)?);
            publish(app, "starting", "Starting wake-word listener…");
        }
        let mut woke = false;
        if let Some(detector) = &mut self.detector {
            while let Ok(event) = detector.events.try_recv() {
                match event.as_str() {
                    "ready" => detector.ready = true,
                    "wake" => woke = true,
                    _ => return Err("Wake-word listener stopped. Retrying…".into()),
                }
            }
            if !detector.ready {
                if detector.started.elapsed() > Duration::from_secs(10) {
                    return Err("Wake-word listener could not start".into());
                }
                return Ok(Tick::None);
            }
        }
        if !self.owns_recorder() {
            if !crate::permissions::status().microphone {
                return Err("Allow microphone access to listen for Tucky".into());
            }
            let (send, receive) = sync::sync_channel(32);
            self.overflow.store(false, Ordering::Relaxed);
            let overflow = self.overflow.clone();
            recorder.set_chunk_callback(Some(Arc::new(move |pcm, rate, channels| {
                let mono = pcm
                    .chunks_exact(channels.max(1) as usize)
                    .map(|frame| frame.iter().sum::<f32>() / channels.max(1) as f32)
                    .collect();
                if send.try_send(AudioChunk { mono, rate }).is_err() {
                    overflow.store(true, Ordering::Relaxed);
                }
            })));
            recorder.set_buffer_limit_secs(3);
            recorder.set_levels_enabled(false);
            recorder.set_preferred_device(preferred.clone());
            // Mark ownership before start so every failure releases callbacks and audio.
            self.chunks = Some(receive);
            recorder.start().map_err(|e| e.to_string())?;
            self.preferred = preferred;
            self.last_audio = Some(Instant::now());
            publish(app, "listening", "Listening for “Tucky”");
        }
        if recorder.stream_failed() || self.overflow.load(Ordering::Relaxed) {
            return Err("Microphone was interrupted. Retrying…".into());
        }
        let mut finish = false;
        if let Some(chunks) = &self.chunks {
            while let Ok(chunk) = chunks.try_recv() {
                self.last_audio = Some(Instant::now());
                if let Some(endpoint) = &mut self.endpoint {
                    finish |= endpoint.feed(&chunk.mono, chunk.rate);
                } else if let Some(detector) = &self.detector {
                    detector
                        .audio
                        .try_send(chunk)
                        .map_err(|_| "Wake-word listener fell behind. Retrying…".to_string())?;
                }
            }
        }
        if self
            .last_audio
            .is_some_and(|last| last.elapsed() > Duration::from_secs(2))
        {
            return Err("Microphone stopped providing audio. Retrying…".into());
        }
        Ok(if finish {
            Tick::Finish
        } else if woke {
            Tick::Wake
        } else {
            Tick::None
        })
    }
}

/// Spellings the ASR produces for "Tucky". Parakeet regularly hears it as
/// "Taki" (seen repeatedly in the user's history); "Take" is also common but is
/// an everyday word, so it is deliberately not accepted.
pub const TRIGGER_SPELLINGS: &[&str] = &[
    "tucky", "tuckey", "tuckie", "tuki", "taki", "takki", "tacky", "tacki",
];

/// The acoustic detector is deliberately followed by a strict transcript gate.
/// Pre-roll can include earlier speech; discard it through the first whole
/// wake word, preserving subsequent mentions inside the request. Never use
/// action_launcher's keep-awake recovery for ambient audio.
pub fn command_from_transcript(text: &str) -> Option<String> {
    let mut start = None;
    for (offset, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if c.is_alphanumeric() || c == '\'' || c == '’' {
            start.get_or_insert(offset);
        } else if let Some(begin) = start.take() {
            let word = text[begin..offset].to_lowercase();
            if TRIGGER_SPELLINGS.contains(&word.as_str()) {
                let command = text[offset..]
                    .trim_start_matches(|c: char| c.is_whitespace() || c.is_ascii_punctuation());
                return (!command.is_empty()).then(|| command.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_whole_wake_word_can_authorize_a_command() {
        for text in [
            "open Safari",
            "keep my computer awake for two hours",
            "Kentucky open Safari",
            "Tucky",
            "Tucky's settings",
        ] {
            assert_eq!(command_from_transcript(text), None, "{text}");
        }
        assert_eq!(
            command_from_transcript("earlier conversation. Tucky, open Safari"),
            Some("open Safari".into())
        );
        assert_eq!(
            command_from_transcript("Tuckie, save a task: test this"),
            Some("save a task: test this".into())
        );
    }
    #[test]
    fn common_asr_misspellings_of_tucky_still_trigger() {
        for text in ["Taki, remind me to redo the catalog page", "Tacky remind me to redo the catalog page"] {
            assert_eq!(
                command_from_transcript(text),
                Some("remind me to redo the catalog page".into()),
                "{text}"
            );
        }
        assert_eq!(command_from_transcript("Take my computer awake"), None);
    }
    #[test]
    fn a_request_can_mention_tucky_without_losing_its_contents() {
        assert_eq!(
            command_from_transcript("Tucky, save a task: update Tucky tomorrow."),
            Some("save a task: update Tucky tomorrow.".into())
        );
        assert_eq!(
            command_from_transcript("Tucky,save a note: hello"),
            Some("save a note: hello".into())
        );
    }
    #[test]
    fn endpoint_waits_for_request_then_a_natural_pause() {
        let mut e = Endpoint::default();
        assert!(!e.feed(&vec![0.0; 16_000 * 3], 16_000));
        assert!(!e.feed(&vec![0.1; 8_000], 16_000));
        assert!(!e.feed(&vec![0.0; 16_000], 16_000));
        assert!(e.feed(&vec![0.0; 4_800], 16_000));
    }
    #[test]
    fn wake_without_a_request_times_out_and_capture_is_bounded() {
        assert!(Endpoint::default().feed(&vec![0.0; 80_000], 16_000));
        let mut e = Endpoint::default();
        for _ in 0..29 {
            assert!(!e.feed(&vec![0.1; 16_000], 16_000));
        }
        assert!(e.feed(&vec![0.1; 16_000], 16_000));
    }

    #[test]
    fn wake_yields_to_every_busy_pipeline_and_capture_interrupt() {
        assert_eq!(gate(true, false, &PipelineState::Idle), Gate::Listen);
        for state in [
            PipelineState::Recording(Action::VoiceAtCursor),
            PipelineState::Recording(Action::EditSelection),
            PipelineState::Processing(Action::VoiceAtCursor),
            PipelineState::Processing(Action::WakeCommand),
            PipelineState::AwaitingConfirmation,
        ] {
            assert_eq!(gate(true, false, &state), Gate::Pause, "{state:?}");
        }
        let capturing = PipelineState::Recording(Action::WakeCommand);
        assert_eq!(gate(true, false, &capturing), Gate::Listen);
        assert_eq!(gate(false, false, &capturing), Gate::Cancel);
        assert_eq!(gate(true, true, &capturing), Gate::Cancel);
        assert_eq!(gate(true, true, &PipelineState::Idle), Gate::Pause);
        assert_eq!(gate(false, false, &PipelineState::Idle), Gate::Pause);
    }
}
