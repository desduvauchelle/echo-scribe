# Recording Transcript — Design

**Date:** 2026-05-22
**Status:** Approved (pending spec review)
**Feature:** On-demand transcript generation for screen recordings, cached in the DB.

## Goal

Add a "Generate transcript" button to the Recordings detail pane. Clicking it
transcribes the recording's audio with the existing Parakeet pipeline and stores
the result. On return visits the cached transcript renders immediately — no
regeneration.

This is the first of two related audio features. The second (audio cleanup /
denoise via DeepFilterNet) is a separate spec, deferred.

## Decisions (locked during brainstorming)

- **Trigger:** manual button only. No auto-on-finish, no background job.
- **Format:** single plain-text block + Copy button. No timestamped/clickable
  segments.
- **Audio extraction:** Approach A — the existing Swift sidecar
  (`echo-scribe-screenrec`) gains an `extract-audio` mode using AVAssetReader.
  Native AAC decode → 16kHz mono WAV → existing `AsrPipeline::transcribe_file`.
  Rejected: pure-Rust symphonia decode (new heavy dep, AAC edge cases);
  record-time WAV (wastes disk, ignores existing recordings, contradicts
  on-demand).
- **Long recordings:** chunk samples into ~60s windows internally, concatenate
  text. Bounds memory and enables a progress %. Invisible to the user.

## Architecture / Data Flow

```
[Generate transcript] click (RecordingsView detail pane)
  → invoke transcribe_recording(id)
     → look up recording.file_path (mp4)
     → sidecar: echo-scribe-screenrec extract-audio --in <mp4> --out <tmp.wav>  (16kHz mono int16)
     → AsrPipeline: chunk wav samples ~60s windows, transcribe each, concat → text
        (emit `transcribe-progress` {id, pct} per chunk)
     → db: UPDATE recordings SET transcript = text WHERE id
     → delete tmp.wav
     → return text
  → UI shows text block + Copy button; cached → reload skips regeneration
```

## Components

### 1. Swift sidecar — `extract-audio` subcommand
File: `src-tauri/screenrec/main.swift`

New subcommand alongside `record` / `--list-sources`:
`extract-audio --in <mp4> --out <wav>`.

- Open `AVAsset(url: mp4)`. If it has no audio track → emit
  `{"event":"error","kind":"no_audio","msg":"..."}` to stderr, exit nonzero.
- `AVAssetReader` + `AVAssetReaderAudioMixOutput` (or
  `AVAssetReaderTrackOutput`) with output settings:
  `AVFormatIDKey: kAudioFormatLinearPCM`, `AVSampleRateKey: 16000`,
  `AVNumberOfChannelsKey: 1`, `AVLinearPCMBitDepthKey: 16`,
  `AVLinearPCMIsFloatKey: false`, interleaved.
- Drain sample buffers, accumulate PCM int16, write a canonical 44-byte WAV
  header + data so Rust `load_wav_16k_mono_int16` parses it (PCM fmt=1,
  channels=1, rate=16000, bits=16).
- On success emit `{"event":"done","path":"<wav>","samples":N}` to stderr,
  exit 0.
- Errors emit `{"event":"error","kind":"...","msg":"..."}`, exit nonzero.

### 2. Rust — sidecar invocation
File: `src-tauri/src/screenrec/mod.rs`

```rust
/// Extract the recording's audio track to a temporary 16kHz mono WAV.
/// Returns the temp wav path (caller deletes). Err if no audio track.
pub fn extract_audio(app: &AppHandle, mp4: &Path) -> Result<PathBuf, ScreenrecError>;
```

- Resolve the sidecar binary the same way `record` does.
- Output wav in the app cache dir: `<cache>/transcribe/<recording-id>.wav`
  (or a tempfile).
- Spawn, wait, parse last stderr JSON line. Map `kind=no_audio` to a typed
  error variant the command can translate to "Recording has no audio".

### 3. Rust — chunked transcription
File: `src-tauri/src/asr/pipeline.rs`

```rust
/// Transcribe arbitrary-length 16kHz mono samples by windowing into
/// ~`WINDOW_SECS`-second chunks, transcribing each, and joining with spaces.
/// Calls `progress(pct)` after each chunk (0..=100).
pub async fn transcribe_long(
    &self,
    samples: Vec<f32>,
    from_rate: u32,
    channels: u16,
    progress: impl Fn(u8) + Send + 'static,
) -> Result<String, AsrError>;
```

- `const WINDOW_SECS: usize = 60;` window length in samples = `WINDOW_SECS * from_rate * channels`.
- Split `samples` into consecutive windows (last window may be short).
- For each window call existing `self.transcribe(window, from_rate, channels)`.
- Concatenate non-empty results with a single space; trim.
- `progress((done * 100 / total) as u8)` after each window.
- The pure chunk-boundary math is factored into a small testable helper:
  `fn window_ranges(len: usize, window: usize) -> Vec<(usize, usize)>`.

### 4. DB
Files: `src-tauri/src/db/schema.rs`, `src-tauri/src/db/recordings.rs`

- Migration `(15, "ALTER TABLE recordings ADD COLUMN transcript TEXT;")`.
- Bump the two schema-version test asserts `14` → `15`.
- `RecordingRow`: add `pub transcript: Option<String>,` (after `title`).
- `insert`, `list`, `get` SELECT/INSERT column lists + `row_to_recording` updated.
- New fn:
  ```rust
  pub fn set_transcript(conn: &Connection, id: &str, transcript: &str) -> Result<(), DbError> {
      conn.execute("UPDATE recordings SET transcript = ?1 WHERE id = ?2", params![transcript, id])?;
      Ok(())
  }
  ```
- `sample()` test helper: add `transcript: None,`.

### 5. Command
Files: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

```rust
#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String>;
```

- `require_db`; load the `RecordingRow` by id (404 → error).
- `extract_audio(&app, &mp4)` → wav path.
- `load_wav_16k_mono_int16(wav)` → samples/rate/channels.
- `asr.transcribe_long(samples, rate, channels, |pct| emit "transcribe-progress" {id, pct})`.
- `set_transcript(conn, id, &text)`.
- Delete temp wav (success and error paths).
- Return text. Insert builder for new recordings sets `transcript: None`.
- Register `transcribe_recording` in lib.rs macro list + invoke_handler.

### 6. Frontend
Files: `src/lib/api.ts`, `src/views/sections/RecordingsView.tsx`

- `api.ts`: add `transcript: string | null;` to `RecordingRow`;
  `export const transcribeRecording = (id: string): Promise<string> =>
   invoke("transcribe_recording", { id });`
- `RecordingsView.tsx` detail pane, below the video:
  - `selected.transcript` present → heading "Transcript", text block
    (`whitespace-pre-wrap`), Copy button.
  - else → "Generate transcript" button.
  - While running: `busy` disables button, show spinner + `pct`%
    (listen `transcribe-progress`, filter by `id`).
  - On success: `refresh()` so the cached transcript loads from DB.
  - Errors → existing `error` banner.
  - Empty transcript → show "No speech detected" + allow re-generate.

## Error Handling / Edge Cases

| Case | Behavior |
|------|----------|
| Video-only (no audio track) | sidecar `kind=no_audio` → command Err "Recording has no audio"; nothing stored |
| Model not downloaded | `AsrError::NotDownloaded` → "Download a transcription model first" (existing model-download UX) |
| Sidecar crash / nonzero exit | parse stderr, return error string; temp wav cleaned |
| Empty transcript (silence) | store empty; UI "No speech detected"; re-generate allowed |
| Concurrent clicks | button disabled while `busy`; one job at a time |
| mp4 missing on disk | file-not-found error surfaced |
| Temp wav | app cache dir; deleted after transcribe (success or fail) |

## Testing

**Rust unit:**
- Migration v15 adds `transcript` column; schema-version assert is 15.
- `recordings.rs` round-trip: insert → `set_transcript` → `get` returns text.
- `window_ranges(len, window)` boundary math: exact multiple, remainder,
  len < window, len == 0.

**Manual (no model in CI):**
- Recording with speech → Generate → text appears; persists across reselect and
  app reload.
- Video-only recording → graceful "no audio" error.
- Long recording (>2 min) → progress % advances; full text returned.

## Out of Scope (deferred)

- Audio cleanup / denoise (DeepFilterNet) — separate spec.
- Timestamped/clickable transcript segments.
- Auto-transcribe on recording finish.
- Transcript search / export.
```
