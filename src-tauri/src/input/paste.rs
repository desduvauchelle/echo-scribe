use std::thread;
use std::time::Duration;
use thiserror::Error;
use tracing::{info, warn};

/// Milliseconds to wait after sending Cmd+V before restoring the clipboard.
/// The target application needs time to read the clipboard contents.
const RESTORE_DELAY_MS: u64 = 100;

#[derive(Debug, Error)]
pub enum PasteError {
    #[error("failed to set clipboard: {0}")]
    Clipboard(String),
    #[error("failed to synthesize keystroke: {0}")]
    Keystroke(String),
    #[error("failed to initialize enigo: {0}")]
    Init(String),
}

/// Copies `text` to the clipboard and synthesizes Cmd+V (macOS) /
/// Ctrl+V (other platforms) to paste at the focused application's cursor.
///
/// Preserves the user's existing clipboard content: saves it before
/// overwriting, then restores it after the paste keystroke lands.
pub fn paste_at_cursor(text: &str) -> Result<(), PasteError> {
    use arboard::Clipboard;

    let mut clipboard = Clipboard::new().map_err(|e| PasteError::Clipboard(e.to_string()))?;

    // ── Save original clipboard ──────────────────────────────────
    let original = clipboard.get_text().ok(); // None if clipboard is empty or non-text
    if original.is_some() {
        info!("saved existing clipboard content for restoration");
    }

    // ── Write transcription to clipboard ─────────────────────────
    clipboard
        .set_text(text)
        .map_err(|e| PasteError::Clipboard(e.to_string()))?;
    info!(len = text.len(), "set clipboard text");

    // ── Synthesize paste keystroke ────────────────────────────────
    synthesize_cmd_v()?;

    // ── Restore original clipboard ───────────────────────────────
    // Wait for the target app to process the paste event, then put
    // the user's original content back.
    if let Some(original_text) = original {
        thread::sleep(Duration::from_millis(RESTORE_DELAY_MS));
        // Best-effort restore — don't fail the transcription if this errors.
        match clipboard.set_text(&original_text) {
            Ok(()) => info!("restored original clipboard content"),
            Err(e) => warn!(?e, "failed to restore original clipboard content"),
        }
    }

    Ok(())
}

/// Synthesizes Cmd+V (macOS) or Ctrl+V (other platforms).
///
/// On macOS we use CoreGraphics directly and set CGEventFlagCommand on the V
/// keydown event itself rather than relying on a separate modifier press.
/// The two-step enigo approach (press Meta, click V, release Meta) is
/// racy: CGEventPost is asynchronous, so the V keydown can be dispatched
/// before the global CombinedSessionState has registered the Command flag,
/// causing the target app to receive plain "v" instead of a paste.
/// Setting the flag directly on the event is deterministic.
///
/// We post at CGEventTapLocation::Session so the events bypass our own
/// HID-level CGEventTap and go straight to the focused application.
#[cfg(target_os = "macos")]
fn synthesize_cmd_v() -> Result<(), PasteError> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|_| PasteError::Keystroke("failed to create CGEventSource".into()))?;

    // kVK_ANSI_V = 9
    let v_down = CGEvent::new_keyboard_event(source.clone(), 9, true)
        .map_err(|_| PasteError::Keystroke("failed to create V keydown event".into()))?;
    v_down.set_flags(CGEventFlags::CGEventFlagCommand);
    v_down.post(CGEventTapLocation::Session);

    thread::sleep(Duration::from_millis(20));

    let v_up = CGEvent::new_keyboard_event(source, 9, false)
        .map_err(|_| PasteError::Keystroke("failed to create V keyup event".into()))?;
    v_up.post(CGEventTapLocation::Session);

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn synthesize_cmd_v() -> Result<(), PasteError> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| PasteError::Init(e.to_string()))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_error_display_messages() {
        let e = PasteError::Clipboard("test".into());
        assert!(e.to_string().contains("clipboard"));

        let e = PasteError::Keystroke("test".into());
        assert!(e.to_string().contains("keystroke"));

        let e = PasteError::Init("test".into());
        assert!(e.to_string().contains("enigo"));
    }

    #[test]
    fn paste_error_init_display() {
        let e = PasteError::Init("bad driver".into());
        assert_eq!(e.to_string(), "failed to initialize enigo: bad driver");
    }

    #[test]
    fn restore_delay_is_reasonable() {
        // The post-paste delay before restoring clipboard must be
        // long enough for the target app to read the clipboard (50ms+)
        // but short enough to not noticeably delay the user (<500ms).
        assert!(RESTORE_DELAY_MS >= 50);
        assert!(RESTORE_DELAY_MS <= 500);
    }
}
