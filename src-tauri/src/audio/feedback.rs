//! Audio feedback for the recording lifecycle.
//!
//! Plays one of three short tones — Start, Stop, Ready — without blocking
//! the coordinator. Each call decodes a small bundled WAV (generated at
//! build time, see `build.rs`) on a fresh thread and lets rodio play it
//! through the default output stream. The sounds are tiny (~3 KB each), so
//! re-decoding per call costs essentially nothing.
//!
//! A global atomic flag mirrors the user's `audio_feedback_enabled` setting;
//! the coordinator is expected to push setting changes through
//! [`set_enabled`] (we do this when the setting first loads and on every
//! settings update).

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use rodio::{Decoder, OutputStream, Sink};
use tracing::warn;

/// Feedback sounds. Each variant maps to a static WAV byte slice generated
/// in `build.rs` and dropped into `OUT_DIR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sfx {
    Start,
    Stop,
    Ready,
}

const START_WAV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/start.wav"));
const STOP_WAV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/stop.wav"));
const READY_WAV: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ready.wav"));

impl Sfx {
    fn bytes(self) -> &'static [u8] {
        match self {
            Sfx::Start => START_WAV,
            Sfx::Stop => STOP_WAV,
            Sfx::Ready => READY_WAV,
        }
    }
}

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Update the runtime "enabled" flag. Called by the settings command on
/// startup (with the persisted value) and on every change.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Returns the current runtime "enabled" flag. Mostly useful for tests.
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Play the given sound. Non-blocking: spawns a tiny thread that owns the
/// `OutputStream` for the playback's lifetime. Errors are logged at warn
/// level — feedback should never break the pipeline.
pub fn play(sfx: Sfx) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    thread::spawn(move || {
        if let Err(e) = play_blocking(sfx) {
            warn!(?sfx, ?e, "audio feedback playback failed");
        }
    });
}

fn play_blocking(sfx: Sfx) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (_stream, handle) = OutputStream::try_default()?;
    let sink = Sink::try_new(&handle)?;
    let cursor = Cursor::new(sfx.bytes());
    let source = Decoder::new(cursor)?;
    sink.append(source);
    // Each WAV is < 200 ms; cap the wait at 1s as a safety net so we don't
    // hang if rodio's `sleep_until_end` ever stalls.
    let deadline = std::time::Instant::now() + Duration::from_millis(1_000);
    while !sink.empty() {
        if std::time::Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_wavs_are_nonempty_and_riff() {
        for sfx in [Sfx::Start, Sfx::Stop, Sfx::Ready] {
            let b = sfx.bytes();
            assert!(b.len() > 44, "wav too short for header");
            assert_eq!(&b[0..4], b"RIFF");
            assert_eq!(&b[8..12], b"WAVE");
        }
    }

    #[test]
    fn enabled_flag_round_trips() {
        // Save + restore the flag so we don't pollute other tests' state.
        let prev = is_enabled();
        set_enabled(false);
        assert!(!is_enabled());
        set_enabled(true);
        assert!(is_enabled());
        set_enabled(prev);
    }
}
