//! Capture-and-restore the macOS frontmost application, plus rich context.
//!
//! `FocusContext` is captured at hotkey-press time (before our overlay can
//! steal key-window status) and carries two concerns:
//!   1. `pid` — used by `restore()` to re-activate the original app before
//!      synthesising Cmd+V, so paste lands in the right window.
//!   2. `app_name`, `window_title`, `browser_url` — stored with each item
//!      and fed to the LLM classifier for richer routing.
//!
//! `FocusElement` is a separate, non-serializable handle to the AX-level
//! focused UI element. Restoring it directly via `kAXFocusedAttribute`
//! bypasses NSApplication's "most-recently-key NSWindow" routing, which
//! could otherwise land Cmd+V in the wrong field of a multi-window app.

#[cfg(target_os = "macos")]
use libc::pid_t;

#[cfg(target_os = "macos")]
use objc2_application_services::AXUIElement;
#[cfg(target_os = "macos")]
use objc2_core_foundation::CFRetained;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FocusContext {
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
}

/// Opaque handle to the AX UI element that had keyboard focus at capture
/// time. Lives alongside `FocusContext` (kept separate so `FocusContext`
/// remains `Serialize`-able for persistence). Coordinator holds this in a
/// `LocalSet`-backed task, so non-`Send` is fine.
#[cfg(target_os = "macos")]
pub struct FocusElement {
    element: CFRetained<AXUIElement>,
    role: Option<String>,
}

#[cfg(target_os = "macos")]
impl std::fmt::Debug for FocusElement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FocusElement")
            .field("role", &self.role)
            .finish()
    }
}

#[cfg(not(target_os = "macos"))]
#[derive(Debug)]
pub struct FocusElement;

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

/// Capture the AX-level focused UI element via the system-wide AXUIElement.
/// Returns `None` if Accessibility permission is missing or the call fails.
#[cfg(target_os = "macos")]
pub fn capture_focused_element() -> Option<FocusElement> {
    use objc2_core_foundation::{CFString, CFType};
    use std::ptr::NonNull;

    let ax_focused_ui = CFString::from_str("AXFocusedUIElement");
    let ax_role = CFString::from_str("AXRole");

    unsafe {
        let system_wide = AXUIElement::new_system_wide();
        let _ = system_wide.set_messaging_timeout(0.1);

        let mut raw: *const CFType = std::ptr::null();
        let err = system_wide.copy_attribute_value(
            &ax_focused_ui,
            NonNull::new(&mut raw as *mut *const CFType)?,
        );
        if err.0 != 0 || raw.is_null() {
            return None;
        }
        let nn = NonNull::new(raw as *mut AXUIElement)?;
        let element: CFRetained<AXUIElement> = CFRetained::from_raw(nn);

        // Best-effort role lookup for diagnostic logging.
        let role = {
            let mut role_raw: *const CFType = std::ptr::null();
            let err2 = element.copy_attribute_value(
                &ax_role,
                NonNull::new(&mut role_raw as *mut *const CFType)?,
            );
            if err2.0 == 0 && !role_raw.is_null() {
                let role_nn = NonNull::new(role_raw as *mut CFString)?;
                let role_cf: CFRetained<CFString> = CFRetained::from_raw(role_nn);
                Some(role_cf.to_string())
            } else {
                None
            }
        };

        Some(FocusElement { element, role })
    }
}

#[cfg(not(target_os = "macos"))]
pub fn capture_focused_element() -> Option<FocusElement> {
    None
}

#[cfg(target_os = "macos")]
impl FocusElement {
    pub fn role(&self) -> Option<&str> {
        self.role.as_deref()
    }

    /// Set `kAXFocusedAttribute = true` on the captured element. This restores
    /// keyboard focus to the exact UI element the user was on, surgically
    /// avoiding NSApp's "most-recently-key NSWindow" routing.
    pub fn restore(&self) -> bool {
        use objc2_core_foundation::{CFBoolean, CFString};

        let ax_focused = CFString::from_str("AXFocused");
        let true_val: &CFBoolean = CFBoolean::new(true);
        unsafe {
            let err = self
                .element
                .set_attribute_value(&ax_focused, true_val.as_ref());
            err.0 == 0
        }
    }
}

/// Returns the pid of the currently-frontmost application.
#[cfg(target_os = "macos")]
pub fn current_frontmost_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    Some(app.processIdentifier() as i32)
}

#[cfg(not(target_os = "macos"))]
pub fn current_frontmost_pid() -> Option<i32> {
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

/// Restore focus before paste. Strategy:
///   1. If the AX element is still alive, set `kAXFocusedAttribute=true` on it.
///      That routes focus to the exact UI element the user was on — bypassing
///      NSApp's last-key-window heuristic, which is what makes paste land in
///      the *previous* field of multi-window apps.
///   2. If the captured app is not currently frontmost, also call
///      `activateWithOptions` to bring the app forward. Skipped when the
///      captured pid is already frontmost (e.g. dictating into Echo Scribe
///      itself), because re-activating a same-app pid can shuffle key-window
///      ordering and is the common-case regression source.
///   3. If AX restore fails, fall back to `activateWithOptions` only.
#[cfg(target_os = "macos")]
pub fn restore_focus(ctx: &FocusContext, element: Option<&FocusElement>) -> RestoreOutcome {
    let frontmost = current_frontmost_pid();
    let same_app = frontmost == Some(ctx.pid);

    let mut activated = false;
    if !same_app {
        for attempt in 0..3 {
            if restore(ctx) {
                if attempt > 0 {
                    tracing::info!(attempt, pid = ctx.pid, "app activated on retry");
                }
                activated = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !activated {
            tracing::warn!(pid = ctx.pid, "activateWithOptions failed after 3 attempts");
        }
    }

    let ax_set = match element {
        Some(el) => el.restore(),
        None => false,
    };

    RestoreOutcome {
        same_app,
        activated_app: activated,
        ax_focused: ax_set,
        element_role: element.and_then(|e| e.role().map(|s| s.to_string())),
        frontmost_pid_before: frontmost,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn restore_focus(_ctx: &FocusContext, _element: Option<&FocusElement>) -> RestoreOutcome {
    RestoreOutcome::default()
}

/// Diagnostics from a `restore_focus` call. All fields are best-effort.
#[derive(Debug, Default, Clone)]
pub struct RestoreOutcome {
    pub same_app: bool,
    pub activated_app: bool,
    pub ax_focused: bool,
    pub element_role: Option<String>,
    pub frontmost_pid_before: Option<i32>,
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
    use objc2_core_foundation::{CFString, CFType};
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

    #[test]
    fn restore_returns_false_for_invalid_pid() {
        let ctx = FocusContext {
            pid: -1,
            bundle_id: None,
            app_name: None,
            window_title: None,
            browser_url: None,
        };
        assert!(!restore(&ctx));
    }

    #[test]
    fn restore_focus_with_invalid_pid_returns_no_activation() {
        let ctx = FocusContext {
            pid: -1,
            bundle_id: None,
            app_name: None,
            window_title: None,
            browser_url: None,
        };
        let outcome = restore_focus(&ctx, None);
        assert!(!outcome.activated_app);
        assert!(!outcome.ax_focused);
    }

    #[test]
    fn current_frontmost_pid_is_positive_when_present() {
        if let Some(pid) = current_frontmost_pid() {
            assert!(pid > 0);
        }
    }
}
