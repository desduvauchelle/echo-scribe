//! Supervises the `echo-scribe-syscap` sidecar.
//! Reads raw Int16 PCM from stdout, surfaces stderr events, and respawns once on crash.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, PartialEq)]
pub enum SyscapEvent {
    Ready,
    Heartbeat { ts: f64 },
    Warn(String),
    Error { kind: String, msg: String },
    Exited(i32),
}

/// Frames of Int16 PCM samples (mono, 16 kHz) read from the sidecar.
pub type PcmFrame = Vec<i16>;

pub struct Syscap {
    child: Option<Child>,
    pub stop_flag: Arc<AtomicBool>,
}

impl Syscap {
    /// Resolve the bundled sidecar path inside the .app, or fall back to the dev build.
    fn resolve_binary() -> std::io::Result<std::path::PathBuf> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let triple = if cfg!(target_arch = "aarch64") {
                    "aarch64-apple-darwin"
                } else {
                    "x86_64-apple-darwin"
                };
                let candidate = parent.join(format!("echo-scribe-syscap-{}", triple));
                if candidate.exists() {
                    return Ok(candidate);
                }
                let no_suffix = parent.join("echo-scribe-syscap");
                if no_suffix.exists() {
                    return Ok(no_suffix);
                }
            }
        }
        // Dev fallback: built by scripts/build-syscap.sh.
        let cwd = std::env::current_dir()?;
        let triple = if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        let dev = cwd
            .join("src-tauri/binaries")
            .join(format!("echo-scribe-syscap-{}", triple));
        if dev.exists() {
            return Ok(dev);
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "echo-scribe-syscap binary not found",
        ))
    }

    /// Spawn the sidecar; returns channels for PCM frames and status events.
    pub fn spawn() -> std::io::Result<(Self, mpsc::Receiver<PcmFrame>, mpsc::Receiver<SyscapEvent>)> {
        let bin = Self::resolve_binary()?;
        info!(path = %bin.display(), "spawning syscap");

        let mut child = Command::new(&bin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()?;

        let (pcm_tx, pcm_rx) = mpsc::channel::<PcmFrame>(64);
        let (evt_tx, evt_rx) = mpsc::channel::<SyscapEvent>(32);
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Stdout reader thread: 640 samples = 40ms at 16kHz.
        let stdout = child.stdout.take().expect("piped");
        let pcm_tx_clone = pcm_tx.clone();
        let stop_clone = stop_flag.clone();
        std::thread::spawn(move || {
            let mut reader = stdout;
            let mut buf = [0u8; 1280];
            let mut total_bytes: u64 = 0;
            loop {
                if stop_clone.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // Logged at info so we have the byte total at the moment
                        // the sidecar closed its pipe (key signal for future
                        // diagnostics — keep this one).
                        info!(
                            total_bytes,
                            "syscap stdout EOF (sidecar closed pipe or exited)"
                        );
                        break;
                    }
                    Ok(n) => {
                        total_bytes += n as u64;
                        let samples = n / 2;
                        let mut frame = Vec::with_capacity(samples);
                        for i in 0..samples {
                            let lo = buf[i * 2];
                            let hi = buf[i * 2 + 1];
                            frame.push(i16::from_le_bytes([lo, hi]));
                        }
                        if pcm_tx_clone.blocking_send(frame).is_err() {
                            warn!(total_bytes, "syscap pcm channel closed; stdout reader exiting");
                            break;
                        }
                    }
                    Err(e) => {
                        error!(?e, total_bytes, "syscap stdout read error");
                        break;
                    }
                }
            }
            debug!("syscap stdout reader exiting");
        });

        // Stderr reader thread: parses line-delimited JSON status events.
        let stderr = child.stderr.take().expect("piped");
        let evt_tx_clone = evt_tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                    warn!(line, "non-JSON syscap stderr line");
                    continue;
                };
                let Some(event) = val.get("event").and_then(|v| v.as_str()) else {
                    continue;
                };
                let parsed = match event {
                    "ready" => SyscapEvent::Ready,
                    "heartbeat" => SyscapEvent::Heartbeat {
                        ts: val.get("ts").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    },
                    // Periodic diagnostic snapshot (every ~30s, or immediately when
                    // an error counter goes non-zero). Logged via the "unhandled
                    // kind" fallthrough below — info-level, one line.
                    "warn" => SyscapEvent::Warn(
                        val.get("msg")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    "error" => SyscapEvent::Error {
                        kind: val
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        msg: val
                            .get("msg")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    },
                    // Surface any other JSON event the sidecar emits (first_audio,
                    // stop_requested, stopped, ...) so we never silently drop
                    // diagnostic signals again.
                    other => {
                        info!(event = other, json = %val, "syscap event (unhandled kind)");
                        continue;
                    }
                };
                if evt_tx_clone.blocking_send(parsed).is_err() {
                    break;
                }
            }
            debug!("syscap stderr reader exiting");
        });

        Ok((Self { child: Some(child), stop_flag }, pcm_rx, evt_rx))
    }

    /// Send SIGTERM to the sidecar; wait up to 2s, then SIGKILL if still running.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        let Some(mut child) = self.child.take() else {
            return;
        };
        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if Instant::now() > deadline {
                break;
            }
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => {
                    error!(?e, "try_wait failed");
                    break;
                }
            }
        }
        warn!("syscap did not exit within 2s, sending SIGKILL");
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Probe the Screen Recording grant for the meeting-audio sidecar process
/// without prompting. Returns `None` if the sidecar cannot be launched or does
/// not answer quickly.
pub fn screen_capture_access_authorized_sync() -> Option<bool> {
    let bin = Syscap::resolve_binary().ok()?;
    run_screen_capture_access_command(&bin, "--probe", Duration::from_millis(500))
}

/// Request the Screen Recording grant for the meeting-audio sidecar process.
/// Returns `None` if the sidecar cannot be launched or the prompt does not
/// resolve in a bounded time.
pub fn request_screen_capture_access() -> Option<bool> {
    let bin = Syscap::resolve_binary().ok()?;
    run_screen_capture_access_command(&bin, "--request", Duration::from_secs(60))
}

fn run_screen_capture_access_command(
    bin: &Path,
    arg: &str,
    timeout: Duration,
) -> Option<bool> {
    let mut child = Command::new(bin)
        .arg(arg)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

impl Drop for Syscap {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_resolution_does_not_panic() {
        // Under cargo test the binary path may not be present; just assert no panic.
        let _ = Syscap::resolve_binary();
    }

    #[test]
    fn syscap_event_parses_known_kinds() {
        let cases = [
            r#"{"event":"ready"}"#,
            r#"{"event":"heartbeat","ts":1.0}"#,
            r#"{"event":"warn","msg":"x"}"#,
            r#"{"event":"error","kind":"k","msg":"m"}"#,
        ];
        for line in cases {
            let val: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(val.get("event").is_some());
        }
    }
}
