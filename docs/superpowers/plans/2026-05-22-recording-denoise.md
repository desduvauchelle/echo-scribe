# Recording Audio Denoise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand "Clean up audio" button to the Recordings detail pane that denoises a recording's audio (RNNoise / `nnnoiseless`), muxes the cleaned audio back into a new MP4, and lets the user toggle Original/Cleaned playback.

**Architecture:** A new Rust `denoise` module runs `nnnoiseless` over 48kHz mono PCM. The Swift sidecar gains a `--rate` option on `extract-audio` and a new `mux-audio` mode (AVMutableComposition). A new async command chains extract(48k) → denoise → mux → DB, gated by a compile-time `DELETE_ORIGINAL_AFTER_DENOISE` flag. The React detail pane gets a button (with progress) and an Original/Cleaned video toggle.

**Tech Stack:** Rust (Tauri v2, rusqlite, tokio, `nnnoiseless`), Swift (AVFoundation), React/TypeScript.

Spec: `docs/superpowers/specs/2026-05-22-recording-denoise-design.md`

**RNNoise sample convention (critical):** `nnnoiseless` samples are `f32` in the i16 range (−32768..=32767), NOT normalized −1..1. Read PCM16 → cast `i16` to `f32` as-is; clamp+round to `i16` on write.

---

## File Structure

- `src-tauri/Cargo.toml` — add `nnnoiseless` dep.
- `src-tauri/src/denoise/mod.rs` — new module: `denoise_wav` + private `frame_ranges` (+ unit test).
- `src-tauri/src/lib.rs` — `mod denoise;` declaration; register `denoise_recording` command (two lists).
- `src-tauri/src/db/schema.rs` — migration v16; bump asserts to 16.
- `src-tauri/src/db/recordings.rs` — `denoised_path` field; queries; `set_denoised_path`; `promote_denoised`; tests.
- `src-tauri/screenrec/main.swift` — `extract-audio --rate`; new `mux-audio` mode.
- `src-tauri/src/screenrec/mod.rs` — `extract_audio_at(rate)`; `mux_audio`.
- `src-tauri/src/commands.rs` — `denoise_recording` + `DELETE_ORIGINAL_AFTER_DENOISE`; `denoised_path: None` in insert builder.
- `src/lib/api.ts` — `denoised_path` field; `denoiseRecording`.
- `src/views/sections/RecordingsView.tsx` — button, progress, Original/Cleaned toggle.

---

## Task 1: `nnnoiseless` dep + denoise module

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/denoise/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod denoise;`)

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:
```toml
# RNNoise audio denoiser (pure Rust, embedded model). default-features off to
# drop the bin feature's clap/hound/dasp CLI deps.
nnnoiseless = { version = "0.5", default-features = false }
```

- [ ] **Step 2: Create the module with a failing test for `frame_ranges`**

Create `src-tauri/src/denoise/mod.rs`:
```rust
//! On-demand audio denoising for screen recordings using RNNoise
//! (`nnnoiseless`). Operates on 48kHz mono 16-bit PCM WAV files.
//!
//! RNNoise convention: samples are f32 in the i16 range (−32768..=32767), NOT
//! normalized to −1..1.

use std::io::{Read, Write};
use std::path::Path;

use nnnoiseless::{DenoiseState, FRAME_SIZE};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DenoiseError {
    #[error("io: {0}")]
    Io(String),
    #[error("wav: {0}")]
    Wav(String),
}

/// Split `len` samples into consecutive `[start, end)` frames of at most
/// `frame` samples. The final frame may be short. Empty when `len == 0`.
fn frame_ranges(len: usize, frame: usize) -> Vec<(usize, usize)> {
    if len == 0 || frame == 0 {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + frame).min(len);
        ranges.push((start, end));
        start = end;
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_ranges_splits_correctly() {
        assert_eq!(frame_ranges(960, 480), vec![(0, 480), (480, 960)]);
        assert_eq!(frame_ranges(1000, 480), vec![(0, 480), (480, 960), (960, 1000)]);
        assert_eq!(frame_ranges(200, 480), vec![(0, 200)]);
        assert_eq!(frame_ranges(0, 480), Vec::<(usize, usize)>::new());
    }
}
```

- [ ] **Step 3: Declare the module**

In `src-tauri/src/lib.rs`, add `mod denoise;` alongside the other top-level `mod` declarations (e.g. near `mod asr;` / `mod screenrec;`).

- [ ] **Step 4: Run the failing test**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri && cargo test --lib frame_ranges`
Expected: PASS (the helper is implemented). If `nnnoiseless` fails to resolve, fix the dep line first. (We write the test + helper together here; the TDD signal is that `cargo test` compiles the new module + dep cleanly.)

- [ ] **Step 5: Implement the WAV reader, writer, and `denoise_wav`**

Append to `src-tauri/src/denoise/mod.rs` (above the `#[cfg(test)]` module):
```rust
/// Read a 16-bit PCM WAV into f32 samples kept in the i16 range. Returns
/// (samples, sample_rate, channels).
fn read_wav_pcm16(path: &Path) -> Result<(Vec<f32>, u32, u16), DenoiseError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| DenoiseError::Io(e.to_string()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(DenoiseError::Wav("not a WAV file".into()));
    }
    let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
    let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    let bits = u16::from_le_bytes(bytes[34..36].try_into().unwrap());
    if bits != 16 {
        return Err(DenoiseError::Wav(format!("expected 16-bit PCM, got {bits}")));
    }
    // Find the `data` chunk.
    let mut pos = 12;
    let (data_off, data_len) = loop {
        if pos + 8 > bytes.len() {
            return Err(DenoiseError::Wav("no data chunk".into()));
        }
        let id = &bytes[pos..pos + 4];
        let sz = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            break (pos + 8, sz.min(bytes.len() - (pos + 8)));
        }
        pos += 8 + sz + (sz & 1);
    };
    let samples = bytes[data_off..data_off + data_len]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32)
        .collect();
    Ok((samples, sample_rate, channels))
}

/// Write f32 samples (in i16 range) as a 48kHz mono 16-bit PCM WAV.
fn write_wav_pcm16_mono_48k(path: &Path, samples: &[f32]) -> Result<(), DenoiseError> {
    let sample_rate: u32 = 48_000;
    let channels: u16 = 1;
    let bits: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits / 8) as u32;
    let block_align = channels * (bits / 8);
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = s.clamp(-32768.0, 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::File::create(path)
        .and_then(|mut f| f.write_all(&out))
        .map_err(|e| DenoiseError::Io(e.to_string()))
}

/// Denoise a 48kHz mono 16-bit PCM WAV with RNNoise, writing a cleaned WAV.
/// `progress(pct)` is called with 0..=100 as frames are processed.
pub fn denoise_wav(
    in_48k_mono: &Path,
    out_48k_mono: &Path,
    progress: impl Fn(u8),
) -> Result<(), DenoiseError> {
    let (samples, _rate, _channels) = read_wav_pcm16(in_48k_mono)?;
    let ranges = frame_ranges(samples.len(), FRAME_SIZE);
    let total = ranges.len();
    let mut state = DenoiseState::new();
    let mut out: Vec<f32> = Vec::with_capacity(samples.len());
    let mut in_frame = [0.0f32; FRAME_SIZE];
    let mut out_frame = [0.0f32; FRAME_SIZE];
    for (i, (start, end)) in ranges.into_iter().enumerate() {
        let n = end - start;
        in_frame[..n].copy_from_slice(&samples[start..end]);
        for v in in_frame[n..].iter_mut() {
            *v = 0.0; // zero-pad the final partial frame
        }
        state.process_frame(&mut out_frame, &in_frame);
        out.extend_from_slice(&out_frame[..n]); // truncate padding back off
        if total > 0 {
            progress(((i + 1) * 100 / total) as u8);
        }
    }
    write_wav_pcm16_mono_48k(out_48k_mono, &out)
}
```

- [ ] **Step 6: Build + test**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri && cargo build --lib && cargo test --lib frame_ranges`
Expected: clean build (a `dead_code` warning for `denoise_wav` until a later task calls it is acceptable — do NOT add `#[allow]`); `frame_ranges` test passes.

- [ ] **Step 7: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/denoise/mod.rs src-tauri/src/lib.rs
git commit -m "feat(denoise): nnnoiseless wav denoise module + frame_ranges"
```

---

## Task 2: DB column `denoised_path`

**Files:**
- Modify: `src-tauri/src/db/schema.rs` (migration + asserts)
- Modify: `src-tauri/src/db/recordings.rs` (struct, queries, fns, tests)
- Modify: `src-tauri/src/commands.rs` (insert builder — required for compile)

- [ ] **Step 1: Add migration v16**

In `src-tauri/src/db/schema.rs`, after the v15 (`transcript`) migration tuple in `MIGRATIONS`, add:
```rust
    (
        16,
        r#"
ALTER TABLE recordings ADD COLUMN denoised_path TEXT;
"#,
    ),
```

- [ ] **Step 2: Bump the two version asserts**

In `schema.rs`, change the assert at ~line 316 and ~line 437 from `"15"` to `"16"`:
```rust
        assert_eq!(v, "16");
```
```rust
        assert_eq!(version, "16");
```

- [ ] **Step 3: Add the field to `RecordingRow`**

In `src-tauri/src/db/recordings.rs`, after the `transcript` field:
```rust
    /// Path to the denoised MP4 (separate file). `None` until cleaned.
    pub denoised_path: Option<String>,
```

- [ ] **Step 4: Update `insert`**

Add `denoised_path` to the column list, a `?19` placeholder, and `r.denoised_path,` to `params!` after `r.transcript,`:
```rust
        "INSERT INTO recordings (
            id, created_at, file_path, duration_ms, width, height, size_bytes,
            source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
            drive_link, upload_status, upload_error, exports, title, transcript,
            denoised_path
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
```
…and add `r.denoised_path,` after `r.transcript,` in the `params!` block.

- [ ] **Step 5: Update `list` and `get` SELECTs**

Append `, denoised_path` to the end of the column list (after `transcript`) in both `list` and `get`.

- [ ] **Step 6: Update `row_to_recording`**

After `transcript: row.get(17)?,` add:
```rust
        denoised_path: row.get(18)?,
```

- [ ] **Step 7: Add `set_denoised_path` and `promote_denoised`**

After `set_transcript` in `recordings.rs`:
```rust
/// Set or clear the denoised-file path for a recording.
pub fn set_denoised_path(conn: &Connection, id: &str, path: Option<&str>) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET denoised_path = ?1 WHERE id = ?2",
        params![path, id],
    )?;
    Ok(())
}

/// Promote the cleaned file to be the recording's primary file and clear the
/// denoised marker. Used when the original is deleted after denoise.
pub fn promote_denoised(conn: &Connection, id: &str, cleaned_path: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET file_path = ?1, denoised_path = NULL WHERE id = ?2",
        params![cleaned_path, id],
    )?;
    Ok(())
}
```

- [ ] **Step 8: Update the `sample()` test helper**

After `transcript: None,` in `sample()`:
```rust
            denoised_path: None,
```

- [ ] **Step 9: Add tests**

In the `tests` module of `recordings.rs`:
```rust
    #[test]
    fn set_and_promote_denoised() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().denoised_path, None);

        set_denoised_path(&conn, "rec-1", Some("/tmp/rec-1.cleaned.mp4")).unwrap();
        assert_eq!(
            get(&conn, "rec-1").unwrap().unwrap().denoised_path.as_deref(),
            Some("/tmp/rec-1.cleaned.mp4")
        );

        promote_denoised(&conn, "rec-1", "/tmp/rec-1.cleaned.mp4").unwrap();
        let row = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(row.file_path, "/tmp/rec-1.cleaned.mp4");
        assert_eq!(row.denoised_path, None);

        set_denoised_path(&conn, "rec-1", None).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().denoised_path, None);
    }
```

- [ ] **Step 10: Fix the insert builder in commands.rs (compile requirement)**

Adding the field breaks the `RecordingRow` initializer in `src-tauri/src/commands.rs` (the one that already sets `transcript: None,`). Add directly after it:
```rust
        denoised_path: None,
```
(Without this the crate does not compile and tests can't run.)

- [ ] **Step 11: Build + test**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri && cargo test --lib recordings && cargo test --lib schema`
Expected: all pass, including `set_and_promote_denoised` and the migration/version tests.

- [ ] **Step 12: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/src/db/schema.rs src-tauri/src/db/recordings.rs src-tauri/src/commands.rs
git commit -m "feat(db): add recordings.denoised_path + set/promote helpers"
```

---

## Task 3: Swift sidecar — `extract-audio --rate` + `mux-audio`

**Files:**
- Modify: `src-tauri/screenrec/main.swift`

No Rust unit test; verify by Swift build + manual run. Follow the file's existing `emit(...)` / `emitError(kind:msg:)` conventions and exit-code style.

- [ ] **Step 1: Add a `--rate` parameter to `extractAudio`**

Change the function signature and the two hardcoded `16000` uses. Replace the current `func extractAudio(inPath: String, outPath: String) {` and its body's sample-rate constants:

Signature →
```swift
func extractAudio(inPath: String, outPath: String, rate: Int) {
```
In `settings`, change `AVSampleRateKey: 16000,` →
```swift
        AVSampleRateKey: rate,
```
And the header constant `let sampleRate: UInt32 = 16000` →
```swift
    let sampleRate: UInt32 = UInt32(rate)
```

- [ ] **Step 2: Parse `--rate` in the dispatch block**

In the `extract-audio` dispatch block (currently parsing `--in`/`--out`), add a `--rate` option defaulting to 16000, and pass it through. Replace the block body:
```swift
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "extract-audio" {
    var inPath: String?
    var outPath: String?
    var rate = 16000
    let a = CommandLine.arguments
    var i = 2
    while i < a.count {
        if a[i] == "--in", i + 1 < a.count { inPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { outPath = a[i + 1]; i += 1 }
        else if a[i] == "--rate", i + 1 < a.count { rate = Int(a[i + 1]) ?? 16000; i += 1 }
        i += 1
    }
    guard let inPath, let outPath else {
        emitError(kind: "args", msg: "extract-audio requires --in and --out")
        exit(2)
    }
    extractAudio(inPath: inPath, outPath: outPath, rate: rate)
}
```
(Match the existing loop variable names if they differ; the key additions are `var rate` + the `--rate` branch + passing `rate:`.)

- [ ] **Step 3: Add the `mux-audio` function**

Add near `extractAudio` (uses AVMutableComposition to combine the original video track with the cleaned audio, then exports a new mp4):
```swift
// --- mode: `mux-audio --video <mp4> --audio <wav> --out <mp4>` ---
func muxAudio(videoPath: String, audioPath: String, outPath: String) {
    let videoAsset = AVAsset(url: URL(fileURLWithPath: videoPath))
    let audioAsset = AVAsset(url: URL(fileURLWithPath: audioPath))
    guard let vTrack = videoAsset.tracks(withMediaType: .video).first else {
        emitError(kind: "no_video", msg: "no video track in source")
        exit(3)
    }
    guard let aTrack = audioAsset.tracks(withMediaType: .audio).first else {
        emitError(kind: "no_audio", msg: "no audio track in cleaned wav")
        exit(3)
    }

    let comp = AVMutableComposition()
    guard let cv = comp.addMutableTrack(withMediaType: .video,
                                        preferredTrackID: kCMPersistentTrackID_Invalid),
          let ca = comp.addMutableTrack(withMediaType: .audio,
                                        preferredTrackID: kCMPersistentTrackID_Invalid) else {
        emitError(kind: "compose", msg: "failed to add composition tracks")
        exit(4)
    }
    let vRange = CMTimeRange(start: .zero, duration: videoAsset.duration)
    do {
        try cv.insertTimeRange(vRange, of: vTrack, at: .zero)
        cv.preferredTransform = vTrack.preferredTransform
        let aDur = min(audioAsset.duration, videoAsset.duration)
        try ca.insertTimeRange(CMTimeRange(start: .zero, duration: aDur), of: aTrack, at: .zero)
    } catch {
        emitError(kind: "compose", msg: "\(error)")
        exit(4)
    }

    try? FileManager.default.removeItem(at: URL(fileURLWithPath: outPath))
    guard let export = AVAssetExportSession(asset: comp,
                                            presetName: AVAssetExportPresetHighestQuality) else {
        emitError(kind: "export", msg: "could not create export session")
        exit(5)
    }
    export.outputURL = URL(fileURLWithPath: outPath)
    export.outputFileType = .mp4
    let sem = DispatchSemaphore(value: 0)
    export.exportAsynchronously { sem.signal() }
    sem.wait()
    if export.status == .completed {
        emit(["event": "done", "path": outPath])
        exit(0)
    } else {
        emitError(kind: "export", msg: "\(String(describing: export.error))")
        exit(5)
    }
}
```

- [ ] **Step 4: Dispatch `mux-audio`**

Add a dispatch block next to the `extract-audio` one:
```swift
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "mux-audio" {
    var videoPath: String?
    var audioPath: String?
    var outPath: String?
    let a = CommandLine.arguments
    var i = 2
    while i < a.count {
        if a[i] == "--video", i + 1 < a.count { videoPath = a[i + 1]; i += 1 }
        else if a[i] == "--audio", i + 1 < a.count { audioPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { outPath = a[i + 1]; i += 1 }
        i += 1
    }
    guard let videoPath, let audioPath, let outPath else {
        emitError(kind: "args", msg: "mux-audio requires --video --audio --out")
        exit(2)
    }
    muxAudio(videoPath: videoPath, audioPath: audioPath, outPath: outPath)
}
```

- [ ] **Step 5: Build the sidecar**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bash scripts/build-screenrec.sh`
Expected: builds without errors; updates `src-tauri/binaries/echo-scribe-screenrec-<triple>`.

- [ ] **Step 6: Manual round-trip check (48k extract → mux)**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
BIN=$(ls src-tauri/binaries/echo-scribe-screenrec-* | head -1)
MP4=$(ls -t "$HOME/Library/Application Support/EchoScribe/recordings/"*.mp4 2>/dev/null | head -1)
echo "MP4=$MP4"
"$BIN" extract-audio --in "$MP4" --out /tmp/dn48.wav --rate 48000; echo "extract exit=$?"
xxd /tmp/dn48.wav | head -2     # expect RIFF/WAVE; sample rate 0x80BB (48000) at offset 24
"$BIN" mux-audio --video "$MP4" --audio /tmp/dn48.wav --out /tmp/dn-mux.mp4; echo "mux exit=$?"
ls -la /tmp/dn-mux.mp4
```
Expected: both print `{"event":"done",...}`, exit 0; `/tmp/dn-mux.mp4` exists and plays (it will sound the same as the original here — denoise happens in Rust, this only checks extract@48k + mux). If the only recording has no audio, note it.

- [ ] **Step 7: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/screenrec/main.swift src-tauri/binaries/echo-scribe-screenrec-*
git commit -m "feat(screenrec): extract-audio --rate + mux-audio mode"
```

---

## Task 4: Rust screenrec wrappers

**Files:**
- Modify: `src-tauri/src/screenrec/mod.rs`

- [ ] **Step 1: Generalize extraction to take a rate**

In `src-tauri/src/screenrec/mod.rs`, replace the existing `pub fn extract_audio(mp4, out_wav)` with a rate-aware variant plus a back-compat wrapper. Find the current function (starts ~line 63) and change it to:
```rust
/// Extract a recording's audio track to a mono WAV at `out_wav`, resampled to
/// `rate` Hz. Err `"no_audio"` means the recording has no audio track.
pub fn extract_audio_at(mp4: &std::path::Path, out_wav: &std::path::Path, rate: u32) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("extract-audio")
        .arg("--in").arg(mp4)
        .arg("--out").arg(out_wav)
        .arg("--rate").arg(rate.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
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
    Err(format!("audio extraction failed (exit {:?})", out.status.code()))
}

/// Back-compat: extract at 16kHz (used by the transcript pipeline).
pub fn extract_audio(mp4: &std::path::Path, out_wav: &std::path::Path) -> Result<(), String> {
    extract_audio_at(mp4, out_wav, 16_000)
}
```

- [ ] **Step 2: Add `mux_audio`**

After `extract_audio`, add:
```rust
/// Mux a cleaned audio WAV into the original video, writing a new mp4.
pub fn mux_audio(video: &std::path::Path, audio: &std::path::Path, out: &std::path::Path) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let res = Command::new(&bin)
        .arg("mux-audio")
        .arg("--video").arg(video)
        .arg("--audio").arg(audio)
        .arg("--out").arg(out)
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
```

- [ ] **Step 3: Build**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri && cargo build --lib`
Expected: clean build. `extract_audio` callers (transcript command) still compile unchanged. `dead_code` on `extract_audio_at`/`mux_audio` until the next task is acceptable.

- [ ] **Step 4: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/src/screenrec/mod.rs
git commit -m "feat(screenrec): extract_audio_at(rate) + mux_audio wrappers"
```

---

## Task 5: `denoise_recording` command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command + flag**

Add to `src-tauri/src/commands.rs` (near `transcribe_recording`):
```rust
/// Compile-time switch: while denoise is being validated we keep the original
/// file and expose an Original/Cleaned toggle. Set to `true` to delete the
/// original after a successful denoise and keep only the cleaned file.
const DELETE_ORIGINAL_AFTER_DENOISE: bool = false;

/// Denoise a recording's audio and mux it into a new cleaned MP4.
/// Emits `denoise-progress` events `{ id, pct }` while running.
#[tauri::command]
pub async fn denoise_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // Look up the original mp4 path; drop the DB borrow before any await.
    let orig: std::path::PathBuf = {
        let db = require_db(&state)?;
        let row = db
            .with_conn(|c| crate::db::recordings::get(c, &id))
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "recording not found".to_string())?;
        std::path::PathBuf::from(row.file_path)
    };
    if !orig.exists() {
        return Err("recording file is missing on disk".into());
    }

    let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
    let src_wav = dir.join(format!("{id}.dn-src.wav"));
    let out_wav = dir.join(format!("{id}.dn-out.wav"));
    let clean_mp4 = dir.join(format!("{id}.cleaned.mp4"));

    let cleanup = |extra: Option<&std::path::Path>| {
        let _ = std::fs::remove_file(&src_wav);
        let _ = std::fs::remove_file(&out_wav);
        if let Some(p) = extra {
            let _ = std::fs::remove_file(p);
        }
    };

    // 1. Extract 48kHz mono audio.
    let orig_c = orig.clone();
    let src_wav_c = src_wav.clone();
    let extract = tokio::task::spawn_blocking(move || {
        crate::screenrec::extract_audio_at(&orig_c, &src_wav_c, 48_000)
    })
    .await
    .map_err(|_| "extraction task panicked".to_string())?;
    if let Err(e) = extract {
        cleanup(None);
        if e == "no_audio" {
            return Err("Recording has no audio".into());
        }
        return Err(e);
    }

    // 2. Denoise (progress emitted per frame batch).
    let app_p = app.clone();
    let id_p = id.clone();
    let src_wav_c = src_wav.clone();
    let out_wav_c = out_wav.clone();
    let denoise = tokio::task::spawn_blocking(move || {
        crate::denoise::denoise_wav(&src_wav_c, &out_wav_c, move |pct| {
            let _ = app_p.emit("denoise-progress", serde_json::json!({ "id": id_p, "pct": pct }));
        })
    })
    .await
    .map_err(|_| "denoise task panicked".to_string())?;
    if let Err(e) = denoise {
        cleanup(None);
        return Err(e.to_string());
    }

    // 3. Mux cleaned audio + original video → new mp4.
    let orig_c = orig.clone();
    let out_wav_c = out_wav.clone();
    let clean_mp4_c = clean_mp4.clone();
    let mux = tokio::task::spawn_blocking(move || {
        crate::screenrec::mux_audio(&orig_c, &out_wav_c, &clean_mp4_c)
    })
    .await
    .map_err(|_| "mux task panicked".to_string())?;
    if let Err(e) = mux {
        cleanup(Some(&clean_mp4));
        return Err(e);
    }

    // 4. Verify output before any DB / destructive step.
    match std::fs::metadata(&clean_mp4) {
        Ok(m) if m.len() > 0 => {}
        _ => {
            cleanup(Some(&clean_mp4));
            return Err("denoise produced an empty file".into());
        }
    }

    let clean_str = clean_mp4.to_string_lossy().to_string();

    // 5. Record the cleaned path.
    {
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::set_denoised_path(c, &id, Some(&clean_str)))
            .map_err(|e| e.to_string())?;
    }

    // 6. Optionally drop the original and promote the cleaned file.
    if DELETE_ORIGINAL_AFTER_DENOISE {
        let _ = std::fs::remove_file(&orig);
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::promote_denoised(c, &id, &clean_str))
            .map_err(|e| e.to_string())?;
    }

    cleanup(None); // remove temp wavs; keep clean_mp4
    Ok(())
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, add `denoise_recording,` after `transcribe_recording,` in BOTH the macro export list and the `invoke_handler!` list.

- [ ] **Step 3: Build**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri && cargo build --lib`
Expected: clean build; the earlier `dead_code` warnings for `denoise_wav` / `extract_audio_at` / `mux_audio` are gone.

- [ ] **Step 4: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): denoise_recording command + delete-original flag"
```

---

## Task 6: Frontend — API + UI

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/views/sections/RecordingsView.tsx`

- [ ] **Step 1: API binding**

In `src/lib/api.ts`, add to `RecordingRow` after `transcript`:
```ts
  denoised_path: string | null;
```
And near `transcribeRecording`:
```ts
export const denoiseRecording = (id: string): Promise<void> =>
  invoke("denoise_recording", { id });
```

- [ ] **Step 2: Imports + state**

In `src/views/sections/RecordingsView.tsx`, add `denoiseRecording` to the `../../lib/api` import. Add state near the other hooks:
```tsx
  const [denoising, setDenoising] = useState(false);
  const [denoiseProgress, setDenoiseProgress] = useState(0);
  const [showCleaned, setShowCleaned] = useState(true);
```

- [ ] **Step 3: Progress listener**

Add an effect alongside the existing listeners:
```tsx
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("denoise-progress", (e) => {
      if (selected && e.payload.id === selected.id) setDenoiseProgress(e.payload.pct);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [selected]);
```

- [ ] **Step 4: Reset toggle/progress on selection change**

In the list-row `onClick` (the one that does `setSelected(r); setRenaming(false); setProgress(0);`), also add:
```tsx
                  setDenoiseProgress(0);
                  setShowCleaned(true);
```

- [ ] **Step 5: Denoise handler**

Add near `onTranscribe`:
```tsx
  const onDenoise = useCallback(async () => {
    if (!selected) return;
    setDenoising(true);
    setDenoiseProgress(0);
    setError(null);
    try {
      await denoiseRecording(selected.id);
      await refresh();
      setShowCleaned(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setDenoising(false);
    }
  }, [selected, refresh]);
```

- [ ] **Step 6: Original/Cleaned toggle above the video**

Replace the existing `<video … />` element. The current element is:
```tsx
              <video
                key={selected.id}
                src={convertFileSrc(selected.file_path)}
                controls
                className="w-full rounded-lg bg-black"
              />
```
Replace with:
```tsx
              {selected.denoised_path ? (
                <div className="mb-2 inline-flex overflow-hidden rounded-md border border-line text-[12px]">
                  <button
                    onClick={() => setShowCleaned(false)}
                    className={`px-3 py-1 ${!showCleaned ? "bg-surface font-medium" : ""}`}
                  >
                    Original
                  </button>
                  <button
                    onClick={() => setShowCleaned(true)}
                    className={`px-3 py-1 ${showCleaned ? "bg-surface font-medium" : ""}`}
                  >
                    Cleaned
                  </button>
                </div>
              ) : null}
              <video
                key={`${selected.id}-${showCleaned && selected.denoised_path ? "clean" : "orig"}`}
                src={convertFileSrc(
                  showCleaned && selected.denoised_path
                    ? selected.denoised_path
                    : selected.file_path,
                )}
                controls
                className="w-full rounded-lg bg-black"
              />
```

- [ ] **Step 7: "Clean up audio" button in the actions row**

In the `<div className="mt-4 flex gap-2">` action row (with Reveal/Delete), add another button:
```tsx
                <button
                  onClick={() => void onDenoise()}
                  disabled={denoising}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
                >
                  {denoising
                    ? `Cleaning… ${denoiseProgress}%`
                    : selected.denoised_path
                      ? "Re-clean audio"
                      : "Clean up audio"}
                </button>
```

- [ ] **Step 8: Typecheck**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bunx tsc --noEmit -p tsconfig.json`
Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src/lib/api.ts src/views/sections/RecordingsView.tsx
git commit -m "feat(ui): clean up audio button + Original/Cleaned toggle"
```

---

## Task 7: Full build + manual verification

**Files:** none (build + manual QA)

- [ ] **Step 1: Build the app bundle**

Run: `cd /Users/denisduvauchelle/Documents/code/echo-scribe && bun tauri build --bundles app`
Expected: build succeeds; `.app` under `src-tauri/target/release/bundle/macos/`.

- [ ] **Step 2: Reinstall (skip-TCC — no permission code changed)**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "/Users/denisduvauchelle/Documents/code/echo-scribe/src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 3: Manual checks**

  - Noisy recording → "Clean up audio" → progress % climbs → on finish an Original/Cleaned toggle appears above the video; Cleaned plays with reduced background noise. Switch toggle → audio source changes. Reselect / relaunch → cleaned persists (toggle still there).
  - Button now reads "Re-clean audio"; clicking re-runs and overwrites.
  - Video-only recording → "Recording has no audio" error; no toggle.

- [ ] **Step 4: Verify the delete-original flag**

  - Edit `src-tauri/src/commands.rs`: set `const DELETE_ORIGINAL_AFTER_DENOISE: bool = true;`
  - Rebuild + reinstall (Steps 1–2). On a fresh recording, click Clean up audio. Expected: after success, the original mp4 is gone from `~/Library/Application Support/EchoScribe/recordings/`, only `<id>.cleaned.mp4` remains, the player shows no toggle (plays the cleaned file as `file_path`).
  - Revert the flag back to `false` for now (keep originals during testing) unless you decide otherwise. Commit whichever final value you choose:
```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/src/commands.rs
git commit -m "chore(denoise): set DELETE_ORIGINAL_AFTER_DENOISE final value"
```

---

## Notes for the executor

- TCC: no Info.plist / entitlements / capabilities / TCC-dep changes → use the **skip-TCC** reinstall (per project CLAUDE.md).
- The Swift sidecar MUST be rebuilt (`bash scripts/build-screenrec.sh`) for Task 3; the binary artifact is committed.
- RNNoise sample scaling is the most likely correctness pitfall: samples stay in the i16 range end-to-end (read i16→f32 as-is, clamp+round on write). Do not normalize to ±1.
- Rust tests: `cd src-tauri && cargo test --lib`. The Swift sidecar, RNNoise audio quality, and AVFoundation mux are verified manually (no model run / AVFoundation in CI).
- Column index reference: exports=15, title=16, transcript=17, denoised_path=18; insert placeholder `?19`.
```
