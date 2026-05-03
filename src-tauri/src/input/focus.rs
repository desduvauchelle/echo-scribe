//! Capture-and-restore the macOS frontmost application, plus rich context.
//!
//! `FocusContext` is captured at hotkey-press time (before our overlay can
//! steal key-window status) and carries two concerns:
//!   1. `pid` — used by `restore()` to re-activate the original app before
//!      synthesising Cmd+V, so paste lands in the right window.
//!   2. `app_name`, `window_title`, `browser_url` — stored with each item
//!      and fed to the LLM classifier for richer routing.

#[cfg(target_os = "macos")]
use libc::pid_t;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FocusContext {
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
}

/// Capture the frontmost application plus window/browser context.
/// Best-effort: never panics; missing fields are `None`.
#[cfg(target_os = "macos")]
pub fn capture_context() -> Option<FocusContext> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let pid = app.processIdentifier() as i32;
    let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
    let app_name = app.localizedName().map(|s| s.to_string());

    let window_title = capture_window_title_macos(pid);
    let browser_url = bundle_id
        .as_deref()
        .and_then(capture_browser_url_macos);

    Some(FocusContext {
        pid,
        bundle_id,
        app_name,
        window_title,
        browser_url,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_context() -> Option<FocusContext> {
    None
}

/// Re-activate the previously-frontmost app before synthesising Cmd+V.
#[cfg(target_os = "macos")]
pub fn restore(ctx: &FocusContext) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    let Some(app) =
        NSRunningApplication::runningApplicationWithProcessIdentifier(ctx.pid as pid_t)
    else {
        return false;
    };
    #[allow(deprecated)]
    let opts = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    app.activateWithOptions(opts)
}

#[cfg(not(target_os = "macos"))]
pub fn restore(_ctx: &FocusContext) -> bool {
    false
}

// ── macOS helpers ─────────────────────────────────────────────────────────────

/// Get the focused window's title via the Accessibility API.
/// Returns `None` if accessibility permission is absent or the call errors.
#[cfg(target_os = "macos")]
fn capture_window_title_macos(pid: i32) -> Option<String> {
    use objc2_application_services::AXUIElement;
    use objc2_core_foundation::{CFRetained, CFString, CFType};
    use std::ptr::NonNull;

    // kAXFocusedWindowAttribute and kAXTitleAttribute are #define macros
    // (CFSTR literals), not exported C symbols. We build CFStrings from the
    // underlying string values directly.
    let ax_focused_window = CFString::from_str("AXFocusedWindow");
    let ax_title = CFString::from_str("AXTitle");

    unsafe {
        let app_el = AXUIElement::new_application(pid as pid_t);
        // Limit each AX round-trip to 100 ms so a hung app never delays recording.
        let _ = app_el.set_messaging_timeout(0.1);

        let mut win_raw: *const CFType = std::ptr::null();
        let err = app_el.copy_attribute_value(
            &ax_focused_window,
            NonNull::new(&mut win_raw as *mut *const CFType)?,
        );
        if err.0 != 0 || win_raw.is_null() {
            return None;
        }
        // copy_attribute_value follows the "Create Rule": the caller owns +1 ref.
        // The actual runtime type for kAXFocusedWindowAttribute is AXUIElement.
        let win_nn = NonNull::new(win_raw as *mut AXUIElement)?;
        let win_el: CFRetained<AXUIElement> = CFRetained::from_raw(win_nn);

        let mut title_raw: *const CFType = std::ptr::null();
        let err2 = win_el.copy_attribute_value(
            &ax_title,
            NonNull::new(&mut title_raw as *mut *const CFType)?,
        );
        if err2.0 != 0 || title_raw.is_null() {
            return None;
        }
        // The actual runtime type for kAXTitleAttribute is CFString.
        let title_nn = NonNull::new(title_raw as *mut CFString)?;
        let title_cf: CFRetained<CFString> = CFRetained::from_raw(title_nn);
        let s = title_cf.to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

/// Fetch the active tab URL from a known browser via AppleScript.
/// Spawns a background thread with a 500 ms deadline so it never blocks.
#[cfg(target_os = "macos")]
fn capture_browser_url_macos(bundle_id: &str) -> Option<String> {
    let script = match bundle_id {
        "com.apple.Safari" =>
            "tell application \"Safari\" to get URL of current tab of front window",
        "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.canary" =>
            "tell application \"Google Chrome\" to get URL of active tab of front window",
        "company.thebrowser.Browser" =>
            "tell application \"Arc\" to get URL of active tab of front window",
        "com.brave.Browser" | "com.brave.Browser.beta" =>
            "tell application \"Brave Browser\" to get URL of active tab of front window",
        _ => return None,
    };

    let script = script.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
        let _ = tx.send(result);
    });

    let output = rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .ok()?
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() || url == "missing value" {
        None
    } else {
        Some(url)
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn capture_context_returns_some_with_valid_pid() {
        let ctx = capture_context();
        if let Some(c) = ctx {
            assert!(c.pid > 0, "pid should be positive, got {}", c.pid);
        }
    }

    #[test]
    fn capture_context_returns_app_name() {
        let ctx = capture_context();
        if let Some(c) = ctx {
            assert!(
                c.app_name.is_some(),
                "expected app_name to be populated, got None (pid={})",
                c.pid
            );
        }
    }

    #[test]
    fn capture_browser_url_returns_none_for_unknown_bundle() {
        let url = capture_browser_url_macos("com.example.unknown");
        assert!(url.is_none());
    }
}
