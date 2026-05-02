//! Energy-based Voice Activity Detection for silence filtering.
//!
//! Strips silent frames from 16 kHz mono PCM so the ASR engine only sees
//! actual speech, reducing Parakeet inference time roughly in proportion to
//! the silence fraction of the recording.
//!
//! Algorithm: per-frame RMS energy gate with onset confirmation, pre-roll,
//! and hangover — mirroring the SmoothedVad design used in Handy.

use std::collections::VecDeque;
use tracing::info;

/// 30 ms at 16 kHz — Silero VAD's native frame size; we match it.
const FRAME_SAMPLES: usize = 480;

/// ~-50 dBFS.  Well below quiet speech, well above background silence.
const RMS_THRESHOLD: f32 = 0.003;

/// Frames of context kept before an onset (pre-roll).  15 × 30 ms = 450 ms.
const PREFILL_FRAMES: usize = 15;

/// Frames kept after speech ends before declaring silence (hangover).
/// Prevents clipping trailing consonants or short pauses mid-sentence.
const HANGOVER_FRAMES: usize = 15;

/// Consecutive above-threshold frames required to confirm speech onset.
/// Suppresses isolated noise spikes.
const ONSET_FRAMES: usize = 2;

/// Filter silent frames from a 16 kHz mono PCM buffer.
///
/// Returns a new buffer containing only speech frames (with pre-roll and
/// hangover padding).  If the whole recording is below the energy threshold
/// (e.g. mic was muted) the original buffer is returned unchanged so the ASR
/// engine can still attempt transcription rather than silently producing "".
pub fn filter_silence(samples: &[f32]) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::with_capacity(samples.len());

    // Ring buffer holding the last PREFILL_FRAMES+1 frames for pre-roll.
    let mut frame_buf: VecDeque<Vec<f32>> = VecDeque::new();

    let mut in_speech = false;
    let mut hangover: usize = 0;
    let mut onset: usize = 0;

    for frame in samples.chunks(FRAME_SAMPLES) {
        // Always update the ring buffer so pre-roll is always current.
        frame_buf.push_back(frame.to_vec());
        while frame_buf.len() > PREFILL_FRAMES + 1 {
            frame_buf.pop_front();
        }

        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        let is_voice = rms > RMS_THRESHOLD;

        match (in_speech, is_voice) {
            // --- Potential onset: accumulate consecutive voice frames ---
            (false, true) => {
                onset += 1;
                if onset >= ONSET_FRAMES {
                    in_speech = true;
                    hangover = HANGOVER_FRAMES;
                    onset = 0;
                    // Flush the entire ring buffer as pre-roll (includes the
                    // onset frames themselves so nothing is double-emitted).
                    for f in &frame_buf {
                        out.extend_from_slice(f);
                    }
                }
                // Otherwise keep waiting — frame already buffered for pre-roll.
            }

            // --- Ongoing speech ---
            (true, true) => {
                hangover = HANGOVER_FRAMES;
                out.extend_from_slice(frame);
            }

            // --- Trailing hangover or very short pause ---
            (true, false) => {
                if hangover > 0 {
                    hangover -= 1;
                    out.extend_from_slice(frame);
                } else {
                    in_speech = false;
                }
            }

            // --- Silence / broken onset sequence ---
            (false, false) => {
                onset = 0;
            }
        }
    }

    if out.is_empty() {
        // Entire recording was silent — return original so ASR can still try.
        samples.to_vec()
    } else {
        let original_ms = samples.len() / 16;
        let speech_ms = out.len() / 16;
        let removed_pct = 100 - (out.len() * 100 / samples.len().max(1));
        info!(
            original_ms,
            speech_ms,
            removed_pct,
            "VAD: filtered silence from recording"
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence(frames: usize) -> Vec<f32> {
        vec![0.0f32; frames * FRAME_SAMPLES]
    }

    fn speech(frames: usize) -> Vec<f32> {
        // Sine wave at comfortable amplitude — clearly above RMS_THRESHOLD.
        let n = frames * FRAME_SAMPLES;
        (0..n)
            .map(|i| (i as f32 * 0.1).sin() * 0.1)
            .collect()
    }

    #[test]
    fn pure_silence_returns_original() {
        let s = silence(100);
        let out = filter_silence(&s);
        assert_eq!(out.len(), s.len(), "silent recording must be returned unchanged");
    }

    #[test]
    fn pure_speech_survives() {
        let s = speech(50);
        let out = filter_silence(&s);
        // All frames are speech; some pre-roll overhead is fine but nothing
        // should be dropped.
        assert!(
            out.len() >= s.len() - FRAME_SAMPLES * PREFILL_FRAMES,
            "speech frames must not be stripped"
        );
    }

    #[test]
    fn leading_silence_stripped() {
        // 1 second of silence then 1 second of speech.
        let mut s = silence(33); // ~1 s
        s.extend(speech(33));
        let out = filter_silence(&s);
        // Output should be much shorter than input.
        assert!(
            out.len() < s.len(),
            "leading silence should be stripped: out={} input={}",
            out.len(),
            s.len()
        );
    }

    #[test]
    fn trailing_silence_stripped() {
        // 1 second of speech then 2 seconds of silence.
        let mut s = speech(33);
        s.extend(silence(66));
        let out = filter_silence(&s);
        // Output should be shorter than input (trailing silence removed).
        assert!(
            out.len() < s.len(),
            "trailing silence should be stripped: out={} input={}",
            out.len(),
            s.len()
        );
    }

    #[test]
    fn empty_input_returns_empty() {
        let out = filter_silence(&[]);
        assert!(out.is_empty());
    }
}
