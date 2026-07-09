//! Pure caption-segment math: convert Parakeet's native segment timestamps
//! (seconds, relative to the chunk's first sample) into source-time caption
//! segments (`start_ms`/`end_ms` relative to the recording's t=0).
//!
//! The ASR inference itself lives in [`crate::asr::pipeline`] /
//! [`crate::asr::parakeet`] and is not unit-testable here. Everything in this
//! module is pure (no IO, no model) so the offset/segmentation arithmetic can be
//! exercised on synthetic inputs.
//!
//! Time base: caption times are ms relative to audio-stream t=0, which the
//! recording sidecar starts together with the video/event streams — i.e. the
//! same base as `<id>.events.jsonl`. See the task report for the 250 ms
//! leading-silence caveat inherited from `transcribe_with`.

use serde::Serialize;

/// A timed caption span, ready to hand to the frontend. Times are **ms relative
/// to the recording's t=0**. Serialized camelCase so the TS side receives
/// `{ startMs, endMs, text }` (matches the `src/lib/api.ts` wrapper's type).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Convert one Parakeet segment (`start`/`end` in **seconds**, relative to the
/// chunk's first sample) into a source-time [`CaptionSegment`], shifting by the
/// chunk's `offset_ms` from the recording start.
///
/// Returns `None` when the trimmed text is empty (empty segments are dropped per
/// the contract). `end` is clamped to be ≥ `start` so a caption never has a
/// negative duration even if the model emits a slightly-reversed span.
pub fn caption_from_secs(
    start_secs: f32,
    end_secs: f32,
    text: &str,
    offset_ms: u64,
) -> Option<CaptionSegment> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let start_ms = secs_to_ms(start_secs).saturating_add(offset_ms);
    let end_ms_raw = secs_to_ms(end_secs).saturating_add(offset_ms);
    let end_ms = end_ms_raw.max(start_ms);
    Some(CaptionSegment {
        start_ms,
        end_ms,
        text: trimmed.to_string(),
    })
}

/// Convert a non-negative seconds value to whole milliseconds, rounding to the
/// nearest ms and clamping negatives to 0. Parakeet occasionally emits tiny
/// negative starts after the leading-silence subtraction; those become 0.
fn secs_to_ms(secs: f32) -> u64 {
    if secs <= 0.0 {
        return 0;
    }
    (secs as f64 * 1000.0).round() as u64
}

/// Total spoken duration across all segments, in ms — the sum of each caption's
/// `(end_ms - start_ms)`. Logged at info per the contract. Pure over the slice.
pub fn total_speech_ms(segments: &[CaptionSegment]) -> u64 {
    segments
        .iter()
        .map(|s| s.end_ms.saturating_sub(s.start_ms))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_convert_to_nearest_ms() {
        assert_eq!(secs_to_ms(0.0), 0);
        assert_eq!(secs_to_ms(1.0), 1000);
        assert_eq!(secs_to_ms(1.2345), 1235); // 1234.5 rounds half away from zero
        assert_eq!(secs_to_ms(0.001), 1);
        assert_eq!(secs_to_ms(2.5), 2500);
    }

    #[test]
    fn negative_seconds_clamp_to_zero() {
        // Parakeet can emit a small negative start after the 250ms pad subtract.
        assert_eq!(secs_to_ms(-0.1), 0);
        let seg = caption_from_secs(-0.1, 0.4, "hi", 0).unwrap();
        assert_eq!(seg.start_ms, 0);
        assert_eq!(seg.end_ms, 400);
    }

    #[test]
    fn offset_shifts_into_source_time() {
        // A segment 1.0s..1.5s inside a chunk that starts 60s into the recording
        // must land at 61.0s..61.5s in source time.
        let seg = caption_from_secs(1.0, 1.5, "hello", 60_000).unwrap();
        assert_eq!(seg.start_ms, 61_000);
        assert_eq!(seg.end_ms, 61_500);
        assert_eq!(seg.text, "hello");
    }

    #[test]
    fn empty_text_is_dropped() {
        assert!(caption_from_secs(0.0, 1.0, "", 0).is_none());
        assert!(caption_from_secs(0.0, 1.0, "   ", 0).is_none());
        assert!(caption_from_secs(0.0, 1.0, "\n\t ", 0).is_none());
    }

    #[test]
    fn text_is_trimmed() {
        let seg = caption_from_secs(0.0, 1.0, "  spaced  ", 0).unwrap();
        assert_eq!(seg.text, "spaced");
    }

    #[test]
    fn reversed_span_clamps_end_to_start() {
        // If the model ever emits end < start, don't produce a negative duration.
        let seg = caption_from_secs(2.0, 1.0, "oops", 0).unwrap();
        assert_eq!(seg.start_ms, 2000);
        assert_eq!(seg.end_ms, 2000);
    }

    #[test]
    fn total_speech_ms_sums_durations() {
        let segs = vec![
            CaptionSegment { start_ms: 0, end_ms: 500, text: "a".into() },
            CaptionSegment { start_ms: 1000, end_ms: 1750, text: "b".into() },
        ];
        assert_eq!(total_speech_ms(&segs), 500 + 750);
        assert_eq!(total_speech_ms(&[]), 0);
    }

    #[test]
    fn serializes_camel_case() {
        let seg = CaptionSegment { start_ms: 10, end_ms: 20, text: "hi".into() };
        let json = serde_json::to_string(&seg).unwrap();
        assert_eq!(json, r#"{"startMs":10,"endMs":20,"text":"hi"}"#);
    }
}
