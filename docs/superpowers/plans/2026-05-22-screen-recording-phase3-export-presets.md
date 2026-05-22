# Screen Recording Phase 3 — Export Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user transcode any recording in the library to a smaller H.264 preset (1080p / 720p / 480p) on demand, stored alongside the original and tracked in the `exports` JSON column.

**Architecture:** Add an `export` sub-command to the existing `echo-scribe-screenrec` Swift sidecar (AVAssetExportSession). The Rust `screenrec` module gains a blocking `export()` supervisor that parses the sidecar's `progress`/`done` events. A new `export_recording` Tauri command merges the result into the recording's `exports` JSON. The Recordings library view gets per-quality export buttons.

**Tech Stack:** Swift (AVFoundation `AVAssetExportSession`), Rust (`std::process`, `serde_json`, `rusqlite`), TypeScript/React (Tauri `invoke`).

**Prerequisite for:** Phase 4 (Drive upload) — manual upload picks a quality, which reuses `export_recording`.

**Spec:** `docs/superpowers/specs/2026-05-22-screen-recording-design.md` (Phase 3, lines 258).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src-tauri/screenrec/main.swift` | Add `export` sub-command (AVAssetExportSession) | Modify |
| `src-tauri/src/screenrec/mod.rs` | `ExportDone`, `parse_export_done`, blocking `export()` supervisor | Modify |
| `src-tauri/src/db/recordings.rs` | `update_exports(conn, id, json)` | Modify |
| `src-tauri/src/commands.rs` | `export_recording` Tauri command | Modify |
| `src-tauri/src/lib.rs` | Register `export_recording` in the handler list | Modify |
| `src/lib/api.ts` | `exportRecording` binding | Modify |
| `src/views/sections/RecordingsView.tsx` | Export quality buttons + list of existing exports | Modify |

---

## Task 1: Swift sidecar `export` sub-command

**Files:**
- Modify: `src-tauri/screenrec/main.swift` (insert after the `--list-sources` block ends at line 98, before the `record` arg parsing at line 100)

- [ ] **Step 1: Add the `export` branch**

Insert this block immediately after line 98 (the closing `}` of the `if CommandLine.arguments.contains("--list-sources")` block) and before the `// --- arg parsing: record ...` comment on line 100. It runs its own RunLoop and exits, so it never falls through to the `record` parser:

```swift
// --- mode: `export --in <path> --out <path> --quality <1080|720|480>` ---
if CommandLine.arguments.contains("export") {
    var inPath: String?
    var exOutPath: String?
    var quality = "1080"
    let a = CommandLine.arguments
    var i = 1
    while i < a.count {
        if a[i] == "--in", i + 1 < a.count { inPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { exOutPath = a[i + 1]; i += 1 }
        else if a[i] == "--quality", i + 1 < a.count { quality = a[i + 1]; i += 1 }
        i += 1
    }
    guard let ip = inPath, let op = exOutPath else { emitFatal("args", "export needs --in and --out") }
    let preset: String
    switch quality {
    case "480": preset = AVAssetExportPreset640x480
    case "720": preset = AVAssetExportPreset1280x720
    default:    preset = AVAssetExportPreset1920x1080
    }
    let asset = AVURLAsset(url: URL(fileURLWithPath: ip))
    let outURL = URL(fileURLWithPath: op)
    try? FileManager.default.removeItem(at: outURL)
    guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
        emitFatal("export", "cannot create export session for preset \(preset)")
    }
    session.outputURL = outURL
    session.outputFileType = .mp4
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
    timer.setEventHandler { emit(["event": "progress", "pct": Int(session.progress * 100)]) }
    timer.resume()
    session.exportAsynchronously {
        timer.cancel()
        if session.status == .completed {
            let size = (try? FileManager.default.attributesOfItem(atPath: op)[.size] as? Int) ?? 0
            emit(["event": "done", "path": op, "size": size ?? 0])
            exit(0)
        } else {
            emit(["event": "error", "kind": "export", "msg": session.error?.localizedDescription ?? "export failed"])
            exit(1)
        }
    }
    RunLoop.main.run()
}
```

- [ ] **Step 2: Build the sidecar**

Run: `./scripts/build-screenrec.sh`
Expected: `built: src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin` (no compile errors).

- [ ] **Step 3: Smoke-test export against a real recording**

Find any existing recording MP4 (record one from the app first if none exist):

Run:
```bash
SRC=$(ls -t "$HOME/Library/Application Support/EchoScribe/recordings/"*.mp4 | head -1)
./src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin export --in "$SRC" --out /tmp/exp-720.mp4 --quality 720
ls -l /tmp/exp-720.mp4
```
Expected: stderr shows `{"event":"progress",...}` lines then `{"event":"done","path":"/tmp/exp-720.mp4","size":<n>}`, exit 0, and `/tmp/exp-720.mp4` exists with size > 0 and smaller than the source.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/screenrec/main.swift src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin
git commit -m "feat(screenrec): add export sub-command to sidecar (AVAssetExportSession presets)"
```

---

## Task 2: Rust supervisor `export()`

**Files:**
- Modify: `src-tauri/src/screenrec/mod.rs` (add `use std::path::Path;` to line 5's import; add types + fn; add unit test)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/screenrec/mod.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib screenrec::tests::parse_export_done`
Expected: FAIL — `cannot find function 'parse_export_done'`.

- [ ] **Step 3: Add the import, types, and `export()` fn**

Change line 5 of `src-tauri/src/screenrec/mod.rs` from:

```rust
use std::path::PathBuf;
```

to:

```rust
use std::path::{Path, PathBuf};
```

Then add this block after `parse_stopped` (after line 83):

```rust
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
/// running the sidecar's `export` sub-command. Blocks until the sidecar emits
/// `done` (success) or `error` (failure) or its stderr closes. Returns the
/// finalized export info on success.
pub fn export(in_path: &Path, out_path: &Path, quality: &str) -> Result<ExportDone, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    info!(in_ = %in_path.display(), out = %out_path.display(), quality, "screenrec export");
    let mut child = Command::new(&bin)
        .arg("export")
        .arg("--in")
        .arg(in_path)
        .arg("--out")
        .arg(out_path)
        .arg("--quality")
        .arg(quality)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().expect("piped");
    let reader = BufReader::new(stderr);
    let mut done: Option<ExportDone> = None;
    let mut err: Option<String> = None;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if let Some(d) = parse_export_done(&line) {
            done = Some(d);
            break;
        } else if line.contains("\"event\":\"error\"") {
            warn!(line, "screenrec export error");
            err = Some(line);
            break;
        }
    }
    let _ = child.wait();
    done.ok_or_else(|| err.unwrap_or_else(|| "export produced no output".into()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib screenrec::tests::parse_export_done`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/screenrec/mod.rs
git commit -m "feat(screenrec): blocking export() supervisor + done-event parser"
```

---

## Task 3: DB `update_exports`

**Files:**
- Modify: `src-tauri/src/db/recordings.rs` (add fn after `delete` at line 85; add unit test)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/db/recordings.rs`:

```rust
    #[test]
    fn update_exports_persists_json() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        let json = r#"[{"quality":"720","path":"/tmp/rec-1-720.mp4","size":4242}]"#;
        update_exports(&conn, "rec-1", json).unwrap();
        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.exports, json);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib db::recordings::tests::update_exports`
Expected: FAIL — `cannot find function 'update_exports'`.

- [ ] **Step 3: Add the function**

Add to `src-tauri/src/db/recordings.rs` after `delete` (after line 85):

```rust
pub fn update_exports(conn: &Connection, id: &str, exports_json: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE recordings SET exports = ?2 WHERE id = ?1",
        params![id, exports_json],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib db::recordings::tests::update_exports`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/recordings.rs
git commit -m "feat(db): add update_exports for recordings"
```

---

## Task 4: `export_recording` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add command after `reveal_recording`, before `open_screenrec_setup` ~line 2774)
- Modify: `src-tauri/src/lib.rs` (add to `use` re-export list ~line 69 and `generate_handler!` ~line 312)

- [ ] **Step 1: Add the command**

Insert into `src-tauri/src/commands.rs` immediately before the `#[tauri::command] pub fn open_screenrec_setup` definition (line 2773):

```rust
/// Transcode a recording to `quality` ("1080"|"720"|"480"), store the output
/// next to the source as `<stem>-<quality>.mp4`, and merge it into the row's
/// `exports` JSON (replacing any prior export of the same quality). Returns the
/// updated row.
#[tauri::command]
pub fn export_recording(
    state: State<'_, AppState>,
    id: String,
    quality: String,
) -> Result<crate::db::recordings::RecordingRow, String> {
    let db = require_db(&state)?;
    let row = db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or("recording not found")?;
    let src = std::path::PathBuf::from(&row.file_path);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("rec")
        .to_string();
    let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
    let out = dir.join(format!("{stem}-{quality}.mp4"));

    let done = crate::screenrec::export(&src, &out, &quality)?;

    let mut exports: Vec<serde_json::Value> =
        serde_json::from_str(&row.exports).unwrap_or_default();
    exports.retain(|e| e.get("quality").and_then(|q| q.as_str()) != Some(quality.as_str()));
    exports.push(serde_json::json!({
        "quality": quality,
        "path": done.path,
        "size": done.size,
    }));
    let exports_json = serde_json::to_string(&exports).map_err(|e| e.to_string())?;
    db.with_conn(|c| crate::db::recordings::update_exports(c, &id, &exports_json))
        .map_err(|e| e.to_string())?;
    db.with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "recording vanished".to_string())
}
```

- [ ] **Step 2: Register the command in `lib.rs`**

In `src-tauri/src/lib.rs`, add `export_recording,` to the `commands::{...}` re-export near line 69 (next to `reveal_recording`):

```rust
    reveal_recording,
    export_recording,
    list_screen_sources,
```

And add it to the `tauri::generate_handler![` list near line 312 (next to `reveal_recording`):

```rust
            reveal_recording,
            export_recording,
            list_screen_sources,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(screenrec): export_recording command wires sidecar export into exports JSON"
```

---

## Task 5: `exportRecording` TS binding

**Files:**
- Modify: `src/lib/api.ts` (add next to `deleteRecording`/`revealRecording`)

- [ ] **Step 1: Add the binding**

In `src/lib/api.ts`, add next to the other recording bindings (after `revealRecording`):

```ts
export const exportRecording = (
  id: string,
  quality: "1080" | "720" | "480",
): Promise<RecordingRow> => invoke("export_recording", { id, quality });
```

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit` (or the project's typecheck script; if none, `bunx tsc --noEmit -p tsconfig.json`)
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): exportRecording binding"
```

---

## Task 6: Recordings view export UI

**Files:**
- Modify: `src/views/sections/RecordingsView.tsx`

- [ ] **Step 1: Import the binding and a parsed-exports helper**

In `src/views/sections/RecordingsView.tsx`, add `exportRecording` to the import from `../../lib/api` (line 4-12 block):

```ts
import {
  isScreenRecording,
  openScreenrecSetup,
  stopScreenRecording,
  listRecordings,
  deleteRecording,
  revealRecording,
  exportRecording,
  type RecordingRow,
} from "../../lib/api";
```

Add this helper above the `RecordingsView` component (after `fmtSize`, line 25):

```ts
type ExportVariant = { quality: string; path: string; size: number };

function parseExports(json: string): ExportVariant[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ExportVariant[]) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Add export state + handler inside the component**

Inside `RecordingsView`, after the `onDelete` callback (line 89), add:

```ts
  const [exporting, setExporting] = useState<string | null>(null);

  const onExport = useCallback(
    async (id: string, quality: "1080" | "720" | "480") => {
      setExporting(quality);
      setError(null);
      try {
        await exportRecording(id, quality);
        await refresh();
        // Keep the selection pointed at the refreshed row so new exports show.
        const fresh = await listRecordings();
        setSelected(fresh.find((r) => r.id === id) ?? null);
      } catch (e) {
        setError(String(e));
      } finally {
        setExporting(null);
      }
    },
    [refresh],
  );
```

- [ ] **Step 3: Render export buttons + existing exports in the detail pane**

In the detail pane, replace the action row block (lines 157-170, the `<div className="mt-4 flex gap-2">...</div>`) with:

```tsx
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => revealRecording(selected.id)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
                >
                  Reveal in Finder
                </button>
                <span className="ml-2 text-[12px] text-muted">Export:</span>
                {(["1080", "720", "480"] as const).map((q) => (
                  <button
                    key={q}
                    onClick={() => onExport(selected.id, q)}
                    disabled={exporting !== null}
                    className="rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
                  >
                    {exporting === q ? `${q}p…` : `${q}p`}
                  </button>
                ))}
                <button
                  onClick={() => onDelete(selected.id)}
                  className="ml-auto rounded-md border border-line px-3 py-1.5 text-[13px] text-red-500 hover:bg-surface"
                >
                  Delete
                </button>
              </div>
              {parseExports(selected.exports).length > 0 ? (
                <div className="mt-3 text-[12px] text-muted">
                  Exports:{" "}
                  {parseExports(selected.exports)
                    .map((e) => `${e.quality}p (${fmtSize(e.size)})`)
                    .join(" · ")}
                </div>
              ) : null}
```

- [ ] **Step 4: Build the app and verify the export flow end to end**

Run: `bun tauri build --bundles app`
Then reinstall (default skip-TCC per CLAUDE.md — no permission code changed in this phase):

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

Manual check: open Recordings, select a recording, click `720p`, confirm the button shows `720p…` then the "Exports: 720p (… MB)" line appears and a `<stem>-720.mp4` file exists in `~/Library/Application Support/EchoScribe/recordings/`.

- [ ] **Step 5: Commit**

```bash
git add src/views/sections/RecordingsView.tsx
git commit -m "feat(screenrec): export quality buttons in Recordings view"
```

---

## Self-review checklist (run before handoff)

1. **Spec coverage:** `export` sub-op (Task 1), library export UI Original/1080/720/480 — note: "Original" is the source itself (already playable/revealable); export buttons cover 1080/720/480 (Tasks 4-6). ✅
2. **Type consistency:** `ExportDone {path, size}` (Task 2) matches the sidecar `done {path, size}` (Task 1) and the exports JSON shape `{quality, path, size}` (Tasks 4, 6). `update_exports(conn, id, json)` signature matches its call site. ✅
3. **No placeholders:** every code step has full code; commands have expected output. ✅

## Notes for Phase 4

- `export_recording` is the reuse point: Phase 4's manual upload calls it (or its inner logic) to produce the chosen-quality file, then uploads that file.
- A long export blocks one Tauri command worker thread; acceptable for v1. If it becomes a problem, wrap in `tauri::async_runtime::spawn_blocking` and emit `screenrec-changed`-style progress events.
