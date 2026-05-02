//! Native macOS permission checks.
//!
//! We only *check* permission status here — we never trigger the system
//! prompt. Requesting microphone access happens implicitly the first time
//! cpal opens an input stream; requesting accessibility access requires the
//! user to flip the switch in System Settings, which we deep-link to.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PermissionsStatus {
    pub microphone: bool,
    pub accessibility: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum SettingsPane {
    Microphone,
    Accessibility,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::PermissionsStatus;
    use objc2_application_services::AXIsProcessTrusted;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    pub fn status() -> PermissionsStatus {
        PermissionsStatus {
            microphone: microphone_authorized(),
            accessibility: accessibility_trusted(),
        }
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
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::PermissionsStatus;

    pub fn status() -> PermissionsStatus {
        // On non-macOS hosts we don't gate anything; pretend everything is
        // green so the dev experience is unblocked.
        PermissionsStatus {
            microphone: true,
            accessibility: true,
        }
    }
}

/// Snapshot of the macOS permission state for the running process.
pub fn status() -> PermissionsStatus {
    imp::status()
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
