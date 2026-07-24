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

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct FocusContext {
    /// `#[serde(default)]` because persisted capture_context JSON has not
    /// always included `pid` (it is only meaningful in-process for focus
    /// restore); without the default, every stored row would fail to parse
    /// back and the background tagger would see no context at all.
    #[serde(default)]
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
    /// Active tab title for known browsers. Often richer than `window_title`
    /// for SPAs whose window title is the app name (e.g. "Google Chrome" vs
    /// "Echo Scribe — pricing"). Fetched via same osascript path as
    /// `browser_url`. `None` outside browsers or on AppleScript failure.
    #[serde(default)]
    pub browser_tab_title: Option<String>,
    /// Best-effort specific title for the current page, document, tab, or
    /// high-level content surface. This is deliberately separate from
    /// `window_title`: many apps expose only the app name as the window title,
    /// while a focused web area, selected tab, or document attribute contains
    /// the useful project/page title.
    #[serde(default)]
    pub content_title: Option<String>,
    /// Best-effort URL or document path for the current content surface.
    #[serde(default)]
    pub content_url: Option<String>,
    /// Diagnostic source for `content_title`/`content_url`.
    #[serde(default)]
    pub content_source: Option<String>,
    /// Distilled project-name candidates derived from the other fields at
    /// capture time: repo/folder names pulled from window titles and
    /// AXDocument paths (Claude Code / terminals / IDEs), site hosts and
    /// repo slugs from browser URLs. Lowercase, deduped, best-first. These
    /// are what let the router match a project *by name* without the user
    /// configuring aliases.
    #[serde(default)]
    pub project_hints: Vec<String>,
}

/// Opaque handle to the AX UI element that had keyboard focus at capture
/// time. Lives alongside `FocusContext` (kept separate so `FocusContext`
/// remains `Serialize`-able for persistence). Coordinator holds this in a
/// `LocalSet`-backed task, so non-`Send` is fine.
#[cfg(target_os = "macos")]
pub struct FocusElement {
    element: CFRetained<AXUIElement>,
    /// The application pid the element was captured from. Needed at restore
    /// time so we can build an app-level `AXUIElement` and use the
    /// conventional `app.set(AXFocusedUIElement, element)` pattern, which
    /// is reliable across NSApp / Electron / Cocoa apps. Setting
    /// `AXFocused=true` directly on the element is read-only on most
    /// targets and was the cause of our earlier restore failures.
    pid: i32,
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

#[cfg(not(target_os = "macos"))]
impl FocusElement {
    pub fn selected_text(&self) -> Option<String> {
        None
    }
    pub fn replace_selected_text(&self, _text: &str) -> i32 {
        -1
    }
}

/// How a text selection was captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionMethod {
    /// Read directly via the Accessibility `AXSelectedText` attribute.
    Ax,
    /// Read by synthesizing Cmd+C and reading the clipboard.
    Copy,
}

/// A captured text selection plus how it was obtained.
#[derive(Debug, Clone)]
pub struct SelectionSnapshot {
    pub text: String,
    pub method: SelectionMethod,
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
    let browser_tab_title = bundle_id
        .as_deref()
        .and_then(capture_browser_tab_title_macos);
    let (content_title, content_url, content_source) = capture_content_metadata_macos(
        pid,
        app_name.as_deref(),
        window_title.as_deref(),
        browser_tab_title.as_deref(),
        browser_url.as_deref(),
    );

    let mut ctx = FocusContext {
        pid,
        bundle_id,
        app_name,
        window_title,
        browser_url,
        browser_tab_title,
        content_title,
        content_url,
        content_source,
        project_hints: Vec::new(),
    };
    ctx.project_hints = derive_project_hints(&ctx);
    Some(ctx)
}

#[cfg(not(target_os = "macos"))]
pub fn capture_context() -> Option<FocusContext> {
    None
}

/// Capture the AX-level focused UI element of the given pid's application.
///
/// Tries the **app-level** `AXUIElement` first (the conventional, reliable
/// pattern), and falls back to the system-wide element only if the app-level
/// query fails. The previous system-wide-only approach returned
/// `kAXErrorNoValue (-25212)` for the vast majority of apps in production
/// — the system-wide `AXFocusedUIElement` attribute only populates when an
/// app explicitly forwards focus through it, which most apps do not.
///
/// Emits diagnostic log lines with the raw `AXError` code from each call
/// path so we can tell exactly which step succeeded or failed.
#[cfg(target_os = "macos")]
pub fn capture_focused_element(pid: i32) -> Option<FocusElement> {
    use objc2_core_foundation::{CFString, CFType};
    use std::ptr::NonNull;

    let ax_focused_ui = CFString::from_str("AXFocusedUIElement");
    let ax_role = CFString::from_str("AXRole");

    unsafe {
        // ── Strategy 1: app-level AXFocusedUIElement ────────────────────
        let app_el = AXUIElement::new_application(pid as pid_t);
        // 500 ms keeps the hotkey responsive while ruling out timeout on
        // first round-trip to heavy AX servers (Electron, etc.).
        let _ = app_el.set_messaging_timeout(0.5);

        let mut raw: *const CFType = std::ptr::null();
        let out_ptr = NonNull::new(&mut raw as *mut *const CFType)?;
        let app_err = app_el.copy_attribute_value(&ax_focused_ui, out_ptr);

        let (element, source) = if app_err.0 == 0 && !raw.is_null() {
            let nn = NonNull::new(raw as *mut AXUIElement)?;
            (CFRetained::<AXUIElement>::from_raw(nn), "app")
        } else {
            // ── Strategy 2: system-wide fallback ────────────────────────
            tracing::info!(
                pid,
                ax_error = app_err.0,
                raw_null = raw.is_null(),
                "capture_focused_element: app-level returned no element; falling back to system-wide"
            );
            let system_wide = AXUIElement::new_system_wide();
            let _ = system_wide.set_messaging_timeout(0.5);
            let mut sw_raw: *const CFType = std::ptr::null();
            let sw_out = NonNull::new(&mut sw_raw as *mut *const CFType)?;
            let sw_err = system_wide.copy_attribute_value(&ax_focused_ui, sw_out);
            if sw_err.0 != 0 || sw_raw.is_null() {
                tracing::info!(
                    pid,
                    app_ax_error = app_err.0,
                    system_wide_ax_error = sw_err.0,
                    raw_null = sw_raw.is_null(),
                    "capture_focused_element: both paths failed; no element captured"
                );
                return None;
            }
            let nn = NonNull::new(sw_raw as *mut AXUIElement)?;
            (CFRetained::<AXUIElement>::from_raw(nn), "system-wide")
        };

        // Best-effort role lookup for diagnostic logging.
        let (role, role_err) = {
            let mut role_raw: *const CFType = std::ptr::null();
            let role_out = NonNull::new(&mut role_raw as *mut *const CFType)?;
            let err2 = element.copy_attribute_value(&ax_role, role_out);
            let role = if err2.0 == 0 && !role_raw.is_null() {
                let role_nn = NonNull::new(role_raw as *mut CFString)?;
                let role_cf: CFRetained<CFString> = CFRetained::from_raw(role_nn);
                Some(role_cf.to_string())
            } else {
                None
            };
            (role, err2.0)
        };

        tracing::info!(
            pid,
            source,
            role = ?role,
            role_ax_error = role_err,
            "capture_focused_element: captured element"
        );

        Some(FocusElement { element, pid, role })
    }
}

#[cfg(not(target_os = "macos"))]
pub fn capture_focused_element(_pid: i32) -> Option<FocusElement> {
    None
}

/// Capture the current text selection: try the Accessibility `AXSelectedText`
/// attribute first (clean, no clipboard side effects), then fall back to a
/// synthetic Cmd+C + clipboard read. Returns `None` when nothing is selected.
#[cfg(target_os = "macos")]
pub fn capture_selection(element: Option<&FocusElement>) -> Option<SelectionSnapshot> {
    if let Some(el) = element {
        if let Some(text) = el.selected_text() {
            tracing::info!(target: "edit", chars = text.len(), "capture_selection: via AXSelectedText");
            return Some(SelectionSnapshot { text, method: SelectionMethod::Ax });
        }
    }
    if let Some(text) = crate::input::paste::capture_selection_via_copy() {
        tracing::info!(target: "edit", chars = text.len(), "capture_selection: via Cmd+C fallback");
        return Some(SelectionSnapshot { text, method: SelectionMethod::Copy });
    }
    tracing::info!(target: "edit", "capture_selection: no selection found (AX empty + clipboard unchanged)");
    None
}

#[cfg(not(target_os = "macos"))]
pub fn capture_selection(_element: Option<&FocusElement>) -> Option<SelectionSnapshot> {
    None
}

#[cfg(target_os = "macos")]
impl FocusElement {
    pub fn role(&self) -> Option<&str> {
        self.role.as_deref()
    }

    pub fn pid(&self) -> i32 {
        self.pid
    }

    /// Restore keyboard focus to the captured element using the conventional
    /// AX pattern: `app_element.set(kAXFocusedUIElement, captured_element)`.
    /// This sets the *app's* notion of which element has focus and is what
    /// NSApp / Cocoa / standard AX servers honour.
    ///
    /// Falls back to `element.set(AXFocused, true)` only if the app-level
    /// path fails (kept as a last resort for the rare app that supports it).
    ///
    /// Returns the raw `AXError` code from the primary path
    /// (0 = `kAXErrorSuccess`). Common non-zero codes to expect:
    ///   * -25205 `kAXErrorAttributeUnsupported` — app doesn't expose
    ///      `kAXFocusedUIElement` as settable.
    ///   * -25204 `kAXErrorCannotComplete` — usually a timeout or the
    ///      target app is unresponsive to AX messages.
    ///   * -25200 `kAXErrorInvalidUIElement` — the captured element is
    ///      stale (re-rendered/replaced since capture).
    pub fn restore(&self) -> i32 {
        use objc2_core_foundation::{CFBoolean, CFString};
        use objc2_application_services::AXUIElement;

        let ax_focused_ui = CFString::from_str("AXFocusedUIElement");

        unsafe {
            // Primary: app.set(kAXFocusedUIElement, element)
            let app_el = AXUIElement::new_application(self.pid as pid_t);
            let _ = app_el.set_messaging_timeout(0.5);
            let element_ref: &AXUIElement = &self.element;
            let element_as_cf: &objc2_core_foundation::CFType = element_ref.as_ref();
            let err = app_el.set_attribute_value(&ax_focused_ui, element_as_cf);
            tracing::info!(
                pid = self.pid,
                ax_error = err.0,
                "FocusElement::restore app.set(AXFocusedUIElement, element)"
            );
            if err.0 == 0 {
                return 0;
            }

            // Fallback: element.set(AXFocused = true). Rarely works on
            // standard NSApp/Cocoa elements but documented for some custom
            // AX servers — cheap to try once before giving up.
            let ax_focused = CFString::from_str("AXFocused");
            let true_val: &CFBoolean = CFBoolean::new(true);
            let err2 = self
                .element
                .set_attribute_value(&ax_focused, true_val.as_ref());
            tracing::info!(
                pid = self.pid,
                ax_error = err2.0,
                primary_ax_error = err.0,
                "FocusElement::restore fallback element.set(AXFocused=true)"
            );
            err2.0
        }
    }

    /// Read the element's current selection via `AXSelectedText`. Returns
    /// `None` when the attribute is unsupported or empty. Raw (no whitespace
    /// normalization) so we never alter the user's text.
    pub fn selected_text(&self) -> Option<String> {
        use objc2_core_foundation::{CFString, CFType};
        use std::ptr::NonNull;
        let attr = CFString::from_str("AXSelectedText");
        unsafe {
            let _ = self.element.set_messaging_timeout(0.2);
            let mut raw: *const CFType = std::ptr::null();
            let out = NonNull::new(&mut raw as *mut *const CFType)?;
            let err = self.element.copy_attribute_value(&attr, out);
            if err.0 != 0 || raw.is_null() {
                return None;
            }
            let value: CFRetained<CFType> = CFRetained::from_raw(NonNull::new(raw as *mut CFType)?);
            let s = value.downcast::<CFString>().ok().map(|s| s.to_string())?;
            if s.is_empty() { None } else { Some(s) }
        }
    }

    /// Replace the element's current selection in place by setting
    /// `AXSelectedText`. Returns the raw `AXError` (0 = success). Works in apps
    /// that expose a settable `AXSelectedText` (most native/Cocoa text fields);
    /// callers fall back to Cmd+V paste when this returns non-zero.
    pub fn replace_selected_text(&self, text: &str) -> i32 {
        use objc2_core_foundation::CFString;
        let attr = CFString::from_str("AXSelectedText");
        let value = CFString::from_str(text);
        unsafe {
            let _ = self.element.set_messaging_timeout(0.5);
            let err = self.element.set_attribute_value(&attr, value.as_ref());
            tracing::info!(
                pid = self.pid,
                ax_error = err.0,
                chars = text.len(),
                "FocusElement::replace_selected_text set(AXSelectedText)"
            );
            err.0
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl FocusElement {
    pub fn role(&self) -> Option<&str> {
        None
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

#[cfg(target_os = "macos")]
fn should_restore_captured_element(
    frontmost_pid_before_restore: Option<i32>,
    captured_pid: i32,
    element_captured: bool,
) -> bool {
    element_captured && frontmost_pid_before_restore != Some(captured_pid)
}

/// Restore focus before paste. Strategy:
///   1. If the captured app is not currently frontmost, call
///      `activateWithOptions` to bring the app forward.
///   2. For that cross-app return path, restore the captured AX element so
///      multi-window apps route paste to the field that started dictation.
///   3. If the captured app is already frontmost, do not reapply the captured
///      AX element. The AX snapshot can be stale after a recent click or UI
///      re-render; in that case forcing it back is what makes paste land in a
///      previously focused field despite a visible caret elsewhere.
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

    let should_restore_element =
        should_restore_captured_element(frontmost, ctx.pid, element.is_some());
    let (ax_set, ax_error) = match element {
        Some(el) if should_restore_element => {
            let code = el.restore();
            (code == 0, Some(code))
        }
        Some(_) => {
            tracing::info!(
                pid = ctx.pid,
                frontmost_pid_before = ?frontmost,
                "skipping captured AX element restore because target app is already frontmost"
            );
            (false, None)
        }
        None => (false, None),
    };

    RestoreOutcome {
        same_app,
        activated_app: activated,
        ax_focused: ax_set,
        ax_error,
        element_captured: element.is_some(),
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
    /// Raw `AXError` code from `FocusElement::restore()`. `None` if no
    /// element was captured (so we never made the call). 0 means success.
    pub ax_error: Option<i32>,
    /// Whether `capture_focused_element()` returned `Some` at hotkey-press
    /// time. Distinguishes "capture failed, restore never ran" from
    /// "capture succeeded, restore returned non-zero".
    pub element_captured: bool,
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

    run_osascript_with_timeout(script)
}

/// Fetch the active tab *title* from a known browser via AppleScript.
/// For SPAs (Gmail, Notion, Linear, Meet) the `<title>` is far more
/// informative than the AX window title, which is often the app name.
#[cfg(target_os = "macos")]
fn capture_browser_tab_title_macos(bundle_id: &str) -> Option<String> {
    let script = match bundle_id {
        "com.apple.Safari" =>
            "tell application \"Safari\" to get name of current tab of front window",
        "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.canary" =>
            "tell application \"Google Chrome\" to get title of active tab of front window",
        "company.thebrowser.Browser" =>
            "tell application \"Arc\" to get title of active tab of front window",
        "com.brave.Browser" | "com.brave.Browser.beta" =>
            "tell application \"Brave Browser\" to get title of active tab of front window",
        _ => return None,
    };

    run_osascript_with_timeout(script)
}

/// Derive a more specific content title/URL than the app-level window title.
///
/// Priority order:
/// 1. Browser tab title/URL, already acquired through app-specific safe paths.
/// 2. Focused window AX attributes such as AXDocument, AXURL, AXDescription.
/// 3. Focused high-level element attributes, excluding text-entry values.
/// 4. A bounded shallow scan for selected tabs and web/document areas.
#[cfg(target_os = "macos")]
fn capture_content_metadata_macos(
    pid: i32,
    app_name: Option<&str>,
    window_title: Option<&str>,
    browser_tab_title: Option<&str>,
    browser_url: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    if let Some(title) = normalize_content_candidate(browser_tab_title, app_name, window_title) {
        return (
            Some(title),
            browser_url.and_then(normalize_url_candidate),
            Some("browser_tab".to_string()),
        );
    }

    let Some(window) = focused_window_element_macos(pid) else {
        return (None, None, None);
    };

    if let Some(found) =
        inspect_ax_element_for_content(&window, app_name, window_title, "ax_window", false)
    {
        return found;
    }

    if let Some(focused) = focused_ui_element_macos(pid) {
        if let Some(found) = inspect_ax_element_for_content(
            &focused,
            app_name,
            window_title,
            "ax_focused_element",
            false,
        ) {
            return found;
        }
    }

    scan_ax_children_for_content(&window, app_name, window_title).unwrap_or((None, None, None))
}

#[cfg(target_os = "macos")]
fn focused_window_element_macos(pid: i32) -> Option<CFRetained<AXUIElement>> {
    use objc2_core_foundation::{CFString, CFType};
    use std::ptr::NonNull;

    let ax_focused_window = CFString::from_str("AXFocusedWindow");
    unsafe {
        let app_el = AXUIElement::new_application(pid as pid_t);
        let _ = app_el.set_messaging_timeout(0.1);
        let mut raw: *const CFType = std::ptr::null();
        let err = app_el.copy_attribute_value(
            &ax_focused_window,
            NonNull::new(&mut raw as *mut *const CFType)?,
        );
        if err.0 != 0 || raw.is_null() {
            return None;
        }
        CFRetained::from_raw(NonNull::new(raw as *mut AXUIElement)?).into()
    }
}

#[cfg(target_os = "macos")]
fn focused_ui_element_macos(pid: i32) -> Option<CFRetained<AXUIElement>> {
    use objc2_core_foundation::{CFString, CFType};
    use std::ptr::NonNull;

    let ax_focused_ui = CFString::from_str("AXFocusedUIElement");
    unsafe {
        let app_el = AXUIElement::new_application(pid as pid_t);
        let _ = app_el.set_messaging_timeout(0.1);
        let mut raw: *const CFType = std::ptr::null();
        let err =
            app_el.copy_attribute_value(&ax_focused_ui, NonNull::new(&mut raw as *mut *const CFType)?);
        if err.0 != 0 || raw.is_null() {
            return None;
        }
        CFRetained::from_raw(NonNull::new(raw as *mut AXUIElement)?).into()
    }
}

#[cfg(target_os = "macos")]
fn inspect_ax_element_for_content(
    element: &AXUIElement,
    app_name: Option<&str>,
    window_title: Option<&str>,
    source: &str,
    allow_text_value: bool,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let role = copy_ax_string_attribute(element, "AXRole");
    let title = copy_ax_string_attribute(element, "AXTitle")
        .or_else(|| copy_ax_string_attribute(element, "AXDescription"))
        .or_else(|| copy_ax_string_attribute(element, "AXDocument"))
        .and_then(|s| normalize_content_candidate(Some(&s), app_name, window_title));
    let title = title.or_else(|| {
        if allow_text_value && is_high_signal_role(role.as_deref()) {
            copy_ax_string_attribute(element, "AXValue")
                .and_then(|s| normalize_content_candidate(Some(&s), app_name, window_title))
        } else {
            None
        }
    });
    let url = copy_ax_url_like_attribute(element, "AXURL")
        .or_else(|| copy_ax_url_like_attribute(element, "AXDocument"))
        .and_then(|s| normalize_url_candidate(&s));

    if title.is_some() || url.is_some() {
        Some((title, url, Some(source.to_string())))
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn scan_ax_children_for_content(
    root: &AXUIElement,
    app_name: Option<&str>,
    window_title: Option<&str>,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    use objc2_core_foundation::Type;

    let mut stack = vec![root.retain()];
    let mut visited = 0usize;

    while let Some(element) = stack.pop() {
        visited += 1;
        if visited > 40 {
            break;
        }

        let role = copy_ax_string_attribute(&element, "AXRole");
        if is_high_signal_role(role.as_deref()) {
            if let Some(found) = inspect_ax_element_for_content(
                &element,
                app_name,
                window_title,
                role.as_deref().unwrap_or("ax_child"),
                false,
            ) {
                return Some(found);
            }
        }

        if stack.len() < 40 {
            stack.extend(copy_ax_children(&element).into_iter().take(12));
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn is_high_signal_role(role: Option<&str>) -> bool {
    matches!(
        role,
        Some("AXWebArea")
            | Some("AXTabGroup")
            | Some("AXTab")
            | Some("AXDocument")
            | Some("AXGroup")
            | Some("AXScrollArea")
    )
}

#[cfg(target_os = "macos")]
fn copy_ax_string_attribute(element: &AXUIElement, attr: &str) -> Option<String> {
    use objc2_core_foundation::{CFString, CFType};
    use std::ptr::NonNull;

    let attr = CFString::from_str(attr);
    unsafe {
        let _ = element.set_messaging_timeout(0.05);
        let mut raw: *const CFType = std::ptr::null();
        let err = element.copy_attribute_value(&attr, NonNull::new(&mut raw as *mut *const CFType)?);
        if err.0 != 0 || raw.is_null() {
            return None;
        }
        let value: CFRetained<CFType> = CFRetained::from_raw(NonNull::new(raw as *mut CFType)?);
        value
            .downcast::<CFString>()
            .ok()
            .map(|s| s.to_string())
            .and_then(|s| normalize_raw_string(&s))
    }
}

#[cfg(target_os = "macos")]
fn copy_ax_url_like_attribute(element: &AXUIElement, attr: &str) -> Option<String> {
    use objc2_core_foundation::{CFString, CFType, CFURL};
    use std::ptr::NonNull;

    let attr = CFString::from_str(attr);
    unsafe {
        let _ = element.set_messaging_timeout(0.05);
        let mut raw: *const CFType = std::ptr::null();
        let err = element.copy_attribute_value(&attr, NonNull::new(&mut raw as *mut *const CFType)?);
        if err.0 != 0 || raw.is_null() {
            return None;
        }
        let value: CFRetained<CFType> = CFRetained::from_raw(NonNull::new(raw as *mut CFType)?);
        match value.downcast::<CFString>() {
            Ok(s) => normalize_raw_string(&s.to_string()),
            Err(value) => value
                .downcast::<CFURL>()
                .ok()
                .and_then(|u| {
                    #[allow(deprecated)]
                    {
                        objc2_core_foundation::CFURLGetString(&u).map(|s| s.to_string())
                    }
                })
                .and_then(|s| normalize_raw_string(&s)),
        }
    }
}

#[cfg(target_os = "macos")]
fn copy_ax_children(element: &AXUIElement) -> Vec<CFRetained<AXUIElement>> {
    use objc2_core_foundation::{CFArray, CFString, CFType};
    use std::ptr::NonNull;

    let attr = CFString::from_str("AXChildren");
    unsafe {
        let _ = element.set_messaging_timeout(0.05);
        let mut raw: *const CFType = std::ptr::null();
        let err = element.copy_attribute_value(
            &attr,
            NonNull::new(&mut raw as *mut *const CFType).expect("local out pointer"),
        );
        if err.0 != 0 || raw.is_null() {
            return Vec::new();
        }
        let value: CFRetained<CFType> = match NonNull::new(raw as *mut CFType) {
            Some(ptr) => CFRetained::from_raw(ptr),
            None => return Vec::new(),
        };
        let Ok(array) = value.downcast::<CFArray>() else {
            return Vec::new();
        };
        let array: CFRetained<CFArray<AXUIElement>> =
            CFRetained::cast_unchecked::<CFArray<AXUIElement>>(array);
        array.iter().take(12).collect()
    }
}

fn normalize_content_candidate(
    candidate: Option<&str>,
    app_name: Option<&str>,
    window_title: Option<&str>,
) -> Option<String> {
    let s = normalize_raw_string(candidate?)?;
    if s.chars().count() > 240 {
        return None;
    }
    let s_l = s.to_lowercase();
    let generic = ["home", "untitled", "new tab", "start page", "settings"];
    if generic.iter().any(|g| s_l == *g) {
        return None;
    }
    if app_name
        .and_then(normalize_raw_string)
        .map(|app| app.eq_ignore_ascii_case(&s))
        .unwrap_or(false)
    {
        return None;
    }
    if window_title
        .and_then(normalize_raw_string)
        .map(|title| title.eq_ignore_ascii_case(&s))
        .unwrap_or(false)
    {
        return None;
    }
    Some(s)
}

fn normalize_url_candidate(candidate: &str) -> Option<String> {
    let s = normalize_raw_string(candidate)?;
    let s_l = s.to_lowercase();
    if s_l.starts_with("http://")
        || s_l.starts_with("https://")
        || s_l.starts_with("file://")
        || s.starts_with('/')
    {
        Some(s)
    } else {
        None
    }
}

fn normalize_raw_string(candidate: &str) -> Option<String> {
    let s = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() || s == "missing value" {
        None
    } else {
        Some(s)
    }
}

// ── project-hint derivation ──────────────────────────────────────────────────
//
// Pure string distillation (no OS calls) so it is unit-testable and can run
// both at capture time and retroactively over stored capture_context rows.

/// Directory names that never identify a project on their own.
const GENERIC_PATH_SEGMENTS: &[&str] = &[
    "src", "bin", "lib", "app", "apps", "build", "dist", "target", "out",
    "node_modules", "home", "users", "documents", "desktop", "downloads",
    "tmp", "temp", "private", "var", "opt", "usr", "applications", "library",
    "volumes", "system",
];

/// Parent dirs whose *child* is almost always the project/repo folder
/// (e.g. `~/Documents/code/echo-scribe/...` → `echo-scribe`).
const CODE_PARENT_DIRS: &[&str] = &[
    "code", "repos", "repositories", "projects", "dev", "work", "github",
    "git", "workspace", "workspaces", "sources",
];

/// Window-title tokens that are shell/terminal noise, never a project.
const TITLE_NOISE_TOKENS: &[&str] = &[
    "zsh", "-zsh", "bash", "-bash", "fish", "sh", "node", "python", "python3",
    "claude", "codex", "terminal", "vim", "nvim", "tmux", "ssh", "login",
];

/// Distill project-name candidates from a captured focus context.
/// Lowercase, deduped (order-preserving), capped at 8.
pub fn derive_project_hints(ctx: &FocusContext) -> Vec<String> {
    let mut hints: Vec<String> = Vec::new();
    let app_l = ctx.app_name.as_deref().map(str::to_lowercase);

    let mut push = |candidate: Option<String>, hints: &mut Vec<String>| {
        let Some(h) = candidate else { return };
        let h = h.trim().to_lowercase();
        if h.len() < 2 || h.chars().count() > 64 {
            return;
        }
        if app_l.as_deref() == Some(h.as_str()) {
            return;
        }
        if !hints.iter().any(|e| e == &h) {
            hints.push(h);
        }
    };

    // Strongest signal first: AXDocument / content paths (Terminal cwd,
    // VS Code document, browser content URL).
    if let Some(u) = ctx.content_url.as_deref() {
        if u.starts_with("http://") || u.starts_with("https://") {
            for h in hints_from_web_url(u) {
                push(Some(h), &mut hints);
            }
        } else {
            push(hint_from_path(u), &mut hints);
        }
    }
    for title in [ctx.window_title.as_deref(), ctx.content_title.as_deref()]
        .into_iter()
        .flatten()
    {
        for h in hints_from_title(title) {
            push(Some(h), &mut hints);
        }
    }
    if let Some(u) = ctx.browser_url.as_deref() {
        for h in hints_from_web_url(u) {
            push(Some(h), &mut hints);
        }
    }

    hints.truncate(8);
    hints
}

/// Extract the project/repo folder from a filesystem path or file:// URL.
pub fn hint_from_path(raw: &str) -> Option<String> {
    let path = raw
        .strip_prefix("file://")
        .unwrap_or(raw)
        .replace("%20", " ");
    if !path.starts_with('/') && !path.starts_with('~') {
        return None;
    }
    let mut segments: Vec<&str> = path
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "~")
        .collect();
    // Drop a trailing filename ("main.rs", "notes.md"): dot + short extension.
    if let Some(last) = segments.last() {
        if looks_like_filename(last) {
            segments.pop();
        }
    }
    // Prefer the child of a known code-parent dir.
    for (i, seg) in segments.iter().enumerate() {
        if CODE_PARENT_DIRS.contains(&seg.to_lowercase().as_str()) {
            if let Some(next) = segments.get(i + 1) {
                if !is_generic_segment(next) {
                    return Some(next.to_lowercase());
                }
            }
        }
    }
    // Otherwise the deepest non-generic directory.
    segments
        .iter()
        .rev()
        .find(|s| !is_generic_segment(s))
        .map(|s| s.to_lowercase())
}

fn is_generic_segment(seg: &str) -> bool {
    let l = seg.to_lowercase();
    l.starts_with('.') || GENERIC_PATH_SEGMENTS.contains(&l.as_str())
}

fn looks_like_filename(seg: &str) -> bool {
    let Some((stem, ext)) = seg.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && (1..=5).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Extract repo-ish tokens from a window/content title. Titles are split on
/// common separators; path-like segments go through [`hint_from_path`];
/// single-token segments that look like a repo slug (`echo-scribe`,
/// `livecaseplus-server`) are kept as-is.
pub fn hints_from_title(title: &str) -> Vec<String> {
    let mut out = Vec::new();
    let cleaned = title
        .chars()
        .filter(|c| !matches!(c, '✳' | '✶' | '●' | '◐' | '◑' | '◒' | '◓'))
        .collect::<String>();
    let segments = split_title_segments(&cleaned);
    for seg in segments {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        if seg.contains('/') {
            if let Some(h) = hint_from_path(seg) {
                out.push(h);
            }
            continue;
        }
        if let Some(h) = repo_slug_token(seg) {
            out.push(h);
        }
    }
    out
}

fn split_title_segments(title: &str) -> Vec<&str> {
    let mut segments = vec![title];
    for sep in [" — ", " – ", " - ", " · ", " | ", " :: "] {
        segments = segments
            .into_iter()
            .flat_map(|s| s.split(sep))
            .collect();
    }
    segments
}

/// Accept a single token that looks like a repo/project slug: one word,
/// ascii alphanumerics plus `-`/`_`/`.`, containing a separator or digit
/// (so plain English words like "Settings" don't qualify), not a filename,
/// not shell noise, not a terminal geometry like `80×24`.
fn repo_slug_token(seg: &str) -> Option<String> {
    let s = seg.trim();
    if s.contains(' ') || s.len() < 3 || s.chars().count() > 64 {
        return None;
    }
    let l = s.to_lowercase();
    if TITLE_NOISE_TOKENS.contains(&l.as_str()) {
        return None;
    }
    if l.contains('×') || l.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    if !s.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if looks_like_filename(s) {
        return None;
    }
    // Require a hyphen/underscore/dot — the signature of a repo slug. A bare
    // word ("Inbox", "Settings") is too ambiguous to be a project hint.
    if !s.contains('-') && !s.contains('_') && !s.contains('.') {
        return None;
    }
    Some(l)
}

/// Extract hints from a web URL: the host (minus `www.`), plus the repo slug
/// (and `owner/repo`) for known code-forge hosts.
pub fn hints_from_web_url(url: &str) -> Vec<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    let Some(rest) = rest else {
        return Vec::new();
    };
    let mut parts = rest.splitn(2, '/');
    let host_port = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let host = host_port
        .split('@')
        .next_back()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_lowercase();
    if host.is_empty() || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() {
        return Vec::new();
    }
    let mut out = vec![host.clone()];
    const FORGES: &[&str] = &["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];
    if FORGES.contains(&host.as_str()) {
        let segs: Vec<&str> = path
            .split(['/', '?', '#'])
            .filter(|s| !s.is_empty())
            .collect();
        if segs.len() >= 2 {
            let owner = segs[0].to_lowercase();
            let repo = segs[1].to_lowercase();
            out.push(repo.clone());
            out.push(format!("{owner}/{repo}"));
        }
    }
    out
}

/// Run an AppleScript with a 500 ms deadline. Returns trimmed stdout on
/// success, `None` on timeout/failure/empty/"missing value".
#[cfg(target_os = "macos")]
fn run_osascript_with_timeout(script: &str) -> Option<String> {
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
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() || s == "missing value" {
        None
    } else {
        Some(s)
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
            ..Default::default()
        };
        assert!(!restore(&ctx));
    }

    #[test]
    fn restore_focus_with_invalid_pid_returns_no_activation() {
        let ctx = FocusContext {
            pid: -1,
            ..Default::default()
        };
        let outcome = restore_focus(&ctx, None);
        assert!(!outcome.activated_app);
        assert!(!outcome.ax_focused);
    }

    #[test]
    fn does_not_restore_captured_ax_element_when_target_app_is_already_frontmost() {
        assert!(
            !should_restore_captured_element(Some(42), 42, true),
            "a captured AX element can be stale; if the app is already frontmost, keep the visible caret"
        );
    }

    #[test]
    fn restores_captured_ax_element_when_returning_to_a_background_app() {
        assert!(
            should_restore_captured_element(Some(7), 42, true),
            "cross-app dictation still needs the captured element after app activation"
        );
    }

    #[test]
    fn current_frontmost_pid_is_positive_when_present() {
        if let Some(pid) = current_frontmost_pid() {
            assert!(pid > 0);
        }
    }
}

#[cfg(test)]
mod hint_tests {
    use super::*;

    #[test]
    fn hint_from_terminal_cwd_file_url_prefers_code_parent_child() {
        // Terminal.app exposes the shell cwd as the window AXDocument.
        assert_eq!(
            hint_from_path("file:///Users/denis/Documents/code/echo-scribe"),
            Some("echo-scribe".into())
        );
        // Deep inside the repo still resolves to the repo folder.
        assert_eq!(
            hint_from_path("/Users/denis/Documents/code/echo-scribe/src-tauri/src"),
            Some("echo-scribe".into())
        );
    }

    #[test]
    fn hint_from_path_drops_trailing_filename() {
        assert_eq!(
            hint_from_path("/Users/denis/projects/livecaseplus-server/app/main.py"),
            Some("livecaseplus-server".into())
        );
    }

    #[test]
    fn hint_from_path_falls_back_to_deepest_non_generic_dir() {
        assert_eq!(
            hint_from_path("/Users/denis/my-notes/src"),
            Some("my-notes".into())
        );
        assert_eq!(hint_from_path("not a path"), None);
    }

    #[test]
    fn claude_code_terminal_title_yields_repo_hint() {
        // Claude Code sets the terminal title to a status glyph + task + repo
        // folder; the repo slug is the token we want.
        let hints = hints_from_title("✳ Fix the queue worker — echo-scribe");
        assert_eq!(hints, vec!["echo-scribe".to_string()]);
    }

    #[test]
    fn terminal_default_title_yields_cwd_hint_not_shell_noise() {
        let hints = hints_from_title("echo-scribe — -zsh — 80×24");
        assert_eq!(hints, vec!["echo-scribe".to_string()]);
    }

    #[test]
    fn vscode_title_yields_repo_but_not_filename() {
        let hints = hints_from_title("coordinator.rs — echo-scribe");
        assert_eq!(hints, vec!["echo-scribe".to_string()]);
    }

    #[test]
    fn plain_english_titles_yield_no_hints() {
        assert!(hints_from_title("Inbox").is_empty());
        assert!(hints_from_title("Weekly Standup - Zoom Meeting").is_empty());
        assert!(hints_from_title("Settings").is_empty());
    }

    #[test]
    fn web_url_yields_host_and_forge_repo() {
        let hints = hints_from_web_url("https://github.com/desduvauchelle/echo-scribe/pull/12");
        assert_eq!(
            hints,
            vec![
                "github.com".to_string(),
                "echo-scribe".to_string(),
                "desduvauchelle/echo-scribe".to_string()
            ]
        );
        assert_eq!(
            hints_from_web_url("https://www.notion.so/Some-Page-abc123"),
            vec!["notion.so".to_string()]
        );
        assert!(hints_from_web_url("http://localhost:5173/app").is_empty());
        assert!(hints_from_web_url("http://127.0.0.1:8080/").is_empty());
    }

    #[test]
    fn derive_project_hints_merges_sources_and_dedupes() {
        let ctx = FocusContext {
            app_name: Some("Terminal".into()),
            window_title: Some("✳ Refactor tagger — echo-scribe".into()),
            content_url: Some("file:///Users/denis/Documents/code/echo-scribe".into()),
            content_source: Some("ax_window".into()),
            ..Default::default()
        };
        let hints = derive_project_hints(&ctx);
        assert_eq!(hints, vec!["echo-scribe".to_string()]);
    }

    #[test]
    fn derive_project_hints_skips_app_name_echo() {
        let ctx = FocusContext {
            app_name: Some("echo-scribe".into()),
            window_title: Some("echo-scribe".into()),
            ..Default::default()
        };
        assert!(derive_project_hints(&ctx).is_empty());
    }

    #[test]
    fn focus_context_parses_legacy_json_without_pid_or_hints() {
        // Rows written by older builds: hand-rolled JSON with no `pid` and no
        // `project_hints`. These must still deserialize (the tagger depends
        // on it).
        let legacy = r#"{"app_name":"Code","window_title":"main.rs — echo-scribe","browser_url":null,"browser_tab_title":null,"content_title":null,"content_url":null,"content_source":null,"bundle_id":"com.microsoft.VSCode"}"#;
        let ctx: FocusContext =
            serde_json::from_str(legacy).expect("legacy capture_context must parse");
        assert_eq!(ctx.pid, 0);
        assert_eq!(ctx.app_name.as_deref(), Some("Code"));
        assert!(ctx.project_hints.is_empty());
    }

    #[test]
    fn focus_context_full_serde_round_trip_preserves_hints() {
        let mut ctx = FocusContext {
            pid: 4242,
            bundle_id: Some("com.googlecode.iterm2".into()),
            app_name: Some("iTerm2".into()),
            window_title: Some("✳ Plan review — livecaseplus-server".into()),
            ..Default::default()
        };
        ctx.project_hints = derive_project_hints(&ctx);
        let json = serde_json::to_string(&ctx).unwrap();
        let back: FocusContext = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pid, 4242);
        assert_eq!(back.project_hints, vec!["livecaseplus-server".to_string()]);
    }
}
