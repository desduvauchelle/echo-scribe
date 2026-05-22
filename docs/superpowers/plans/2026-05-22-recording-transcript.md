# Recording Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand "Generate transcript" button to the Recordings detail pane that transcribes a recording's audio with the existing Parakeet pipeline and caches the result in the DB.

**Architecture:** A new `extract-audio` mode in the Swift `echo-scribe-screenrec` sidecar decodes the recording's mp4 audio track to a 16kHz mono WAV (native AVAssetReader). A new async Tauri command extracts that WAV, transcribes it in ~60s windows via the existing `AsrPipeline`, stores the text in a new `recordings.transcript` column, and returns it. The React detail pane shows a Generate button (with progress %) or the cached transcript + Copy.

**Tech Stack:** Rust (Tauri v2, rusqlite, tokio), Swift (AVFoundation), React/TypeScript, Parakeet ONNX via transcribe-rs.

Spec: `docs/superpowers/specs/2026-05-22-recording-transcript-design.md`

---

## File Structure

- `src-tauri/src/db/schema.rs` — add migration v15; bump version asserts to `15`.
- `src-tauri/src/db/recordings.rs` — `transcript` field on `RecordingRow`; queries; `set_transcript()`; tests.
- `src-tauri/src/asr/pipeline.rs` — `window_ranges()` helper + `transcribe_long()` chunked method; `window_ranges` unit test.
- `src-tauri/screenrec/main.swift` — new `extract-audio --in <mp4> --out <wav>` subcommand.
- `src-tauri/src/screenrec/mod.rs` — `extract_audio()` Rust wrapper that spawns the sidecar.
- `src-tauri/src/commands.rs` — `transcribe_recording` command; set `transcript: None` in the recording insert builder.
- `src-tauri/src/lib.rs` — register `transcribe_recording`.
- `src/lib/api.ts` — `transcript` field on `RecordingRow`; `transcribeRecording()`.
- `src/views/sections/RecordingsView.tsx` — transcript UI (Generate button + progress + cached block + Copy).

---

## Task 1: DB column + `set_transcript`

**Files:**
- Modify: `src-tauri/src/db/schema.rs` (migration list + two asserts)
- Modify: `src-tauri/src/db/recordings.rs` (struct, queries, new fn, tests)

- [ ] **Step 1: Add the migration**

In `src-tauri/src/db/schema.rs`, find the v14 migration entry (the `ALTER TABLE recordings ADD COLUMN title TEXT;` at line ~246). Add a v15 entry immediately after that tuple in the `MIGRATIONS` array:

```rust
    (
        15,
        r#"
ALTER TABLE recordings ADD COLUMN transcript TEXT;
"#,
    ),
```

- [ ] **Step 2: Bump the schema-version asserts**

In `src-tauri/src/db/schema.rs` there are two asserts that currently expect `"14"` (lines ~310 and ~431). Change both:

```rust
        assert_eq!(v, "15");
```
```rust
        assert_eq!(version, "15");
```

- [ ] **Step 3: Add `transcript` to `RecordingRow`**

In `src-tauri/src/db/recordings.rs`, in the `RecordingRow` struct, add after the `title` field:

```rust
    /// Cached plain-text transcript; `None` until generated on demand.
    pub transcript: Option<String>,
```

- [ ] **Step 4: Update `insert`**

In `insert`, add `transcript` to the column list and a `?18` placeholder, and add `r.transcript,` to the `params!` block after `r.title,`:

```rust
    conn.execute(
        "INSERT INTO recordings (
            id, created_at, file_path, duration_ms, width, height, size_bytes,
            source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
            drive_link, upload_status, upload_error, exports, title, transcript
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            r.id,
            r.created_at,
            r.file_path,
            r.duration_ms,
            r.width,
            r.height,
            r.size_bytes,
            r.source_label,
            r.has_mic as i64,
            r.has_sysaudio as i64,
            r.thumb_path,
            r.drive_file_id,
            r.drive_link,
            r.upload_status,
            r.upload_error,
            r.exports,
            r.title,
            r.transcript,
        ],
    )?;
```

- [ ] **Step 5: Update `list` and `get` SELECTs**

In both `list` and `get`, append `, transcript` to the end of the selected column list (after `title`):

```rust
        "SELECT id, created_at, file_path, duration_ms, width, height, size_bytes,
                source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
                drive_link, upload_status, upload_error, exports, title, transcript
         FROM recordings ...",
```

- [ ] **Step 6: Update `row_to_recording`**

Add after `title: row.get(16)?,`:

```rust
        transcript: row.get(17)?,
```

- [ ] **Step 7: Add `set_transcript`**

After the `rename` fn in `src-tauri/src/db/recordings.rs`:

```rust
/// Store the generated transcript text for a recording.
pub fn set_transcript(conn: &Connection, id: &str, transcript: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET transcript = ?1 WHERE id = ?2",
        params![transcript, id],
    )?;
    Ok(())
}
```

- [ ] **Step 8: Update the `sample()` test helper**

In the `tests` module `sample()`, add after `title: None,`:

```rust
            transcript: None,
```

- [ ] **Step 9: Write the failing test**

Add to the `tests` module in `src-tauri/src/db/recordings.rs`:

```rust
    #[test]
    fn set_transcript_round_trip() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        assert_eq!(get(&conn, "rec-1").unwrap().unwrap().transcript, None);

        set_transcript(&conn, "rec-1", "hello world").unwrap();
        assert_eq!(
            get(&conn, "rec-1").unwrap().unwrap().transcript.as_deref(),
            Some("hello world")
        );
    }
```

- [ ] **Step 10: Run tests**

Run: `cd src-tauri && cargo test --lib recordings && cargo test --lib schema`
Expected: all pass, including `set_transcript_round_trip` and the migration/version tests.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/db/schema.rs src-tauri/src/db/recordings.rs
git commit -m "feat(db): add recordings.transcript column + set_transcript"
```

---

## Task 2: Chunked transcription (`window_ranges` + `transcribe_long`)

**Files:**
- Modify: `src-tauri/src/asr/pipeline.rs` (new helper + method + test)

- [ ] **Step 1: Write the failing test for `window_ranges`**

Add to the `tests` module in `src-tauri/src/asr/pipeline.rs` (if no `tests` module exists, create one at the bottom: `#[cfg(test)] mod tests { use super::*;`):

```rust
    #[test]
    fn window_ranges_splits_correctly() {
        // exact multiple
        assert_eq!(window_ranges(10, 5), vec![(0, 5), (5, 10)]);
        // remainder: last window short
        assert_eq!(window_ranges(12, 5), vec![(0, 5), (5, 10), (10, 12)]);
        // len < window: single full-length window
        assert_eq!(window_ranges(3, 5), vec![(0, 3)]);
        // empty
        assert_eq!(window_ranges(0, 5), Vec::<(usize, usize)>::new());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test --lib window_ranges`
Expected: FAIL — `cannot find function window_ranges`.

- [ ] **Step 3: Implement `window_ranges`**

Add near the top of `impl AsrPipeline` block's file (module-level free fn, above or below the `impl`):

```rust
/// Split a buffer of `len` samples into consecutive `[start, end)` windows of
/// at most `window` samples each. The final window may be shorter. Returns an
/// empty vec when `len == 0`.
fn window_ranges(len: usize, window: usize) -> Vec<(usize, usize)> {
    if len == 0 || window == 0 {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + window).min(len);
        ranges.push((start, end));
        start = end;
    }
    ranges
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd src-tauri && cargo test --lib window_ranges`
Expected: PASS.

- [ ] **Step 5: Implement `transcribe_long`**

Add a new method inside `impl AsrPipeline` (after `transcribe_file`):

```rust
    /// Transcribe arbitrary-length audio by windowing the samples into
    /// ~60-second chunks, transcribing each via [`Self::transcribe`], and
    /// joining the non-empty results with single spaces. Calls `progress(pct)`
    /// with 0..=100 after each chunk completes.
    pub async fn transcribe_long(
        &self,
        samples: Vec<f32>,
        from_rate: u32,
        channels: u16,
        progress: impl Fn(u8) + Send + 'static,
    ) -> Result<String, AsrError> {
        const WINDOW_SECS: usize = 60;
        let window = WINDOW_SECS * from_rate as usize * channels.max(1) as usize;
        let ranges = window_ranges(samples.len(), window);
        if ranges.is_empty() {
            return Ok(String::new());
        }
        let total = ranges.len();
        let mut parts: Vec<String> = Vec::with_capacity(total);
        for (i, (start, end)) in ranges.into_iter().enumerate() {
            let chunk = samples[start..end].to_vec();
            let text = self.transcribe(chunk, from_rate, channels).await?;
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
            let pct = ((i + 1) * 100 / total) as u8;
            progress(pct);
        }
        Ok(parts.join(" "))
    }
```

- [ ] **Step 6: Verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: builds clean (no model needed; `transcribe_long` isn't exercised by a unit test).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/asr/pipeline.rs
git commit -m "feat(asr): chunked transcribe_long + window_ranges helper"
```

---

## Task 3: Swift sidecar `extract-audio` mode

**Files:**
- Modify: `src-tauri/screenrec/main.swift` (new subcommand)

This task has no Rust unit test — verification is `cargo`/Swift build + a manual run. Follow the existing event/exit conventions in the file (stderr line-delimited JSON, nonzero exit on error).

- [ ] **Step 1: Add subcommand dispatch**

Find where the top-level args are dispatched (the block that handles `record` and `--list-sources`). Add a branch for `extract-audio`. Mirror the existing arg-parsing style:

```swift
// extract-audio --in <mp4> --out <wav>
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "extract-audio" {
    var inPath: String?
    var outPath: String?
    var i = 2
    let a = CommandLine.arguments
    while i < a.count {
        if a[i] == "--in", i + 1 < a.count { inPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { outPath = a[i + 1]; i += 1 }
        i += 1
    }
    guard let inPath, let outPath else {
        emitError(kind: "args", msg: "extract-audio requires --in and --out")
        exit(2)
    }
    extractAudio(inPath: inPath, outPath: outPath)  // calls exit() itself
}
```

If the file already has an `emitError(kind:msg:)` helper, reuse it. If not, add this near the other event helpers:

```swift
func emitError(kind: String, msg: String) {
    let obj: [String: Any] = ["event": "error", "kind": kind, "msg": msg]
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}
```

- [ ] **Step 2: Implement `extractAudio`**

Add this function (uses AVAssetReader to decode the audio track to 16kHz mono PCM int16, then writes a canonical 44-byte WAV header + data):

```swift
import AVFoundation

func extractAudio(inPath: String, outPath: String) {
    let url = URL(fileURLWithPath: inPath)
    let asset = AVAsset(url: url)
    guard let track = asset.tracks(withMediaType: .audio).first else {
        emitError(kind: "no_audio", msg: "recording has no audio track")
        exit(3)
    }

    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) }
    catch { emitError(kind: "reader", msg: "\(error)"); exit(4) }

    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
        emitError(kind: "reader", msg: "cannot add audio output")
        exit(4)
    }
    reader.add(output)

    var pcm = Data()
    guard reader.startReading() else {
        emitError(kind: "reader", msg: "startReading failed: \(String(describing: reader.error))")
        exit(4)
    }
    while reader.status == .reading {
        guard let sample = output.copyNextSampleBuffer(),
              let block = CMSampleBufferGetDataBuffer(sample) else { continue }
        let length = CMBlockBufferGetDataLength(block)
        var bytes = [UInt8](repeating: 0, count: length)
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes)
        pcm.append(contentsOf: bytes)
        CMSampleBufferInvalidate(sample)
    }
    if reader.status == .failed {
        emitError(kind: "reader", msg: "read failed: \(String(describing: reader.error))")
        exit(4)
    }

    // Build a 44-byte canonical PCM WAV header (mono, 16kHz, 16-bit).
    let sampleRate: UInt32 = 16000
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
    let blockAlign = channels * (bitsPerSample / 8)
    let dataLen = UInt32(pcm.count)
    var header = Data()
    func append32(_ v: UInt32) { var x = v.littleEndian; header.append(Data(bytes: &x, count: 4)) }
    func append16(_ v: UInt16) { var x = v.littleEndian; header.append(Data(bytes: &x, count: 2)) }
    header.append("RIFF".data(using: .ascii)!)
    append32(36 + dataLen)
    header.append("WAVE".data(using: .ascii)!)
    header.append("fmt ".data(using: .ascii)!)
    append32(16)            // PCM fmt chunk size
    append16(1)             // audio format = PCM
    append16(channels)
    append32(sampleRate)
    append32(byteRate)
    append16(blockAlign)
    append16(bitsPerSample)
    header.append("data".data(using: .ascii)!)
    append32(dataLen)

    var file = header
    file.append(pcm)
    do {
        try file.write(to: URL(fileURLWithPath: outPath))
    } catch {
        emitError(kind: "write", msg: "\(error)")
        exit(5)
    }

    let samples = Int(dataLen) / 2
    let obj: [String: Any] = ["event": "done", "path": outPath, "samples": samples]
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
    exit(0)
}
```

- [ ] **Step 3: Build the sidecar**

Run: `bash scripts/build-screenrec.sh`
Expected: builds without errors; produces the `echo-scribe-screenrec-<triple>` binary in `src-tauri/binaries/`.

- [ ] **Step 4: Manually verify against a real recording**

Pick an existing recording mp4 (under `~/Library/Application Support/EchoScribe/recordings/`) and run:

```bash
BIN=$(ls src-tauri/binaries/echo-scribe-screenrec-* | head -1)
MP4=$(ls -t "$HOME/Library/Application Support/EchoScribe/recordings/"*.mp4 | head -1)
"$BIN" extract-audio --in "$MP4" --out /tmp/extract-test.wav
ls -la /tmp/extract-test.wav
```

Expected: stderr prints `{"event":"done","path":"/tmp/extract-test.wav","samples":N}` and the WAV file exists and is non-trivial in size (for a recording with audio). For a video-only recording, expect `{"event":"error","kind":"no_audio",...}` and nonzero exit.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/screenrec/main.swift src-tauri/binaries/echo-scribe-screenrec-*
git commit -m "feat(screenrec): extract-audio mode (mp4 -> 16kHz mono WAV)"
```

---

## Task 4: Rust `extract_audio` wrapper

**Files:**
- Modify: `src-tauri/src/screenrec/mod.rs` (new fn + error mapping)

- [ ] **Step 1: Add the `extract_audio` function**

In `src-tauri/src/screenrec/mod.rs`, add after `list_sources` (it can use the private `resolve_binary`). It runs the sidecar synchronously and parses the last stderr JSON line:

```rust
/// Extract a recording's audio track to a 16kHz mono WAV at `out_wav`.
/// Returns `Ok(())` on success. Err string is user-facing; the special
/// message "no_audio" is returned when the recording has no audio track so the
/// caller can show a friendly message.
pub fn extract_audio(mp4: &std::path::Path, out_wav: &std::path::Path) -> Result<(), String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin)
        .arg("extract-audio")
        .arg("--in")
        .arg(mp4)
        .arg("--out")
        .arg(out_wav)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        return Ok(());
    }

    // Inspect stderr for the structured error kind.
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/screenrec/mod.rs
git commit -m "feat(screenrec): extract_audio() rust wrapper around sidecar"
```

---

## Task 5: `transcribe_recording` command

**Files:**
- Modify: `src-tauri/src/commands.rs` (new command + insert builder)
- Modify: `src-tauri/src/lib.rs` (register command)

- [ ] **Step 1: Set `transcript: None` in the recording insert builder**

In `src-tauri/src/commands.rs`, find where a `RecordingRow` is constructed when a recording is saved (the builder that sets `title: None,`). Add:

```rust
        transcript: None,
```

- [ ] **Step 2: Add the command**

Add to `src-tauri/src/commands.rs` (near `rename_recording`). Note the careful scoping so no `&Db` borrow is held across an `.await`:

```rust
/// Transcribe a recording's audio on demand and cache the result in the DB.
/// Emits `transcribe-progress` events `{ id, pct }` while running.
#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    // Look up the mp4 path, dropping the DB borrow before any await.
    let mp4: std::path::PathBuf = {
        let db = require_db(&state)?;
        let row = db
            .with_conn(|c| crate::db::recordings::get(c, &id))
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "recording not found".to_string())?;
        std::path::PathBuf::from(row.file_path)
    };
    if !mp4.exists() {
        return Err("recording file is missing on disk".into());
    }

    // Require a downloaded ASR model up front for a clear message.
    if !state.asr.ready() {
        return Err("Download a transcription model first".into());
    }

    // Extract audio to a temp WAV in the recordings dir.
    let wav = crate::screenrec::recordings_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{id}.transcribe.wav"));
    let mp4_for_blocking = mp4.clone();
    let wav_for_blocking = wav.clone();
    let extract = tokio::task::spawn_blocking(move || {
        crate::screenrec::extract_audio(&mp4_for_blocking, &wav_for_blocking)
    })
    .await
    .map_err(|_| "extraction task panicked".to_string())?;
    if let Err(e) = extract {
        let _ = std::fs::remove_file(&wav);
        if e == "no_audio" {
            return Err("Recording has no audio".into());
        }
        return Err(e);
    }

    // Load + transcribe in ~60s windows, emitting progress.
    let (samples, rate, channels) = match AsrPipeline::load_wav_16k_mono_int16(&wav) {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::remove_file(&wav);
            return Err(e.to_string());
        }
    };
    let asr = std::sync::Arc::clone(&state.asr);
    let app_for_progress = app.clone();
    let id_for_progress = id.clone();
    let text = asr
        .transcribe_long(samples, rate, channels, move |pct| {
            let _ = app_for_progress.emit(
                "transcribe-progress",
                serde_json::json!({ "id": id_for_progress, "pct": pct }),
            );
        })
        .await
        .map_err(|e| e.to_string());

    // Always clean up the temp WAV.
    let _ = std::fs::remove_file(&wav);
    let text = text?;

    // Persist (re-borrow DB after the awaits).
    {
        let db = require_db(&state)?;
        db.with_conn(|c| crate::db::recordings::set_transcript(c, &id, &text))
            .map_err(|e| e.to_string())?;
    }

    Ok(text)
}
```

- [ ] **Step 3: Register the command in `lib.rs`**

In `src-tauri/src/lib.rs`, add `transcribe_recording,` in both the macro export list and the `invoke_handler![generate_handler!]` list, right after `rename_recording,` in each.

- [ ] **Step 4: Build**

Run: `cd src-tauri && cargo build --lib`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): transcribe_recording command with progress events"
```

---

## Task 6: Frontend — API + UI

**Files:**
- Modify: `src/lib/api.ts` (field + function)
- Modify: `src/views/sections/RecordingsView.tsx` (UI)

- [ ] **Step 1: Add the API binding**

In `src/lib/api.ts`, add to the `RecordingRow` interface after `title`:

```ts
  transcript: string | null;
```

And add the function near `renameRecording`:

```ts
export const transcribeRecording = (id: string): Promise<string> =>
  invoke("transcribe_recording", { id });
```

- [ ] **Step 2: Wire imports + state in RecordingsView**

In `src/views/sections/RecordingsView.tsx`, add `transcribeRecording` to the import from `../../lib/api`, and add state near the other `useState` hooks:

```tsx
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
```

- [ ] **Step 3: Listen for progress events**

Add an effect alongside the existing `screenrec-changed` listener:

```tsx
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("transcribe-progress", (e) => {
      if (selected && e.payload.id === selected.id) setProgress(e.payload.pct);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [selected]);
```

- [ ] **Step 4: Add the generate handler**

Add a callback near `saveRename`:

```tsx
  const onTranscribe = useCallback(async () => {
    if (!selected) return;
    setTranscribing(true);
    setProgress(0);
    setError(null);
    try {
      await transcribeRecording(selected.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }, [selected, refresh]);
```

- [ ] **Step 5: Render the transcript section**

In the detail pane, after the `<div className="mt-4 flex gap-2">…</div>` action row (Reveal / Delete), add:

```tsx
              <div className="mt-6 border-t border-line pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold">Transcript</h3>
                  {selected.transcript ? (
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(selected.transcript ?? "");
                      }}
                      className="rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-surface"
                    >
                      Copy
                    </button>
                  ) : null}
                </div>
                {selected.transcript ? (
                  selected.transcript.trim() ? (
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                      {selected.transcript}
                    </p>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] text-muted">No speech detected.</span>
                      <button
                        onClick={() => void onTranscribe()}
                        disabled={transcribing}
                        className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
                      >
                        Re-generate
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    onClick={() => void onTranscribe()}
                    disabled={transcribing}
                    className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                  >
                    {transcribing ? `Transcribing… ${progress}%` : "Generate transcript"}
                  </button>
                )}
              </div>
```

- [ ] **Step 6: Reset progress on selection change**

In the list-row `onClick` that calls `setSelected(r)` and `setRenaming(false)`, also add `setProgress(0);` so a stale percentage doesn't flash when switching recordings.

- [ ] **Step 7: Typecheck the frontend**

Run: `bun run build` (or `bunx tsc --noEmit` if the project exposes it)
Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/views/sections/RecordingsView.tsx
git commit -m "feat(ui): recording transcript generate button + cached display"
```

---

## Task 7: Full build + manual verification

**Files:** none (build + manual QA)

- [ ] **Step 1: Build the app bundle**

Run: `bun tauri build --bundles app`
Expected: build succeeds; `.app` produced under `src-tauri/target/release/bundle/macos/`.

- [ ] **Step 2: Reinstall (skip-TCC — no permission code changed)**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 3: Manual checks**

  - Recording **with speech** → open it → "Generate transcript" → progress advances → text appears. Reselect another recording and come back → transcript still shows (cached). Quit + relaunch → still cached.
  - **Copy** button copies the text.
  - **Video-only** recording (no audio) → Generate → error banner "Recording has no audio"; no transcript stored.
  - **Long** recording (>2 min) → progress % climbs in steps; full text returned.

- [ ] **Step 4: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore: recording transcript manual-QA fixes"
```

---

## Notes for the executor

- This branch (`feat/screen-recording-phase2`) carries uncommitted Phase 2 work (setup-window layout, window filters, SCK thumbnails, rename feature). Those are **separate** from this feature. Do not revert them. If asked to merge Phase 2 to main, that is a distinct step from this plan.
- TCC: none of these changes touch Info.plist / entitlements / capabilities / TCC-relevant deps, so the **skip-TCC** reinstall is correct (per project CLAUDE.md).
- Rust tests: `cd src-tauri && cargo test --lib`. The Swift sidecar and full ASR run are verified manually (no model in CI).
```
