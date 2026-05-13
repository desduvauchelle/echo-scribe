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

/// Configure the main window so that activating the app (e.g. from the tray
/// menu) brings the window to the *current* Mission Control Space instead of
/// switching the user back to whichever Space the window was last shown on.
///
/// macOS tracks this via `NSWindow.collectionBehavior`; the
/// `MoveToActiveSpace` bit tells the window to follow the user when the app
/// becomes active. We OR it into the existing behavior so we don't clobber
/// any defaults Tauri/AppKit set on creation.
#[cfg(target_os = "macos")]
pub fn enable_move_to_active_space<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr as *mut NSWindow,
        Ok(_) => {
            tracing::warn!("ns_window() returned null; skipping moveToActiveSpace");
            return;
        }
        Err(e) => {
            tracing::warn!(?e, "failed to fetch NSWindow; skipping moveToActiveSpace");
            return;
        }
    };

    // SAFETY: Tauri hands us a retained NSWindow pointer; wrap it without
    // taking ownership of the +1 refcount so the underlying window isn't
    // released when this Retained drops.
    let ns_window: Retained<NSWindow> =
        unsafe { Retained::retain(ns_window_ptr) }.expect("non-null NSWindow");
    let current = ns_window.collectionBehavior();
    ns_window.setCollectionBehavior(current | NSWindowCollectionBehavior::MoveToActiveSpace);
}

#[cfg(not(target_os = "macos"))]
pub fn enable_move_to_active_space<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
