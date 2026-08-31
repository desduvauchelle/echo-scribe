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

/// Whether an element with a given accessibility role can receive text from a
/// synthesized ⌘V.
///
/// This is the guard against the worst dictation failure: a transcript pasted
/// into something that cannot hold a caret is swallowed with no error and no
/// visible effect, so the user watches a long dictation simply vanish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextTarget {
    /// A text-editing role. ⌘V lands.
    Accepts,
    /// A role that provably cannot hold a caret (list, button, menu, …).
    /// ⌘V is delivered and discarded.
    Rejects,
    /// Unrecognised role. Deliberately permissive: plenty of apps expose
    /// custom or container roles over perfectly good text views, and blind
    /// ⌘V is the long-standing behavior that works for them.
    #[default]
    Unknown,
    /// The app reports *no focused element at all*. Distinct from
    /// [`TextTarget::Unknown`]: there is no element whose role we failed to
    /// recognise, there is nothing focused, so a ⌘V has provably nowhere to
    /// land. Treating this as `Unknown` is what let a transcript vanish into
    /// a Mail inbox on 2026-08-25 — the restore had already failed, the
    /// re-read said "nothing has focus", and the paste was sent anyway.
    NoFocus,
}

impl TextTarget {
    /// Classify the role of the element captured at hotkey time.
    ///
    /// `None` here means "we never captured an element", which is not
    /// evidence about where the caret is — it stays [`TextTarget::Unknown`]
    /// so the blind-⌘V path that works for many apps is preserved. Use
    /// [`TextTarget::from_probe`] for a live focus read, where `None` is
    /// evidence.
    pub fn from_role(role: Option<&str>) -> Self {
        match role {
            Some(
                "AXTextArea" | "AXTextField" | "AXSecureTextField" | "AXSearchField" | "AXComboBox",
            ) => TextTarget::Accepts,
            Some(
                "AXList"
                | "AXTable"
                | "AXOutline"
                | "AXRow"
                | "AXCell"
                | "AXColumn"
                | "AXTabGroup"
                | "AXButton"
                | "AXRadioButton"
                | "AXCheckBox"
                | "AXPopUpButton"
                | "AXMenuButton"
                | "AXMenu"
                | "AXMenuItem"
                | "AXMenuBar"
                | "AXMenuBarItem"
                | "AXImage"
                | "AXSlider"
                | "AXScrollBar"
                | "AXToolbar"
                | "AXStaticText"
                | "AXLink"
                | "AXProgressIndicator"
                | "AXDisclosureTriangle",
            ) => TextTarget::Rejects,
            // Containers (AXGroup, AXScrollArea, AXWebArea, AXWindow, …), custom
            // roles, and "no role read" all land here.
            _ => TextTarget::Unknown,
        }
    }

    /// Classify a *live* focus probe of the target app.
    ///
    /// Unlike [`TextTarget::from_role`], `None` is meaningful: the app was
    /// asked what has keyboard focus and answered "nothing". That is a
    /// provable dead end for ⌘V, so it maps to [`TextTarget::NoFocus`].
    pub fn from_probe(role: Option<&str>) -> Self {
        match role {
            None => TextTarget::NoFocus,
            Some(r) => TextTarget::from_role(Some(r)),
        }
    }

    /// Whether a synthesized ⌘V may be sent at this target.
    ///
    /// `Unknown` stays permissive (unrecognised roles are usually fine);
    /// `Rejects` and `NoFocus` are both provable dead ends.
    pub fn allows_synthetic_paste(self) -> bool {
        matches!(self, TextTarget::Accepts | TextTarget::Unknown)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TextTarget::Accepts => "accepts",
            TextTarget::Rejects => "rejects",
            TextTarget::Unknown => "unknown",
            TextTarget::NoFocus => "no_focus",
        }
    }
}

/// Result of writing text straight into a captured AX element.
///
/// The distinction that matters is `Refuted` vs `Unverifiable`: an `AXError`
/// of 0 is *not* proof that text landed (setting an attribute on an element
/// an app no longer considers live succeeds and does nothing), so we measure
/// the element instead of believing the return code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertOutcome {
    /// The element's character count moved as expected. Text is in.
    Confirmed,
    /// The write failed, or the character count provably did not change.
    /// Safe to fall back to ⌘V — nothing was inserted.
    Refuted,
    /// The write reported success but the element does not expose a
    /// character count, so we cannot measure it. Treated as success: we must
    /// not retry via ⌘V, because if the text *did* land a retry would
    /// duplicate it.
    Unverifiable,
}

impl InsertOutcome {
    /// Whether the caller should consider the text delivered and skip ⌘V.
    pub fn delivered(self) -> bool {
        matches!(self, InsertOutcome::Confirmed | InsertOutcome::Unverifiable)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            InsertOutcome::Confirmed => "confirmed",
            InsertOutcome::Refuted => "refuted",
            InsertOutcome::Unverifiable => "unverifiable",
        }
    }
}

/// What the caller intends to do once focus is restored. Determines whether a
/// dead-end target may be swapped for wherever the user is focused now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteIntent {
    /// Insert text at the caret. Additive and easy to undo, so when the
    /// captured target cannot accept text we may fall back to the user's
    /// current field rather than dropping the transcript.
    Insert,
    /// Replace the user's selection. Must land in the captured element or not
    /// at all — redirecting would stomp unrelated text in another app.
    ReplaceSelection,
}

/// Why a synthesized paste must not be sent. `None` from
/// [`RestoreOutcome::blocker`] means it is safe to paste.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteBlocker {
    /// The captured app refused to come forward, so ⌘V would land in whatever
    /// app is still in front.
    AppNotFrontmost,
    /// The target was verified, but another app became frontmost during the
    /// short settle delay before Cmd+V was dispatched.
    FocusChanged,
    /// Nothing that can hold text has keyboard focus, so ⌘V would be
    /// swallowed (e.g. dictation started with a file list or button focused).
    NoTextTarget,
}

impl PasteBlocker {
    /// Short machine-readable reason, recorded on the capture event.
    pub fn reason(self) -> &'static str {
        match self {
            PasteBlocker::AppNotFrontmost => "focus_restore",
            PasteBlocker::FocusChanged => "focus_changed",
            PasteBlocker::NoTextTarget => "no_text_target",
        }
    }

    /// Friendly, actionable message for the user. Raw AX detail stays in the log.
    pub fn user_message(self, app_label: &str) -> String {
        match self {
            PasteBlocker::AppNotFrontmost => format!(
                "Couldn't switch back to {app_label}. Your transcript is on the clipboard — press ⌘V to paste it."
            ),
            PasteBlocker::FocusChanged =>
                "Focus moved to another app before the transcript could be pasted. Your transcript is on the clipboard — click the intended field and press ⌘V."
                    .to_string(),
            PasteBlocker::NoTextTarget =>
                "No text field was focused, so there was nowhere to type. Your transcript is on the clipboard — click into a field and press ⌘V."
                    .to_string(),
        }
    }
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
    let browser_url = bundle_id.as_deref().and_then(capture_browser_url_macos);
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

    Some(FocusContext {
        pid,
        bundle_id,
        app_name,
        window_title,
        browser_url,
        browser_tab_title,
        content_title,
        content_url,
        content_source,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_context() -> Option<FocusContext> {
    None
}

/// Ask a Chromium-based AX server (Electron apps, Chrome/Arc/Brave, VS Code)
/// to build its accessibility tree. These apps report `kAXErrorNoValue` for
/// `AXFocusedUIElement` until an assistive client opts in:
///   * `AXManualAccessibility` — Electron's documented switch.
///   * `AXEnhancedUserInterface` — Chromium's switch (what VoiceOver sets).
/// Both writes fail harmlessly (`kAXErrorAttributeUnsupported`) on apps that
/// don't know the attribute, so this is safe to attempt on any pid.
/// The tree builds asynchronously, so the first query after enabling can
/// still miss; callers retry (and the paste-time re-probe benefits even when
/// the press-time retry loses the race).
#[cfg(target_os = "macos")]
fn enable_chromium_ax(app_el: &AXUIElement, pid: i32) {
    use objc2_core_foundation::{CFBoolean, CFString};

    let true_val: &CFBoolean = CFBoolean::new(true);
    unsafe {
        let manual = CFString::from_str("AXManualAccessibility");
        let err_manual = app_el.set_attribute_value(&manual, true_val.as_ref());
        let enhanced = CFString::from_str("AXEnhancedUserInterface");
        let err_enhanced = app_el.set_attribute_value(&enhanced, true_val.as_ref());
        tracing::info!(
            pid,
            manual_ax_error = err_manual.0,
            enhanced_ax_error = err_enhanced.0,
            "enable_chromium_ax: requested accessibility tree"
        );
    }
}

/// Which application actually owns an AX element, via `AXUIElementGetPid`.
///
/// The one authoritative answer to "whose element is this?". Without it a
/// system-wide focus read can hand us an element belonging to a completely
/// different app, which we then mislabel with the target's pid and try to
/// restore into the target — a set that silently no-ops while reporting
/// success. Returns `None` if the element is stale or the call fails.
#[cfg(target_os = "macos")]
fn element_owner_pid(element: &AXUIElement) -> Option<i32> {
    use std::ptr::NonNull;
    let mut owner: pid_t = 0;
    let out = NonNull::new(&mut owner as *mut pid_t)?;
    let err = unsafe { element.pid(out) };
    if err.0 != 0 {
        return None;
    }
    Some(owner as i32)
}

/// Capture the AX-level focused UI element of the given pid's application.
///
/// Tries the **app-level** `AXUIElement` first (the conventional, reliable
/// pattern). If that returns no element — the signature of a Chromium-based
/// app that hasn't built its AX tree yet — it enables the tree via
/// [`enable_chromium_ax`] and retries once, then falls back to the
/// system-wide element. The previous system-wide-only approach returned
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
        let mut app_err = app_el.copy_attribute_value(&ax_focused_ui, out_ptr);

        // ── Strategy 1b: Chromium/Electron/WebKit apps hide their AX tree
        // until asked. Enable it and retry, bounded (≤ ~300 ms extra, only
        // on the empty path) so the hotkey stays responsive; WebKit in
        // particular often needs more than one beat to build the tree, and
        // an element captured here is what unlocks the direct-insert path.
        if app_err.0 != 0 || raw.is_null() {
            enable_chromium_ax(&app_el, pid);
            for settle_ms in [120u64, 180] {
                std::thread::sleep(std::time::Duration::from_millis(settle_ms));
                raw = std::ptr::null();
                let out_ptr = NonNull::new(&mut raw as *mut *const CFType)?;
                app_err = app_el.copy_attribute_value(&ax_focused_ui, out_ptr);
                if app_err.0 == 0 && !raw.is_null() {
                    break;
                }
            }
        }

        let (element, source) = if app_err.0 == 0 && !raw.is_null() {
            let nn = NonNull::new(raw as *mut AXUIElement)?;
            (CFRetained::<AXUIElement>::from_raw(nn), "app")
        } else {
            // ── Strategy 2: system-wide fallback ────────────────────────
            tracing::info!(
                pid,
                ax_error = app_err.0,
                raw_null = raw.is_null(),
                "capture_focused_element: app-level returned no element after ax-enable retry; falling back to system-wide"
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

        // ── Ownership check ─────────────────────────────────────────────
        // The system-wide focus attribute is global: it can point at an
        // element belonging to a *different* app than the one we are about
        // to paste into (commonly a stale pointer to the field we pasted
        // into moments ago). Keeping such an element would mean restoring
        // app B's text field as app A's focus — a no-op that returns
        // kAXErrorSuccess and sends the paste into the void.
        //
        // Treat a foreign element as no element at all: the caller then
        // falls back to a live focus probe of the real target and, if that
        // comes back empty, blocks the paste instead of guessing.
        let owner_pid = element_owner_pid(&element);
        if owner_pid != Some(pid) {
            tracing::warn!(
                pid,
                owner_pid = ?owner_pid,
                source,
                "capture_focused_element: focused element belongs to a different app; discarding it"
            );
            return None;
        }

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
            return Some(SelectionSnapshot {
                text,
                method: SelectionMethod::Ax,
            });
        }
    }
    if let Some(text) = crate::input::paste::capture_selection_via_copy() {
        tracing::info!(target: "edit", chars = text.len(), "capture_selection: via Cmd+C fallback");
        return Some(SelectionSnapshot {
            text,
            method: SelectionMethod::Copy,
        });
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
        use objc2_application_services::AXUIElement;
        use objc2_core_foundation::{CFBoolean, CFString};

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
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
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

    /// Character count of this element, when it reports one.
    pub fn char_count(&self) -> Option<i64> {
        copy_ax_i64_attribute(&self.element, "AXNumberOfCharacters")
    }

    /// Write `text` into this element at its caret and **verify it landed**.
    ///
    /// This is the primary delivery path for dictation, and the reason a
    /// transcript can no longer arrive in the wrong place: it addresses the
    /// element directly rather than aiming a keystroke at whatever happens
    /// to have focus. There is no app activation, no clipboard round-trip,
    /// and no dependency on which window the WindowServer thinks is key —
    /// so there is no window in which the target can change underneath us.
    ///
    /// Verification measures the element's character count before and after
    /// and compares against the expected delta (inserted chars minus any
    /// selection the insert replaced). A `Refuted` result means nothing was
    /// written, so the caller may safely fall back to ⌘V.
    pub fn insert_text_verified(&self, text: &str) -> InsertOutcome {
        let inserted = text.chars().count() as i64;
        let replaced = self
            .selected_text()
            .map(|s| s.chars().count() as i64)
            .unwrap_or(0);
        let before = self.char_count();

        let err = self.replace_selected_text(text);
        if err != 0 {
            tracing::warn!(
                pid = self.pid,
                ax_error = err,
                "insert_text_verified: AX write failed; falling back to paste"
            );
            return InsertOutcome::Refuted;
        }

        let after = self.char_count();
        let verdict = match (before, after) {
            (Some(b), Some(a)) => {
                let expected = b - replaced + inserted;
                if a == expected || a != b {
                    InsertOutcome::Confirmed
                } else {
                    InsertOutcome::Refuted
                }
            }
            // No measurable character count: the write reported success and
            // we cannot prove otherwise. Retrying with ⌘V risks duplicating
            // text that did land, which is worse than an unverified success.
            _ => InsertOutcome::Unverifiable,
        };

        tracing::info!(
            pid = self.pid,
            role = ?self.role,
            chars = inserted,
            replaced,
            before = ?before,
            after = ?after,
            verdict = verdict.as_str(),
            "insert_text_verified: direct AX insertion"
        );
        verdict
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

/// Final guard immediately before synthesizing paste.
///
/// Focus can change after app activation was verified but before the settle
/// delay completes. The caller must only dispatch Cmd+V while the intended
/// target is still frontmost.
pub fn paste_target_still_frontmost(
    expected_target_pid: Option<i32>,
    current_frontmost_pid: Option<i32>,
) -> bool {
    match expected_target_pid {
        Some(expected_pid) => current_frontmost_pid == Some(expected_pid),
        None => true,
    }
}

/// Which API actually brought the target app forward.
///
/// Logged at paste time so the diagnostics answer *which* activation path
/// works on this macOS version, rather than only telling us that activation
/// failed. See `activate_app` for why there is more than one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ActivationPath {
    /// No API reported success (or the app was already frontmost).
    #[default]
    None,
    /// `-[NSRunningApplication activateFromApplication:options:]` (macOS 14+).
    Cooperative,
    /// `-[NSRunningApplication activateWithOptions:]` — deprecated in macOS 14.
    Legacy,
    /// `-[NSWorkspace openApplicationAtURL:configuration:]`, which routes
    /// through LaunchServices instead of the in-process activation path.
    LaunchServices,
}

impl ActivationPath {
    pub fn as_str(self) -> &'static str {
        match self {
            ActivationPath::None => "none",
            ActivationPath::Cooperative => "cooperative",
            ActivationPath::Legacy => "legacy",
            ActivationPath::LaunchServices => "launch_services",
        }
    }
}

/// Re-activate the previously-frontmost app before synthesising Cmd+V.
///
/// macOS 14 replaced free-for-all activation with *cooperative* activation:
/// `NSApplicationActivateIgnoringOtherApps` is deprecated and, per Apple's own
/// header, "will have no effect". Echo Scribe is an accessory app that is
/// never frontmost, so the legacy call is routinely denied — which is exactly
/// the `activateWithOptions failed` / `frontmost_verified=false` pair we were
/// logging on the cross-app paste path.
///
/// So we try the modern in-process call first and keep the legacy one only as
/// a fallback for pre-14 systems. `activate_via_launch_services` is the third
/// tier and lives in its own function because it is asynchronous.
#[cfg(target_os = "macos")]
pub fn activate_app(ctx: &FocusContext) -> ActivationPath {
    use objc2::runtime::NSObjectProtocol;
    use objc2::sel;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(ctx.pid as pid_t)
    else {
        return ActivationPath::None;
    };

    // macOS 14+: name ourselves as the app handing over active status. The
    // selector is absent on older systems, so probe before calling it.
    if app.respondsToSelector(sel!(activateFromApplication:options:)) {
        let me = NSRunningApplication::currentApplication();
        if app.activateFromApplication_options(&me, NSApplicationActivationOptions::empty()) {
            return ActivationPath::Cooperative;
        }
    }

    #[allow(deprecated)]
    let opts = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    if app.activateWithOptions(opts) {
        return ActivationPath::Legacy;
    }

    ActivationPath::None
}

/// Ask LaunchServices to bring the app forward.
///
/// Unlike `NSRunningApplication`'s in-process activation this goes out to
/// launchservicesd, which is not bound by the cooperative-activation rules
/// that block a background app from fronting someone else. It is asynchronous
/// — the caller must poll `wait_until_frontmost` afterwards; a `true` return
/// only means the request was dispatched.
///
/// Only ever called for a pid we already resolved to a *running* app, and with
/// `createsNewApplicationInstance = false`, so this can never launch a second
/// copy of the target.
#[cfg(target_os = "macos")]
pub fn activate_via_launch_services(ctx: &FocusContext) -> bool {
    use block2::RcBlock;
    use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
    use objc2_foundation::NSError;

    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(ctx.pid as pid_t)
    else {
        return false;
    };
    let Some(url) = app.bundleURL() else {
        tracing::warn!(
            pid = ctx.pid,
            "no bundle URL for target app; cannot activate via LaunchServices"
        );
        return false;
    };

    let config = NSWorkspaceOpenConfiguration::configuration();
    config.setActivates(true);
    config.setCreatesNewApplicationInstance(false);
    config.setAddsToRecentItems(false);

    let pid = ctx.pid;
    let handler = RcBlock::new(move |_app: *mut NSRunningApplication, err: *mut NSError| {
        if !err.is_null() {
            // Safety: non-null NSError owned by the caller for the duration
            // of the callback.
            let msg = unsafe { (*err).localizedDescription() };
            tracing::warn!(pid, error = %msg, "LaunchServices activation failed");
        }
    });

    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
        &url,
        &config,
        Some(&handler),
    );
    true
}

#[cfg(not(target_os = "macos"))]
pub fn activate_via_launch_services(_ctx: &FocusContext) -> bool {
    false
}

/// Decide whether to re-apply the captured AX element at paste time.
///
///   * Cross-app return path: always restore (multi-window apps route paste
///     to the field that started dictation).
///   * Same-app: only restore when **nothing currently has focus**. A live
///     caret must never be overridden (the AX snapshot can be stale after a
///     recent click), but when the app reports a focus *void* — e.g. a click
///     activated the window without making any field first responder — the
///     blind Cmd+V would land nowhere, so restoring the captured element can
///     only help.
fn should_restore_captured_element(
    frontmost_pid_before_restore: Option<i32>,
    captured_pid: i32,
    element_captured: bool,
    paste_time_focus_present: bool,
) -> bool {
    if !element_captured {
        return false;
    }
    if frontmost_pid_before_restore != Some(captured_pid) {
        return true;
    }
    !paste_time_focus_present
}

/// Probe which element (if any) has AX focus in the app *right now*.
/// Returns the element's role when something has focus (`"?"` if the role
/// read fails — presence is the signal, the role is diagnostic), `None`
/// when the app reports no focused element.
#[cfg(target_os = "macos")]
fn probe_focused_role(pid: i32) -> Option<String> {
    let el = focused_ui_element_macos(pid)?;
    Some(copy_ax_string_attribute(&el, "AXRole").unwrap_or_else(|| "?".to_string()))
}

/// Probe for AX focus, treating an empty first answer as "not built yet"
/// rather than "nothing focused".
///
/// A single-shot probe reads `None` for two very different situations:
/// a real focus void, and a Chromium/Electron/WebKit app whose AX tree is
/// lazily built (or an app still re-establishing its first responder right
/// after a cross-app activation). Production logs show the second case is
/// the common one — Tauri/Electron apps answered "no focus" moments after
/// the user was typing in them, and the paste was refused. So on an empty
/// read, ask the app to build its tree (same switch the capture path
/// flips) and re-probe with settle sleeps; `just_activated` buys extra
/// polls because focus restoration after activation is asynchronous.
/// The retries only run on the empty path, so a healthy app pays nothing.
#[cfg(target_os = "macos")]
fn probe_focused_role_settled(pid: i32, just_activated: bool) -> Option<String> {
    if let Some(role) = probe_focused_role(pid) {
        return Some(role);
    }
    let app_el = unsafe { AXUIElement::new_application(pid as pid_t) };
    enable_chromium_ax(&app_el, pid);
    let polls = if just_activated { 4 } else { 2 };
    for attempt in 0..polls {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Some(role) = probe_focused_role(pid) {
            tracing::info!(
                pid,
                attempt,
                role = %role,
                "probe_focused_role_settled: focus appeared after ax-enable retry"
            );
            return Some(role);
        }
    }
    None
}

/// After a cross-app activation, poll until the target app is actually
/// frontmost. Activation is asynchronous (and unreliable under modern
/// cooperative-activation rules), so a `true` return from any activation API
/// does not mean the app is forward yet — and a paste synthesized before it
/// is lands in whatever app is still in front.
///
/// On timeout we log the sequence of pids we actually observed, which
/// distinguishes "the app never moved" (all polls show the same intruder)
/// from "it was still coming forward when we gave up" (pid churn, or the
/// target appearing at the tail) — the two need opposite fixes.
#[cfg(target_os = "macos")]
fn wait_until_frontmost(pid: i32, polls: u32, label: &str) -> bool {
    let mut observed: Vec<String> = Vec::new();
    for attempt in 0..polls {
        let front = current_frontmost_pid();
        if front == Some(pid) {
            if attempt > 0 {
                tracing::info!(
                    pid,
                    attempt,
                    stage = label,
                    "target app became frontmost after wait"
                );
            }
            return true;
        }
        match observed.last() {
            Some(last) if *last == format!("{front:?}") => {}
            _ => observed.push(format!("{front:?}")),
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
    tracing::warn!(
        pid,
        stage = label,
        polls,
        observed_frontmost = %observed.join(" -> "),
        "target app never became frontmost"
    );
    false
}

/// Deliver `text` straight into the captured element, without activating the
/// app or synthesizing a keystroke — when that is provably the right target.
///
/// Returns `None` when direct insertion does not apply and the caller should
/// use the activate-and-⌘V path.
///
/// The gate matters as much as the write. Direct insertion addresses the
/// element captured at hotkey time, so it must not be used when the user has
/// a *live caret somewhere else in the same app*: they may have clicked into
/// a different field while speaking, and the visible caret wins. So we insert
/// directly only when there is no live caret to respect:
///
///   * the captured app is not frontmost — the user moved away entirely, and
///     the captured element is exactly where the old code would have pasted
///     after yanking the app forward; or
///   * the captured app is frontmost but reports no focused element — a
///     click-activated window with no first responder, where ⌘V would land
///     nowhere at all.
///
/// `ReplaceSelection` is excluded: the edit path applies its own AX
/// write-back against a selection it captured itself.
#[cfg(target_os = "macos")]
pub fn try_direct_insert(
    ctx: &FocusContext,
    element: Option<&FocusElement>,
    text: &str,
    intent: PasteIntent,
) -> Option<InsertOutcome> {
    if intent != PasteIntent::Insert {
        return None;
    }
    let el = element?;
    if TextTarget::from_role(el.role()) != TextTarget::Accepts {
        return None;
    }

    let frontmost = current_frontmost_pid();
    let live_focus_present = if frontmost == Some(ctx.pid) {
        probe_focused_role(ctx.pid).is_some()
    } else {
        false
    };
    if !should_restore_captured_element(frontmost, ctx.pid, true, live_focus_present) {
        tracing::info!(
            pid = ctx.pid,
            "direct insert skipped; target app frontmost with a live caret to respect"
        );
        return None;
    }

    let outcome = el.insert_text_verified(text);
    tracing::info!(
        pid = ctx.pid,
        app = ?ctx.app_name,
        frontmost_pid = ?frontmost,
        outcome = outcome.as_str(),
        "direct AX insert attempted (no app activation, no synthetic paste)"
    );
    Some(outcome)
}

#[cfg(not(target_os = "macos"))]
pub fn try_direct_insert(
    _ctx: &FocusContext,
    _element: Option<&FocusElement>,
    _text: &str,
    _intent: PasteIntent,
) -> Option<InsertOutcome> {
    None
}

/// Restore focus before paste. Strategy:
///   0. If the captured element provably cannot hold a caret, stop: never
///      activate an app for a paste that would be swallowed (see
///      [`redirect_or_block`]).
///   1. If the captured app is not currently frontmost, call
///      `activateWithOptions` to bring the app forward, then **verify** it
///      actually became frontmost (`frontmost_verified`) so the caller can
///      refuse to paste into the wrong app.
///   2. For that cross-app return path, restore the captured AX element so
///      multi-window apps route paste to the field that started dictation.
///   3. If the captured app is already frontmost, probe its *current*
///      focused element. If something has focus, leave it alone (the AX
///      snapshot can be stale; the visible caret wins). If the app reports
///      a focus void — click-activated window with no first responder —
///      restore the captured element so Cmd+V has somewhere to land.
///   4. Re-read the focused role after any restore and refuse to paste into
///      an element that rejects text.
#[cfg(target_os = "macos")]
pub fn restore_focus(
    ctx: &FocusContext,
    element: Option<&FocusElement>,
    intent: PasteIntent,
) -> RestoreOutcome {
    let frontmost = current_frontmost_pid();
    let same_app = frontmost == Some(ctx.pid);
    let captured_target = TextTarget::from_role(element.and_then(|e| e.role()));

    // Guard 1: the element that was focused at hotkey-press time cannot hold a
    // caret — dictation started with a file list, a button, or a menu focused.
    // Activating its app would steal the user's current window for a ⌘V that
    // gets discarded, which is exactly how a 73-second transcript disappeared
    // into a Finder list view. Never activate for a dead-end target.
    if captured_target == TextTarget::Rejects {
        return redirect_or_block(ctx, element, intent, frontmost, same_app);
    }

    // Guard 1b: cross-app return with nothing captured. Probe the captured
    // app *before* activating it: if whatever holds focus there provably
    // rejects text (dictation started from a file tree, a read-only page…),
    // activation would steal the user's screen for a ⌘V that gets discarded
    // — while their live caret may be exactly where they are looking right
    // now (observed 2026-08-31: VS Code sidebar outline captured, user had
    // moved to a chat text area by paste time). Same dead-end rule as
    // Guard 1, evaluated live. `from_role`, not `from_probe`: an empty
    // probe of a background webview app is opacity, not evidence, and must
    // stay on the activate-and-verify path.
    if !same_app && element.is_none() {
        let pre_activation_role = probe_focused_role(ctx.pid);
        if TextTarget::from_role(pre_activation_role.as_deref()) == TextTarget::Rejects {
            tracing::warn!(
                pid = ctx.pid,
                app = ?ctx.app_name,
                live_role = ?pre_activation_role,
                "captured app's live focus rejects text; skipping its activation"
            );
            return redirect_or_block(ctx, element, intent, frontmost, same_app);
        }
    }

    let mut activated = false;
    let mut activation_path = ActivationPath::None;
    let frontmost_verified = if same_app {
        true
    } else {
        // Tier 1+2: in-process activation (cooperative, then legacy).
        for attempt in 0..3 {
            let path = activate_app(ctx);
            if path != ActivationPath::None {
                if attempt > 0 {
                    tracing::info!(
                        attempt,
                        pid = ctx.pid,
                        path = path.as_str(),
                        "app activated on retry"
                    );
                }
                activated = true;
                activation_path = path;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !activated {
            tracing::warn!(
                pid = ctx.pid,
                "in-process activation refused after 3 attempts; falling back to LaunchServices"
            );
        }
        // Even when the API reported failure the app can still come forward
        // (or already be mid-transition) — trust the observed frontmost pid,
        // not the return value.
        if wait_until_frontmost(ctx.pid, 10, "in_process") {
            true
        } else {
            // Tier 3: LaunchServices. Not bound by cooperative activation,
            // so this is the one that works when a background app needs to
            // front someone else. Slower (out-of-process), hence the longer
            // poll budget — but we only pay it on a path that would
            // otherwise have lost the paste entirely.
            if activate_via_launch_services(ctx) {
                let ok = wait_until_frontmost(ctx.pid, 20, "launch_services");
                if ok {
                    activated = true;
                    activation_path = ActivationPath::LaunchServices;
                }
                ok
            } else {
                false
            }
        }
    };

    // What has focus in the target app *right now*? Only meaningful when the
    // app is actually frontmost. The settled probe matters most right after
    // a cross-app activation: the app is frontmost but may not have
    // re-established its first responder (or built its AX tree) yet.
    let paste_time_focus_role = if frontmost_verified {
        probe_focused_role_settled(ctx.pid, !same_app)
    } else {
        None
    };

    let should_restore_element = should_restore_captured_element(
        frontmost,
        ctx.pid,
        element.is_some(),
        paste_time_focus_role.is_some(),
    );
    let (ax_set, ax_error) = match element {
        Some(el) if should_restore_element => {
            if same_app {
                tracing::info!(
                    pid = ctx.pid,
                    captured_role = ?el.role(),
                    "focus void detected (no focused element at paste time); restoring captured element"
                );
            }
            let code = el.restore();
            (code == 0, Some(code))
        }
        Some(_) => {
            tracing::info!(
                pid = ctx.pid,
                frontmost_pid_before = ?frontmost,
                paste_time_focus_role = ?paste_time_focus_role,
                "skipping captured AX element restore; target app frontmost with live focus"
            );
            (false, None)
        }
        None => (false, None),
    };

    // Guard 2: `paste_time_focus_role` was read *before* the element restore,
    // so re-read it after to learn where the caret actually ended up. A role
    // that rejects text means the ⌘V we are about to send would be swallowed.
    let final_focus_role = if frontmost_verified && ax_set {
        probe_focused_role_settled(ctx.pid, false)
    } else {
        paste_time_focus_role.clone()
    };
    // `from_probe`, not `from_role`: this is a live read of the target app,
    // so "nothing has focus" is evidence, not an unknown. An `ax_set` of
    // true only means the AX call returned 0 — this re-read is what decides
    // whether the restore actually took.
    let final_target = TextTarget::from_probe(final_focus_role.as_deref());

    // `NoFocus` is only proof of a dead end when the app has demonstrated it
    // reports focus at all — i.e. we captured an app-owned focused element
    // from it at hotkey time. When we never got one (Tauri/Electron webviews
    // routinely expose nothing through `AXFocusedUIElement`, even with the
    // tree enabled), an empty probe is indistinguishable from AX opacity, so
    // it is not evidence about the caret. Those apps get the long-standing
    // blind ⌘V, bounded by the post-paste landing check and by keeping the
    // transcript on the clipboard. The 2026-08-25 Mail regression stays
    // fixed: Mail *did* expose the captured element, so its silence blocks.
    let no_focus_provable = element.is_some();
    let blocker = if !frontmost_verified {
        Some(PasteBlocker::AppNotFrontmost)
    } else if final_target == TextTarget::NoFocus && !no_focus_provable {
        tracing::warn!(
            pid = ctx.pid,
            app = ?ctx.app_name,
            "target app reports no focused element but never exposed one this round; allowing blind paste under landing check"
        );
        None
    } else if !final_target.allows_synthetic_paste() {
        tracing::warn!(
            pid = ctx.pid,
            captured_role = ?element.and_then(|e| e.role()),
            final_focus_role = ?final_focus_role,
            final_target = final_target.as_str(),
            ax_restore_reported_success = ax_set,
            "no element able to accept text has focus; refusing synthetic paste"
        );
        Some(PasteBlocker::NoTextTarget)
    } else {
        None
    };

    RestoreOutcome {
        same_app,
        activated_app: activated,
        activation_path,
        frontmost_verified,
        ax_focused: ax_set,
        ax_error,
        element_captured: element.is_some(),
        element_role: element.and_then(|e| e.role().map(|s| s.to_string())),
        frontmost_pid_before: frontmost,
        paste_time_focus_role: final_focus_role,
        captured_target,
        paste_time_target: final_target,
        redirected_pid: None,
        blocker,
    }
}

/// Handle a captured element that cannot accept text (Guard 1).
///
/// The captured target is a dead end, so there is nothing to lose by looking
/// elsewhere — and one obvious place to look: if the user is *right now*
/// focused in a real text field, that is where they moved to while speaking
/// and where they expect the dictation to appear. Pasting there beats pasting
/// into the void. When no such field exists, block the paste so the caller
/// falls back to the clipboard instead of losing the transcript silently.
///
/// Never redirects for [`PasteIntent::ReplaceSelection`]: overwriting a
/// selection in an app the user did not dictate from would destroy text.
#[cfg(target_os = "macos")]
fn redirect_or_block(
    ctx: &FocusContext,
    element: Option<&FocusElement>,
    intent: PasteIntent,
    frontmost: Option<i32>,
    same_app: bool,
) -> RestoreOutcome {
    let captured_role = element.and_then(|e| e.role().map(|s| s.to_string()));
    let base = RestoreOutcome {
        same_app,
        element_captured: element.is_some(),
        element_role: captured_role.clone(),
        frontmost_pid_before: frontmost,
        captured_target: TextTarget::Rejects,
        ..Default::default()
    };

    // Our own overlay is never a paste destination.
    let candidate = frontmost.filter(|pid| *pid != std::process::id() as i32);

    if intent == PasteIntent::Insert {
        if let Some(pid) = candidate {
            let role = probe_focused_role(pid);
            if TextTarget::from_probe(role.as_deref()) == TextTarget::Accepts {
                tracing::warn!(
                    captured_pid = ctx.pid,
                    captured_role = ?captured_role,
                    target_pid = pid,
                    target_role = ?role,
                    redirected = pid != ctx.pid,
                    "captured element cannot accept text; pasting into the currently focused text field instead"
                );
                return RestoreOutcome {
                    // The app we are about to paste into is already frontmost,
                    // so no activation is needed and none was attempted.
                    frontmost_verified: true,
                    paste_time_focus_role: role,
                    paste_time_target: TextTarget::Accepts,
                    redirected_pid: (pid != ctx.pid).then_some(pid),
                    blocker: None,
                    ..base
                };
            }
        }
    }

    tracing::warn!(
        captured_pid = ctx.pid,
        captured_role = ?captured_role,
        frontmost_pid = ?frontmost,
        intent = ?intent,
        "no element able to accept text; refusing synthetic paste"
    );
    RestoreOutcome {
        frontmost_verified: same_app,
        blocker: Some(PasteBlocker::NoTextTarget),
        ..base
    }
}

#[cfg(not(target_os = "macos"))]
pub fn restore_focus(
    _ctx: &FocusContext,
    _element: Option<&FocusElement>,
    _intent: PasteIntent,
) -> RestoreOutcome {
    RestoreOutcome {
        // Non-macOS has no activation handling and no AX focus reporting;
        // never block the paste on either.
        frontmost_verified: true,
        ..RestoreOutcome::default()
    }
}

/// Diagnostics from a `restore_focus` call. All fields are best-effort.
#[derive(Debug, Default, Clone)]
pub struct RestoreOutcome {
    pub same_app: bool,
    pub activated_app: bool,
    /// Which activation API brought the app forward. `None` when the app was
    /// already frontmost or nothing worked.
    pub activation_path: ActivationPath,
    /// Whether the target app was observed frontmost after (re)activation.
    /// When `false`, a synthesized Cmd+V would land in some *other* app —
    /// callers must not paste.
    pub frontmost_verified: bool,
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
    /// Role of whatever held AX focus in the target app just before Cmd+V,
    /// re-read *after* any element restore so it reflects where the caret
    /// actually ended up (`None` = the app reported no focused element — a
    /// focus void).
    pub paste_time_focus_role: Option<String>,
    /// Whether the element captured at hotkey-press time could accept text.
    pub captured_target: TextTarget,
    /// Whether whatever holds focus just before Cmd+V can accept text.
    pub paste_time_target: TextTarget,
    /// Set when the captured target was a dead end and the paste was pointed
    /// at the app the user is focused on now instead. Diagnostic only —
    /// nothing needs to be activated, since that app is already frontmost.
    pub redirected_pid: Option<i32>,
    /// `Some` when the paste must not be synthesized at all. Callers fall back
    /// to leaving the transcript on the clipboard and telling the user.
    pub blocker: Option<PasteBlocker>,
}

impl RestoreOutcome {
    /// `true` when the same-app paste has a confirmed landing spot: either
    /// something already held focus at paste time, or we successfully
    /// restored the captured element into a focus void. When the app never
    /// answered any focus query (e.g. it doesn't support AX focus reporting
    /// at all) we stay conservative and treat the paste as likely fine —
    /// blind Cmd+V was the long-standing behavior for those apps.
    pub fn paste_target_confirmed_or_unknown(&self) -> bool {
        // A paste sent at a focus void (the AX-opaque-app blind-⌘V path) may
        // be discarded without a trace — keep the transcript on the
        // clipboard so a manual ⌘V still works if it was.
        if self.paste_time_target == TextTarget::NoFocus {
            return false;
        }
        // Blind ⌘V with no captured element and no confirmed text target
        // (webview containers report AXWebArea/AXGroup): landing is
        // unverifiable, and webviews can blur their DOM caret across an
        // activation cycle so the ⌘V lands nowhere (observed 2026-08-31,
        // 252 chars silently lost AND clobbered off the clipboard by the
        // old-clipboard restore). Keeping the transcript on the clipboard
        // makes manual ⌘V an instant recovery, and removes the race where
        // a slow webview processes the ⌘V after the old clipboard is
        // restored and pastes stale content.
        if !self.element_captured && self.paste_time_target != TextTarget::Accepts {
            return false;
        }
        if !self.same_app {
            return true;
        }
        // The app proved it reports focus (we captured an element at press
        // time). If it now reports a void and the heal failed, the Cmd+V
        // has nowhere to land.
        if self.element_captured && self.paste_time_focus_role.is_none() && !self.ax_focused {
            return false;
        }
        true
    }
}

#[cfg(not(target_os = "macos"))]
pub fn activate_app(_ctx: &FocusContext) -> ActivationPath {
    ActivationPath::None
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
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

/// Fetch the active tab URL from a known browser via AppleScript.
/// Spawns a background thread with a 500 ms deadline so it never blocks.
#[cfg(target_os = "macos")]
fn capture_browser_url_macos(bundle_id: &str) -> Option<String> {
    let script = match bundle_id {
        "com.apple.Safari" => {
            "tell application \"Safari\" to get URL of current tab of front window"
        }
        "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.canary" => {
            "tell application \"Google Chrome\" to get URL of active tab of front window"
        }
        "company.thebrowser.Browser" => {
            "tell application \"Arc\" to get URL of active tab of front window"
        }
        "com.brave.Browser" | "com.brave.Browser.beta" => {
            "tell application \"Brave Browser\" to get URL of active tab of front window"
        }
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
        "com.apple.Safari" => {
            "tell application \"Safari\" to get name of current tab of front window"
        }
        "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.canary" => {
            "tell application \"Google Chrome\" to get title of active tab of front window"
        }
        "company.thebrowser.Browser" => {
            "tell application \"Arc\" to get title of active tab of front window"
        }
        "com.brave.Browser" | "com.brave.Browser.beta" => {
            "tell application \"Brave Browser\" to get title of active tab of front window"
        }
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
        let err = app_el.copy_attribute_value(
            &ax_focused_ui,
            NonNull::new(&mut raw as *mut *const CFType)?,
        );
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
        let err =
            element.copy_attribute_value(&attr, NonNull::new(&mut raw as *mut *const CFType)?);
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

/// Read an integer AX attribute (e.g. `AXNumberOfCharacters`).
///
/// This is the measuring tape for paste verification: comparing a text
/// element's character count before and after an insert is how we learn
/// whether text actually landed, rather than trusting an `AXError` of 0.
/// Uses a slightly longer timeout than the string reader because it is
/// called on the paste path, where a wrong answer is worse than a slow one.
#[cfg(target_os = "macos")]
fn copy_ax_i64_attribute(element: &AXUIElement, attr: &str) -> Option<i64> {
    use objc2_core_foundation::{CFNumber, CFString, CFType};
    use std::ptr::NonNull;

    let attr = CFString::from_str(attr);
    unsafe {
        let _ = element.set_messaging_timeout(0.2);
        let mut raw: *const CFType = std::ptr::null();
        let err =
            element.copy_attribute_value(&attr, NonNull::new(&mut raw as *mut *const CFType)?);
        if err.0 != 0 || raw.is_null() {
            return None;
        }
        let value: CFRetained<CFType> = CFRetained::from_raw(NonNull::new(raw as *mut CFType)?);
        value.downcast::<CFNumber>().ok().and_then(|n| n.as_i64())
    }
}

/// Character count of whatever element currently has focus in `pid`, used to
/// verify that a synthesized ⌘V actually landed. `None` when nothing has
/// focus or the element does not report a character count.
#[cfg(target_os = "macos")]
pub fn focused_char_count(pid: i32) -> Option<i64> {
    let el = focused_ui_element_macos(pid)?;
    copy_ax_i64_attribute(&el, "AXNumberOfCharacters")
}

#[cfg(not(target_os = "macos"))]
pub fn focused_char_count(_pid: i32) -> Option<i64> {
    None
}

/// After synthesizing ⌘V, confirm the text actually arrived.
///
/// The keystroke path is inherently unverifiable at the point of dispatch —
/// `CGEventPost` succeeds whether or not anything consumes the event — so
/// this is the only place we learn that a paste was swallowed. Polls the
/// focused element's character count, because apps apply a paste
/// asynchronously and the count is briefly unchanged right after dispatch.
///
/// Returns `Some(true)` when the text landed, `Some(false)` when the count
/// was readable the whole time and never moved, and `None` when the element
/// reports no character count (nothing provable either way).
#[cfg(target_os = "macos")]
pub fn wait_for_paste_landed(pid: i32, before: i64, polls: u32) -> Option<bool> {
    let mut saw_readable = false;
    for _ in 0..polls {
        std::thread::sleep(std::time::Duration::from_millis(60));
        match focused_char_count(pid) {
            Some(now) => {
                saw_readable = true;
                if now != before {
                    return Some(true);
                }
            }
            None => {}
        }
    }
    saw_readable.then_some(false)
}

#[cfg(not(target_os = "macos"))]
pub fn wait_for_paste_landed(_pid: i32, _before: i64, _polls: u32) -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
fn copy_ax_url_like_attribute(element: &AXUIElement, attr: &str) -> Option<String> {
    use objc2_core_foundation::{CFString, CFType, CFURL};
    use std::ptr::NonNull;

    let attr = CFString::from_str(attr);
    unsafe {
        let _ = element.set_messaging_timeout(0.05);
        let mut raw: *const CFType = std::ptr::null();
        let err =
            element.copy_attribute_value(&attr, NonNull::new(&mut raw as *mut *const CFType)?);
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
    fn activate_app_reports_no_path_for_invalid_pid() {
        let ctx = FocusContext {
            pid: -1,
            bundle_id: None,
            app_name: None,
            window_title: None,
            browser_url: None,
            browser_tab_title: None,
            content_title: None,
            content_url: None,
            content_source: None,
        };
        assert_eq!(activate_app(&ctx), ActivationPath::None);
        // No running app resolves from pid -1, so the LaunchServices tier
        // must bail out before it can ever ask launchservicesd to open
        // anything.
        assert!(!activate_via_launch_services(&ctx));
    }

    #[test]
    fn restore_focus_with_invalid_pid_returns_no_activation() {
        let ctx = FocusContext {
            pid: -1,
            bundle_id: None,
            app_name: None,
            window_title: None,
            browser_url: None,
            browser_tab_title: None,
            content_title: None,
            content_url: None,
            content_source: None,
        };
        let outcome = restore_focus(&ctx, None, PasteIntent::Insert);
        assert!(!outcome.activated_app);
        assert!(!outcome.ax_focused);
    }

    #[test]
    fn text_roles_accept_paste() {
        for role in [
            "AXTextArea",
            "AXTextField",
            "AXSecureTextField",
            "AXSearchField",
            "AXComboBox",
        ] {
            assert_eq!(
                TextTarget::from_role(Some(role)),
                TextTarget::Accepts,
                "{role} edits text"
            );
        }
    }

    #[test]
    fn structural_roles_reject_paste() {
        // AXList is the role Finder reported for the file/tab list that
        // swallowed a 73-second dictation.
        for role in [
            "AXList",
            "AXTabGroup",
            "AXTable",
            "AXOutline",
            "AXRow",
            "AXButton",
            "AXMenuItem",
            "AXImage",
            "AXStaticText",
        ] {
            assert_eq!(
                TextTarget::from_role(Some(role)),
                TextTarget::Rejects,
                "{role} cannot hold a caret"
            );
        }
    }

    #[test]
    fn container_and_missing_roles_stay_permissive() {
        // Containers routinely wrap real text views, and plenty of apps expose
        // custom roles — blocking these would break working pastes.
        for role in [
            Some("AXGroup"),
            Some("AXScrollArea"),
            Some("AXWebArea"),
            Some("AXWindow"),
            Some("AXSomeCustomRole"),
            Some("?"),
            None,
        ] {
            assert_eq!(
                TextTarget::from_role(role),
                TextTarget::Unknown,
                "{role:?} must not block the paste"
            );
        }
    }

    #[test]
    fn blocker_messages_are_friendly_and_distinct() {
        let not_frontmost = PasteBlocker::AppNotFrontmost.user_message("Slack");
        assert!(not_frontmost.contains("Slack"));
        assert!(not_frontmost.contains("⌘V"));
        let no_target = PasteBlocker::NoTextTarget.user_message("Finder");
        assert!(no_target.contains("⌘V"));
        assert_ne!(not_frontmost, no_target);
        assert_ne!(
            PasteBlocker::AppNotFrontmost.reason(),
            PasteBlocker::NoTextTarget.reason()
        );
    }

    #[test]
    fn uneditable_capture_blocks_paste_when_nothing_can_accept_text() {
        // pid -1 never resolves, so no candidate element can accept text: the
        // paste must be blocked rather than fired blindly.
        let ctx = FocusContext {
            pid: -1,
            bundle_id: None,
            app_name: None,
            window_title: None,
            browser_url: None,
            browser_tab_title: None,
            content_title: None,
            content_url: None,
            content_source: None,
        };
        let outcome = redirect_or_block(&ctx, None, PasteIntent::Insert, Some(-1), true);
        assert_eq!(outcome.blocker, Some(PasteBlocker::NoTextTarget));
        assert_eq!(outcome.captured_target, TextTarget::Rejects);
        assert!(
            !outcome.activated_app,
            "a dead-end target must never pull its app forward"
        );
        assert_eq!(outcome.redirected_pid, None);
    }

    #[test]
    fn uneditable_capture_never_redirects_an_edit() {
        let ctx = FocusContext {
            pid: -1,
            bundle_id: None,
            app_name: None,
            window_title: None,
            browser_url: None,
            browser_tab_title: None,
            content_title: None,
            content_url: None,
            content_source: None,
        };
        // Even with a live frontmost app available as a candidate, replacing a
        // selection must never be pointed at a different app.
        let outcome = redirect_or_block(
            &ctx,
            None,
            PasteIntent::ReplaceSelection,
            current_frontmost_pid(),
            false,
        );
        assert_eq!(outcome.redirected_pid, None);
        assert_eq!(outcome.blocker, Some(PasteBlocker::NoTextTarget));
    }

    #[test]
    fn does_not_restore_captured_ax_element_when_frontmost_app_has_live_focus() {
        assert!(
            !should_restore_captured_element(Some(42), 42, true, true),
            "a captured AX element can be stale; if the app is frontmost with a live caret, keep it"
        );
    }

    #[test]
    fn restores_captured_ax_element_into_a_same_app_focus_void() {
        assert!(
            should_restore_captured_element(Some(42), 42, true, false),
            "click-activated window with no first responder: blind Cmd+V lands nowhere, heal the void"
        );
    }

    #[test]
    fn never_restores_without_a_captured_element() {
        assert!(!should_restore_captured_element(Some(42), 42, false, false));
        assert!(!should_restore_captured_element(Some(7), 42, false, true));
    }

    #[test]
    fn restores_captured_ax_element_when_returning_to_a_background_app() {
        assert!(
            should_restore_captured_element(Some(7), 42, true, true),
            "cross-app dictation still needs the captured element after app activation"
        );
        assert!(should_restore_captured_element(Some(7), 42, true, false));
    }

    #[test]
    /// A live focus probe that comes back empty is evidence of a dead end,
    /// while "we never captured an element" is not. Conflating the two is
    /// what made the caret guard unable to fire.
    fn probe_none_is_no_focus_but_captured_none_stays_unknown() {
        assert_eq!(TextTarget::from_probe(None), TextTarget::NoFocus);
        assert_eq!(TextTarget::from_role(None), TextTarget::Unknown);
        // An unrecognised role is still permissive on both paths: plenty of
        // apps wrap real text views in custom roles.
        assert_eq!(
            TextTarget::from_probe(Some("AXCustomThing")),
            TextTarget::Unknown
        );
        assert_eq!(
            TextTarget::from_probe(Some("AXTextArea")),
            TextTarget::Accepts
        );
        assert_eq!(TextTarget::from_probe(Some("AXList")), TextTarget::Rejects);
    }

    #[test]
    /// Only provable dead ends block a synthetic paste.
    fn synthetic_paste_allowed_only_for_accepts_and_unknown() {
        assert!(TextTarget::Accepts.allows_synthetic_paste());
        assert!(TextTarget::Unknown.allows_synthetic_paste());
        assert!(!TextTarget::Rejects.allows_synthetic_paste());
        assert!(!TextTarget::NoFocus.allows_synthetic_paste());
    }

    #[test]
    /// Regression for the 2026-08-25 Mail incident: dictation captured a
    /// system-wide `AXTextArea` that belonged to another app, the restore
    /// silently no-opped, and the paste-time re-read reported no focus at
    /// all — which the old code classified as `Unknown` and pasted into.
    fn no_focus_after_failed_restore_blocks_the_paste() {
        // What the log recorded: paste_time_focus=None, so the target is a
        // provable void, not an unrecognised role.
        let final_target = TextTarget::from_probe(None);
        assert_eq!(final_target, TextTarget::NoFocus);
        assert!(
            !final_target.allows_synthetic_paste(),
            "a focus void must never receive a synthetic paste"
        );
    }

    #[test]
    /// An unverifiable write must count as delivered: retrying it via ⌘V
    /// would duplicate text that may already have landed.
    fn insert_outcome_delivery_semantics() {
        assert!(InsertOutcome::Confirmed.delivered());
        assert!(InsertOutcome::Unverifiable.delivered());
        assert!(!InsertOutcome::Refuted.delivered());
    }

    #[test]
    /// Direct insert is gated on there being no live caret to respect: it
    /// must not hijack a field the user clicked into while speaking.
    fn direct_insert_gate_matches_restore_gate() {
        // App not frontmost → the captured element is the target.
        assert!(should_restore_captured_element(Some(99), 42, true, false));
        // App frontmost with a live caret → leave it alone.
        assert!(!should_restore_captured_element(Some(42), 42, true, true));
        // App frontmost but reporting a focus void → captured element wins.
        assert!(should_restore_captured_element(Some(42), 42, true, false));
    }

    #[test]
    fn paste_target_confirmed_logic() {
        // Cross-app path with a captured element: activation/verification is
        // the gate, not focus probing. (Cross-app with *nothing* captured
        // and an unconfirmed target keeps the transcript on the clipboard —
        // see blind_paste_at_focus_void_keeps_transcript_on_clipboard.)
        let cross = RestoreOutcome {
            same_app: false,
            element_captured: true,
            ..Default::default()
        };
        assert!(cross.paste_target_confirmed_or_unknown());

        // Same app, focus-reporting app (element captured), void at paste
        // time, heal failed → paste has nowhere to land.
        let void_unhealed = RestoreOutcome {
            same_app: true,
            element_captured: true,
            paste_time_focus_role: None,
            ax_focused: false,
            ..Default::default()
        };
        assert!(!void_unhealed.paste_target_confirmed_or_unknown());

        // Same void, but the heal succeeded → confirmed.
        let void_healed = RestoreOutcome {
            ax_focused: true,
            ..void_unhealed.clone()
        };
        assert!(void_healed.paste_target_confirmed_or_unknown());

        // Live focus at paste time → confirmed.
        let live = RestoreOutcome {
            paste_time_focus_role: Some("AXTextArea".into()),
            ..void_unhealed.clone()
        };
        assert!(live.paste_target_confirmed_or_unknown());

        // App never proved it reports focus (no element captured) and the
        // live target is unconfirmed: the paste still goes out (blind ⌘V),
        // but the transcript stays on the clipboard because the landing is
        // unverifiable.
        let unknown = RestoreOutcome {
            same_app: true,
            element_captured: false,
            ..Default::default()
        };
        assert!(!unknown.paste_target_confirmed_or_unknown());
    }

    #[test]
    fn blind_paste_at_focus_void_keeps_transcript_on_clipboard() {
        // The AX-opaque-app path (blocker downgraded, ⌘V sent at a probe
        // void) may be silently discarded — the transcript must stay on the
        // clipboard so a manual ⌘V recovers it. Applies cross-app too.
        for same_app in [true, false] {
            let blind = RestoreOutcome {
                same_app,
                element_captured: false,
                paste_time_target: TextTarget::NoFocus,
                ..Default::default()
            };
            assert!(
                !blind.paste_target_confirmed_or_unknown(),
                "NoFocus target (same_app={same_app}) must keep the transcript on the clipboard"
            );
        }

        // Same rule for an unconfirmed (Unknown) target with nothing
        // captured — the AXWebArea blind-⌘V path, where a webview can blur
        // its caret across activation and swallow the paste unverifiably.
        let webview_blind = RestoreOutcome {
            same_app: false,
            element_captured: false,
            paste_time_target: TextTarget::Unknown,
            ..Default::default()
        };
        assert!(!webview_blind.paste_target_confirmed_or_unknown());

        // But a confirmed Accepts target restores the user's clipboard even
        // when nothing was captured at hotkey time (live probe confirmed).
        let live_confirmed = RestoreOutcome {
            same_app: true,
            element_captured: false,
            paste_time_target: TextTarget::Accepts,
            paste_time_focus_role: Some("AXTextArea".into()),
            ..Default::default()
        };
        assert!(live_confirmed.paste_target_confirmed_or_unknown());
    }

    #[test]
    fn blocks_paste_when_focus_changes_after_target_verification() {
        assert!(paste_target_still_frontmost(Some(42), Some(42)));
        assert!(
            !paste_target_still_frontmost(Some(42), Some(7)),
            "Cmd+V must not be sent after another app becomes frontmost during the settle delay"
        );
    }

    #[test]
    fn current_frontmost_pid_is_positive_when_present() {
        if let Some(pid) = current_frontmost_pid() {
            assert!(pid > 0);
        }
    }
}
