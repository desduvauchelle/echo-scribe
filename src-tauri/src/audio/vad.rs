//! Energy-based Voice Activity Detection for silence filtering.
//!
//! Trims silence from the beginning and end of 16 kHz mono PCM while
//! preserving the complete utterance between those boundaries.
//!
//! Internal low-energy audio is deliberately retained. A webcam or distant
//! microphone can put quiet words below the energy threshold even when louder
//! words in the same recording are detected correctly; removing those frames
//! makes partial sentences unavoidable.

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

/// Trim outer silence from a 16 kHz mono PCM buffer.
///
/// Once speech begins, every frame through the final detected speech frame is
/// preserved, including long pauses and quieter words. If the whole recording
/// is below the energy threshold (e.g. mic was muted), the original buffer is
/// returned unchanged so the ASR engine can still attempt transcription.
pub fn filter_silence(samples: &[f32]) -> Vec<f32> {
    let frames: Vec<&[f32]> = samples.chunks(FRAME_SAMPLES).collect();
    let voiced: Vec<bool> = frames
        .iter()
        .map(|frame| {
            let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
            rms > RMS_THRESHOLD
        })
        .collect();

    let first_confirmed_voice = voiced
        .windows(ONSET_FRAMES)
        .position(|window| window.iter().all(|is_voice| *is_voice));
    let Some(first_voice_frame) = first_confirmed_voice else {
        // Entire recording was silent — return original so ASR can still try.
        return samples.to_vec();
    };

    let last_voice_frame = voiced
        .iter()
        .rposition(|is_voice| *is_voice)
        .unwrap_or(first_voice_frame);
    let start_frame = first_voice_frame.saturating_sub(PREFILL_FRAMES);
    let end_frame = (last_voice_frame + 1 + HANGOVER_FRAMES).min(frames.len());
    let start_sample = start_frame * FRAME_SAMPLES;
    let end_sample = (end_frame * FRAME_SAMPLES).min(samples.len());
    let out = samples[start_sample..end_sample].to_vec();

    let original_ms = samples.len() / 16;
    let speech_ms = out.len() / 16;
    let removed_pct = 100 - (out.len() * 100 / samples.len().max(1));
    info!(
        original_ms,
        speech_ms, removed_pct, "VAD: trimmed outer silence from recording"
    );
    out
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
        (0..n).map(|i| (i as f32 * 0.1).sin() * 0.1).collect()
    }

    fn quiet_speech(frames: usize) -> Vec<f32> {
        // Deliberately below the energy threshold. This represents words
        // spoken more quietly than the surrounding phrases, not disposable
        // silence: once an utterance has begun, it must still reach ASR.
        let n = frames * FRAME_SAMPLES;
        (0..n).map(|i| (i as f32 * 0.1).sin() * 0.001).collect()
    }

    #[test]
    fn pure_silence_returns_original() {
        let s = silence(100);
        let out = filter_silence(&s);
        assert_eq!(
            out.len(),
            s.len(),
            "silent recording must be returned unchanged"
        );
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
    fn preserves_quiet_words_between_louder_speech() {
        let mut input = speech(20);
        input.extend(quiet_speech(40));
        input.extend(speech(20));

        let out = filter_silence(&input);

        assert_eq!(
            out.len(),
            input.len(),
            "VAD must not delete quiet words or sentence fragments from the middle of an utterance"
        );
    }

    #[test]
    fn empty_input_returns_empty() {
        let out = filter_silence(&[]);
        assert!(out.is_empty());
    }
}
