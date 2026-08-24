//! Local IPC bridge that lets the `--mcp` stdio process (see `mcp.rs`) drive
//! screen recording in the running GUI app. The GUI app is the only process
//! holding the Screen Recording / Camera TCC grants and the sidecar
//! supervision, so recording tools are forwarded here over a unix socket.
//!
//! Protocol: one request per connection, newline-delimited JSON both ways.
//! Request `{"method":"...","params":{...}}` → response
//! `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`.
//!
//! Every request is gated on the persisted `mcp_recording_enabled` setting
//! (mirrored into an atomic so toggling takes effect without a restart). The
//! socket lives in the app-support dir with 0600 permissions, so only the
//! logged-in user can reach it.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracing::{error, info, warn};

static RECORDING_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_recording_enabled(on: bool) {
    RECORDING_ENABLED.store(on, Ordering::SeqCst);
}

fn recording_enabled() -> bool {
    RECORDING_ENABLED.load(Ordering::SeqCst)
}

/// `~/Library/Application Support/EchoScribe/mcp-bridge.sock` — shared with the
/// `--mcp` client in `mcp.rs`, which connects to it from a separate process.
pub fn socket_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    let dir = home
        .join("Library")
        .join("Application Support")
        .join(crate::data_folder_name());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mcp-bridge.sock"))
}

/// Bind the bridge socket and serve requests for the life of the process.
/// Spawned once from `setup`. The app quits via `libc::_exit(0)`, so a stale
/// socket file from the previous run is expected — always unlink first.
pub fn spawn(app: AppHandle<Wry>) {
    std::thread::spawn(move || {
        let path = match socket_path() {
            Ok(p) => p,
            Err(e) => {
                error!(target: "mcp", %e, "bridge socket path unavailable; recording tools disabled");
                return;
            }
        };
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                error!(target: "mcp", %e, "bridge socket bind failed; recording tools disabled");
                return;
            }
        };
        if let Err(e) =
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        {
            warn!(target: "mcp", %e, "bridge socket chmod failed");
        }
        info!(target: "mcp", path = %path.display(), "mcp bridge listening");
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    let app = app.clone();
                    std::thread::spawn(move || handle_conn(&app, stream));
                }
                Err(e) => warn!(target: "mcp", %e, "bridge accept failed"),
            }
        }
    });
}

fn handle_conn(app: &AppHandle<Wry>, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            warn!(target: "mcp", %e, "bridge stream clone failed");
            return;
        }
    });
    let mut line = String::new();
    if let Err(e) = reader.read_line(&mut line) {
        warn!(target: "mcp", %e, "bridge read failed");
        return;
    }
    let response = match serde_json::from_str::<Value>(&line) {
        Ok(request) => {
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            match dispatch(app, &method, &params) {
                Ok(result) => json!({"ok": true, "result": result}),
                Err(e) => {
                    warn!(target: "mcp", method = %method, err = %e, "bridge request failed");
                    json!({"ok": false, "error": e})
                }
            }
        }
        Err(e) => json!({"ok": false, "error": format!("invalid request: {e}")}),
    };
    let mut stream = stream;
    let _ = writeln!(stream, "{response}");
}

fn dispatch(app: &AppHandle<Wry>, method: &str, params: &Value) -> Result<Value, String> {
    if !recording_enabled() {
        return Err(
            "The 'Screen recording' permission for coding agents is turned off. Ask the user \
             to enable it in Echo Scribe → Settings → Coding Agents."
                .to_string(),
        );
    }
    info!(target: "mcp", method, "bridge request");
    match method {
        "list_sources" => list_sources(),
        "start_recording" => start_recording(app, params),
        "stop_recording" => stop_recording(app),
        "status" => status(app),
        _ => Err(format!("unknown bridge method: {method}")),
    }
}

/// Windows + displays, without the picker thumbnail paths (an MCP client has
/// no use for them and they bloat every listing).
fn list_sources() -> Result<Value, String> {
    let sources = crate::commands::list_screen_sources()?;
    Ok(json!({
        "displays": sources
            .displays
            .iter()
            .map(|d| json!({"id": d.id, "label": d.label, "width": d.width, "height": d.height}))
            .collect::<Vec<_>>(),
        "windows": sources
            .windows
            .iter()
            .map(|w| json!({"id": w.id, "app": w.app, "title": w.title, "width": w.width, "height": w.height, "on_screen": w.on_screen}))
            .collect::<Vec<_>>(),
    }))
}

fn start_recording(app: &AppHandle<Wry>, params: &Value) -> Result<Value, String> {
    let window_id = params.get("window_id").and_then(Value::as_u64).map(|v| v as u32);
    let display_id = params.get("display_id").and_then(Value::as_u64).map(|v| v as u32);
    let mic = params.get("mic").and_then(Value::as_bool).unwrap_or(false);
    let sysaudio = params
        .get("system_audio")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let camera = params.get("camera").and_then(Value::as_bool).unwrap_or(false);

    let sources = crate::commands::list_screen_sources()?;
    let mut warnings: Vec<String> = Vec::new();

    // Resolve the capture target + a human-readable label, mirroring what the
    // setup window builds so MCP recordings look native in the library.
    let (display_id, window_id, source_label) = if let Some(id) = window_id {
        let win = sources.windows.iter().find(|w| w.id == id).ok_or_else(|| {
            format!("window {id} not found — call list_recording_sources for current window ids")
        })?;
        if !win.on_screen {
            warnings.push(
                "target window is off-screen (another Space, or minimized): frames are only \
                 captured when its content updates, so the video may come out empty — bring \
                 the window on-screen for reliable capture"
                    .into(),
            );
        }
        (None, Some(id), format!("{} — {}", win.app, win.title))
    } else {
        let display = match display_id {
            Some(id) => sources.displays.iter().find(|d| d.id == id).ok_or_else(|| {
                format!("display {id} not found — call list_recording_sources for current display ids")
            })?,
            None => sources
                .displays
                .first()
                .ok_or_else(|| "no displays available to record".to_string())?,
        };
        (Some(display.id), None, display.label.clone())
    };

    let state = app.state::<crate::commands::AppState>();

    // Mic on = the user's preferred recording mic if one is set, else the
    // system-default input device. MCP callers only say "mic: true".
    let mic_device = if mic {
        let preferred = state.settings.screenrec_mic_device();
        if !preferred.is_empty() {
            Some(preferred)
        } else {
            let devices = crate::audio::devices::list_input_devices();
            let name = devices
                .iter()
                .find(|d| d.is_system_default)
                .or_else(|| devices.first())
                .map(|d| d.name.clone());
            if name.is_none() {
                warnings.push("no microphone input device found; recording without mic".into());
            }
            name
        }
    } else {
        None
    };

    // Camera on = the user's preferred webcam if one is set, else the first
    // available camera. Same warn-and-continue policy as the setup flow.
    let camera_uid = if camera {
        let preferred = state.settings.screenrec_camera_uid();
        let uid = if !preferred.is_empty() {
            Some(preferred)
        } else {
            crate::screenrec::list_cameras()
                .ok()
                .and_then(|c| c.cameras.first().map(|c| c.uid.clone()))
        };
        if uid.is_none() {
            warnings.push("no camera found; recording without webcam".into());
        }
        uid
    } else {
        None
    };

    tauri::async_runtime::block_on(crate::commands::start_screen_recording_inner(
        &state,
        app,
        display_id,
        window_id,
        mic_device.clone(),
        sysaudio,
        source_label.clone(),
        None,
        camera_uid.clone(),
        None,
    ))?;

    Ok(json!({
        "started": true,
        "source_label": source_label,
        "mic_device": mic_device,
        "system_audio": sysaudio,
        "camera_uid": camera_uid,
        "warnings": warnings,
    }))
}

fn stop_recording(app: &AppHandle<Wry>) -> Result<Value, String> {
    let state = app.state::<crate::commands::AppState>();
    let row = crate::commands::stop_screen_recording_inner(&state, app)?;
    // Match the stop command's side effects so an MCP-stopped recording
    // behaves identically: UI refresh + background denoise.
    let _ = app.emit("screenrec-changed", ());
    crate::commands::spawn_auto_denoise(app.clone(), row.id.clone());
    // Auto-denoise runs in the background and, when it succeeds, replaces the
    // recording with `<id>.cleaned.mp4` (deleting the original). Hand the MCP
    // client both paths so it can fall back if video_path has been swapped by
    // the time it reads the file.
    let cleaned_video_path = std::path::Path::new(&row.file_path)
        .parent()
        .map(|dir| dir.join(format!("{}.cleaned.mp4", row.id)))
        .map(|p| p.to_string_lossy().into_owned());
    Ok(json!({
        "id": row.id,
        "video_path": row.file_path,
        "cleaned_video_path": cleaned_video_path,
        "note": "A background audio-cleanup pass may replace video_path with cleaned_video_path shortly after stop. If video_path is missing, use cleaned_video_path.",
        "webcam_video_path": row.webcam_path,
        "events_path": row.events_path,
        "duration_ms": row.duration_ms,
        "width": row.width,
        "height": row.height,
        "size_bytes": row.size_bytes,
        "source_label": row.source_label,
    }))
}

fn status(app: &AppHandle<Wry>) -> Result<Value, String> {
    let state = app.state::<crate::commands::AppState>();
    let guard = state
        .active_recording
        .lock()
        .map_err(|_| "lock poisoned".to_string())?;
    Ok(match guard.as_ref() {
        Some((handle, meta)) => json!({
            "recording": true,
            "paused": handle.is_paused(),
            "source_label": meta.source_label,
        }),
        None => json!({"recording": false}),
    })
}
