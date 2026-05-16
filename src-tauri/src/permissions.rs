//! Native macOS permission checks and prompts.
//!
//! [`status`] only *checks* state and never prompts. The dedicated
//! [`request_microphone`] and [`prompt_accessibility`] entry points trigger the
//! standard macOS prompts; they're only invoked when the user clicks the
//! "Grant access" button in onboarding.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PermissionsStatus {
    pub microphone: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
    pub calendars: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum SettingsPane {
    Microphone,
    Accessibility,
    ScreenCapture,
    Calendars,
}

/// Result of an asynchronous microphone access request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAccessOutcome {
    Granted,
    Denied,
    /// The completion handler dropped its sender without producing a value
    /// (e.g. the framework never invoked it). Treat like `Denied` for UX.
    Undetermined,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{MicAccessOutcome, PermissionsStatus};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_application_services::{
        kAXTrustedCheckOptionPrompt, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
    };
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use objc2_core_foundation::{
        kCFBooleanTrue, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks,
        CFDictionary,
    };
    use std::ffi::c_void;
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    pub fn status() -> PermissionsStatus {
        PermissionsStatus {
            microphone: microphone_authorized(),
            accessibility: accessibility_trusted(),
            screen_recording: screen_recording_authorized(),
            calendars: crate::calendar::is_authorized_sync(),
        }
    }

    /// Non-prompting probe of the Screen Recording TCC grant.
    ///
    /// Backs ScreenCaptureKit. `CGPreflightScreenCaptureAccess` returns the
    /// cached decision without ever showing a dialog — safe to call from any
    /// thread on app startup, in tray menus, etc.
    pub fn screen_recording_authorized() -> bool {
        core_graphics::access::ScreenCaptureAccess.preflight()
    }

    /// Trigger the macOS Screen Recording prompt.
    ///
    /// `CGRequestScreenCaptureAccess` either (a) returns immediately with the
    /// cached decision, or (b) prompts the user and returns the user's
    /// response. There is no async completion handler — the call is
    /// synchronous on the framework side but cheap, so we don't bother with
    /// a tokio oneshot.
    pub fn request_screen_recording() -> bool {
        core_graphics::access::ScreenCaptureAccess.request()
    }

    fn accessibility_trusted() -> bool {
        // SAFETY: AXIsProcessTrusted is a thread-safe pure read on the
        // current process's accessibility-trust state. It never prompts.
        unsafe { AXIsProcessTrusted() }
    }

    fn microphone_authorized() -> bool {
        // SAFETY: AVCaptureDevice.authorizationStatusForMediaType: with
        // AVMediaTypeAudio is a pure status read; it never prompts the user.
        // (The prompt only fires on +requestAccessForMediaType: or when
        // creating an AVCaptureDeviceInput.)
        let media_type = unsafe { AVMediaTypeAudio };
        let Some(media_type) = media_type else {
            // The static was nil — extremely unlikely on a real macOS system,
            // but treat it as "not authorized" rather than crashing.
            return false;
        };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        status == AVAuthorizationStatus::Authorized
    }

    /// Asynchronously request microphone access via AVCaptureDevice.
    ///
    /// On the first call from a process this triggers the standard macOS
    /// in-process prompt. Subsequent calls return the cached decision
    /// immediately without prompting.
    ///
    /// Implemented by handing AVFoundation an Objective-C block whose body
    /// fires a tokio oneshot, then `await`ing on the receive end.
    pub async fn request_microphone() -> MicAccessOutcome {
        let media_type = match unsafe { AVMediaTypeAudio } {
            Some(t) => t,
            None => return MicAccessOutcome::Undetermined,
        };

        let (tx, rx) = oneshot::channel::<bool>();
        // Scope the RcBlock so it is dropped before any `.await`. The block
        // itself is `!Send`, so holding it across the await would make the
        // surrounding future non-`Send` and Tauri requires `Send` futures.
        // AVFoundation -copy-s the block internally on the call below, so
        // dropping our local reference immediately is fine.
        {
            // The completion handler may run on an arbitrary dispatch queue
            // and is invoked exactly once. RcBlock requires `Fn`, so we wrap
            // the sender in a Mutex<Option<_>> for interior mutability and
            // `take()` it on first invocation. If AVFoundation never calls
            // us, the sender is dropped when the (copied) block is dropped
            // and the receiver resolves to `Err(_)` -> Undetermined.
            let tx_slot: Mutex<Option<oneshot::Sender<bool>>> = Mutex::new(Some(tx));
            let block = RcBlock::new(move |granted: Bool| {
                if let Ok(mut guard) = tx_slot.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(granted.as_bool());
                    }
                }
            });

            // SAFETY: requestAccessForMediaType:completionHandler: is the
            // documented entry point for prompting. The block matches the
            // expected signature `void (^)(BOOL)`. AVFoundation retains
            // (copies) the block internally, so it remains alive after we
            // drop our local `RcBlock` here.
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &block);
            }
        }

        match rx.await {
            Ok(true) => MicAccessOutcome::Granted,
            Ok(false) => MicAccessOutcome::Denied,
            Err(_) => MicAccessOutcome::Undetermined,
        }
    }

    /// Trigger the standard macOS Accessibility prompt via
    /// `AXIsProcessTrustedWithOptions({ kAXTrustedCheckOptionPrompt: true })`.
    ///
    /// Returns the current trust state, which will be `false` on the first
    /// call — the prompt only nudges the user toward System Settings; the
    /// toggle still has to be flipped there.
    pub fn prompt_accessibility() -> bool {
        // Build a one-entry CFDictionary mapping kAXTrustedCheckOptionPrompt -> kCFBooleanTrue.
        let key_ptr: *const c_void =
            (unsafe { kAXTrustedCheckOptionPrompt } as *const _) as *const c_void;
        let value_ptr: *const c_void = match unsafe { kCFBooleanTrue } {
            Some(b) => (b as *const _) as *const c_void,
            None => std::ptr::null(),
        };

        let mut keys = [key_ptr];
        let mut values = [value_ptr];

        // SAFETY: We pass valid CFType pointers, matching key/value counts
        // (1), and the standard kCFType{Key,Value}DictionaryCallBacks. The
        // resulting CFDictionary retains both. `options` is then passed by
        // reference to AXIsProcessTrustedWithOptions, which is documented
        // to accept a CFDictionaryRef (or NULL).
        let options = unsafe {
            CFDictionary::new(
                None,
                keys.as_mut_ptr(),
                values.as_mut_ptr(),
                keys.len() as isize,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )
        };

        unsafe { AXIsProcessTrustedWithOptions(options.as_deref()) }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{MicAccessOutcome, PermissionsStatus};

    pub fn status() -> PermissionsStatus {
        // On non-macOS hosts we don't gate anything; pretend everything is
        // green so the dev experience is unblocked.
        PermissionsStatus {
            microphone: true,
            accessibility: true,
            screen_recording: true,
            calendars: true,
        }
    }

    pub async fn request_microphone() -> MicAccessOutcome {
        MicAccessOutcome::Granted
    }

    pub fn prompt_accessibility() -> bool {
        true
    }

    pub fn screen_recording_authorized() -> bool {
        true
    }

    pub fn request_screen_recording() -> bool {
        true
    }
}

/// Snapshot of the macOS permission state for the running process.
pub fn status() -> PermissionsStatus {
    imp::status()
}

/// Asynchronously request microphone access via AVCaptureDevice. The first
/// call from a process triggers the standard macOS in-process prompt;
/// subsequent calls return the cached decision immediately without
/// prompting.
pub async fn request_microphone() -> MicAccessOutcome {
    imp::request_microphone().await
}

/// Triggers the standard macOS Accessibility prompt by calling
/// `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt = true`.
/// Returns the current trust state (which will be `false` on the first call;
/// the user still has to flip the toggle in System Settings).
pub fn prompt_accessibility() -> bool {
    imp::prompt_accessibility()
}

/// Returns the current Screen Recording (TCC `kTCCServiceScreenCapture`)
/// grant for this process without prompting. Backs the ScreenCaptureKit
/// path used by the syscap sidecar to capture the other participant's
/// audio during meetings.
pub fn screen_recording_authorized() -> bool {
    imp::screen_recording_authorized()
}

/// Trigger the macOS Screen Recording prompt and return the resulting
/// grant. On first call this shows the system dialog; subsequent calls
/// return the cached decision without prompting.
pub fn request_screen_recording() -> bool {
    imp::request_screen_recording()
}

/// Trigger the macOS Calendar prompt by spawning the `echo-scribe-calmatch`
/// sidecar with `--request-access`. Returns the resulting authorization
/// state. The sidecar exits 0 on grant, 1 on deny; we treat absence of
/// the binary (dev build) as a non-grant.
pub async fn prompt_calendars() -> bool {
    crate::calendar::prompt_access().await
}

/// Non-prompting probe of the Calendar grant. Spawns the sidecar with
/// `--probe`. Returns false when the sidecar isn't built.
pub fn calendars_authorized() -> bool {
    crate::calendar::is_authorized_sync()
}

/// Open the relevant System Settings pane for the user to grant access.
///
/// Uses the `x-apple.systempreferences:` URL scheme via the `open(1)` binary.
/// Equivalent to clicking "Open System Settings" in the macOS prompt.
pub fn open_settings(pane: SettingsPane) -> Result<(), std::io::Error> {
    let url = match pane {
        SettingsPane::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        SettingsPane::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        SettingsPane::ScreenCapture => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        SettingsPane::Calendars => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
        }
    };
    let status = std::process::Command::new("open").arg(url).status()?;
    if !status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("`open {url}` exited with {status}"),
        ));
    }
    Ok(())
}
