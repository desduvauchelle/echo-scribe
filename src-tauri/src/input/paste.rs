use enigo::{Direction, Enigo, Key, Keyboard, Settings};
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
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| PasteError::Init(e.to_string()))?;

    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };

    // V key. On macOS we use the raw hardware keycode (9 on ANSI/QWERTY) to
    // bypass enigo's TSMGetInputSourceProperty lookup, which crashes when called
    // from a background thread on macOS 14+. On other platforms Key::Unicode is fine.
    // TODO: route this through the main thread so non-QWERTY macOS layouts work.
    #[cfg(target_os = "macos")]
    let v_key = Key::Other(9);
    #[cfg(not(target_os = "macos"))]
    let v_key = Key::Unicode('v');

    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(v_key, Direction::Click)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;

    if let Err(e) = enigo.key(v_key, Direction::Release) {
        warn!(?e, "could not release v key (likely already released)");
    }

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
    fn restore_delay_is_reasonable() {
        // The post-paste delay before restoring clipboard must be
        // long enough for the target app to read the clipboard (50ms+)
        // but short enough to not noticeably delay the user (<500ms).
        assert!(RESTORE_DELAY_MS >= 50);
        assert!(RESTORE_DELAY_MS <= 500);
    }
}
