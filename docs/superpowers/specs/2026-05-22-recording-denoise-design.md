# Recording Audio Denoise — Design

**Date:** 2026-05-22
**Status:** Approved (pending spec review)
**Feature:** On-demand audio cleanup (noise removal / voice clarity) for screen recordings, producing a cleaned MP4.

## Goal

Add a "Clean up audio" button to the Recordings detail pane. Clicking it runs the
recording's audio through DeepFilterNet, muxes the cleaned audio back into a new
MP4, and lets the user toggle Original/Cleaned playback. This is the second of the
two audio features (the first, on-demand transcripts, shipped separately).

## Decisions (locked during brainstorming)

- **Output:** a cleaned MP4 (new file), original video track preserved, audio
  replaced with the denoised track.
- **Original handling:** keep BOTH during testing, gated by a compile-time
  constant `DELETE_ORIGINAL_AFTER_DENOISE` (default `false`). When flipped to
  `true` later, a successful denoise deletes the original and keeps only the
  cleaned file.
- **Trigger:** manual button, same pattern as the transcript feature.
- **Denoiser:** DeepFilterNet via the `deep_filter` Rust crate with its
  `default-model` feature — the model weights are EMBEDDED in the crate
  (`DfParams::default()`), so there is no separate model download or bundling
  step. Pure Rust (tract), CPU, 48kHz. Verified: `DfTract::process(noisy:
  ArrayView2<f32>, enh: ArrayViewMut2<f32>) -> Result<f32>` operates frame by
  frame (`hop_size` samples per channel). Rejected: RNNoise (weaker), download
  model on first use (unnecessary — weights are embedded).
- **Channels:** downmix to 48kHz MONO for denoise; cleaned track muxed as mono.
  Voice clarity is the goal and the model is mono — simplest, good quality.
- **Mux:** Swift sidecar `echo-scribe-screenrec` gains a `mux-audio` mode using
  AVMutableComposition + AVAssetExportSession. Rejected: ffmpeg (distribution
  weight), consistent with the transcript feature's extraction decision.
- **Audio extraction:** reuse the transcript feature's sidecar `extract-audio`
  mode, adding a `--rate <hz>` parameter (default 16000) so denoise can request
  48000.

## Architecture / Data Flow

```
[Clean up audio] click (RecordingsView detail pane)
  → invoke denoise_recording(id)
     → look up recording.file_path (orig mp4); error if missing
     → sidecar: extract-audio --in <orig.mp4> --out <tmp48.wav> --rate 48000   (48kHz mono)
     → Rust DeepFilterNet: DfTract (embedded model), process in hop_size frames
        → cleaned 48kHz mono → write <clean48.wav>   (emit `denoise-progress` {id, pct})
     → sidecar: mux-audio --video <orig.mp4> --audio <clean48.wav> --out <clean.mp4>
        (AVMutableComposition: orig video track + cleaned audio → export new mp4)
     → verify <clean.mp4> exists and is non-trivial
     → db: set denoised_path = <clean.mp4>
     → if DELETE_ORIGINAL_AFTER_DENOISE: rm orig, db set file_path=<clean.mp4>, denoised_path=NULL
     → rm temp wavs (all paths)
     → return
  → UI: video player gains Original/Cleaned toggle (swaps convertFileSrc src); cached
```

Ordering guarantee: the original file is deleted (when the flag is on) only AFTER
the mux output is verified to exist and the DB is updated, so there is never a
moment where both files are gone.

## Components

### 1. Cargo dependency
File: `src-tauri/Cargo.toml`
- Add `deep_filter` with the embedded-model + tract features (exact feature
  names confirmed at implementation; expected `default-model` and `tract`). This
  transitively pulls `ndarray`. Confirm the build links and the binary size
  increase (~embedded model) is acceptable.

### 2. Denoise module
File: `src-tauri/src/denoise/mod.rs` (new)
```rust
pub fn denoise_wav(
    in_48k_mono: &Path,
    out_48k_mono: &Path,
    progress: impl Fn(u8),
) -> Result<(), DenoiseError>;
```
- Read the input 48kHz mono WAV into `Vec<f32>` (reuse the WAV reader logic from
  `asr::pipeline::load_wav_16k_mono_int16`, generalized — it already parses rate
  / channels / 16-bit PCM; factor a shared `read_wav_pcm16(path) -> (Vec<f32>,
  rate, channels)` if clean to do so, otherwise a local reader).
- Build `DfTract` from `DfParams::default()` + `RuntimeParams::new(1, ...)`.
- Read `hop_size` from the model; process the samples in `hop_size`-sample
  frames. For each frame: copy into an `Array2<f32>` shaped `[1, hop_size]`
  (zero-pad the final partial frame), call `process`, append the enhanced
  `hop_size` samples to the output buffer. Truncate output to the original sample
  count.
- Write the output as a 48kHz mono 16-bit PCM WAV (same canonical header writer
  the Swift side uses; in Rust, write RIFF/WAVE/fmt(PCM,1ch,48000,16)/data).
- `progress(pct)` = `frames_done * 100 / total_frames`.
- `DenoiseError` enum: `Io`, `Wav`, `Model`, `Process`.

Pure frame-chunking math (`window_ranges(len, hop)` already exists in
`asr::pipeline`; either reuse via a shared helper or replicate a tiny local
`frame_ranges`) gets a unit test.

### 3. Swift sidecar
File: `src-tauri/screenrec/main.swift`
- **`extract-audio`**: add `--rate <hz>` arg (default 16000). Use it for
  `AVSampleRateKey`. All existing transcript calls (no `--rate`) keep 16000.
- **`mux-audio --video <mp4> --audio <wav> --out <mp4>`** (new subcommand):
  - `AVMutableComposition`. Insert the video track from the original asset
    (full time range) into a composition video track. Insert the audio from the
    cleaned WAV asset into a composition audio track.
  - Export with `AVAssetExportSession` (preset `AVAssetExportPresetPassthrough`
    for video if compatible; otherwise `...HighestQuality`), `outputFileType
    .mp4`, to the `--out` path.
  - Emit `{"event":"done","path":<out>}` on success, `{"event":"error",...}`
    nonzero exit on failure, matching the existing `emit`/`emitError` helpers.

### 4. Rust screenrec wrappers
File: `src-tauri/src/screenrec/mod.rs`
- Generalize extraction: `extract_audio_at(mp4, out_wav, rate: u32)`; keep
  `extract_audio(mp4, out_wav)` calling it with `16000` (transcript path
  unchanged).
- `mux_audio(video: &Path, audio: &Path, out: &Path) -> Result<(), String>` —
  spawns the sidecar `mux-audio` mode, parses stderr for the structured error
  kind on failure (mirrors `extract_audio`).

### 5. DB
Files: `src-tauri/src/db/schema.rs`, `src-tauri/src/db/recordings.rs`
- Migration `(16, "ALTER TABLE recordings ADD COLUMN denoised_path TEXT;")`.
- Bump the two schema-version test asserts `15` → `16`.
- `RecordingRow`: add `pub denoised_path: Option<String>,` (after `transcript`).
- Update `insert` (column list + `?19` placeholder + param), `list`/`get`
  SELECTs, `row_to_recording` (`denoised_path: row.get(18)?`).
- `pub fn set_denoised_path(conn, id, path: Option<&str>)` — sets/clears the
  column.
- `pub fn promote_denoised(conn, id, cleaned_path: &str)` — sets `file_path =
  cleaned_path, denoised_path = NULL` (used when the delete-original flag is on).
- `sample()` test helper: add `denoised_path: None,`.
- The recording insert builder in `commands.rs` sets `denoised_path: None,`.

### 6. Command
Files: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
```rust
/// Compile-time switch: once denoise is trusted, set true to delete the
/// original and keep only the cleaned file.
const DELETE_ORIGINAL_AFTER_DENOISE: bool = false;

#[tauri::command]
pub async fn denoise_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String>;
```
- Look up the mp4 (drop the `&Db` borrow before any `.await`, same scoping rule
  the transcript command uses).
- Extract 48kHz mono WAV (spawn_blocking → `extract_audio_at(.., 48000)`); map
  `no_audio` → "Recording has no audio".
- `spawn_blocking` → `denoise::denoise_wav(tmp48, clean48, |pct| emit
  "denoise-progress" {id,pct})`.
- `mux_audio(orig, clean48, clean_mp4)`.
- Verify `clean_mp4` exists + size > 0.
- DB `set_denoised_path(id, Some(clean_mp4))`.
- If `DELETE_ORIGINAL_AFTER_DENOISE`: remove the original file, then
  `promote_denoised(id, clean_mp4)`.
- Remove temp WAVs on every path (success and error). On any error before the DB
  write, also remove a partial `clean_mp4`.
- Register `denoise_recording` in lib.rs (macro list + invoke_handler).

Naming: cleaned mp4 lives next to the original, e.g.
`<recordings_dir>/<id>.cleaned.mp4`; temp wavs `<id>.dn-src.wav` /
`<id>.dn-out.wav`.

### 7. Frontend
Files: `src/lib/api.ts`, `src/views/sections/RecordingsView.tsx`
- `api.ts`: add `denoised_path: string | null;` to `RecordingRow`;
  `export const denoiseRecording = (id: string): Promise<void> =>
   invoke("denoise_recording", { id });`
- `RecordingsView.tsx`:
  - "Clean up audio" button in the actions area. While running: disabled +
    `Cleaning… {pct}%` (listen `denoise-progress`, filter by id). On success:
    `refresh()`.
  - If `denoised_path` is set: show an Original / Cleaned toggle above the
    `<video>`; the `<video src>` uses `convertFileSrc(file_path)` for Original or
    `convertFileSrc(denoised_path)` for Cleaned. Default to Cleaned.
  - If already denoised, the button reads "Re-clean audio" (re-run overwrites).
  - Reset the per-recording progress + toggle state on selection change.

## Error Handling / Edge Cases

| Case | Behavior |
|------|----------|
| No audio track | `extract-audio` `no_audio` → "Recording has no audio"; nothing changed |
| Already denoised | button "Re-clean audio"; re-run overwrites cleaned file |
| DeepFilterNet load/process fail | `DenoiseError` → user string; temp wavs removed; original untouched |
| Mux/export fail | sidecar error parsed → Err; cleaned wav + partial mp4 removed; original untouched |
| mp4 missing on disk | "recording file is missing on disk" before any work |
| Concurrent clicks | button disabled while busy; one job at a time |
| Crash mid-run with flag on | original deleted only AFTER mux verified + DB updated; no both-gone window |
| Temp wavs | recordings dir; removed on all paths |

## Testing

**Rust unit:**
- Migration v16 adds `denoised_path`; schema-version assert is 16.
- `recordings.rs` round-trip: insert → `set_denoised_path(Some)` → `get` returns
  it → `promote_denoised` sets `file_path` and clears `denoised_path`.
- Frame-chunk math (`window_ranges`/`frame_ranges`): exact hop multiple,
  remainder (final partial frame zero-padded), zero length.

**Manual (no model run / AVFoundation in CI):**
- Noisy recording → Clean up audio → progress advances → Cleaned plays clearer;
  Original/Cleaned toggle swaps audio.
- Flip `DELETE_ORIGINAL_AFTER_DENOISE = true`, rebuild → denoise → original file
  gone, only cleaned remains, no toggle shown.
- Video-only recording → "Recording has no audio".
- Re-clean an already-cleaned recording → overwrites, still plays.

## Out of Scope (deferred)

- Stereo denoise (mono only for now).
- Denoise feeding the transcript pipeline for better accuracy (possible later;
  the two features are independent today).
- Export presets / Drive upload (separate phases).
- Adjustable denoise strength / noise-profile selection.

## Build / TCC Notes

- Touches `Cargo.toml` (new crate). Does NOT touch Info.plist / entitlements /
  capabilities, so the **skip-TCC** reinstall applies (per project CLAUDE.md).
- The Swift sidecar must be rebuilt (`bash scripts/build-screenrec.sh`) for the
  `extract-audio --rate` and `mux-audio` changes.
```
