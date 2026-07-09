//! Supervises the `echo-scribe-screenrec` sidecar: spawn, read stderr JSON
//! events, finalize on SIGTERM. Mirrors `meeting/syscap.rs`.

pub mod drive;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

// ----- Source enumeration types -----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplaySource {
    pub id: u32,
    pub width: i64,
    pub height: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowSource {
    pub id: u32,
    pub app: String,
    pub title: String,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub thumb: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Sources {
    pub displays: Vec<DisplaySource>,
    pub windows: Vec<WindowSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraSource {
    pub uid: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Cameras {
    pub cameras: Vec<CameraSource>,
}

/// Parse the JSON stdout of `--list-cameras` into [`Cameras`].
pub fn parse_cameras(stdout: &str) -> Result<Cameras, String> {
    serde_json::from_str::<Cameras>(stdout.trim()).map_err(|e| e.to_string())
}

/// Parse the JSON stdout of `--list-sources` into [`Sources`].
pub fn parse_sources(stdout: &str) -> Result<Sources, String> {
    serde_json::from_str::<Sources>(stdout.trim()).map_err(|e| e.to_string())
}

/// Build a user-facing message from a failed `--list-sources` run. The raw
/// sidecar detail is logged by the caller; the returned string is safe to show
/// in the UI (short, human, no JSON/stack traces).
fn list_sources_error(stderr: &str) -> String {
    // The sidecar emits its failure reason on stderr as
    // `{"event":"error","kind":"list_sources","msg":"..."}`. Pull the msg out
    // and special-case the Screen Recording permission denial, which is by far
    // the most common cause (e.g. after the app bundle is replaced).
    let sidecar_msg = stderr.lines().rev().find_map(|line| {
        let val: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        if val.get("event").and_then(|v| v.as_str()) == Some("error") {
            val.get("msg").and_then(|v| v.as_str()).map(|s| s.to_string())
        } else {
            None
        }
    });
    if let Some(msg) = &sidecar_msg {
        let low = msg.to_lowercase();
        if low.contains("tcc") || low.contains("declined") || low.contains("permission") {
            return "Screen Recording permission is needed to list windows and displays. \
                    Enable Echo Scribe in System Settings → Privacy & Security → Screen Recording, \
                    then fully quit and reopen Echo Scribe."
                .to_string();
        }
    }
    "Couldn't list screens and windows. See Settings → Diagnostics → logs for details.".to_string()
}

/// Invoke the sidecar with `--list-sources` and parse the result. On failure
/// (non-zero exit, empty output, or unparseable JSON) the sidecar's stderr is
/// captured and logged, and a friendly message is returned — never the raw
/// serde/`EOF` parse error.
pub fn list_sources() -> Result<Sources, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("--list-sources")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            warn!(target: "screenrec", error = %e, "failed to spawn --list-sources");
            "Couldn't start the screen-recording helper. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || stdout.trim().is_empty() {
        warn!(target: "screenrec", status = ?out.status.code(), stderr = %stderr.trim(),
              "--list-sources failed");
        return Err(list_sources_error(&stderr));
    }
    match parse_sources(&stdout) {
        Ok(s) => {
            info!(target: "screenrec", displays = s.displays.len(), windows = s.windows.len(),
                  "listed screen sources");
            Ok(s)
        }
        Err(e) => {
            warn!(target: "screenrec", error = %e, stderr = %stderr.trim(),
                  "failed to parse --list-sources output");
            Err(list_sources_error(&stderr))
        }
    }
}

/// Build a user-facing message from a failed `--list-cameras` run. Mirrors
/// `list_sources_error`: raw sidecar detail is logged by the caller, this
/// string is safe to show in the UI.
fn list_cameras_error(stderr: &str) -> String {
    let sidecar_msg = stderr.lines().rev().find_map(|line| {
        let val: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        if val.get("event").and_then(|v| v.as_str()) == Some("error") {
            val.get("msg").and_then(|v| v.as_str()).map(|s| s.to_string())
        } else {
            None
        }
    });
    if let Some(msg) = &sidecar_msg {
        let low = msg.to_lowercase();
        if low.contains("tcc") || low.contains("declined") || low.contains("permission") {
            return "Camera permission is needed to list webcams. \
                    Enable Echo Scribe in System Settings → Privacy & Security → Camera, \
                    then fully quit and reopen Echo Scribe."
                .to_string();
        }
    }
    "Couldn't list cameras. See Settings → Diagnostics → logs for details.".to_string()
}

/// Invoke the sidecar with `--list-cameras` and parse the result. On failure
/// (non-zero exit, empty output, or unparseable JSON) the sidecar's stderr is
/// captured and logged, and a friendly message is returned — never the raw
/// serde/`EOF` parse error.
pub fn list_cameras() -> Result<Cameras, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("--list-cameras")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            warn!(target: "screenrec", error = %e, "failed to spawn --list-cameras");
            "Couldn't start the screen-recording helper. See Settings → Diagnostics → logs for details.".to_string()
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || stdout.trim().is_empty() {
        warn!(target: "screenrec", status = ?out.status.code(), stderr = %stderr.trim(),
              "--list-cameras failed");
        return Err(list_cameras_error(&stderr));
    }
    match parse_cameras(&stdout) {
        Ok(c) => {
            info!(target: "screenrec", cameras = c.cameras.len(), "listed cameras");
            Ok(c)
        }
        Err(e) => {
            warn!(target: "screenrec", error = %e, stderr = %stderr.trim(),
                  "failed to parse --list-cameras output");
            Err(list_cameras_error(&stderr))
        }
    }
}

/// Bounds (`x, y, width, height`) of a display, in GLOBAL POINTS with the
/// primary display's top-left corner as the origin (`+y` down) — the exact
/// space the sidecar's `--rect` flag and recorded-events file use (see
/// `InputEvents.swift`'s header comment and `main.swift`'s crop-origin math).
///
/// Source of truth: `CGDisplayBounds` (via the `core-graphics` crate), keyed
/// by the SAME id `--list-sources` returns as `DisplaySource.id` — on macOS
/// `SCDisplay.displayID` IS the `CGDirectDisplayID` (see `main.swift`'s
/// `--list-sources` handler, which reads `d.displayID` directly). This means
/// no separate matching/correlation step against Tauri's `Monitor` API is
/// needed: `CGDisplayBounds(display_id)` already returns exactly the frame
/// the area picker needs to size + position itself on, in the coordinate
/// space the resulting crop rect must be expressed in. Tauri's `Monitor`
/// struct is deliberately NOT used here — it exposes physical-pixel size +
/// position with no display id, so there is no way to correlate a `Monitor`
/// back to a specific `CGDirectDisplayID` without guessing by resolution.
///
/// Returns `None` if the display id is no longer valid (e.g. unplugged
/// between listing and picking) — `CGDisplayBounds` returns a zero rect for
/// an invalid id, treated here as "not found" rather than a valid 0×0 display.
pub fn display_bounds(display_id: u32) -> Option<(f64, f64, f64, f64)> {
    let display = core_graphics::display::CGDisplay::new(display_id);
    let bounds = display.bounds();
    if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
        return None;
    }
    Some((bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height))
}

/// Extract a recording's audio track to a mono WAV at `out_wav`, resampled to
/// `rate` Hz. Returns `Ok(())` on success. The Err string is user-facing; the
/// special value `"no_audio"` is returned when the recording has no audio track
/// so the caller can show a friendly message.
pub fn extract_audio_at(
    mp4: &std::path::Path,
    out_wav: &std::path::Path,
    rate: u32,
) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("extract-audio")
        .arg("--in")
        .arg(mp4)
        .arg("--out")
        .arg(out_wav)
        .arg("--rate")
        .arg(rate.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        return Ok(());
    }

    // Inspect stderr for the structured error kind (scan from the last line).
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines().rev() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("event").and_then(|v| v.as_str()) == Some("error") {
                let kind = val.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                if kind == "no_audio" {
                    return Err("no_audio".into());
                }
                let msg = val.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
                return Err(format!("audio extraction failed: {msg}"));
            }
        }
    }
    Err(format!(
        "audio extraction failed (exit {:?})",
        out.status.code()
    ))
}

/// Back-compat: extract at 16kHz mono (used by the transcript pipeline).
pub fn extract_audio(mp4: &std::path::Path, out_wav: &std::path::Path) -> Result<(), String> {
    extract_audio_at(mp4, out_wav, 16_000)
}

/// A decoded 16-bit PCM mono WAV: its `data`-chunk samples plus the sample
/// rate. The intermediate representation shared by `trim_wav_samples` and
/// `retime_wav_samples` so the header/chunk plumbing lives in one place.
struct MonoWav {
    sample_rate: u32,
    samples: Vec<i16>,
}

/// Read a 16-bit PCM mono WAV from disk into `MonoWav`. Rejects non-WAV,
/// non-mono, and non-16-bit inputs (callers always feed `extract_audio_at(..,
/// 48_000)` output, which is mono 16-bit). Skips any chunks between `fmt ` and
/// `data`. Pure aside from the file read.
fn read_mono_wav(wav_in: &std::path::Path) -> Result<MonoWav, String> {
    let mut bytes = Vec::new();
    {
        use std::io::Read;
        std::fs::File::open(wav_in)
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| format!("could not read WAV: {e}"))?;
    }
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
    let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    let bits = u16::from_le_bytes(bytes[34..36].try_into().unwrap());
    if bits != 16 {
        return Err(format!("expected 16-bit PCM WAV, got {bits}-bit"));
    }
    if channels != 1 {
        return Err(format!("expected mono WAV, got {channels} channels"));
    }
    // Find the `data` chunk (skip any chunks between `fmt ` and `data`).
    let mut pos = 12;
    let (data_off, data_len) = loop {
        if pos + 8 > bytes.len() {
            return Err("no data chunk in WAV".into());
        }
        let id = &bytes[pos..pos + 4];
        let sz = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            break (pos + 8, sz.min(bytes.len() - (pos + 8)));
        }
        pos += 8 + sz + (sz & 1); // chunks are word-aligned
    };
    let samples: Vec<i16> = bytes[data_off..data_off + data_len]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    Ok(MonoWav {
        sample_rate,
        samples,
    })
}

/// Serialize a 16-bit PCM mono WAV (`sample_rate` Hz, the given `samples`) to
/// `wav_out`. Inverse of `read_mono_wav`; the canonical 44-byte header writer
/// shared by the trim/retime paths.
fn write_mono_wav(
    wav_out: &std::path::Path,
    sample_rate: u32,
    samples: &[i16],
) -> Result<(), String> {
    let out_data_len = (samples.len() * 2) as u32;
    let byte_rate = sample_rate * 2; // mono, 16-bit
    let mut out = Vec::with_capacity(44 + out_data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + out_data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align = channels * 2
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&out_data_len.to_le_bytes());
    for &s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(wav_out, &out).map_err(|e| format!("could not write WAV: {e}"))
}

/// Copy a millisecond sub-range `[start_ms, end_ms)` of a 16-bit PCM mono WAV
/// (`wav_in`) into a fresh WAV (`wav_out`), preserving the sample rate. Pure
/// file→file sample-range copy — no resampling, no channel changes.
///
/// Used by `finalize_rendered_recording` to align the muxed soundtrack with an
/// editor trim: `extract_audio_at` gives the full-length 48kHz mono WAV, then
/// this slices out the kept window so the audio starts/ends with the trimmed
/// video.
///
/// Semantics:
///   - `start_ms`/`end_ms` are clamped to `[0, total_ms]`; if `end_ms <=
///     start_ms` after clamping (or `start_ms` is at/after the end of the
///     data), returns an error rather than writing a zero-length file.
///   - A range covering the whole clip copies every sample verbatim.
///   - The input must be 16-bit PCM mono; other formats are rejected (callers
///     always pass `extract_audio_at(.., 48_000)` output, which is mono 16-bit).
pub fn trim_wav_samples(
    wav_in: &std::path::Path,
    wav_out: &std::path::Path,
    start_ms: u64,
    end_ms: u64,
) -> Result<(), String> {
    let wav = read_mono_wav(wav_in)?;
    let total_samples = wav.samples.len();
    let sr = wav.sample_rate as u64;

    // ms → sample index (round to nearest sample), clamped into range.
    let ms_to_sample = |ms: u64| -> usize {
        let s = (ms.saturating_mul(sr) + 500) / 1000; // round to nearest
        (s.min(total_samples as u64)) as usize
    };
    let start_s = ms_to_sample(start_ms);
    let end_s = ms_to_sample(end_ms);
    if end_s <= start_s {
        return Err(format!(
            "trim range is empty (start_ms={start_ms}, end_ms={end_ms}, samples={total_samples})"
        ));
    }

    write_mono_wav(wav_out, wav.sample_rate, &wav.samples[start_s..end_s])
}

/// One speed range in POST-TRIM millisecond time, as parsed from the
/// `x-speed-ranges` finalize header. `start_ms`/`end_ms` are relative to the
/// start of the (already-trimmed) WAV; `rate` is the playback multiplier
/// (2.0 = twice as fast → half the samples; 0.5 = half speed → twice as many).
///
/// CONTRACT: the frontend sends these ALREADY shifted into post-trim time
/// (`shiftRangesForTrim` in editorProject.ts) so Rust applies them directly to
/// the trimmed audio without re-deriving the trim offset.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
pub struct SpeedRangeSamples {
    pub start_ms: u64,
    pub end_ms: u64,
    pub rate: f64,
}

/// Clamp `ranges` (POST-TRIM ms, as received from the frontend) so none of
/// them extend past `total_ms` (the actual duration of the audio they'll be
/// applied to). The frontend builds ranges against the VIDEO's nominal
/// duration, but the extracted/trimmed audio track is often a little shorter,
/// so a range near the end of the recording can legitimately exceed the audio
/// length even though the request is otherwise well-formed. Silently rejecting
/// that (the old behaviour) caused un-retimed audio to be muxed onto
/// already-retimed video → permanent A/V desync.
///
/// Rules:
///   - A range whose `end_ms` exceeds `total_ms` is truncated to `end_ms =
///     total_ms`.
///   - A range whose `start_ms >= total_ms` (or that becomes empty after
///     truncation, i.e. `start_ms >= end_ms`) is dropped entirely.
///   - Ranges fully within `total_ms` pass through unchanged.
///
/// This does NOT touch genuinely invalid input (unsorted, overlapping,
/// non-positive rate, `start_ms >= end_ms` on the ORIGINAL range) — those are
/// still caught by `retime_wav_samples`'s validation after clamping, which
/// then fails loudly rather than desyncing (see `finalize_rendered_recording`).
///
/// Pure and unit-tested independent of any WAV I/O.
fn clamp_ranges_to_len(ranges: &[SpeedRangeSamples], total_ms: u64) -> Vec<SpeedRangeSamples> {
    let mut out = Vec::with_capacity(ranges.len());
    for (i, r) in ranges.iter().enumerate() {
        if r.start_ms >= total_ms {
            info!(
                target: "screenrec",
                range_index = i,
                start_ms = r.start_ms,
                end_ms = r.end_ms,
                total_ms,
                "clamp_ranges_to_len: range starts at/after audio end; dropping"
            );
            continue;
        }
        if r.end_ms > total_ms {
            info!(
                target: "screenrec",
                range_index = i,
                orig_end_ms = r.end_ms,
                clamped_end_ms = total_ms,
                total_ms,
                "clamp_ranges_to_len: range end exceeds audio length; clamping"
            );
            out.push(SpeedRangeSamples {
                start_ms: r.start_ms,
                end_ms: total_ms,
                rate: r.rate,
            });
        } else {
            out.push(*r);
        }
    }
    out
}

/// Retime a 16-bit PCM mono WAV (`wav_in`) by resampling each speed range in
/// place, writing the result to `wav_out`. Regions outside every range are
/// copied 1:1; inside a range at `rate`, the span is naively linear-interp
/// resampled so it plays `rate`× faster (a 2× range consumes 2 input samples
/// per output sample → half the samples; 0.5× stretches to twice as many).
///
/// PITCH-SHIFT CAVEAT (v1, accepted): this is a naive time-domain resample, so
/// sped-up audio is pitch-shifted upward ("chipmunk" at 2×) and slowed audio
/// drops in pitch. Proper pitch-preserving time-stretch (WSOLA/phase vocoder)
/// is future work; v1 ships the simple resample to match the video retiming.
///
/// Before validation, incoming `ranges` are clamped to the audio's actual
/// length via `clamp_ranges_to_len` (see its doc for why: the frontend builds
/// ranges against the video's nominal duration, which can slightly exceed the
/// trimmed audio's actual length). After clamping, `ranges` must be sorted
/// ascending by `start_ms`, non-overlapping, and each `rate` must be > 0 —
/// otherwise returns an `Err`. Unlike the pre-clamp behaviour, callers MUST NOT
/// treat this `Err` as "skip retiming and mux un-retimed audio": that silently
/// desyncs A/V. `finalize_rendered_recording` fails the export instead. Empty
/// `ranges` (after clamping) → verbatim copy. The input must be 16-bit PCM
/// mono (same constraint as `trim_wav_samples`).
pub fn retime_wav_samples(
    wav_in: &std::path::Path,
    wav_out: &std::path::Path,
    ranges: &[SpeedRangeSamples],
) -> Result<(), String> {
    let wav = read_mono_wav(wav_in)?;
    let total_samples = wav.samples.len();
    let sr = wav.sample_rate as u64;

    // ms → sample index (round to nearest), NOT clamped — an out-of-range
    // request is a caller error (validated below), not something to silently
    // truncate the way the trim path clamps.
    let ms_to_sample = |ms: u64| -> u64 { (ms.saturating_mul(sr) + 500) / 1000 };

    // Clamp ranges to the audio's actual length BEFORE validating. See
    // `clamp_ranges_to_len` doc for rationale.
    let total_ms = if sr > 0 {
        (total_samples as u64 * 1000) / sr
    } else {
        0
    };
    let ranges = clamp_ranges_to_len(ranges, total_ms);
    let ranges = ranges.as_slice();

    // Validate: sorted, non-overlapping, within data, positive rate.
    let mut prev_end: u64 = 0;
    for (i, r) in ranges.iter().enumerate() {
        if !(r.rate.is_finite() && r.rate > 0.0) {
            return Err(format!("speed range {i} has non-positive rate {}", r.rate));
        }
        if r.end_ms <= r.start_ms {
            return Err(format!(
                "speed range {i} is empty (start_ms={}, end_ms={})",
                r.start_ms, r.end_ms
            ));
        }
        let start_s = ms_to_sample(r.start_ms);
        let end_s = ms_to_sample(r.end_ms);
        if i > 0 && start_s < prev_end {
            return Err(format!(
                "speed ranges must be sorted and non-overlapping (range {i} overlaps its predecessor)"
            ));
        }
        if end_s > total_samples as u64 {
            return Err(format!(
                "speed range {i} extends past the audio data (end_ms={}, samples={total_samples})",
                r.end_ms
            ));
        }
        prev_end = end_s;
    }

    // Walk the timeline: copy verbatim up to each range start, resample the
    // range, then copy the tail after the last range.
    let mut out: Vec<i16> = Vec::with_capacity(total_samples);
    let mut cursor: usize = 0; // next un-emitted input sample index
    for r in ranges {
        let start_s = ms_to_sample(r.start_ms) as usize;
        let end_s = ms_to_sample(r.end_ms) as usize;
        // Verbatim gap before this range.
        if start_s > cursor {
            out.extend_from_slice(&wav.samples[cursor..start_s]);
        }
        // Resample [start_s, end_s) at `rate`. Output length = round(span/rate).
        let span = (end_s - start_s) as f64;
        let out_len = (span / r.rate).round() as usize;
        for j in 0..out_len {
            // Map output index j → fractional input position within the span.
            let src_pos = start_s as f64 + (j as f64) * r.rate;
            let i0 = src_pos.floor() as usize;
            let frac = src_pos - i0 as f64;
            // Linear interpolation between i0 and i0+1, clamped to the span end.
            let s0 = wav.samples[i0.min(end_s - 1)] as f64;
            let s1 = wav.samples[(i0 + 1).min(end_s - 1)] as f64;
            let v = s0 + (s1 - s0) * frac;
            out.push(v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
        }
        cursor = end_s;
    }
    // Verbatim tail after the last range.
    if cursor < total_samples {
        out.extend_from_slice(&wav.samples[cursor..]);
    }

    write_mono_wav(wav_out, wav.sample_rate, &out)
}

// ---- Loudness normalization ----------------------------------------------
//
// DSP constants for `normalize_wav_loudness`. Deliberately a SIMPLE gated-RMS
// normalizer + soft-knee limiter — NOT EBU R128 K-weighting / true-peak. This
// is a polish pass on already-recorded screen-capture audio, not a broadcast
// loudness compliance tool, so we skip the K-weighting filterbank and integrated
// gating windows and just measure gated RMS. The values below are chosen to be
// gentle and unsurprising rather than "correct" in the R128 sense:
//
//   - TARGET_DBFS (−16): a comfortable speech-forward level for screen
//     recordings played back in a browser/desktop; not so hot that a following
//     platform re-normalizes it down, not so quiet that the viewer reaches for
//     the volume.
//   - GATE_DBFS (−40): blocks quieter than this are treated as silence/noise
//     floor and EXCLUDED from the loudness measurement, so room tone and gaps
//     between speech don't drag the measured level down (which would otherwise
//     make us over-boost and amplify hiss). It also means true silence has no
//     measurable loudness → gain stays 1.0 (no blow-up).
//   - BLOCK_MS (400): RMS is measured in 400 ms blocks (a momentary-ish window);
//     each block is gated independently. Long enough to be stable on speech,
//     short enough that the gate can reject quiet gaps.
//   - CEILING_DBFS (−1): after applying the single normalization gain, a
//     soft-knee limiter tucks peaks under −1 dBFS so the boost can't clip. A
//     tiny amount of headroom below 0 dBFS avoids inter-sample-peak overshoot on
//     later re-encode.
//   - MAX_GAIN (~12 dB): clamp the boost so a mostly-quiet clip with a few loud
//     words doesn't get blown up (and its noise floor with it).
const NORM_TARGET_DBFS: f64 = -16.0;
const NORM_GATE_DBFS: f64 = -40.0;
const NORM_BLOCK_MS: u64 = 400;
const NORM_CEILING_DBFS: f64 = -1.0;
const NORM_MAX_GAIN: f64 = 4.0; // ≈ +12 dB, keeps quiet-clip boosts sane

/// Outcome of a `normalize_wav_loudness` pass, for logging. `measured_dbfs` is
/// the gated-RMS loudness of the input (NEG_INFINITY when everything was below
/// the gate, i.e. silence); `gain` is the linear gain actually applied
/// (post-clamp); `limited` is whether the soft-knee limiter engaged on any
/// sample; `ceiling_frac`/`sample_count` are for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessReport {
    pub measured_dbfs: f64,
    pub target_dbfs: f64,
    pub gain: f64,
    pub limited: bool,
    pub sample_count: usize,
}

/// Convert a linear amplitude fraction (0..1 of full scale) to dBFS.
fn lin_to_dbfs(x: f64) -> f64 {
    20.0 * x.max(1e-12).log10()
}

/// Convert dBFS to a linear amplitude fraction (0..1 of full scale).
fn dbfs_to_lin(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

/// Pure DSP core of `normalize_wav_loudness`: takes 48 kHz-ish mono i16 samples,
/// returns normalized samples plus a `LoudnessReport`. Separated from the WAV
/// I/O so it can be unit-tested and reused (mirrors how the retime path keeps
/// its resample logic file-agnostic).
///
/// Algorithm (see the constants above for the rationale, and the module doc for
/// why this is deliberately NOT EBU R128):
///   1. Gated RMS measure: split into `BLOCK_MS` blocks; compute each block's
///      RMS; include only blocks at/above `GATE_DBFS` in the overall measure.
///      If NO block passes the gate (silence), the signal is left untouched
///      (gain = 1.0) — never boost silence.
///   2. Single gain: `gain = target / measured`, clamped to `[.., MAX_GAIN]`.
///   3. Soft-knee limiter at `CEILING_DBFS`: apply the gain, then push any
///      sample whose magnitude exceeds the ceiling back under it with a smooth
///      (tanh-style) knee so the boost can't hard-clip.
fn normalize_samples(samples: &[i16], sample_rate: u32) -> (Vec<i16>, LoudnessReport) {
    let n = samples.len();
    let sr = sample_rate.max(1) as u64;
    let block_len = ((sr * NORM_BLOCK_MS) / 1000).max(1) as usize;
    let gate_lin = dbfs_to_lin(NORM_GATE_DBFS);

    // 1. Gated RMS: accumulate sum-of-squares only from blocks whose own RMS is
    // at/above the gate. Measuring per-block-then-pooling (rather than a single
    // global RMS) is what lets the gate exclude quiet gaps.
    let mut gated_sum_sq = 0.0_f64;
    let mut gated_count: usize = 0;
    let full_scale = i16::MAX as f64;
    let mut i = 0usize;
    while i < n {
        let end = (i + block_len).min(n);
        let block = &samples[i..end];
        let mut sum_sq = 0.0_f64;
        for &s in block {
            let x = (s as f64) / full_scale;
            sum_sq += x * x;
        }
        let block_rms = (sum_sq / block.len() as f64).sqrt();
        if block_rms >= gate_lin {
            gated_sum_sq += sum_sq;
            gated_count += block.len();
        }
        i = end;
    }

    // No block passed the gate → silence/near-silence. Leave untouched.
    if gated_count == 0 {
        return (
            samples.to_vec(),
            LoudnessReport {
                measured_dbfs: f64::NEG_INFINITY,
                target_dbfs: NORM_TARGET_DBFS,
                gain: 1.0,
                limited: false,
                sample_count: n,
            },
        );
    }

    let measured_lin = (gated_sum_sq / gated_count as f64).sqrt();
    let measured_dbfs = lin_to_dbfs(measured_lin);

    // 2. Single normalization gain toward the target, clamped so a mostly-quiet
    // clip can't be blown up (and its noise floor with it).
    let target_lin = dbfs_to_lin(NORM_TARGET_DBFS);
    let gain = (target_lin / measured_lin).clamp(0.0, NORM_MAX_GAIN);

    // 3. Apply gain + soft-knee limiter at the ceiling. The limiter is a smooth
    // tanh knee above the ceiling: below the ceiling samples are linear; above
    // it they're compressed asymptotically toward full scale, so a boosted
    // transient rounds off instead of hard-clipping. `1e-9` avoids treating
    // exactly-at-unity gain as "limited" from FP noise.
    let ceiling = dbfs_to_lin(NORM_CEILING_DBFS); // 0..1 of full scale
    let mut limited = false;
    let out: Vec<i16> = samples
        .iter()
        .map(|&s| {
            let x = (s as f64) / full_scale * gain;
            let mag = x.abs();
            let y = if mag <= ceiling {
                x
            } else {
                limited = true;
                // Soft knee: map the overshoot above the ceiling through tanh so
                // the result stays within (ceiling, 1.0). `over` is how far past
                // the ceiling we are, in units of the remaining headroom.
                let sign = if x < 0.0 { -1.0 } else { 1.0 };
                let headroom = 1.0 - ceiling;
                let over = (mag - ceiling) / headroom.max(1e-9);
                sign * (ceiling + headroom * over.tanh())
            };
            (y * full_scale)
                .round()
                .clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect();

    (
        out,
        LoudnessReport {
            measured_dbfs,
            target_dbfs: NORM_TARGET_DBFS,
            gain,
            limited,
            sample_count: n,
        },
    )
}

/// Loudness-normalize a 16-bit PCM mono WAV (`wav_in`) toward −16 dBFS with a
/// gated-RMS measure and a −1 dBFS soft-knee limiter, writing the result to
/// `wav_out`. Thin file→file wrapper around `normalize_samples` (mirrors how
/// `retime_wav_samples` wraps its pure resample core); returns a
/// `LoudnessReport` for the caller to log.
///
/// Deliberately a simple polish pass, NOT EBU R128 — see the constants block
/// above `normalize_samples` for the rationale. Silence is left untouched
/// (never boost the noise floor). The input must be 16-bit PCM mono (same
/// constraint as `trim_wav_samples`/`retime_wav_samples`; callers feed
/// `extract_audio_at(.., 48_000)` output).
///
/// This is a best-effort polish step: `finalize_rendered_recording` treats any
/// `Err` here as "skip normalization + warn", never failing the export.
pub fn normalize_wav_loudness(
    wav_in: &std::path::Path,
    wav_out: &std::path::Path,
) -> Result<LoudnessReport, String> {
    let wav = read_mono_wav(wav_in)?;
    let (out, report) = normalize_samples(&wav.samples, wav.sample_rate);
    write_mono_wav(wav_out, wav.sample_rate, &out)?;
    Ok(report)
}

/// Mux a cleaned audio WAV into the original video, writing a new mp4.
pub fn mux_audio(
    video: &std::path::Path,
    audio: &std::path::Path,
    out: &std::path::Path,
) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let res = Command::new(&bin)
        .arg("mux-audio")
        .arg("--video")
        .arg(video)
        .arg("--audio")
        .arg(audio)
        .arg("--out")
        .arg(out)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if res.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&res.stderr);
    for line in stderr.lines().rev() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("event").and_then(|v| v.as_str()) == Some("error") {
                let msg = val.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
                return Err(format!("audio mux failed: {msg}"));
            }
        }
    }
    Err(format!("audio mux failed (exit {:?})", res.status.code()))
}

/// Parsed `stopped` event payload from the sidecar.
#[derive(Debug, Clone, PartialEq)]
pub struct StoppedInfo {
    pub path: String,
    pub dur_ms: i64,
    pub width: i64,
    pub height: i64,
    pub size: i64,
    pub thumb: String,
    /// Path to the input-events JSONL sidecar file, if the sidecar recorded
    /// one. `None` when the field is missing or empty (e.g. the no-frames
    /// abort path, which emits a header-only file with `n_events: 0` but may
    /// omit `events` entirely).
    pub events_path: Option<String>,
    /// Total input events recorded (moves, clicks, scrolls, keys). `None` when
    /// the sidecar omits the field (older binaries / non-events runs). M3 will
    /// persist these; for now they're logged at the stop boundary.
    pub n_events: Option<i64>,
    /// Click-down events recorded (subset of `n_events`). `None` when absent.
    pub n_clicks: Option<i64>,
    /// Path to the recorded webcam MP4 sidecar file, if a camera was
    /// selected for this recording. `None` when the field is missing or
    /// empty (no `--camera` was passed to `start()`).
    pub webcam_path: Option<String>,
    /// Host-clock delta (ms) between the webcam file's start and the first
    /// main-capture frame; consumers shift the webcam timeline by this
    /// amount. `None` when the sidecar omits the field (no webcam recorded).
    pub webcam_offset_ms: Option<i64>,
}

/// Parse one line of sidecar stderr JSON into a `StoppedInfo`, if it is the
/// `stopped` event. Returns `None` for any other event or malformed line.
pub fn parse_stopped(line: &str) -> Option<StoppedInfo> {
    let val: serde_json::Value = serde_json::from_str(line).ok()?;
    if val.get("event")?.as_str()? != "stopped" {
        return None;
    }
    let events_path = val
        .get("events")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let webcam_path = val
        .get("webcam")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(StoppedInfo {
        path: val.get("path")?.as_str()?.to_string(),
        dur_ms: val.get("dur_ms").and_then(|v| v.as_i64()).unwrap_or(0),
        width: val.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        height: val.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        size: val.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
        thumb: val.get("thumb").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        events_path,
        n_events: val.get("n_events").and_then(|v| v.as_i64()),
        n_clicks: val.get("n_clicks").and_then(|v| v.as_i64()),
        webcam_path,
        webcam_offset_ms: val.get("webcam_offset_ms").and_then(|v| v.as_i64()),
    })
}

/// Parsed `done` event from an `export` run.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportDone {
    pub path: String,
    pub size: i64,
}

/// Parse one line of sidecar stderr JSON into an `ExportDone`, if it is the
/// `done` event. Returns `None` for any other event or malformed line.
pub fn parse_export_done(line: &str) -> Option<ExportDone> {
    let val: serde_json::Value = serde_json::from_str(line).ok()?;
    if val.get("event")?.as_str()? != "done" {
        return None;
    }
    Some(ExportDone {
        path: val.get("path")?.as_str()?.to_string(),
        size: val.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

/// Transcode `in_path` to `out_path` at `quality` ("1080"|"720"|"480") by
/// running the sidecar's `export` sub-command. Blocks until it finishes.
/// Returns the finalized export info on success. Mirrors `extract_audio`.
pub fn export(in_path: &Path, out_path: &Path, quality: &str) -> Result<ExportDone, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("export")
        .arg("--in")
        .arg(in_path)
        .arg("--out")
        .arg(out_path)
        .arg("--quality")
        .arg(quality)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    // Success: find the `done` event (progress events precede it).
    for line in stderr.lines().rev() {
        if let Some(d) = parse_export_done(line) {
            return Ok(d);
        }
    }
    // Failure: surface the structured error if present.
    for line in stderr.lines().rev() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if val.get("event").and_then(|v| v.as_str()) == Some("error") {
                let msg = val.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
                return Err(format!("export failed: {msg}"));
            }
        }
    }
    Err(format!("export produced no output (exit {:?})", out.status.code()))
}

/// Resolve the bundled `echo-scribe-screenrec` sidecar, falling back to the
/// dev build. Mirrors `meeting/syscap.rs::resolve_binary`.
fn resolve_binary() -> std::io::Result<PathBuf> {
    let triple = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(format!("echo-scribe-screenrec-{}", triple));
            if candidate.exists() {
                return Ok(candidate);
            }
            let no_suffix = parent.join("echo-scribe-screenrec");
            if no_suffix.exists() {
                return Ok(no_suffix);
            }
        }
    }
    let cwd = std::env::current_dir()?;
    let dev = cwd
        .join("src-tauri/binaries")
        .join(format!("echo-scribe-screenrec-{}", triple));
    if dev.exists() {
        return Ok(dev);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "echo-scribe-screenrec binary not found",
    ))
}

/// `~/Library/Application Support/EchoScribe/recordings/`, created if missing.
pub fn recordings_dir() -> std::io::Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME not set"))?;
    let dir = PathBuf::from(home)
        .join("Library/Application Support/EchoScribe/recordings");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Validate a caller-supplied crop rect vector (`[x, y, w, h]`, global points).
/// Returns the tuple on success, or a short friendly error describing why it was
/// rejected (wrong length, or a non-positive width/height). The area-vs-display
/// clamping is a separate concern handled sidecar-side (see
/// [`clamp_rect_to_display`]); this only guards the shape and sign of the input.
pub fn rect_from_vec(v: &[f64]) -> Result<(f64, f64, f64, f64), String> {
    if v.len() != 4 {
        return Err(format!(
            "rect must be [x, y, width, height] (4 numbers), got {}",
            v.len()
        ));
    }
    let (x, y, w, h) = (v[0], v[1], v[2], v[3]);
    if !(w > 0.0) || !(h > 0.0) {
        return Err("rect width and height must be positive".to_string());
    }
    Ok((x, y, w, h))
}

/// Clamp a crop `rect` (`(x, y, w, h)`, global points, top-left origin) to the
/// bounds of `display` (same coordinate space). Origin is pulled to the nearest
/// edge and the size shrunk so the far edge never exceeds the display; the far
/// edge is held fixed when the origin moves inward. Returns `None` when the
/// input size is non-positive or nothing remains after clamping (zero area) —
/// the sidecar treats that as a `bad_rect` fatal. Mirrors the Swift
/// `clampRectToDisplay` used on the capture path; keep the two in sync.
pub fn clamp_rect_to_display(
    rect: (f64, f64, f64, f64),
    display: (f64, f64, f64, f64),
) -> Option<(f64, f64, f64, f64)> {
    let (rx, ry, rw, rh) = rect;
    if rw <= 0.0 || rh <= 0.0 {
        return None;
    }
    let (dx, dy, dw, dh) = display;
    let (d_right, d_bottom) = (dx + dw, dy + dh);
    // Right/bottom edges of the requested rect, then clamp each edge into the
    // display. Origin clamps up to the near edge; far edge clamps down.
    let x0 = rx.max(dx).min(d_right);
    let y0 = ry.max(dy).min(d_bottom);
    let x1 = (rx + rw).max(dx).min(d_right);
    let y1 = (ry + rh).max(dy).min(d_bottom);
    let (w, h) = (x1 - x0, y1 - y0);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some((x0, y0, w, h))
}

/// Parameters for a new recording session.
#[derive(Debug, Clone, Default)]
pub struct RecordParams {
    /// Capture a specific display by its SCDisplay id.
    pub display_id: Option<u32>,
    /// Capture a specific window by its SCWindow id.
    pub window_id: Option<u32>,
    /// Mic device name/uid to mix in (wired up in T3; pushed now so the flag
    /// round-trips through the sidecar's ignored-arg path).
    pub mic_device: Option<String>,
    /// Whether to capture system audio. Defaults to `true`.
    pub sysaudio: bool,
    /// Hide the system cursor during capture (`--hide-cursor`). Defaults to
    /// `false` so an unset value produces the exact same spawn as before
    /// this field existed.
    pub hide_cursor: bool,
    /// Camera device uid to record alongside the main capture (`--camera
    /// <uid>`). `None` means no webcam recording (identical spawn to today).
    pub camera_uid: Option<String>,
    /// Crop region (`(x, y, w, h)`, global points, top-left origin) to capture
    /// instead of the whole display. Valid only on the display path (ignored
    /// with `--window`). `None` means full-display capture — the spawn is then
    /// byte-identical to before this field existed.
    pub rect: Option<(f64, f64, f64, f64)>,
}

/// A running screen recording. Holds the child process and the path it is
/// writing to. Dropping it does not stop the recording — call `stop()`.
pub struct ScreenrecHandle {
    child: Child,
    pub out_path: PathBuf,
    stopped_rx: mpsc::Receiver<StoppedInfo>,
}

impl ScreenrecHandle {
    /// Spawn the sidecar to record to `out_path` with the given `params`.
    /// Waits up to 5s for the sidecar to confirm capture is `ready`
    /// (or report an `error` / exit early) before returning, so callers know
    /// the recording actually started rather than merely that the process spawned.
    pub fn start(out_path: PathBuf, params: RecordParams) -> Result<Self, String> {
        let bin = resolve_binary().map_err(|e| e.to_string())?;
        info!(path = %bin.display(), out = %out_path.display(), "spawning screenrec");
        // Derive the events sidecar path from `out_path`: same directory,
        // same stem, `.events.jsonl` suffix (e.g. `<id>.mp4` -> `<id>.events.jsonl`).
        // Assumes the id stem is dot-free (our ids are `rec-<millis>`); a stem
        // with a dot would have its trailing segment stripped by with_extension.
        let events_path = out_path.with_extension("").with_extension("events.jsonl");
        let mut cmd = Command::new(&bin);
        cmd.arg("record")
            .arg("--out")
            .arg(&out_path)
            .arg("--events")
            .arg(&events_path);
        // Source selection: window takes priority over display.
        if let Some(wid) = params.window_id {
            cmd.arg("--window").arg(wid.to_string());
        } else if let Some(did) = params.display_id {
            cmd.arg("--display").arg(did.to_string());
        }
        // Audio flags.
        if !params.sysaudio {
            cmd.arg("--no-sysaudio");
        }
        if let Some(ref uid) = params.mic_device {
            cmd.arg("--mic").arg(uid);
        }
        // Cursor + webcam flags: only appended when set, so a default
        // false/None call produces the exact same spawn as before these
        // params existed (the sidecar doesn't implement them yet).
        if params.hide_cursor {
            cmd.arg("--hide-cursor");
        }
        if let Some(ref uid) = params.camera_uid {
            cmd.arg("--camera").arg(uid);
        }
        // Area (region-of-display) capture. Appended ONLY when set, so a
        // full-display call produces a byte-identical spawn to before this
        // param existed. Format `x,y,w,h` in global points; the sidecar
        // clamps it to the display and crops via SCStreamConfiguration.sourceRect.
        if let Some((x, y, w, h)) = params.rect {
            cmd.arg("--rect").arg(format!("{x},{y},{w},{h}"));
        }
        let mut child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        let (tx, rx) = mpsc::channel::<StoppedInfo>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let stderr = child.stderr.take().expect("piped");
        let log_path = recordings_dir().ok().map(|d| d.join("screenrec-last.log"));
        let out_path_for_log = out_path.clone();
        std::thread::spawn(move || {
            let mut ready_reported = false;
            let mut log_file = log_path
                .as_ref()
                .and_then(|p| std::fs::File::create(p).ok());
            if let Some(f) = log_file.as_mut() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = writeln!(f, "=== start {} out={} ===", ts, out_path_for_log.display());
            }
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(f) = log_file.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
                if !ready_reported {
                    if line.contains("\"event\":\"ready\"") {
                        let _ = ready_tx.send(Ok(()));
                        ready_reported = true;
                    } else if line.contains("\"event\":\"error\"") {
                        let _ = ready_tx.send(Err(line.clone()));
                        ready_reported = true;
                    }
                }
                if let Some(info) = parse_stopped(&line) {
                    let _ = tx.send(info);
                    break;
                } else if line.contains("\"event\":\"error\"") {
                    warn!(line, "screenrec error event");
                }
            }
            // stderr closed (process exited) before ready: unblock start().
            if !ready_reported {
                let _ = ready_tx.send(Err("screenrec exited before ready".into()));
            }
        });

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self { child, out_path, stopped_rx: rx }),
            Ok(Err(e)) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(format!("screenrec failed to start: {e}"))
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                Err("screenrec did not become ready within 5s".into())
            }
        }
    }

    /// SIGTERM the sidecar and wait up to 10s for the `stopped` event (which
    /// arrives after AVAssetWriter finishes finalizing the MP4). Returns the
    /// finalized recording info.
    pub fn stop(mut self) -> Result<StoppedInfo, String> {
        // If the sidecar already exited (crashed mid-recording), don't block the
        // full timeout waiting for a `stopped` that will never arrive.
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return self
                .stopped_rx
                .recv_timeout(Duration::from_secs(1))
                .map_err(|_| "screenrec exited without finalizing".to_string());
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let info = self
            .stopped_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "screenrec did not finalize within 10s".to_string());

        // Reap the process regardless.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stopped_extracts_fields() {
        let line = r#"{"event":"stopped","path":"/tmp/a.mp4","dur_ms":4000,"width":3456,"height":2234,"size":99,"thumb":"/tmp/a.jpg"}"#;
        let got = parse_stopped(line).unwrap();
        assert_eq!(got.path, "/tmp/a.mp4");
        assert_eq!(got.dur_ms, 4000);
        assert_eq!(got.width, 3456);
        assert_eq!(got.thumb, "/tmp/a.jpg");
    }

    #[test]
    fn parse_stopped_ignores_other_events() {
        assert!(parse_stopped(r#"{"event":"ready"}"#).is_none());
        assert!(parse_stopped(r#"{"event":"heartbeat","ts":1.0}"#).is_none());
        assert!(parse_stopped("not json").is_none());
    }

    #[test]
    fn parse_stopped_extracts_events_path() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","events":"/r/a.events.jsonl","n_events":42,"n_clicks":3}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.events_path.as_deref(), Some("/r/a.events.jsonl"));
    }

    #[test]
    fn parse_stopped_events_optional() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.events_path, None);
    }

    #[test]
    fn parse_stopped_extracts_event_counts() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","events":"/r/a.events.jsonl","n_events":42,"n_clicks":3}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.n_events, Some(42));
        assert_eq!(info.n_clicks, Some(3));
    }

    #[test]
    fn parse_stopped_event_counts_optional() {
        // Older sidecar / no-events run omits n_events and n_clicks entirely.
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.n_events, None);
        assert_eq!(info.n_clicks, None);
    }

    #[test]
    fn parse_stopped_extracts_webcam_fields() {
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","webcam":"/r/a.webcam.mp4","webcam_offset_ms":120}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.webcam_path.as_deref(), Some("/r/a.webcam.mp4"));
        assert_eq!(info.webcam_offset_ms, Some(120));
    }

    #[test]
    fn parse_stopped_webcam_fields_absent() {
        // No --camera was passed to start(): sidecar omits both fields entirely.
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.webcam_path, None);
        assert_eq!(info.webcam_offset_ms, None);
    }

    #[test]
    fn parse_stopped_webcam_path_empty_string_is_none() {
        // Sidecar reports the key but with an empty value (no webcam file produced).
        let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","webcam":""}"#;
        let info = parse_stopped(line).unwrap();
        assert_eq!(info.webcam_path, None);
    }

    #[test]
    fn parse_sources_reads_displays_and_windows() {
        let s = r#"{"displays":[{"id":1,"width":3840,"height":2160,"label":"Display 1"}],"windows":[{"id":42,"app":"Safari","title":"x","width":800,"height":600}]}"#;
        let got = parse_sources(s).unwrap();
        assert_eq!(got.displays.len(), 1);
        assert_eq!(got.windows[0].app, "Safari");
    }

    #[test]
    fn list_sources_error_detects_permission_denial() {
        // Exactly what the sidecar writes on stderr when Screen Recording is
        // not granted (observed live).
        let stderr = r#"{"event":"error","kind":"list_sources","msg":"The user declined TCCs for application, window, display capture"}"#;
        let msg = list_sources_error(stderr);
        assert!(msg.contains("Screen Recording permission"), "got: {msg}");
        assert!(msg.contains("System Settings"), "got: {msg}");
    }

    #[test]
    fn list_sources_error_generic_when_no_structured_error() {
        // Empty stderr (e.g. the helper died before emitting) -> generic,
        // never a raw serde/EOF error, and not the permission message.
        let msg = list_sources_error("");
        assert!(msg.contains("See Settings → Diagnostics"), "got: {msg}");
        assert!(!msg.contains("Screen Recording permission"), "got: {msg}");
    }

    #[test]
    fn parse_cameras_reads_uid_and_name() {
        let s = r#"{"cameras":[{"uid":"abc-123","name":"FaceTime HD Camera"}]}"#;
        let got = parse_cameras(s).unwrap();
        assert_eq!(got.cameras.len(), 1);
        assert_eq!(got.cameras[0].uid, "abc-123");
        assert_eq!(got.cameras[0].name, "FaceTime HD Camera");
    }

    #[test]
    fn parse_cameras_empty_list() {
        let s = r#"{"cameras":[]}"#;
        let got = parse_cameras(s).unwrap();
        assert!(got.cameras.is_empty());
    }

    #[test]
    fn list_cameras_error_detects_permission_denial() {
        let stderr = r#"{"event":"error","kind":"list_cameras","msg":"The user declined TCCs for camera capture"}"#;
        let msg = list_cameras_error(stderr);
        assert!(msg.contains("Camera permission"), "got: {msg}");
        assert!(msg.contains("System Settings"), "got: {msg}");
    }

    #[test]
    fn list_cameras_error_generic_when_no_structured_error() {
        // Empty stderr (helper died before emitting) -> generic message,
        // never a raw serde/EOF error, and not the permission message.
        let msg = list_cameras_error("");
        assert!(msg.contains("See Settings → Diagnostics"), "got: {msg}");
        assert!(!msg.contains("Camera permission"), "got: {msg}");
    }

    #[test]
    fn parse_export_done_extracts_fields() {
        let line = r#"{"event":"done","path":"/tmp/a-720.mp4","size":4242}"#;
        let got = parse_export_done(line).unwrap();
        assert_eq!(got.path, "/tmp/a-720.mp4");
        assert_eq!(got.size, 4242);
    }

    #[test]
    fn parse_export_done_ignores_other_events() {
        assert!(parse_export_done(r#"{"event":"progress","pct":50}"#).is_none());
        assert!(parse_export_done("not json").is_none());
    }

    // ---- clamp_rect_to_display -------------------------------------------

    #[test]
    fn clamp_rect_fully_inside_is_unchanged() {
        // A rect wholly within a primary (origin 0,0) display is returned as-is.
        let display = (0.0, 0.0, 1920.0, 1080.0);
        let got = clamp_rect_to_display((100.0, 100.0, 800.0, 600.0), display);
        assert_eq!(got, Some((100.0, 100.0, 800.0, 600.0)));
    }

    #[test]
    fn clamp_rect_overhang_clamps_size_to_display_edge() {
        // Rect extends past the right/bottom edges: width/height shrink so it
        // ends exactly at the display's far edges, origin unchanged.
        let display = (0.0, 0.0, 1920.0, 1080.0);
        let got = clamp_rect_to_display((1800.0, 1000.0, 500.0, 500.0), display);
        assert_eq!(got, Some((1800.0, 1000.0, 120.0, 80.0)));
    }

    #[test]
    fn clamp_rect_negative_origin_moves_into_display() {
        // Origin before the display's top-left is pulled to the edge; width is
        // reduced by the same amount so the far edge stays put.
        let display = (0.0, 0.0, 1920.0, 1080.0);
        let got = clamp_rect_to_display((-50.0, -30.0, 400.0, 300.0), display);
        // x: -50 -> 0 (lost 50 of width -> 350); y: -30 -> 0 (lost 30 -> 270).
        assert_eq!(got, Some((0.0, 0.0, 350.0, 270.0)));
    }

    #[test]
    fn clamp_rect_respects_nonzero_display_origin() {
        // A second display sits at global (1920, -200). A rect given in global
        // points must clamp against that display's actual frame, not (0,0).
        let display = (1920.0, -200.0, 1920.0, 1080.0);
        // Fully inside the second display -> unchanged.
        let inside = clamp_rect_to_display((2000.0, -100.0, 400.0, 300.0), display);
        assert_eq!(inside, Some((2000.0, -100.0, 400.0, 300.0)));
        // Overhanging the right edge (1920+1920 = 3840): width clamps to 3840-3600=240.
        let over = clamp_rect_to_display((3600.0, 0.0, 500.0, 200.0), display);
        assert_eq!(over, Some((3600.0, 0.0, 240.0, 200.0)));
    }

    #[test]
    fn clamp_rect_zero_area_after_clamp_is_none() {
        let display = (0.0, 0.0, 1920.0, 1080.0);
        // Origin at/after the far edge -> nothing left to capture.
        assert_eq!(clamp_rect_to_display((1920.0, 0.0, 100.0, 100.0), display), None);
        assert_eq!(clamp_rect_to_display((0.0, 1080.0, 100.0, 100.0), display), None);
        // Origin entirely off the near side by more than its size -> empty.
        assert_eq!(clamp_rect_to_display((-500.0, 0.0, 400.0, 100.0), display), None);
    }

    #[test]
    fn clamp_rect_nonpositive_input_size_is_none() {
        let display = (0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(clamp_rect_to_display((10.0, 10.0, 0.0, 100.0), display), None);
        assert_eq!(clamp_rect_to_display((10.0, 10.0, 100.0, -5.0), display), None);
    }

    // ---- display_bounds ---------------------------------------------------

    #[test]
    fn display_bounds_invalid_id_returns_none() {
        // Verified empirically (not guessed): `CGDisplayBounds` returns a
        // zero-size CGRect for an id with no matching display. NOTE: id `0`
        // is `kCGNullDirectDisplayID` but does NOT reliably zero out —
        // observed returning the main display's real bounds on this host —
        // so it is deliberately NOT used as the "invalid" case here. A
        // clearly-never-allocated large id is the reliable invalid case.
        assert_eq!(display_bounds(u32::MAX), None);
        assert_eq!(display_bounds(999_999), None);
    }

    #[test]
    fn display_bounds_active_display_has_positive_size() {
        // Every CI/dev host running this test has at least one active
        // display (headless Mac test runners still report a virtual one).
        // This exercises the real (non-invalid) branch without hardcoding
        // a specific resolution.
        let active = core_graphics::display::CGDisplay::active_displays()
            .expect("active_displays should succeed on any Mac test host");
        assert!(!active.is_empty(), "expected at least one active display");
        let (_, _, w, h) = display_bounds(active[0]).expect("bounds for an active display id");
        assert!(w > 0.0 && h > 0.0);
    }

    // ---- rect_from_vec ---------------------------------------------------

    #[test]
    fn rect_from_vec_accepts_len_4() {
        assert_eq!(
            rect_from_vec(&[1.0, 2.0, 3.0, 4.0]),
            Ok((1.0, 2.0, 3.0, 4.0))
        );
    }

    #[test]
    fn rect_from_vec_rejects_wrong_len() {
        assert!(rect_from_vec(&[1.0, 2.0, 3.0]).is_err());
        assert!(rect_from_vec(&[1.0, 2.0, 3.0, 4.0, 5.0]).is_err());
        assert!(rect_from_vec(&[]).is_err());
    }

    #[test]
    fn rect_from_vec_rejects_nonpositive_size() {
        assert!(rect_from_vec(&[0.0, 0.0, 0.0, 100.0]).is_err());
        assert!(rect_from_vec(&[0.0, 0.0, 100.0, -1.0]).is_err());
    }

    // ---- trim_wav_samples ------------------------------------------------

    /// Build a 16-bit PCM mono WAV in a temp file at `sample_rate` with the
    /// given samples, returning its path. Uses a unique name per call.
    fn write_test_wav(name: &str, sample_rate: u32, samples: &[i16]) -> PathBuf {
        let data_len = (samples.len() * 2) as u32;
        let byte_rate = sample_rate * 2;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for &s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        let p = std::env::temp_dir().join(format!(
            "es-trimtest-{name}-{}.wav",
            std::process::id()
        ));
        std::fs::write(&p, &out).unwrap();
        p
    }

    /// Read the `data`-chunk samples back out of a mono 16-bit WAV.
    fn read_test_wav_samples(path: &Path) -> Vec<i16> {
        let bytes = std::fs::read(path).unwrap();
        let mut pos = 12;
        loop {
            let id = &bytes[pos..pos + 4];
            let sz = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
            if id == b"data" {
                let off = pos + 8;
                return bytes[off..off + sz]
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]))
                    .collect();
            }
            pos += 8 + sz + (sz & 1);
        }
    }

    #[test]
    fn trim_wav_full_range_equals_input() {
        // 1000 samples @ 1000 Hz = exactly 1000 ms. Full-range copy is identity.
        let samples: Vec<i16> = (0..1000).map(|i| (i % 100) as i16).collect();
        let src = write_test_wav("full-in", 1000, &samples);
        let dst = write_test_wav("full-out", 1000, &[]);
        trim_wav_samples(&src, &dst, 0, 1000).unwrap();
        assert_eq!(read_test_wav_samples(&dst), samples);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn trim_wav_midrange_slice_length() {
        // 1000 samples @ 1000 Hz. Slice [200ms, 700ms) → samples 200..700 = 500.
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        let src = write_test_wav("mid-in", 1000, &samples);
        let dst = write_test_wav("mid-out", 1000, &[]);
        trim_wav_samples(&src, &dst, 200, 700).unwrap();
        let got = read_test_wav_samples(&dst);
        assert_eq!(got.len(), 500);
        assert_eq!(got[0], 200);
        assert_eq!(got[499], 699);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn trim_wav_start_beyond_data_errors() {
        let samples: Vec<i16> = (0..500).map(|i| i as i16).collect(); // 500 ms
        let src = write_test_wav("beyond-in", 1000, &samples);
        let dst = write_test_wav("beyond-out", 1000, &[]);
        // start_ms (600) is past the 500ms of data → empty range → error.
        let err = trim_wav_samples(&src, &dst, 600, 900).unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn trim_wav_end_clamped_to_total() {
        // end_ms past the clip is clamped to the data end, not an error.
        let samples: Vec<i16> = (0..800).map(|i| i as i16).collect(); // 800 ms
        let src = write_test_wav("clamp-in", 1000, &samples);
        let dst = write_test_wav("clamp-out", 1000, &[]);
        trim_wav_samples(&src, &dst, 300, 5000).unwrap();
        let got = read_test_wav_samples(&dst);
        assert_eq!(got.len(), 500); // 300..800
        assert_eq!(got[0], 300);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    // ---- clamp_ranges_to_len ------------------------------------------------

    #[test]
    fn clamp_ranges_passthrough_when_within_len() {
        let ranges = [
            SpeedRangeSamples { start_ms: 100, end_ms: 300, rate: 2.0 },
            SpeedRangeSamples { start_ms: 600, end_ms: 800, rate: 0.5 },
        ];
        let got = clamp_ranges_to_len(&ranges, 1000);
        assert_eq!(got, ranges);
    }

    #[test]
    fn clamp_ranges_truncates_end_past_len() {
        let ranges = [SpeedRangeSamples { start_ms: 100, end_ms: 900, rate: 2.0 }];
        let got = clamp_ranges_to_len(&ranges, 500);
        assert_eq!(got, vec![SpeedRangeSamples { start_ms: 100, end_ms: 500, rate: 2.0 }]);
    }

    #[test]
    fn clamp_ranges_drops_range_starting_at_len() {
        let ranges = [SpeedRangeSamples { start_ms: 500, end_ms: 900, rate: 2.0 }];
        let got = clamp_ranges_to_len(&ranges, 500);
        assert!(got.is_empty());
    }

    #[test]
    fn clamp_ranges_drops_range_starting_past_len() {
        let ranges = [SpeedRangeSamples { start_ms: 600, end_ms: 900, rate: 2.0 }];
        let got = clamp_ranges_to_len(&ranges, 500);
        assert!(got.is_empty());
    }

    #[test]
    fn clamp_ranges_mixed_keeps_and_truncates_and_drops() {
        let ranges = [
            SpeedRangeSamples { start_ms: 0, end_ms: 100, rate: 2.0 }, // untouched
            SpeedRangeSamples { start_ms: 400, end_ms: 900, rate: 1.5 }, // truncated
            SpeedRangeSamples { start_ms: 950, end_ms: 1200, rate: 3.0 }, // dropped
        ];
        let got = clamp_ranges_to_len(&ranges, 500);
        assert_eq!(
            got,
            vec![
                SpeedRangeSamples { start_ms: 0, end_ms: 100, rate: 2.0 },
                SpeedRangeSamples { start_ms: 400, end_ms: 500, rate: 1.5 },
            ]
        );
    }

    #[test]
    fn clamp_ranges_empty_input_is_empty_output() {
        let got = clamp_ranges_to_len(&[], 500);
        assert!(got.is_empty());
    }

    // ---- retime_wav_samples ----------------------------------------------

    #[test]
    fn retime_empty_ranges_is_identity() {
        // 1000 samples @ 1000 Hz = 1000 ms. No ranges → verbatim copy.
        let samples: Vec<i16> = (0..1000).map(|i| (i % 250) as i16).collect();
        let src = write_test_wav("retime-id-in", 1000, &samples);
        let dst = write_test_wav("retime-id-out", 1000, &[]);
        retime_wav_samples(&src, &dst, &[]).unwrap();
        assert_eq!(read_test_wav_samples(&dst), samples);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_2x_halves_span_sample_count() {
        // 1000 samples @ 1000 Hz. A 2× range over [200ms,600ms) covers input
        // samples 200..600 (400 samples) → 200 output samples. Regions outside
        // are copied 1:1: [0,200) = 200 samples, [600,1000) = 400 samples.
        // Total output = 200 + 200 + 400 = 800.
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        let src = write_test_wav("retime-2x-in", 1000, &samples);
        let dst = write_test_wav("retime-2x-out", 1000, &[]);
        retime_wav_samples(&src, &dst, &[SpeedRangeSamples { start_ms: 200, end_ms: 600, rate: 2.0 }]).unwrap();
        let got = read_test_wav_samples(&dst);
        assert_eq!(got.len(), 800);
        // Untouched leading region is verbatim.
        assert_eq!(got[0], 0);
        assert_eq!(got[199], 199);
        // Untouched trailing region resumes at input sample 600.
        assert_eq!(got[400], 600);
        assert_eq!(got[799], 999);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_half_rate_doubles_span_sample_count() {
        // 1000 samples @ 1000 Hz. A 0.5× range over [0ms,1000ms) covers the
        // whole clip (1000 samples) → 2000 output samples (stretched).
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        let src = write_test_wav("retime-half-in", 1000, &samples);
        let dst = write_test_wav("retime-half-out", 1000, &[]);
        retime_wav_samples(&src, &dst, &[SpeedRangeSamples { start_ms: 0, end_ms: 1000, rate: 0.5 }]).unwrap();
        let got = read_test_wav_samples(&dst);
        assert_eq!(got.len(), 2000);
        // First and last samples are anchored (linear interp endpoints).
        assert_eq!(got[0], 0);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_boundary_continuity_untouched_regions_verbatim() {
        // Two ranges leave three untouched regions; each untouched region must
        // be copied sample-for-sample. Ranges: [200,400)@2×, [600,800)@2×.
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        let src = write_test_wav("retime-cont-in", 1000, &samples);
        let dst = write_test_wav("retime-cont-out", 1000, &[]);
        retime_wav_samples(
            &src,
            &dst,
            &[
                SpeedRangeSamples { start_ms: 200, end_ms: 400, rate: 2.0 },
                SpeedRangeSamples { start_ms: 600, end_ms: 800, rate: 2.0 },
            ],
        )
        .unwrap();
        let got = read_test_wav_samples(&dst);
        // [0,200) verbatim = 200 samples; [200,400)@2× = 100; [400,600) verbatim
        // = 200; [600,800)@2× = 100; [800,1000) verbatim = 200. Total = 800.
        assert_eq!(got.len(), 800);
        // Leading region verbatim.
        assert_eq!(got[0], 0);
        assert_eq!(got[199], 199);
        // After the first sped span (200 + 100 = 300), the middle verbatim
        // region resumes at input sample 400.
        assert_eq!(got[300], 400);
        assert_eq!(got[499], 599);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_rejects_overlapping_ranges() {
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        let src = write_test_wav("retime-ovl-in", 1000, &samples);
        let dst = write_test_wav("retime-ovl-out", 1000, &[]);
        let err = retime_wav_samples(
            &src,
            &dst,
            &[
                SpeedRangeSamples { start_ms: 100, end_ms: 500, rate: 2.0 },
                SpeedRangeSamples { start_ms: 400, end_ms: 800, rate: 2.0 },
            ],
        )
        .unwrap_err();
        assert!(err.contains("overlap") || err.contains("sorted"), "got: {err}");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_rejects_unsorted_ranges() {
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        let src = write_test_wav("retime-uns-in", 1000, &samples);
        let dst = write_test_wav("retime-uns-out", 1000, &[]);
        let err = retime_wav_samples(
            &src,
            &dst,
            &[
                SpeedRangeSamples { start_ms: 600, end_ms: 800, rate: 2.0 },
                SpeedRangeSamples { start_ms: 100, end_ms: 300, rate: 2.0 },
            ],
        )
        .unwrap_err();
        assert!(err.contains("sorted") || err.contains("overlap"), "got: {err}");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_clamps_range_extending_past_data_end() {
        // 500 ms of audio (the video's nominal duration was longer, e.g. audio
        // track trimmed shorter than video — the exact scenario from the M3
        // desync finding). Range end 900ms exceeds the 500ms of actual audio
        // data → CLAMPED to 500ms and retiming still applies, rather than
        // rejected outright.
        let samples: Vec<i16> = (0..500).map(|i| i as i16).collect(); // 500 ms
        let src = write_test_wav("retime-past-in", 1000, &samples);
        let dst = write_test_wav("retime-past-out", 1000, &[]);
        retime_wav_samples(
            &src,
            &dst,
            &[SpeedRangeSamples { start_ms: 100, end_ms: 900, rate: 2.0 }],
        )
        .unwrap();
        let got = read_test_wav_samples(&dst);
        // Clamped range is [100,500) = 400 samples @2× → 200 output samples.
        // Leading verbatim region [0,100) = 100 samples. Total = 300.
        assert_eq!(got.len(), 300);
        assert_eq!(got[0], 0);
        assert_eq!(got[99], 99);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_drops_range_starting_at_or_past_data_end() {
        // A range that starts at/after the audio's actual end is dropped
        // entirely rather than rejected or clamped into a degenerate span.
        let samples: Vec<i16> = (0..500).map(|i| i as i16).collect(); // 500 ms
        let src = write_test_wav("retime-fullpast-in", 1000, &samples);
        let dst = write_test_wav("retime-fullpast-out", 1000, &[]);
        retime_wav_samples(
            &src,
            &dst,
            &[SpeedRangeSamples { start_ms: 500, end_ms: 900, rate: 2.0 }],
        )
        .unwrap();
        let got = read_test_wav_samples(&dst);
        // Range dropped entirely → verbatim copy of all 500 samples.
        assert_eq!(got, samples);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_clamp_then_remaining_ranges_still_applied() {
        // Two ranges: the first is fully valid, the second extends past the
        // data end and gets clamped. Both should still be applied. Simulate a
        // shorter audio track: only 700ms of real data.
        let samples: Vec<i16> = (0..700).map(|i| i as i16).collect();
        let src = write_test_wav("retime-clamp-multi-in", 1000, &samples);
        let dst = write_test_wav("retime-clamp-multi-out", 1000, &[]);
        retime_wav_samples(
            &src,
            &dst,
            &[
                SpeedRangeSamples { start_ms: 100, end_ms: 300, rate: 2.0 },
                SpeedRangeSamples { start_ms: 600, end_ms: 900, rate: 2.0 },
            ],
        )
        .unwrap();
        let got = read_test_wav_samples(&dst);
        // [0,100) verbatim=100; [100,300)@2x=100; [300,600) verbatim=300;
        // [600,700) clamped span @2x = 50 (100 samples/2). Total = 550.
        assert_eq!(got.len(), 550);
        assert_eq!(got[0], 0);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_overlap_surviving_clamp_still_rejected() {
        // Genuinely malformed input (overlapping ranges) must still be
        // rejected even after the past-data-end clamp runs — clamping only
        // fixes the "exceeds audio length" case, not overlap/sort violations.
        let samples: Vec<i16> = (0..500).map(|i| i as i16).collect(); // 500 ms
        let src = write_test_wav("retime-ovl-clamp-in", 1000, &samples);
        let dst = write_test_wav("retime-ovl-clamp-out", 1000, &[]);
        let err = retime_wav_samples(
            &src,
            &dst,
            &[
                // Both extend past the 500ms data end and get clamped to
                // end_ms=500, which makes them overlap/duplicate.
                SpeedRangeSamples { start_ms: 100, end_ms: 900, rate: 2.0 },
                SpeedRangeSamples { start_ms: 300, end_ms: 950, rate: 2.0 },
            ],
        )
        .unwrap_err();
        assert!(err.contains("overlap") || err.contains("sorted"), "got: {err}");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn retime_rejects_nonpositive_rate() {
        let samples: Vec<i16> = (0..500).map(|i| i as i16).collect();
        let src = write_test_wav("retime-rate-in", 1000, &samples);
        let dst = write_test_wav("retime-rate-out", 1000, &[]);
        let err = retime_wav_samples(
            &src,
            &dst,
            &[SpeedRangeSamples { start_ms: 100, end_ms: 300, rate: 0.0 }],
        )
        .unwrap_err();
        assert!(err.contains("rate"), "got: {err}");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    // ---- normalize_wav_loudness ------------------------------------------

    /// Peak absolute sample (as a fraction of full-scale) for a slice.
    fn peak_dbfs_frac(samples: &[i16]) -> f64 {
        samples
            .iter()
            .map(|&s| (s as f64).abs() / (i16::MAX as f64))
            .fold(0.0_f64, f64::max)
    }

    /// Un-gated full-signal RMS in dBFS, for asserting the post-normalization
    /// level lands near the target. Mirrors the measurement the DSP does but
    /// without the block gate (the test signals are constant-amplitude tones,
    /// so gating is a no-op on them).
    fn rms_dbfs(samples: &[i16]) -> f64 {
        if samples.is_empty() {
            return f64::NEG_INFINITY;
        }
        let sum_sq: f64 = samples
            .iter()
            .map(|&s| {
                let n = (s as f64) / (i16::MAX as f64);
                n * n
            })
            .sum();
        let rms = (sum_sq / samples.len() as f64).sqrt();
        20.0 * rms.max(1e-12).log10()
    }

    /// Build a full-scale-fraction sine tone: `secs` seconds at 48 kHz,
    /// amplitude `amp` (0..1 of full scale), 220 Hz.
    fn sine_48k(secs: f64, amp: f64) -> Vec<i16> {
        let sr = 48_000.0;
        let n = (secs * sr) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                let v = amp * (2.0 * std::f64::consts::PI * 220.0 * t).sin();
                (v * i16::MAX as f64).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
            })
            .collect()
    }

    #[test]
    fn normalize_silence_is_unchanged_and_no_gain_blowup() {
        // All-silence (or near-silence below the gate) must NOT be boosted:
        // every block is below the −40 dBFS gate, so there's no measurable
        // loudness → gain stays 1.0 and the samples pass through untouched.
        let samples: Vec<i16> = vec![0i16; 48_000]; // 1 s of digital silence
        let src = write_test_wav("norm-silence-in", 48_000, &samples);
        let dst = write_test_wav("norm-silence-out", 48_000, &[]);
        let report = normalize_wav_loudness(&src, &dst).unwrap();
        let got = read_test_wav_samples(&dst);
        assert_eq!(got, samples, "silence must be untouched");
        assert!(
            (report.gain - 1.0).abs() < 1e-9,
            "silence gain must be exactly 1.0 (no blow-up), got {}",
            report.gain
        );
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn normalize_quiet_speech_is_boosted_toward_target() {
        // A quiet tone should be boosted UP toward the −16 dBFS target: the
        // required gain must stay under the +12 dB (MAX_GAIN) clamp so it can
        // actually reach the target. amp 0.06 → RMS ≈ −27.4 dBFS, needing
        // ≈+11.4 dB (< clamp) to land at −16 dBFS.
        let samples = sine_48k(1.0, 0.06);
        let src = write_test_wav("norm-quiet-in", 48_000, &samples);
        let dst = write_test_wav("norm-quiet-out", 48_000, &[]);
        let report = normalize_wav_loudness(&src, &dst).unwrap();
        let got = read_test_wav_samples(&dst);
        assert!(report.gain > 1.5, "quiet input should be boosted, gain={}", report.gain);
        let out_rms = rms_dbfs(&got);
        assert!(
            (out_rms - (-16.0)).abs() < 1.5,
            "post-normalization RMS should land near −16 dBFS, got {out_rms}"
        );
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn normalize_hot_signal_is_attenuated() {
        // A hot tone (RMS well above −16 dBFS target) should be turned DOWN:
        // applied gain < 1 and the output RMS moves toward the target.
        let samples = sine_48k(1.0, 0.9); // amp 0.9 → RMS ≈ −4 dBFS (hot)
        let src = write_test_wav("norm-hot-in", 48_000, &samples);
        let dst = write_test_wav("norm-hot-out", 48_000, &[]);
        let report = normalize_wav_loudness(&src, &dst).unwrap();
        let got = read_test_wav_samples(&dst);
        assert!(report.gain < 1.0, "hot input should be attenuated, gain={}", report.gain);
        let in_rms = rms_dbfs(&samples);
        let out_rms = rms_dbfs(&got);
        assert!(out_rms < in_rms, "hot output RMS ({out_rms}) should be lower than input ({in_rms})");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn normalize_peaks_never_exceed_ceiling() {
        // A plain low-amplitude sine has a crest factor (peak/RMS) of only
        // √2 ≈ 1.414. Even after the full ×4 (MAX_GAIN) boost, its post-gain
        // peak stays well under the −1 dBFS ceiling (≈0.891 of full scale),
        // so the soft-knee limiter branch never actually runs here — it's the
        // MAX_GAIN clamp alone that keeps this particular signal under the
        // ceiling, not the limiter. See
        // `normalize_limiter_engages_on_high_crest_transient` below for a
        // signal that genuinely drives the limiter.
        let samples = sine_48k(1.0, 0.03);
        let src = write_test_wav("norm-ceil-in", 48_000, &samples);
        let dst = write_test_wav("norm-ceil-out", 48_000, &[]);
        normalize_wav_loudness(&src, &dst).unwrap();
        let got = read_test_wav_samples(&dst);
        let peak = peak_dbfs_frac(&got);
        // −1 dBFS ceiling as a fraction of full scale, plus a tiny epsilon for
        // i16 rounding.
        let ceiling = 10.0_f64.powf(-1.0 / 20.0);
        assert!(
            peak <= ceiling + 1e-3,
            "output peak {peak} exceeded the −1 dBFS ceiling {ceiling}"
        );
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn normalize_limiter_engages_on_high_crest_transient() {
        // The soft-knee limiter only engages when the POST-GAIN signal's peak
        // exceeds the −1 dBFS ceiling, which requires a crest factor (peak /
        // RMS) above ≈5.62 (ceiling / MAX_GAIN-headroom math). A pure sine
        // (crest 1.414) can never trip it — see the comment on
        // `normalize_peaks_never_exceed_ceiling`. This test builds a
        // genuinely high-crest-factor signal instead: a quiet speech-like
        // sine bed (amp 0.02, well under the gate's boost threshold) with
        // periodic near-full-scale transient spikes (amp 0.98) punched in
        // every 100 ms. The gated-RMS measure is dominated by the quiet bed
        // (the sparse spikes barely move it), so the clip still earns the
        // full ×4 MAX_GAIN boost — driving the spikes' post-gain magnitude to
        // ~3.92, far past the ~0.891 ceiling. That forces the limiter branch
        // to actually run (`report.limited == true`), and every output
        // sample must still land within i16 range (the limiter's documented
        // contract keeps it in `(ceiling, 1.0)` of full scale — see the
        // soft-knee comment in `normalize_samples`).
        let sr = 48_000usize;
        let secs = 1.0;
        let n = (secs * sr as f64) as usize;
        let base_amp = 0.02;
        let spike_amp = 0.98;
        let spike_width = 4; // samples
        let spike_period = 4_800; // every 100 ms
        let mut samples: Vec<i16> = (0..n)
            .map(|i| {
                let t = i as f64 / sr as f64;
                let v = base_amp * (2.0 * std::f64::consts::PI * 220.0 * t).sin();
                (v * i16::MAX as f64).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
            })
            .collect();
        let mut start = 0usize;
        while start < n {
            for k in 0..spike_width {
                let idx = start + k;
                if idx >= n {
                    break;
                }
                let v = if k % 2 == 0 { spike_amp } else { -spike_amp };
                samples[idx] = (v * i16::MAX as f64).round() as i16;
            }
            start += spike_period;
        }

        let src = write_test_wav("norm-limiter-in", 48_000, &samples);
        let dst = write_test_wav("norm-limiter-out", 48_000, &[]);
        let report = normalize_wav_loudness(&src, &dst).unwrap();
        let got = read_test_wav_samples(&dst);

        assert!(
            report.limited,
            "high-crest-factor transient should have engaged the soft-knee limiter"
        );
        // Every output sample must stay within i16 full-scale bounds — the
        // limiter's documented guarantee (soft knee compresses asymptotically
        // toward, but never past, full scale).
        let peak = peak_dbfs_frac(&got);
        assert!(
            peak <= 1.0 + 1e-6,
            "output peak {peak} exceeded full scale despite the limiter"
        );

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn normalize_unity_gain_round_trips_i16() {
        // A signal already AT the target with peaks below the ceiling should
        // pass through with (near-)unity gain and no limiting, so the i16
        // round-trip is essentially lossless — a sanity check that the DSP
        // isn't corrupting samples when there's nothing to do. Amp 0.224 →
        // RMS = 0.224/√2 ≈ 0.158 ≈ −16 dBFS (the target), peak 0.224 (well
        // under the −1 dBFS ≈ 0.891 ceiling).
        let samples = sine_48k(1.0, 0.224);
        let src = write_test_wav("norm-unity-in", 48_000, &samples);
        let dst = write_test_wav("norm-unity-out", 48_000, &[]);
        let report = normalize_wav_loudness(&src, &dst).unwrap();
        let got = read_test_wav_samples(&dst);
        assert!(
            (report.gain - 1.0).abs() < 0.15,
            "signal already at target should get ~unity gain, got {}",
            report.gain
        );
        assert_eq!(got.len(), samples.len(), "sample count must be preserved");
        // Per-sample deviation stays tiny (near-unity gain + i16 quantization).
        let max_dev = samples
            .iter()
            .zip(got.iter())
            .map(|(&a, &b)| (a as i32 - b as i32).abs())
            .max()
            .unwrap_or(0);
        assert!(max_dev <= 16, "round-trip drift too large: {max_dev}");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }
}
