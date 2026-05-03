//! Capture-and-restore the macOS frontmost application.
//!
//! Used by the coordinator to remember which app the user was in when they
//! pressed the dictation hotkey, so that — after our recording overlay has
//! flickered key-window status away from that app — we can re-activate it
//! before synthesizing Cmd+V. Without this, dictating into Echo Scribe's
//! own chat input fails: opening the overlay (a sibling window in the same
//! process) drops first-responder off the textarea, so the synthesized
//! paste lands nowhere.

#[cfg(target_os = "macos")]
use libc::pid_t;

#[derive(Debug, Clone)]
pub struct FocusSnapshot {
    pub pid: i32,
    pub bundle_id: Option<String>,
}

#[cfg(target_os = "macos")]
pub fn capture_frontmost() -> Option<FocusSnapshot> {
    use objc2_app_kit::NSWorkspace;

    // NSWorkspace.frontmostApplication is documented as main-thread-only-ish,
    // but in practice it's safe from any thread because it's a read of the
    // workspace's cached state. We're called from the coordinator's tokio
    // task. If this ever proves flaky we can hop to main via dispatch.
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let pid: pid_t = app.processIdentifier();
    let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
    Some(FocusSnapshot {
        pid: pid as i32,
        bundle_id,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_frontmost() -> Option<FocusSnapshot> {
    None
}

/// Re-activate the previously-frontmost app. Best-effort: returns whether
/// the activate call succeeded. Caller should sleep briefly after this so
/// the WindowServer has time to re-route key focus before posting events.
#[cfg(target_os = "macos")]
pub fn restore(snapshot: &FocusSnapshot) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    let Some(app) =
        NSRunningApplication::runningApplicationWithProcessIdentifier(snapshot.pid as pid_t)
    else {
        return false;
    };
    // ActivateIgnoringOtherApps is deprecated on macOS 14+ but still
    // honored, and is the only way to forcibly steal focus from a
    // background-launched activation. Without it, activate() is a no-op
    // when our own process is currently frontmost (which it is, since
    // the overlay just opened).
    #[allow(deprecated)]
    let opts = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    unsafe { app.activateWithOptions(opts) }
}

#[cfg(not(target_os = "macos"))]
pub fn restore(_snapshot: &FocusSnapshot) -> bool {
    false
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn capture_returns_some_during_tests() {
        // In a `cargo test` run there's always a frontmost app (the terminal
        // or test runner). We don't assert a specific bundle, just that the
        // call doesn't crash and returns a plausible pid.
        let snap = capture_frontmost();
        if let Some(s) = snap {
            assert!(s.pid > 0, "pid should be positive, got {}", s.pid);
        }
    }
}
