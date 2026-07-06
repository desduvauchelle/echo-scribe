//! Supervises the `echo-scribe-screenrec` sidecar: spawn, read stderr JSON
//! events, finalize on SIGTERM. Mirrors `meeting/syscap.rs`.

pub mod drive;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

// ----- Source enumeration types -----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplaySource {
    pub id: u32,
    pub width: i64,
    pub height: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowSource {
    pub id: u32,
    pub app: String,
    pub title: String,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub thumb: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Sources {
    pub displays: Vec<DisplaySource>,
    pub windows: Vec<WindowSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraSource {
    pub uid: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Cameras {
    pub cameras: Vec<CameraSource>,
}

/// Parse the JSON stdout of `--list-cameras` into [`Cameras`].
pub fn parse_cameras(stdout: &str) -> Result<Cameras, String> {
    serde_json::from_str::<Cameras>(stdout.trim()).map_err(|e| e.to_string())
}

/// Parse the JSON stdout of `--list-sources` into [`Sources`].
pub fn parse_sources(stdout: &str) -> Result<Sources, String> {
    serde_json::from_str::<Sources>(stdout.trim()).map_err(|e| e.to_string())
}

/// Build a user-facing message from a failed `--list-sources` run. The raw
/// sidecar detail is logged by the caller; the returned string is safe to show
/// in the UI (short, human, no JSON/stack traces).
fn list_sources_error(stderr: &str) -> String {
    // The sidecar emits its failure reason on stderr as
    // `{"event":"error","kind":"list_sources","msg":"..."}`. Pull the msg out
    // and special-case the Screen Recording permission denial, which is by far
    // the most common cause (e.g. after the app bundle is replaced).
    let sidecar_msg = stderr.lines().rev().find_map(|line| {
        let val: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        if val.get("event").and_then(|v| v.as_str()) == Some("error") {
            val.get("msg").and_then(|v| v.as_str()).map(|s| s.to_string())
        } else {
            None
        }
    });
    if let Some(msg) = &sidecar_msg {
        let low = msg.to_lowercase();
        if low.contains("tcc") || low.contains("declined") || low.contains("permission") {
            return "Screen Recording permission is needed to list windows and displays. \
                    Enable Echo Scribe in System Settings → Privacy & Security → Screen Recording, \
                    then fully quit and reopen Echo Scribe."
                .to_string();
        }
    }
    "Couldn't list screens and windows. See Settings → Diagnostics → logs for details.".to_string()
}

/// Invoke the sidecar with `--list-sources` and parse the result. On failure
/// (non-zero exit, empty output, or unparseable JSON) the sidecar's stderr is
/// captured and logged, and a friendly message is returned — never the raw
/// serde/`EOF` parse error.
pub fn list_sources() -> Result<Sources, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("--list-sources")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            warn!(target: "screenrec", error = %e, "failed to spawn --list-sources");
            "Couldn't start the screen-recording helper. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || stdout.trim().is_empty() {
        warn!(target: "screenrec", status = ?out.status.code(), stderr = %stderr.trim(),
              "--list-sources failed");
        return Err(list_sources_error(&stderr));
    }
    match parse_sources(&stdout) {
        Ok(s) => {
            info!(target: "screenrec", displays = s.displays.len(), windows = s.windows.len(),
                  "listed screen sources");
            Ok(s)
        }
        Err(e) => {
            warn!(target: "screenrec", error = %e, stderr = %stderr.trim(),
                  "failed to parse --list-sources output");
            Err(list_sources_error(&stderr))
        }
    }
}

/// Build a user-facing message from a failed `--list-cameras` run. Mirrors
/// `list_sources_error`: raw sidecar detail is logged by the caller, this
/// string is safe to show in the UI.
fn list_cameras_error(stderr: &str) -> String {
    let sidecar_msg = stderr.lines().rev().find_map(|line| {
        let val: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        if val.get("event").and_then(|v| v.as_str()) == Some("error") {
            val.get("msg").and_then(|v| v.as_str()).map(|s| s.to_string())
        } else {
            None
        }
    });
    if let Some(msg) = &sidecar_msg {
        let low = msg.to_lowercase();
        if low.contains("tcc") || low.contains("declined") || low.contains("permission") {
            return "Camera permission is needed to list webcams. \
                    Enable Echo Scribe in System Settings → Privacy & Security → Camera, \
                    then fully quit and reopen Echo Scribe."
                .to_string();
        }
    }
    "Couldn't list cameras. See Settings → Diagnostics → logs for details.".to_string()
}

/// Invoke the sidecar with `--list-cameras` and parse the result. On failure
/// (non-zero exit, empty output, or unparseable JSON) the sidecar's stderr is
/// captured and logged, and a friendly message is returned — never the raw
/// serde/`EOF` parse error. NOTE: the sidecar does not implement
/// `--list-cameras` yet (Task 7); until then this always returns the
/// friendly error, which is expected.
pub fn list_cameras() -> Result<Cameras, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("--list-cameras")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            warn!(target: "screenrec", error = %e, "failed to spawn --list-cameras");
            "Couldn't start the screen-recording helper. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || stdout.trim().is_empty() {
        warn!(target: "screenrec", status = ?out.status.code(), stderr = %stderr.trim(),
              "--list-cameras failed");
        return Err(list_cameras_error(&stderr));
    }
    match parse_cameras(&stdout) {
        Ok(c) => {
            info!(target: "screenrec", cameras = c.cameras.len(), "listed cameras");
            Ok(c)
        }
        Err(e) => {
            warn!(target: "screenrec", error = %e, stderr = %stderr.trim(),
                  "failed to parse --list-cameras output");
            Err(list_cameras_error(&stderr))
        }
    }
}

/// Extract a recording's audio track to a mono WAV at `out_wav`, resampled to
/// `rate` Hz. Returns `Ok(())` on success. The Err string is user-facing; the
/// special value `"no_audio"` is returned when the recording has no audio track
/// so the caller can show a friendly message.
pub fn extract_audio_at(
    mp4: &std::path::Path,
    out_wav: &std::path::Path,
    rate: u32,
) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("extract-audio")
        .arg("--in")
        .arg(mp4)
        .arg("--out")
        .arg(out_wav)
        .arg("--rate")
        .arg(rate.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        return Ok(());
    }

    // Inspect stderr for the structured error kind (scan from the last line).
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines().rev() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("event").and_then(|v| v.as_str()) == Some("error") {
                let kind = val.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                if kind == "no_audio" {
                    return Err("no_audio".into());
                }
                let msg = val.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
                return Err(format!("audio extraction failed: {msg}"));
            }
        }
    }
    Err(format!(
        "audio extraction failed (exit {:?})",
        out.status.code()
    ))
}

/// Back-compat: extract at 16kHz mono (used by the transcript pipeline).
pub fn extract_audio(mp4: &std::path::Path, out_wav: &std::path::Path) -> Result<(), String> {
    extract_audio_at(mp4, out_wav, 16_000)
}

/// Mux a cleaned audio WAV into the original video, writing a new mp4.
pub fn mux_audio(
    video: &std::path::Path,
    audio: &std::path::Path,
    out: &std::path::Path,
) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let res = Command::new(&bin)
        .arg("mux-audio")
        .arg("--video")
        .arg(video)
        .arg("--audio")
        .arg(audio)
        .arg("--out")
        .arg(out)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if res.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&res.stderr);
    for line in stderr.lines().rev() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("event").and_then(|v| v.as_str()) == Some("error") {
                let msg = val.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
                return Err(format!("audio mux failed: {msg}"));
            }
        }
    }
    Err(format!("audio mux failed (exit {:?})", res.status.code()))
}

/// Parsed `stopped` event payload from the sidecar.
#[derive(Debug, Clone, PartialEq)]
pub struct StoppedInfo {
    pub path: String,
    pub dur_ms: i64,
    pub width: i64,
    pub height: i64,
    pub size: i64,
    pub thumb: String,
    /// Path to the input-events JSONL sidecar file, if the sidecar recorded
    /// one. `None` when the field is missing or empty (e.g. the no-frames
    /// abort path, which emits a header-only file with `n_events: 0` but may
    /// omit `events` entirely).
    pub events_path: Option<String>,
    /// Total input events recorded (moves, clicks, scrolls, keys). `None` when
    /// the sidecar omits the field (older binaries / non-events runs). M3 will
    /// persist these; for now they're logged at the stop boundary.
    pub n_events: Option<i64>,
    /// Click-down events recorded (subset of `n_events`). `None` when absent.
    pub n_clicks: Option<i64>,
    /// Path to the recorded webcam MP4 sidecar file, if a camera was
    /// selected for this recording. `None` when the field is missing or
    /// empty (no `--camera` was passed to `start()`).
    pub webcam_path: Option<String>,
    /// Host-clock delta (ms) between the webcam file's start and the first
    /// main-capture frame; consumers shift the webcam timeline by this
    /// amount. `None` when the sidecar omits the field (no webcam recorded).
    pub webcam_offset_ms: Option<i64>,
}

/// Parse one line of sidecar stderr JSON into a `StoppedInfo`, if it is the
/// `stopped` event. Returns `None` for any other event or malformed line.
pub fn parse_stopped(line: &str) -> Option<StoppedInfo> {
    let val: serde_json::Value = serde_json::from_str(line).ok()?;
    if val.get("event")?.as_str()? != "stopped" {
        return None;
    }
    let events_path = val
        .get("events")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let webcam_path = val
        .get("webcam")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(StoppedInfo {
        path: val.get("path")?.as_str()?.to_string(),
        dur_ms: val.get("dur_ms").and_then(|v| v.as_i64()).unwrap_or(0),
        width: val.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        height: val.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        size: val.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
        thumb: val.get("thumb").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        events_path,
        n_events: val.get("n_events").and_then(|v| v.as_i64()),
        n_clicks: val.get("n_clicks").and_then(|v| v.as_i64()),
        webcam_path,
        webcam_offset_ms: val.get("webcam_offset_ms").and_then(|v| v.as_i64()),
    })
}

/// Parsed `done` event from an `export` run.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportDone {
    pub path: String,
    pub size: i64,
}

/// Parse one line of sidecar stderr JSON into an `ExportDone`, if it is the
/// `done` event. Returns `None` for any other event or malformed line.
pub fn parse_export_done(line: &str) -> Option<ExportDone> {
    let val: serde_json::Value = serde_json::from_str(line).ok()?;
    if val.get("event")?.as_str()? != "done" {
        return None;
    }
    Some(ExportDone {
        path: val.get("path")?.as_str()?.to_string(),
        size: val.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

/// Transcode `in_path` to `out_path` at `quality` ("1080"|"720"|"480") by
/// running the sidecar's `export` sub-command. Blocks until it finishes.
/// Returns the finalized export info on success. Mirrors `extract_audio`.
pub fn export(in_path: &Path, out_path: &Path, quality: &str) -> Result<ExportDone, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("export")
        .arg("--in")
        .arg(in_path)
        .arg("--out")
        .arg(out_path)
        .arg("--quality")
        .arg(quality)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    // Success: find the `done` event (progress events precede it).
    for line in stderr.lines().rev() {
        if let Some(d) = parse_export_done(line) {
            return Ok(d);
        }
    }
    // Failure: surface the structured error if present.
    for line in stderr.lines().rev() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("event").and_then(|v| v.as_str()) == Some("error") {
                let msg = val.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
                return Err(format!("export failed: {msg}"));
            }
        }
    }
    Err(format!("export produced no output (exit {:?})", out.status.code()))
}

/// Resolve the bundled `echo-scribe-screenrec` sidecar, falling back to the
/// dev build. Mirrors `meeting/syscap.rs::resolve_binary`.
fn resolve_binary() -> std::io::Result<PathBuf> {
    let triple = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(format!("echo-scribe-screenrec-{}", triple));
            if candidate.exists() {
                return Ok(candidate);
            }
            let no_suffix = parent.join("echo-scribe-screenrec");
            if no_suffix.exists() {
                return Ok(no_suffix);
            }
        }
    }
    let cwd = std::env::current_dir()?;
    let dev = cwd
        .join("src-tauri/binaries")
        .join(format!("echo-scribe-screenrec-{}", triple));
    if dev.exists() {
        return Ok(dev);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "echo-scribe-screenrec binary not found",
    ))
}

/// `~/Library/Application Support/EchoScribe/recordings/`, created if missing.
pub fn recordings_dir() -> std::io::Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME not set"))?;
    let dir = PathBuf::from(home)
        .join("Library/Application Support/EchoScribe/recordings");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Parameters for a new recording session.
#[derive(Debug, Clone, Default)]
pub struct RecordParams {
    /// Capture a specific display by its SCDisplay id.
    pub display_id: Option<u32>,
    /// Capture a specific window by its SCWindow id.
    pub window_id: Option<u32>,
    /// Mic device name/uid to mix in (wired up in T3; pushed now so the flag
    /// round-trips through the sidecar's ignored-arg path).
    pub mic_device: Option<String>,
    /// Whether to capture system audio. Defaults to `true`.
    pub sysaudio: bool,
    /// Hide the system cursor during capture (`--hide-cursor`). Defaults to
    /// `false` so an unset value produces the exact same spawn as before
    /// this field existed.
    pub hide_cursor: bool,
    /// Camera device uid to record alongside the main capture (`--camera
    /// <uid>`). `None` means no webcam recording (identical spawn to today).
    pub camera_uid: Option<String>,
}

/// A running screen recording. Holds the child process and the path it is
/// writing to. Dropping it does not stop the recording — call `stop()`.
pub struct ScreenrecHandle {
    child: Child,
    pub out_path: PathBuf,
    stopped_rx: mpsc::Receiver<StoppedInfo>,
}

impl ScreenrecHandle {
    /// Spawn the sidecar to record to `out_path` with the given `params`.
    /// Waits up to 5s for the sidecar to confirm capture is `ready`
    /// (or report an `error` / exit early) before returning, so callers know
    /// the recording actually started rather than merely that the process spawned.
    pub fn start(out_path: PathBuf, params: RecordParams) -> Result<Self, String> {
        let bin = resolve_binary().map_err(|e| e.to_string())?;
        info!(path = %bin.display(), out = %out_path.display(), "spawning screenrec");
        // Derive the events sidecar path from `out_path`: same directory,
        // same stem, `.events.jsonl` suffix (e.g. `<id>.mp4` -> `<id>.events.jsonl`).
        // Assumes the id stem is dot-free (our ids are `rec-<millis>`); a stem
        // with a dot would have its trailing segment stripped by with_extension.
        let events_path = out_path.with_extension("").with_extension("events.jsonl");
        let mut cmd = Command::new(&bin);
        cmd.arg("record")
            .arg("--out")
            .arg(&out_path)
            .arg("--events")
            .arg(&events_path);
        // Source selection: window takes priority over display.
        if let Some(wid) = params.window_id {
            cmd.arg("--window").arg(wid.to_string());
        } else if let Some(did) = params.display_id {
            cmd.arg("--display").arg(did.to_string());
        }
        // Audio flags.
        if !params.sysaudio {
            cmd.arg("--no-sysaudio");
        }
        if let Some(ref uid) = params.mic_device {
            cmd.arg("--mic").arg(uid);
        }
        // Cursor + webcam flags: only appended when set, so a default
        // false/None call produces the exact same spawn as before these
        // params existed (the sidecar doesn't implement them yet).
        if params.hide_cursor {
            cmd.arg("--hide-cursor");
        }
        if let Some(ref uid) = params.camera_uid {
            cmd.arg("--camera").arg(uid);
        }
        let mut child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        let (tx, rx) = mpsc::channel::<StoppedInfo>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let stderr = child.stderr.take().expect("piped");
        let log_path = recordings_dir().ok().map(|d| d.join("screenrec-last.log"));
        let out_path_for_log = out_path.clone();
        std::thread::spawn(move || {
            let mut ready_reported = false;
            let mut log_file = log_path
                .as_ref()
                .and_then(|p| std::fs::File::create(p).ok());
            if let Some(f) = log_file.as_mut() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = writeln!(f, "=== start {} out={} ===", ts, out_path_for_log.display());
            }
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(f) = log_file.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
                if !ready_reported {
                    if line.contains("\"event\":\"ready\"") {
                        let _ = ready_tx.send(Ok(()));
                        ready_reported = true;
                    } else if line.contains("\"event\":\"error\"") {
                        let _ = ready_tx.send(Err(line.clone()));
                        ready_reported = true;
                    }
                }
                if let Some(info) = parse_stopped(&line) {
                    let _ = tx.send(info);
                    break;
                } else if line.contains("\"event\":\"error\"") {
                    warn!(line, "screenrec error event");
                }
            }
            // stderr closed (process exited) before ready: unblock start().
            if !ready_reported {
                let _ = ready_tx.send(Err("screenrec exited before ready".into()));
            }
        });

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self { child, out_path, stopped_rx: rx }),
            Ok(Err(e)) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(format!("screenrec failed to start: {e}"))
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                Err("screenrec did not become ready within 5s".into())
            }
        }
    }

    /// SIGTERM the sidecar and wait up to 10s for the `stopped` event (which
    /// arrives after AVAssetWriter finishes finalizing the MP4). Returns the
    /// finalized recording info.
    pub fn stop(mut self) -> Result<StoppedInfo, String> {
        // If the sidecar already exited (crashed mid-recording), don't block the
        // full timeout waiting for a `stopped` that will never arrive.
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return self
                .stopped_rx
                .recv_timeout(Duration::from_secs(1))
                .map_err(|_| "screenrec exited without finalizing".to_string());
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let info = self
            .stopped_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "screenrec did not finalize within 10s".to_string());

        // Reap the process regardless.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stopped_extracts_fields() {
        let line = r#"{"event":"stopped","path":"/tmp/a.mp4","dur_ms":4000,"width":3456,"height":2234,"size":99,"thumb":"/tmp/a.jpg"}"#;
        let got = parse_stopped(line).unwrap();
        assert_eq!(got.path, "/tmp/a.mp4");
        assert_eq!(got.dur_ms, 4000);
        assert_eq!(got.width, 3456);
        assert_eq!(got.thumb, "/tmp/a.jpg");
    }

    #[test]
    fn parse_stopped_ignores_other_events() {
        assert!(parse_stopped(r#"{"event":"ready"}"#).is_none());
        assert!(parse_stopped(r#"{"event":"heartbeat","ts":1.0}"#).is_none());
        assert!(parse_stopped("not json").is_none());
    }

    #[test]
    fn parse_stopped_extracts_events_path() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","events":"/r/a.events.jsonl","n_events":42,"n_clicks":3}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.events_path.as_deref(), Some("/r/a.events.jsonl"));
    }

    #[test]
    fn parse_stopped_events_optional() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.events_path, None);
    }

    #[test]
    fn parse_stopped_extracts_event_counts() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","events":"/r/a.events.jsonl","n_events":42,"n_clicks":3}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.n_events, Some(42));
        assert_eq!(info.n_clicks, Some(3));
    }

    #[test]
    fn parse_stopped_event_counts_optional() {
        // Older sidecar / no-events run omits n_events and n_clicks entirely.
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.n_events, None);
        assert_eq!(info.n_clicks, None);
    }

    #[test]
    fn parse_stopped_extracts_webcam_fields() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","webcam":"/r/a.webcam.mp4","webcam_offset_ms":120}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.webcam_path.as_deref(), Some("/r/a.webcam.mp4"));
        assert_eq!(info.webcam_offset_ms, Some(120));
    }

    #[test]
    fn parse_stopped_webcam_fields_absent() {
        // No --camera was passed to start(): sidecar omits both fields entirely.
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.webcam_path, None);
        assert_eq!(info.webcam_offset_ms, None);
    }

    #[test]
    fn parse_stopped_webcam_path_empty_string_is_none() {
        // Sidecar reports the key but with an empty value (no webcam file produced).
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","webcam":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.webcam_path, None);
    }

    #[test]
    fn parse_sources_reads_displays_and_windows() {
        let s = r#"{"displays":[{"id":1,"width":3840,"height":2160,"label":"Display 1"}],"windows":[{"id":42,"app":"Safari","title":"x","width":800,"height":600}]}"#;
        let got = parse_sources(s).unwrap();
        assert_eq!(got.displays.len(), 1);
        assert_eq!(got.windows[0].app, "Safari");
    }

    #[test]
    fn list_sources_error_detects_permission_denial() {
        // Exactly what the sidecar writes on stderr when Screen Recording is
        // not granted (observed live).
        let stderr = r#"{"event":"error","kind":"list_sources","msg":"The user declined TCCs for application, window, display capture"}"#;
        let msg = list_sources_error(stderr);
        assert!(msg.contains("Screen Recording permission"), "got: {msg}");
        assert!(msg.contains("System Settings"), "got: {msg}");
    }

    #[test]
    fn list_sources_error_generic_when_no_structured_error() {
        // Empty stderr (e.g. the helper died before emitting) -> generic,
        // never a raw serde/EOF error, and not the permission message.
        let msg = list_sources_error("");
        assert!(msg.contains("See Settings → Diagnostics"), "got: {msg}");
        assert!(!msg.contains("Screen Recording permission"), "got: {msg}");
    }

    #[test]
    fn parse_cameras_reads_uid_and_name() {
        let s = r#"{"cameras":[{"uid":"abc-123","name":"FaceTime HD Camera"}]}"#;
        let got = parse_cameras(s).unwrap();
        assert_eq!(got.cameras.len(), 1);
        assert_eq!(got.cameras[0].uid, "abc-123");
        assert_eq!(got.cameras[0].name, "FaceTime HD Camera");
    }

    #[test]
    fn parse_cameras_empty_list() {
        let s = r#"{"cameras":[]}"#;
        let got = parse_cameras(s).unwrap();
        assert!(got.cameras.is_empty());
    }

    #[test]
    fn list_cameras_error_detects_permission_denial() {
        let stderr = r#"{"event":"error","kind":"list_cameras","msg":"The user declined TCCs for camera capture"}"#;
        let msg = list_cameras_error(stderr);
        assert!(msg.contains("Camera permission"), "got: {msg}");
        assert!(msg.contains("System Settings"), "got: {msg}");
    }

    #[test]
    fn list_cameras_error_generic_when_no_structured_error() {
        // Expected until Task 7 ships --list-cameras: sidecar doesn't
        // recognize the flag yet, so stderr is empty/generic.
        let msg = list_cameras_error("");
        assert!(msg.contains("See Settings → Diagnostics"), "got: {msg}");
        assert!(!msg.contains("Camera permission"), "got: {msg}");
    }

    #[test]
    fn parse_export_done_extracts_fields() {
        let line = r#"{"event":"done","path":"/tmp/a-720.mp4","size":4242}"#;
        let got = parse_export_done(line).unwrap();
        assert_eq!(got.path, "/tmp/a-720.mp4");
        assert_eq!(got.size, 4242);
    }

    #[test]
    fn parse_export_done_ignores_other_events() {
        assert!(parse_export_done(r#"{"event":"progress","pct":50}"#).is_none());
        assert!(parse_export_done("not json").is_none());
    }
}
