//! Beta: NVIDIA PersonaPlex-7B, a full-duplex speech-to-speech model (Moshi
//! architecture), driven through the `echo-scribe-personaplex` sidecar built by
//! `scripts/build-personaplex-sidecar.sh`.
//!
//! Why a sidecar: PersonaPlex is not a text LLM and cannot run on the llama.cpp
//! engine behind [`crate::llm`]. The only Apple-Silicon runtime is MLX
//! (speech-swift), so the model lives in its own Swift process that owns the
//! mic + speaker and streams JSON events back here (text tokens, levels, step
//! timing, errors). The sidecar is installed OUTSIDE the app bundle so nothing
//! about the beta touches `tauri.conf.json` or release CI.
//!
//! Gating: everything here is hidden unless [`beta_enabled`] is true — a
//! marker file in the data folder (or `ECHO_SCRIBE_BETA=1`), so the page only
//! exists on machines where it was deliberately switched on.
//!
//! Diagnostics: every sidecar stderr line and every event is logged under
//! `target: "personaplex"`; friendly strings go to the UI, raw detail stays in
//! the daily log.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

/// Public, ungated 8-bit MLX conversion (Mimi codec + voices + tokenizer
/// included). 4-bit exists but produces garbled speech — see speech-swift docs.
pub const MODEL_ID: &str = "aufklarer/PersonaPlex-7B-MLX-8bit";
/// Folder under `llm-models/` — kept next to the Gemma GGUFs so "models on
/// disk" stays one tree.
pub const MODEL_DIR_NAME: &str = "personaplex-7b-mlx-8bit";
/// Sum of the Hub file sizes (temporal 6.99 GB, depformer 1.38 GB, embeddings
/// 988 MB, mimi 385 MB, tokenizer, voices). Used for the disk-space check and
/// the "of N GB" label; the sidecar reports real byte-weighted progress.
pub const MODEL_SIZE_BYTES: u64 = 9_750_000_000;

pub const SIDECAR_NAME: &str = "echo-scribe-personaplex";
pub const BETA_MARKER_FILE: &str = "beta.enabled";

/// Files the sidecar downloads; all must be present for "downloaded".
const REQUIRED_FILES: &[&str] = &[
    "temporal.safetensors",
    "depformer.safetensors",
    "embeddings.safetensors",
    "mimi.safetensors",
    "tokenizer_spm_32k_3.model",
    "config.json",
];
const VOICE_COUNT: usize = 18;

pub const VOICES: &[(&str, &str)] = &[
    ("NATF0", "Natural female 0"),
    ("NATF1", "Natural female 1"),
    ("NATF2", "Natural female 2"),
    ("NATF3", "Natural female 3"),
    ("NATM0", "Natural male 0"),
    ("NATM1", "Natural male 1"),
    ("NATM2", "Natural male 2"),
    ("NATM3", "Natural male 3"),
    ("VARF0", "Variety female 0"),
    ("VARF1", "Variety female 1"),
    ("VARF2", "Variety female 2"),
    ("VARF3", "Variety female 3"),
    ("VARF4", "Variety female 4"),
    ("VARM0", "Variety male 0"),
    ("VARM1", "Variety male 1"),
    ("VARM2", "Variety male 2"),
    ("VARM3", "Variety male 3"),
    ("VARM4", "Variety male 4"),
];

// ---------------------------------------------------------------------------
// Paths + gating
// ---------------------------------------------------------------------------

fn data_root() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join(crate::data_folder_name())
}

/// `~/Library/Application Support/EchoScribe/beta.enabled`
pub fn beta_marker_path() -> PathBuf {
    data_root().join(BETA_MARKER_FILE)
}

/// True when the beta surface should exist at all. Checked per call (cheap
/// stat) so touching/removing the marker takes effect on the next Settings
/// open, no relaunch needed.
pub fn beta_enabled() -> bool {
    if std::env::var("ECHO_SCRIBE_BETA").map(|v| v == "1").unwrap_or(false) {
        return true;
    }
    beta_marker_path().is_file()
}

pub fn model_dir() -> PathBuf {
    crate::llm::model_storage_dir().join(MODEL_DIR_NAME)
}

/// Where the build script installs the sidecar.
pub fn sidecar_install_dir() -> PathBuf {
    data_root().join("personaplex").join("bin")
}

/// Sidecar lookup order: next to the app executable (if it is ever bundled),
/// the per-user install dir (build script), then the dev build tree.
pub fn resolve_sidecar() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(SIDECAR_NAME));
        }
    }
    candidates.push(sidecar_install_dir().join(SIDECAR_NAME));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(
            cwd.join("src-tauri/personaplex/.build/release")
                .join(SIDECAR_NAME),
        );
        candidates.push(cwd.join("personaplex/.build/release").join(SIDECAR_NAME));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn metallib_present(sidecar: &Path) -> bool {
    sidecar
        .parent()
        .map(|d| d.join("mlx.metallib").is_file())
        .unwrap_or(false)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SidecarVersion {
    #[serde(default)]
    pub sidecar: String,
    #[serde(default)]
    pub speech_swift: String,
    #[serde(default)]
    pub speech_swift_commit: String,
    #[serde(default)]
    pub built_at: String,
}

fn read_sidecar_version(sidecar: &Path) -> Option<SidecarVersion> {
    let path = sidecar.parent()?.join("version.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// All required weight files present + the 18 voice prompts. Pure over `dir`
/// so it is testable with a temp tree.
pub fn model_downloaded_in(dir: &Path) -> bool {
    if !REQUIRED_FILES.iter().all(|f| {
        std::fs::metadata(dir.join(f))
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
    }) {
        return false;
    }
    let voices = std::fs::read_dir(dir.join("voices"))
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|x| x == "safetensors")
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    voices >= VOICE_COUNT
}

pub fn model_downloaded() -> bool {
    model_downloaded_in(&model_dir())
}

/// Recursive byte count (includes the downloader's `.incomplete/` staging so a
/// paused download still shows as disk in use).
pub fn dir_bytes_recursive(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            match e.metadata() {
                Ok(m) if m.is_dir() => dir_bytes_recursive(&p),
                Ok(m) if m.is_file() => m.len(),
                _ => 0,
            }
        })
        .sum()
}

// ---------------------------------------------------------------------------
// Sidecar events
// ---------------------------------------------------------------------------

/// Parsed `event` kind of one sidecar stdout line. Everything is forwarded to
/// the frontend verbatim; this classification only drives logging + the
/// supervisor's own bookkeeping.
#[derive(Debug, Clone, PartialEq)]
pub enum SidecarEvent {
    Hello,
    Progress { fraction: f64 },
    Done,
    Loading { fraction: f64, status: String },
    Warming,
    Ready,
    Text(String),
    Level,
    Stats { step: u64, ms_per_step: f64 },
    Log { level: String, msg: String },
    Error(String),
    Stopped { reason: String },
    Other(String),
}

pub fn parse_event(line: &str) -> Option<(serde_json::Value, SidecarEvent)> {
    let val: serde_json::Value = serde_json::from_str(line).ok()?;
    let kind = val.get("event")?.as_str()?.to_string();
    let s = |k: &str| val.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let f = |k: &str| val.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let ev = match kind.as_str() {
        "hello" => SidecarEvent::Hello,
        "progress" => SidecarEvent::Progress {
            fraction: f("fraction"),
        },
        "done" => SidecarEvent::Done,
        "loading" => SidecarEvent::Loading {
            fraction: f("fraction"),
            status: s("status"),
        },
        "warming" => SidecarEvent::Warming,
        "ready" => SidecarEvent::Ready,
        "text" => SidecarEvent::Text(s("text")),
        "level" => SidecarEvent::Level,
        "stats" => SidecarEvent::Stats {
            step: val.get("step").and_then(|v| v.as_u64()).unwrap_or(0),
            ms_per_step: f("ms_per_step"),
        },
        "log" => SidecarEvent::Log {
            level: s("level"),
            msg: s("msg"),
        },
        "error" => SidecarEvent::Error(s("msg")),
        "stopped" => SidecarEvent::Stopped { reason: s("reason") },
        other => SidecarEvent::Other(other.to_string()),
    };
    Some((val, ev))
}

/// Short, human message for a sidecar failure. The raw text is already in the
/// log; the UI gets a hint about the likely cause + where to look.
pub fn friendly_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("offline cache miss") || lower.contains("no such file") {
        "PersonaPlex weights are missing or incomplete. Download the model again.".to_string()
    } else if lower.contains("microphone") || lower.contains("speaker") || lower.contains("audio") {
        "Couldn't start the microphone or speaker. Check Tucky's microphone permission and \
         that an input device is connected. Details: Settings → Diagnostics → logs."
            .to_string()
    } else if lower.contains("network") || lower.contains("url") || lower.contains("http") || lower.contains("connection") {
        "Download failed — connection problem. Click Download again; it resumes where it stopped."
            .to_string()
    } else if lower.contains("metal") || lower.contains("mlx") {
        "The MLX runtime failed on the GPU. Rebuild the sidecar (scripts/build-personaplex-sidecar.sh) \
         and see Settings → Diagnostics → logs."
            .to_string()
    } else {
        "PersonaPlex sidecar failed. See Settings → Diagnostics → logs for details.".to_string()
    }
}

// ---------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------

struct Running {
    child: Child,
    /// Kept open for the session's lifetime; the sidecar exits on EOF, so a
    /// Tucky crash never leaves an orphan holding the mic.
    stdin: Option<std::process::ChildStdin>,
    started: Instant,
}

static DOWNLOAD: Mutex<Option<Running>> = Mutex::new(None);
static SESSION: Mutex<Option<Running>> = Mutex::new(None);

fn lock<'a>(m: &'a Mutex<Option<Running>>) -> std::sync::MutexGuard<'a, Option<Running>> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn is_running(m: &Mutex<Option<Running>>) -> bool {
    let mut g = lock(m);
    match g.as_mut() {
        Some(r) => match r.child.try_wait() {
            Ok(Some(_)) => {
                *g = None;
                false
            }
            Ok(None) => true,
            Err(_) => false,
        },
        None => false,
    }
}

/// SIGTERM, wait up to `grace`, then SIGKILL. Closes stdin first so a healthy
/// sidecar can wind down on its own.
fn terminate(r: &mut Running, grace: Duration, what: &str) {
    drop(r.stdin.take());
    #[cfg(unix)]
    unsafe {
        libc::kill(r.child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    loop {
        match r.child.try_wait() {
            Ok(Some(status)) => {
                info!(target: "personaplex", %what, ?status, "sidecar exited after stop");
                return;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => break,
            Err(e) => {
                warn!(target: "personaplex", %what, error = %e, "try_wait failed");
                break;
            }
        }
    }
    warn!(target: "personaplex", %what, "sidecar ignored SIGTERM; killing");
    let _ = r.child.kill();
    let _ = r.child.wait();
}

fn spawn_sidecar(args: &[String]) -> Result<Running, String> {
    let Some(bin) = resolve_sidecar() else {
        return Err("PersonaPlex sidecar is not installed. Run scripts/build-personaplex-sidecar.sh."
            .to_string());
    };
    info!(target: "personaplex", path = %bin.display(), ?args, "spawning sidecar");
    let mut child = Command::new(&bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!(target: "personaplex", error = %e, path = %bin.display(), "spawn failed");
            format!("Couldn't launch the PersonaPlex sidecar: {e}")
        })?;
    let stdin = child.stdin.take();
    Ok(Running {
        child,
        stdin,
        started: Instant::now(),
    })
}

/// Drain stderr on its own thread into the log (and mirror to the UI channel
/// so the beta page's raw log pane shows it too).
fn pump_stderr(stderr: std::process::ChildStderr, app: AppHandle, channel: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            info!(target: "personaplex", "[sidecar stderr] {line}");
            let _ = app.emit(
                channel,
                serde_json::json!({ "event": "stderr", "line": line }),
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Runs the sidecar in `download` mode to completion (blocking; call from
/// `spawn_blocking`). Progress → `personaplex:download` events.
fn run_download_blocking(app: AppHandle) -> Result<(), String> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(|e| {
        error!(target: "personaplex", error = %e, dir = %dir.display(), "create model dir failed");
        "Couldn't create the model folder. See Settings → Diagnostics → logs.".to_string()
    })?;
    let needed = MODEL_SIZE_BYTES.saturating_sub(dir_bytes_recursive(&dir));
    crate::download::ensure_disk_space(&dir, needed).map_err(|e| {
        error!(target: "personaplex", error = %e, "disk space check failed");
        e.friendly()
    })?;

    let args = vec![
        "download".to_string(),
        "--model-dir".to_string(),
        dir.to_string_lossy().to_string(),
        "--model-id".to_string(),
        MODEL_ID.to_string(),
    ];
    let mut running = spawn_sidecar(&args)?;
    let stdout = running.child.stdout.take().expect("piped stdout");
    if let Some(stderr) = running.child.stderr.take() {
        pump_stderr(stderr, app.clone(), "personaplex:download");
    }
    {
        let mut g = lock(&DOWNLOAD);
        if let Some(mut prev) = g.take() {
            terminate(&mut prev, Duration::from_secs(2), "download(previous)");
        }
        *g = Some(running);
    }

    let mut failure: Option<String> = None;
    let mut last_logged_pct: i64 = -1;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Some((val, ev)) = parse_event(&line) else {
            warn!(target: "personaplex", line, "non-JSON sidecar stdout line (download)");
            continue;
        };
        match &ev {
            SidecarEvent::Progress { fraction } => {
                let pct = (fraction * 100.0).floor() as i64;
                if pct / 5 != last_logged_pct / 5 {
                    info!(target: "personaplex", pct, "download progress");
                    last_logged_pct = pct;
                }
            }
            SidecarEvent::Error(msg) => {
                error!(target: "personaplex", msg, "download error from sidecar");
                failure = Some(msg.clone());
            }
            SidecarEvent::Done => info!(target: "personaplex", "download complete"),
            SidecarEvent::Log { level, msg } => info!(target: "personaplex", level, "[sidecar] {msg}"),
            other => info!(target: "personaplex", ?other, "download event"),
        }
        let _ = app.emit("personaplex:download", &val);
    }

    let status = {
        let mut g = lock(&DOWNLOAD);
        let status = g.as_mut().map(|r| r.child.wait());
        *g = None;
        status
    };
    let downloaded = model_downloaded();
    info!(target: "personaplex", ?status, downloaded, bytes = dir_bytes_recursive(&model_dir()), "download finished");
    let _ = app.emit(
        "personaplex:download",
        serde_json::json!({ "event": "exited", "downloaded": downloaded }),
    );
    if downloaded {
        return Ok(());
    }
    match failure {
        Some(raw) => Err(friendly_error(&raw)),
        None => Err(
            "Download stopped before all files were verified. Click Download to resume.".to_string(),
        ),
    }
}

// ---------------------------------------------------------------------------
// Chat session
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ChatOptions {
    pub voice: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default = "default_true")]
    pub echo_cancellation: bool,
}

fn default_true() -> bool {
    true
}

fn start_chat_inner(app: AppHandle, opts: ChatOptions) -> Result<(), String> {
    if !VOICES.iter().any(|(id, _)| *id == opts.voice) {
        return Err(format!("Unknown voice '{}'.", opts.voice));
    }
    if !model_downloaded() {
        return Err("Download the PersonaPlex model first.".to_string());
    }
    if is_running(&SESSION) {
        return Err("A PersonaPlex session is already running. Stop it first.".to_string());
    }
    let mut args = vec![
        "chat".to_string(),
        "--model-dir".to_string(),
        model_dir().to_string_lossy().to_string(),
        "--model-id".to_string(),
        MODEL_ID.to_string(),
        "--voice".to_string(),
        opts.voice.clone(),
    ];
    let prompt = opts.prompt.trim();
    if !prompt.is_empty() {
        args.push("--prompt".to_string());
        args.push(prompt.to_string());
    }
    if !opts.echo_cancellation {
        args.push("--no-aec".to_string());
    }
    info!(
        target: "personaplex",
        voice = %opts.voice,
        prompt_chars = prompt.len(),
        aec = opts.echo_cancellation,
        "starting chat session"
    );
    let mut running = spawn_sidecar(&args)?;
    let stdout = running.child.stdout.take().expect("piped stdout");
    if let Some(stderr) = running.child.stderr.take() {
        pump_stderr(stderr, app.clone(), "personaplex:event");
    }
    let pid = running.child.id();
    *lock(&SESSION) = Some(running);

    // Event pump: stdout JSON lines → frontend + log. Ends at EOF, then reaps
    // the child and reports its exit so the UI can never get stuck in "running".
    let app_events = app.clone();
    std::thread::spawn(move || {
        let mut text_chars: usize = 0;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Some((val, ev)) = parse_event(&line) else {
                warn!(target: "personaplex", line, "non-JSON sidecar stdout line (chat)");
                continue;
            };
            match &ev {
                SidecarEvent::Text(t) => text_chars += t.len(),
                SidecarEvent::Level => {}
                SidecarEvent::Stats { step, ms_per_step } => {
                    info!(target: "personaplex", step, ms_per_step = format!("{ms_per_step:.1}"), text_chars, "session stats")
                }
                SidecarEvent::Loading { fraction, status } => {
                    info!(target: "personaplex", pct = (fraction * 100.0) as u32, status, "loading")
                }
                SidecarEvent::Error(msg) => error!(target: "personaplex", msg, "session error from sidecar"),
                SidecarEvent::Log { level, msg } => info!(target: "personaplex", level, "[sidecar] {msg}"),
                other => info!(target: "personaplex", ?other, "session event"),
            }
            let _ = app_events.emit("personaplex:event", &val);
        }
        let (status, uptime) = {
            let mut g = lock(&SESSION);
            let out = match g.as_mut() {
                Some(r) if r.child.id() == pid => {
                    let st = r.child.wait().ok();
                    let up = r.started.elapsed();
                    (st, up)
                }
                _ => (None, Duration::ZERO),
            };
            if matches!(g.as_ref(), Some(r) if r.child.id() == pid) {
                *g = None;
            }
            out
        };
        let code = status.and_then(|s| s.code());
        info!(target: "personaplex", ?code, uptime_secs = uptime.as_secs(), text_chars, "session ended");
        let _ = app_events.emit(
            "personaplex:event",
            serde_json::json!({ "event": "exited", "code": code, "uptime_secs": uptime.as_secs() }),
        );
    });
    Ok(())
}

fn stop_chat_inner() -> Result<(), String> {
    let mut g = lock(&SESSION);
    let Some(mut r) = g.take() else {
        return Ok(());
    };
    // Polite first: the sidecar treats "stop" on stdin like a signal.
    if let Some(stdin) = r.stdin.as_mut() {
        let _ = stdin.write_all(b"stop\n");
        let _ = stdin.flush();
    }
    terminate(&mut r, Duration::from_secs(3), "chat");
    Ok(())
}

/// Called on app shutdown so the sidecar never outlives Tucky.
pub fn shutdown() {
    let _ = stop_chat_inner();
    let mut g = lock(&DOWNLOAD);
    if let Some(mut r) = g.take() {
        terminate(&mut r, Duration::from_secs(1), "download");
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct VoiceInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonaplexStatus {
    pub beta: bool,
    pub beta_marker_path: String,
    pub sidecar_installed: bool,
    pub sidecar_path: Option<String>,
    pub sidecar_install_dir: String,
    pub sidecar_version: Option<SidecarVersion>,
    pub metallib_present: bool,
    pub model_id: String,
    pub model_dir: String,
    pub model_downloaded: bool,
    pub model_bytes_on_disk: u64,
    pub model_size_bytes: u64,
    pub downloading: bool,
    pub session_running: bool,
    pub voices: Vec<VoiceInfo>,
    pub total_ram_bytes: u64,
}

fn total_ram_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut size: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let name = std::ffi::CString::new("hw.memsize").expect("static");
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                &mut size as *mut u64 as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 {
            return size;
        }
    }
    0
}

#[tauri::command]
pub fn beta_features_enabled() -> bool {
    beta_enabled()
}

#[tauri::command]
pub fn personaplex_status() -> PersonaplexStatus {
    let sidecar = resolve_sidecar();
    let dir = model_dir();
    PersonaplexStatus {
        beta: beta_enabled(),
        beta_marker_path: beta_marker_path().to_string_lossy().to_string(),
        sidecar_installed: sidecar.is_some(),
        sidecar_path: sidecar.as_ref().map(|p| p.to_string_lossy().to_string()),
        sidecar_install_dir: sidecar_install_dir().to_string_lossy().to_string(),
        sidecar_version: sidecar.as_ref().and_then(|p| read_sidecar_version(p)),
        metallib_present: sidecar.as_ref().map(|p| metallib_present(p)).unwrap_or(false),
        model_id: MODEL_ID.to_string(),
        model_dir: dir.to_string_lossy().to_string(),
        model_downloaded: model_downloaded_in(&dir),
        model_bytes_on_disk: dir_bytes_recursive(&dir),
        model_size_bytes: MODEL_SIZE_BYTES,
        downloading: is_running(&DOWNLOAD),
        session_running: is_running(&SESSION),
        voices: VOICES
            .iter()
            .map(|(id, label)| VoiceInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
            })
            .collect(),
        total_ram_bytes: total_ram_bytes(),
    }
}

#[tauri::command]
pub async fn personaplex_download(app: AppHandle) -> Result<(), String> {
    if !beta_enabled() {
        return Err("Beta features are not enabled on this machine.".to_string());
    }
    if is_running(&DOWNLOAD) {
        return Err("A download is already running.".to_string());
    }
    if is_running(&SESSION) {
        return Err("Stop the running PersonaPlex session before downloading.".to_string());
    }
    tokio::task::spawn_blocking(move || run_download_blocking(app))
        .await
        .map_err(|e| {
            error!(target: "personaplex", error = %e, "download task panicked");
            "Download task crashed. See Settings → Diagnostics → logs.".to_string()
        })?
}

#[tauri::command]
pub fn personaplex_cancel_download() -> Result<(), String> {
    let mut g = lock(&DOWNLOAD);
    if let Some(mut r) = g.take() {
        info!(target: "personaplex", "cancelling download (partial files are kept for resume)");
        terminate(&mut r, Duration::from_secs(2), "download");
    }
    Ok(())
}

#[tauri::command]
pub fn personaplex_delete_model() -> Result<(), String> {
    if is_running(&SESSION) || is_running(&DOWNLOAD) {
        return Err("Stop the session or download before deleting the model.".to_string());
    }
    let dir = model_dir();
    if dir.is_dir() {
        let bytes = dir_bytes_recursive(&dir);
        std::fs::remove_dir_all(&dir).map_err(|e| {
            error!(target: "personaplex", error = %e, dir = %dir.display(), "delete model failed");
            "Couldn't delete the model folder. See Settings → Diagnostics → logs.".to_string()
        })?;
        info!(target: "personaplex", bytes, dir = %dir.display(), "deleted model");
    }
    Ok(())
}

#[tauri::command]
pub fn personaplex_start_chat(app: AppHandle, opts: ChatOptions) -> Result<(), String> {
    if !beta_enabled() {
        return Err("Beta features are not enabled on this machine.".to_string());
    }
    start_chat_inner(app, opts)
}

#[tauri::command]
pub fn personaplex_stop_chat() -> Result<(), String> {
    info!(target: "personaplex", "stop requested from UI");
    stop_chat_inner()
}

#[tauri::command]
pub fn personaplex_open_model_folder() -> Result<(), String> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Couldn't open folder: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_and_text_events() {
        let (_, ev) = parse_event(r#"{"event":"progress","fraction":0.25}"#).unwrap();
        assert_eq!(ev, SidecarEvent::Progress { fraction: 0.25 });
        let (val, ev) = parse_event(r#"{"event":"text","text":" hello","token":42}"#).unwrap();
        assert_eq!(ev, SidecarEvent::Text(" hello".into()));
        assert_eq!(val["token"], 42);
        let (_, ev) = parse_event(r#"{"event":"stopped","reason":"signal","steps":10}"#).unwrap();
        assert_eq!(ev, SidecarEvent::Stopped { reason: "signal".into() });
        assert!(parse_event("not json").is_none());
        assert!(parse_event(r#"{"noevent":1}"#).is_none());
        let (_, ev) = parse_event(r#"{"event":"brand-new"}"#).unwrap();
        assert_eq!(ev, SidecarEvent::Other("brand-new".into()));
    }

    #[test]
    fn model_downloaded_requires_all_files_and_voices() {
        let tmp = std::env::temp_dir().join(format!("pp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("voices")).unwrap();
        assert!(!model_downloaded_in(&tmp));
        for f in REQUIRED_FILES {
            std::fs::write(tmp.join(f), b"x").unwrap();
        }
        assert!(!model_downloaded_in(&tmp), "voices still missing");
        for (id, _) in VOICES {
            std::fs::write(tmp.join("voices").join(format!("{id}.safetensors")), b"x").unwrap();
        }
        assert!(model_downloaded_in(&tmp));
        // An empty weight file is not "downloaded".
        std::fs::write(tmp.join("mimi.safetensors"), b"").unwrap();
        assert!(!model_downloaded_in(&tmp));
        assert_eq!(dir_bytes_recursive(&tmp), (REQUIRED_FILES.len() - 1 + VOICES.len()) as u64);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn friendly_errors_route_by_cause() {
        assert!(friendly_error("offline cache miss: no model weights").contains("Download"));
        assert!(friendly_error("microphone/speaker setup failed: boom").contains("microphone"));
        assert!(friendly_error("something odd").contains("Diagnostics"));
    }

    #[test]
    fn voice_table_has_eighteen_unique_ids() {
        let mut ids: Vec<&str> = VOICES.iter().map(|(id, _)| *id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), VOICE_COUNT);
    }

    #[test]
    fn model_dir_lives_under_llm_models() {
        assert!(model_dir().ends_with(format!("llm-models/{MODEL_DIR_NAME}")));
    }
}
