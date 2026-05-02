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

    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;

    if let Err(e) = enigo.key(Key::Unicode('v'), Direction::Release) {
        warn!(?e, "could not release v key (likely already released)");
    }

    Ok(())
}
