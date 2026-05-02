/// Dock visibility helpers (macOS only).
///
/// Echo Scribe runs as an `LSUIElement` agent (no dock icon at launch).
/// When the main window is shown we switch to a regular activation policy so
/// the dock icon appears; when the window is hidden/closed we switch back to
/// accessory so the dock icon disappears.
#[cfg(target_os = "macos")]
pub fn set_dock_visible(visible: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    // setActivationPolicy must be called on the main thread. Tauri setup and
    // window events are always dispatched on the main thread, so this is safe.
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let policy = if visible {
            NSApplicationActivationPolicy::Regular
        } else {
            NSApplicationActivationPolicy::Accessory
        };
        app.setActivationPolicy(policy);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_dock_visible(_visible: bool) {}
