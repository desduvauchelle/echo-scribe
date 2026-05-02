use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use thiserror::Error;
use tracing::{info, warn};

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
pub fn paste_at_cursor(text: &str) -> Result<(), PasteError> {
    use arboard::Clipboard;

    let mut clipboard = Clipboard::new().map_err(|e| PasteError::Clipboard(e.to_string()))?;
    clipboard
        .set_text(text)
        .map_err(|e| PasteError::Clipboard(e.to_string()))?;
    info!(len = text.len(), "set clipboard text");

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

    Ok(())
}
