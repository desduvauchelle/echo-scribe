//! Cross-platform dictation trigger helpers.
//!
//! macOS uses the CGEventTap listener in `hotkeys.rs`. Windows/Linux have no
//! event tap, so we drive the coordinator from the global-shortcut plugin and
//! the in-app Record button. Both funnel into `CoordinatorMsg::Hotkey`.

use crate::input::hotkeys::HotkeyEvent;

/// Map a "is the trigger currently active?" boolean to a coordinator hotkey
/// transition. `true` => `Pressed` (start capture), `false` => `Released`
/// (stop + transcribe + paste). Shared by the global shortcut and the button.
pub fn shortcut_state_to_hotkey(pressed: bool) -> HotkeyEvent {
    if pressed {
        HotkeyEvent::Pressed
    } else {
        HotkeyEvent::Released
    }
}

/// Register the default Windows/Linux dictation hotkey (Ctrl+Alt+Space,
/// push-to-talk) with the global-shortcut plugin, forwarding Pressed/Released
/// into the coordinator as `Action::VoiceAtCursor`.
///
/// Windows can't swallow the keystroke the way the macOS CGEventTap does, so
/// the default is a deliberately non-conflicting combo. Rebinding on Windows is
/// deferred; v1 ships this fixed default.
#[cfg(not(target_os = "macos"))]
pub fn register_default_dictation_shortcut(
    app: &tauri::AppHandle,
    coord_tx: tokio::sync::mpsc::UnboundedSender<crate::coordinator::CoordinatorMsg>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            let ev = shortcut_state_to_hotkey(matches!(event.state(), ShortcutState::Pressed));
            if let Err(e) = coord_tx.send(crate::coordinator::CoordinatorMsg::Hotkey(
                crate::coordinator::Action::VoiceAtCursor,
                ev,
            )) {
                tracing::warn!(target: "trigger", ?e, "failed to forward global shortcut to coordinator");
            }
        })
        .map_err(|e| format!("failed to register dictation hotkey: {e}"))?;

    tracing::info!(target: "trigger", "registered default dictation hotkey Ctrl+Alt+Space");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_pressed_and_released() {
        assert_eq!(shortcut_state_to_hotkey(true), HotkeyEvent::Pressed);
        assert_eq!(shortcut_state_to_hotkey(false), HotkeyEvent::Released);
    }
}
