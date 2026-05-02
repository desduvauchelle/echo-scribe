//! System-audio mute/restore around recording sessions.
//!
//! When "mute while recording" is enabled the module saves the current macOS
//! output-mute state on recording start and restores it on stop. Both
//! operations run on a background thread (via `osascript`) so the coordinator
//! is never blocked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use tracing::warn;

static MUTE_WHILE_RECORDING: AtomicBool = AtomicBool::new(false);
/// Whether the system was already muted before the last recording started.
/// Stored so we only unmute if WE muted it (i.e. the user wasn't already muted).
static WAS_MUTED_BEFORE: AtomicBool = AtomicBool::new(false);

pub fn set_enabled(on: bool) {
    MUTE_WHILE_RECORDING.store(on, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    MUTE_WHILE_RECORDING.load(Ordering::Relaxed)
}

/// Call when a recording session starts. Saves the current mute state and
/// mutes system output if it was not already muted.
pub fn on_recording_start() {
    if !is_enabled() {
        return;
    }
    thread::spawn(|| {
        let was_muted = get_system_muted();
        WAS_MUTED_BEFORE.store(was_muted, Ordering::SeqCst);
        if !was_muted {
            set_system_muted(true);
        }
    });
}

/// Call when a recording session ends. Restores system mute to whatever it was
/// before recording started (i.e. unmutes only if WE muted it).
pub fn on_recording_stop() {
    if !is_enabled() {
        return;
    }
    thread::spawn(|| {
        let was_muted = WAS_MUTED_BEFORE.load(Ordering::SeqCst);
        if !was_muted {
            set_system_muted(false);
        }
    });
}

#[cfg(target_os = "macos")]
fn get_system_muted() -> bool {
    std::process::Command::new("osascript")
        .args(["-e", "output muted of (get volume settings)"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn set_system_muted(muted: bool) {
    let expr = if muted {
        "set volume output muted true"
    } else {
        "set volume output muted false"
    };
    if let Err(e) = std::process::Command::new("osascript")
        .args(["-e", expr])
        .status()
    {
        warn!(?e, "failed to set system mute via osascript");
    }
}

#[cfg(not(target_os = "macos"))]
fn get_system_muted() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn set_system_muted(_muted: bool) {}
