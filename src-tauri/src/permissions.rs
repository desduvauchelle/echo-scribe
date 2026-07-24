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
    /// Camera is optional (only used when a screen recording enables the
    /// webcam), but surfaced in the permissions UI so a *denied* grant is
    /// visible and fixable up front — once denied, macOS never re-prompts,
    /// so the record-time request alone can strand the user with no in-app
    /// recovery path.
    pub camera: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum SettingsPane {
    Microphone,
    Accessibility,
    ScreenCapture,
    Calendars,
    Camera,
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

/// Result of an asynchronous camera access request. Mirrors
/// [`MicAccessOutcome`] — kept as a distinct type (rather than reusing
/// `MicAccessOutcome`) so call sites read as camera-specific, even though the
/// three states and their meaning are identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraAccessOutcome {
    Granted,
    Denied,
    /// The completion handler dropped its sender without producing a value
    /// (e.g. the framework never invoked it). Treat like `Denied` for UX.
    Undetermined,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{CameraAccessOutcome, MicAccessOutcome, PermissionsStatus};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_application_services::{
        kAXTrustedCheckOptionPrompt, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
    };
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio, AVMediaTypeVideo,
    };
    use objc2_core_foundation::{
        kCFBooleanTrue, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks,
        CFDictionary,
    };
    use std::ffi::c_void;
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    pub fn status() -> PermissionsStatus {
        let main_screen_recording = screen_recording_authorized();
        PermissionsStatus {
            microphone: microphone_authorized(),
            accessibility: accessibility_trusted(),
            screen_recording: super::merge_screen_recording_grants(
                main_screen_recording,
                crate::screenrec::screen_capture_access_authorized_sync(),
                crate::meeting::syscap::screen_capture_access_authorized_sync(),
            ),
            calendars: crate::calendar::is_authorized_sync(),
            camera: camera_authorized(),
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

    /// Non-prompting probe of the Camera TCC grant. Backs the `camera` field
    /// of [`PermissionsStatus`] — camera is optional (only the webcam overlay
    /// uses it), so it's not a startup *gate*, but it IS surfaced in the
    /// permissions UI so a denied grant is visible and fixable up front the
    /// same way `microphone_authorized` backs `status()`.
    pub fn camera_authorized() -> bool {
        // SAFETY: AVCaptureDevice.authorizationStatusForMediaType: with
        // AVMediaTypeVideo is a pure status read; it never prompts the user.
        // (The prompt only fires on +requestAccessForMediaType: or when
        // creating an AVCaptureDeviceInput.)
        let media_type = unsafe { AVMediaTypeVideo };
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

    /// Asynchronously request camera access via AVCaptureDevice.
    ///
    /// On the first call from a process this triggers the standard macOS
    /// in-process prompt. Subsequent calls return the cached decision
    /// immediately without prompting.
    ///
    /// Implemented by handing AVFoundation an Objective-C block whose body
    /// fires a tokio oneshot, then `await`ing on the receive end. Mirrors
    /// `request_microphone` above exactly, swapping `AVMediaTypeVideo` in.
    pub async fn request_camera() -> CameraAccessOutcome {
        let media_type = match unsafe { AVMediaTypeVideo } {
            Some(t) => t,
            None => return CameraAccessOutcome::Undetermined,
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
            Ok(true) => CameraAccessOutcome::Granted,
            Ok(false) => CameraAccessOutcome::Denied,
            Err(_) => CameraAccessOutcome::Undetermined,
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
    use super::{CameraAccessOutcome, MicAccessOutcome, PermissionsStatus};

    pub fn status() -> PermissionsStatus {
        // On non-macOS hosts we don't gate anything; pretend everything is
        // green so the dev experience is unblocked.
        PermissionsStatus {
            microphone: true,
            accessibility: true,
            screen_recording: true,
            calendars: true,
            camera: true,
        }
    }

    pub async fn request_microphone() -> MicAccessOutcome {
        MicAccessOutcome::Granted
    }

    pub async fn request_camera() -> CameraAccessOutcome {
        CameraAccessOutcome::Granted
    }

    pub fn camera_authorized() -> bool {
        true
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

/// Asynchronously request camera access via AVCaptureDevice. The first call
/// from a process triggers the standard macOS in-process prompt; subsequent
/// calls return the cached decision immediately without prompting.
pub async fn request_camera() -> CameraAccessOutcome {
    imp::request_camera().await
}

/// Non-prompting probe of the Camera TCC grant for this process.
pub fn camera_authorized() -> bool {
    imp::camera_authorized()
}

/// Triggers the standard macOS Accessibility prompt by calling
/// `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt = true`.
/// Returns the current trust state (which will be `false` on the first call;
/// the user still has to flip the toggle in System Settings).
pub fn prompt_accessibility() -> bool {
    imp::prompt_accessibility()
}

/// Returns the current Screen Recording (TCC `kTCCServiceScreenCapture`)
/// grant for the capture processes without prompting. The app uses two
/// ScreenCaptureKit sidecars, so the effective grant must account for those
/// helpers rather than only the main Tauri process.
pub fn screen_recording_authorized() -> bool {
    merge_screen_recording_grants(
        imp::screen_recording_authorized(),
        crate::screenrec::screen_capture_access_authorized_sync(),
        crate::meeting::syscap::screen_capture_access_authorized_sync(),
    )
}

/// Trigger the macOS Screen Recording prompt and return the resulting
/// grant. On first call this shows the system dialog; subsequent calls
/// return the cached decision without prompting.
pub fn request_screen_recording() -> bool {
    let screenrec = crate::screenrec::request_screen_capture_access();
    let syscap = crate::meeting::syscap::request_screen_capture_access();
    let main_app = if screenrec.is_none() && syscap.is_none() {
        imp::request_screen_recording()
    } else {
        imp::screen_recording_authorized()
    };
    merge_screen_recording_grants(main_app, screenrec, syscap)
}

fn merge_screen_recording_grants(
    main_app: bool,
    screenrec_sidecar: Option<bool>,
    syscap_sidecar: Option<bool>,
) -> bool {
    match (screenrec_sidecar, syscap_sidecar) {
        (Some(screenrec), Some(syscap)) => screenrec && syscap,
        (Some(_), None) | (None, Some(_)) => false,
        (None, None) => main_app,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_recording_grant_requires_both_capture_sidecars_when_present() {
        assert!(merge_screen_recording_grants(false, Some(true), Some(true)));
        assert!(!merge_screen_recording_grants(false, Some(true), Some(false)));
        assert!(!merge_screen_recording_grants(false, Some(false), Some(true)));
        assert!(!merge_screen_recording_grants(true, Some(false), Some(false)));
    }

    #[test]
    fn screen_recording_grant_falls_back_to_main_app_when_sidecars_are_unavailable() {
        assert!(merge_screen_recording_grants(true, None, None));
        assert!(!merge_screen_recording_grants(false, None, None));
    }
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
        SettingsPane::Camera => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
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
