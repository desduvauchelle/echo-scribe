# Screen Recording — Phase 1: Capture Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the primary display (with system audio) to a native-resolution H.264 MP4 via a new Swift sidecar, persist each recording in a `recordings` table, and view/play/delete/reveal recordings in a new Recordings library view.

**Architecture:** A dedicated Swift sidecar `echo-scribe-screenrec` uses ScreenCaptureKit → AVAssetWriter to write an MP4 and a poster-frame thumbnail, mirroring the existing `echo-scribe-syscap` sidecar lifecycle (stderr JSON events, SIGTERM = clean finalize). A Rust module `src-tauri/src/screenrec/` supervises the sidecar (mirrors `meeting/syscap.rs`), inserts a DB row on stop, and exposes Tauri commands. A React `RecordingsView` lists rows and triggers start/stop.

**Tech Stack:** Swift (ScreenCaptureKit, AVFoundation), Rust (Tauri v2, rusqlite), React/TypeScript.

**Scope of THIS phase (deliberately narrow):** primary display + system audio only; start/stop from a button in the Recordings view. NOT in this phase: source picker / setup window, microphone + audio mixing, menubar red state, global hotkey, quality export presets, Google Drive. Those are Phases 2–4 in `docs/superpowers/specs/2026-05-22-screen-recording-design.md`.

---

## File Structure

**Create:**
- `src-tauri/screenrec/Package.swift` — Swift package manifest for the new sidecar
- `src-tauri/screenrec/main.swift` — sidecar: capture + encode + thumbnail
- `scripts/build-screenrec.sh` — compiles the sidecar, copies to `binaries/` with arch suffix
- `src-tauri/src/screenrec/mod.rs` — Rust module: supervisor + paths + active-handle
- `src-tauri/src/db/recordings.rs` — `recordings` table CRUD
- `src/views/sections/RecordingsView.tsx` — library view

**Modify:**
- `src-tauri/build.rs` — also run `build-screenrec.sh` in release builds
- `src-tauri/tauri.conf.json` — add the new sidecar to `externalBin`
- `src-tauri/src/db/mod.rs` — register `pub mod recordings;`
- `src-tauri/src/db/schema.rs` — append migration v13 (recordings table); update the v12 version assertion in tests
- `src-tauri/src/lib.rs` — `pub mod screenrec;`, `.manage()` the active-recording handle, register commands
- `src-tauri/src/commands.rs` — new Tauri commands + add field to `AppState`
- `src/lib/api.ts` — typed wrappers for the new commands
- `src/views/Main.tsx` — add a "Recordings" nav item + route

---

## Task 1: Scaffold the `echo-scribe-screenrec` sidecar (build + bundle)

Get a new, bundled, runnable sidecar that emits `ready` and stops on SIGTERM — no capture logic yet. This isolates the build/bundling wiring from the AVFoundation work.

**Files:**
- Create: `src-tauri/screenrec/Package.swift`
- Create: `src-tauri/screenrec/main.swift`
- Create: `scripts/build-screenrec.sh`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Create the Swift package manifest**

Create `src-tauri/screenrec/Package.swift` (mirrors `src-tauri/syscap/Package.swift`):

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "echo-scribe-screenrec",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "echo-scribe-screenrec",
            path: ".",
            sources: ["main.swift"]
        )
    ]
)
```

- [ ] **Step 2: Create a minimal sidecar that emits `ready` and stops on SIGTERM**

Create `src-tauri/screenrec/main.swift`:

```swift
import Foundation
import ScreenCaptureKit
import AVFoundation

// echo-scribe-screenrec
// Phase 1: records the primary display + system audio to an MP4 via
// AVAssetWriter, writes a poster-frame thumbnail, and finalizes on SIGTERM.
// Status events go to stderr as line-delimited JSON; stdout is unused.

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

func emitFatal(_ kind: String, _ msg: String) -> Never {
    emit(["event": "error", "kind": kind, "msg": msg])
    exit(1)
}

// --- arg parsing: `record --out <path>` ---
var outPath: String?
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "record": break
        case "--out": i += 1; if i < args.count { outPath = args[i] }
        default: break
        }
        i += 1
    }
}
guard let outPath = outPath else {
    emitFatal("args", "missing --out <path>")
}

// Phase 1 stub: prove lifecycle. Replaced with real capture in Task 2.
emit(["event": "ready", "out": outPath])

signal(SIGTERM, SIG_IGN)
let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSrc.setEventHandler {
    emit(["event": "stopped", "path": outPath, "dur_ms": 0, "width": 0, "height": 0, "size": 0, "thumb": ""])
    exit(0)
}
termSrc.resume()

RunLoop.main.run()
```

- [ ] **Step 3: Create the build script**

Create `scripts/build-screenrec.sh` (mirrors `scripts/build-syscap.sh`):

```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../src-tauri/screenrec"
swift build -c release
mkdir -p ../binaries
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  TRIPLE="aarch64-apple-darwin"
else
  TRIPLE="x86_64-apple-darwin"
fi
cp .build/release/echo-scribe-screenrec ../binaries/echo-scribe-screenrec-$TRIPLE
echo "built echo-scribe-screenrec-$TRIPLE"
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x scripts/build-screenrec.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Hook the build script into `build.rs`**

In `src-tauri/build.rs`, find the existing release-only block that runs `build-syscap.sh`:

```rust
    if cfg!(not(debug_assertions)) {
        std::process::Command::new("bash")
            .arg("../scripts/build-syscap.sh")
            .current_dir("src-tauri")
            .status()
            .expect("Failed to build syscap");
    }
```

Add an identical block immediately after it for the new sidecar:

```rust
    if cfg!(not(debug_assertions)) {
        std::process::Command::new("bash")
            .arg("../scripts/build-screenrec.sh")
            .current_dir("src-tauri")
            .status()
            .expect("Failed to build screenrec");
    }
```

- [ ] **Step 6: Add the sidecar to the Tauri bundle**

In `src-tauri/tauri.conf.json`, find the `externalBin` array:

```json
"externalBin": ["binaries/echo-scribe-syscap", "binaries/echo-scribe-calmatch"]
```

Add the new sidecar:

```json
"externalBin": ["binaries/echo-scribe-syscap", "binaries/echo-scribe-calmatch", "binaries/echo-scribe-screenrec"]
```

- [ ] **Step 7: Build and smoke-test the sidecar**

Run:
```bash
bash scripts/build-screenrec.sh
./src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin record --out /tmp/test.mp4 &
PID=$!; sleep 1; kill -TERM $PID; wait $PID
```
Expected stderr: a `{"event":"ready","out":"/tmp/test.mp4"}` line, then `{"event":"stopped",...}`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/screenrec/Package.swift src-tauri/screenrec/main.swift scripts/build-screenrec.sh src-tauri/build.rs src-tauri/tauri.conf.json
git commit -m "feat(screenrec): scaffold echo-scribe-screenrec sidecar + bundling"
```

---

## Task 2: Implement video + system-audio capture to MP4

Replace the Phase 1 stub with real ScreenCaptureKit capture writing an H.264 MP4 via AVAssetWriter. Reuse the SCStream/SCContentFilter setup from `src-tauri/syscap/main.swift`.

**Files:**
- Modify: `src-tauri/screenrec/main.swift`

- [ ] **Step 1: Replace `main.swift` with the capture implementation**

Overwrite `src-tauri/screenrec/main.swift`:

```swift
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}
func emitFatal(_ kind: String, _ msg: String) -> Never {
    emit(["event": "error", "kind": kind, "msg": msg])
    exit(1)
}

let OWN_BUNDLE_ID = "com.echoscribe.app"

// --- arg parsing: `record --out <path>` ---
var outPath: String?
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        if args[i] == "--out", i + 1 < args.count { outPath = args[i + 1]; i += 1 }
        i += 1
    }
}
guard let outArg = outPath else { emitFatal("args", "missing --out <path>") }
let outURL = URL(fileURLWithPath: outArg)
try? FileManager.default.removeItem(at: outURL)

@available(macOS 14.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream!
    let outURL: URL
    var writer: AVAssetWriter!
    var videoInput: AVAssetWriterInput!
    var audioInput: AVAssetWriterInput!
    var sessionStarted = false
    var startPTS: CMTime = .zero
    var lastPTS: CMTime = .zero
    let pxWidth: Int
    let pxHeight: Int
    var finished = false
    let finishLock = NSLock()

    init(outURL: URL, width: Int, height: Int) {
        self.outURL = outURL
        self.pxWidth = width
        self.pxHeight = height
        super.init()
    }

    func setupWriter() throws {
        writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: pxWidth,
            AVVideoHeightKey: pxHeight,
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        if writer.canAdd(videoInput) { writer.add(videoInput) }

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 2,
            AVSampleRateKey: 48000,
            AVEncoderBitRateKey: 128000,
        ]
        audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput.expectsMediaDataInRealTime = true
        if writer.canAdd(audioInput) { writer.add(audioInput) }

        guard writer.startWriting() else {
            throw NSError(domain: "screenrec", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: writer.error?.localizedDescription ?? "startWriting failed"])
        }
    }

    func start() throws {
        try setupWriter()
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "screenrec.screen"))
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "screenrec.audio"))
        stream.startCapture { [weak self] err in
            if let err = err { emitFatal("start", err.localizedDescription) }
            emit(["event": "ready"])
            self?.startHeartbeat()
        }
    }

    func startHeartbeat() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        t.schedule(deadline: .now() + 1, repeating: 1.0)
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            let dur = self.sessionStarted
                ? CMTimeGetSeconds(CMTimeSubtract(self.lastPTS, self.startPTS)) * 1000.0
                : 0
            emit(["event": "heartbeat", "ts": Date().timeIntervalSince1970, "dur_ms": Int(dur)])
        }
        t.resume()
        self.heartbeatTimer = t
    }
    var heartbeatTimer: DispatchSourceTimer?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        if !sessionStarted {
            // Start the AVAssetWriter session on the first VIDEO buffer that is
            // marked complete/displayed, so audio before the first frame is dropped.
            guard type == .screen, Self.frameIsComplete(sampleBuffer) else { return }
            startPTS = pts
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
        }
        lastPTS = pts

        switch type {
        case .screen:
            if videoInput.isReadyForMoreMediaData {
                videoInput.append(sampleBuffer)
            }
        case .audio:
            if audioInput.isReadyForMoreMediaData {
                audioInput.append(sampleBuffer)
            }
        default:
            break
        }
    }

    static func frameIsComplete(_ sb: CMSampleBuffer) -> Bool {
        guard let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
              let attachments = (attachmentsArray as NSArray).firstObject as? [SCStreamFrameInfo: Any],
              let statusRaw = attachments[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw) else { return false }
        return status == .complete
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "kind": "stream_stopped", "msg": error.localizedDescription])
        finalize(exitCode: 2)
    }

    func finalize(exitCode: Int32) {
        finishLock.lock()
        if finished { finishLock.unlock(); return }
        finished = true
        finishLock.unlock()

        let durMs = sessionStarted
            ? Int(CMTimeGetSeconds(CMTimeSubtract(lastPTS, startPTS)) * 1000.0)
            : 0
        videoInput.markAsFinished()
        audioInput.markAsFinished()
        writer.finishWriting { [weak self] in
            guard let self = self else { exit(exitCode) }
            let size = (try? FileManager.default.attributesOfItem(atPath: self.outURL.path)[.size] as? Int) ?? 0
            // Thumbnail is written in Task 3; emit empty path for now.
            emit([
                "event": "stopped",
                "path": self.outURL.path,
                "dur_ms": durMs,
                "width": self.pxWidth,
                "height": self.pxHeight,
                "size": size ?? 0,
                "thumb": "",
            ])
            exit(exitCode)
        }
    }
}

@available(macOS 14.0, *)
final class Pinned {
    static let shared = Pinned()
    var recorder: Recorder?
    var termSource: DispatchSourceSignal?
}

@available(macOS 14.0, *)
@MainActor
func run() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { emitFatal("no_display", "no shareable display") }
        let excluded = content.applications.filter { $0.bundleIdentifier == OWN_BUNDLE_ID }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        cfg.width = display.width * 2     // capture at backing-pixel resolution
        cfg.height = display.height * 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30) // 30 fps
        cfg.queueDepth = 6
        cfg.showsCursor = true

        let rec = Recorder(outURL: outURL, width: cfg.width, height: cfg.height)
        let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
        rec.stream = stream
        Pinned.shared.recorder = rec
        try rec.start()

        signal(SIGTERM, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler {
            emit(["event": "stop_requested"])
            stream.stopCapture { _ in
                Pinned.shared.recorder?.finalize(exitCode: 0)
            }
        }
        termSrc.resume()
        Pinned.shared.termSource = termSrc
    } catch {
        emitFatal("setup", error.localizedDescription)
    }
}

if #available(macOS 14.0, *) {
    Task { await run() }
    RunLoop.main.run()
} else {
    emitFatal("os", "macOS 14 or newer required")
}
```

- [ ] **Step 2: Build the sidecar**

Run: `bash scripts/build-screenrec.sh`
Expected: `built echo-scribe-screenrec-aarch64-apple-darwin`, exit 0. (If compile errors, fix against the Swift compiler — the SCStreamFrameInfo/SCFrameStatus attachment API is the most likely spot to need adjustment.)

- [ ] **Step 3: Record a short clip and verify it's a valid MP4**

Run (grant Screen Recording to the terminal if prompted):
```bash
./src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin record --out /tmp/screenrec-test.mp4 &
PID=$!; sleep 4; kill -TERM $PID; wait $PID
mdls -name kMDItemDurationSeconds -name kMDItemPixelWidth /tmp/screenrec-test.mp4
```
Expected: stderr shows `ready`, periodic `heartbeat` with rising `dur_ms`, then `stopped` with non-zero `dur_ms`/`width`/`height`/`size`. `mdls` reports a duration ≈ 3–4s and a non-zero pixel width. Open `/tmp/screenrec-test.mp4` in QuickTime to confirm video + system audio play.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/screenrec/main.swift
git commit -m "feat(screenrec): capture display + system audio to H.264 MP4"
```

---

## Task 3: Write a poster-frame thumbnail on stop

Generate a JPG thumbnail from the recorded file so the library view can show a poster.

**Files:**
- Modify: `src-tauri/screenrec/main.swift`

- [ ] **Step 1: Add a thumbnail helper**

In `src-tauri/screenrec/main.swift`, add this free function above `@available(macOS 14.0, *) final class Pinned`:

```swift
@available(macOS 14.0, *)
func writeThumbnail(for videoURL: URL) -> String {
    let thumbURL = videoURL.deletingPathExtension().appendingPathExtension("jpg")
    let asset = AVURLAsset(url: videoURL)
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: 640, height: 640)
    let time = CMTime(seconds: 0.5, preferredTimescale: 600)
    guard let cg = try? gen.copyCGImage(at: time, actualTime: nil) else { return "" }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { return "" }
    try? data.write(to: thumbURL)
    return thumbURL.path
}
```

- [ ] **Step 2: Import AppKit for `NSBitmapImageRep`**

At the top of `src-tauri/screenrec/main.swift`, add after the existing imports:

```swift
import AppKit
```

- [ ] **Step 3: Use the thumbnail in `finalize`**

In `finalize(exitCode:)`, replace the `writer.finishWriting { ... }` body's `emit([...])` block so the `thumb` value is generated:

```swift
        writer.finishWriting { [weak self] in
            guard let self = self else { exit(exitCode) }
            let size = (try? FileManager.default.attributesOfItem(atPath: self.outURL.path)[.size] as? Int) ?? 0
            let thumb = writeThumbnail(for: self.outURL)
            emit([
                "event": "stopped",
                "path": self.outURL.path,
                "dur_ms": durMs,
                "width": self.pxWidth,
                "height": self.pxHeight,
                "size": size ?? 0,
                "thumb": thumb,
            ])
            exit(exitCode)
        }
```

- [ ] **Step 4: Build and verify a thumbnail is produced**

Run:
```bash
bash scripts/build-screenrec.sh
./src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin record --out /tmp/screenrec-test.mp4 &
PID=$!; sleep 3; kill -TERM $PID; wait $PID
ls -la /tmp/screenrec-test.jpg
```
Expected: `stopped` event has a non-empty `thumb` path; `/tmp/screenrec-test.jpg` exists and is a valid image.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/screenrec/main.swift
git commit -m "feat(screenrec): write poster-frame thumbnail on stop"
```

---

## Task 4: `recordings` table — migration + CRUD (TDD)

**Files:**
- Create: `src-tauri/src/db/recordings.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: Register the module**

In `src-tauri/src/db/mod.rs`, find the module declarations block (the `pub mod ...;` list) and add:

```rust
pub mod recordings;
```

- [ ] **Step 2: Append migration v13 to `schema.rs`**

In `src-tauri/src/db/schema.rs`, the `MIGRATIONS` const is an array of `(u32, &str)` tuples ending at version 12. Append a new tuple as the LAST element of the array (before the closing `];`):

```rust
    (
        13,
        r#"
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  source_label TEXT,
  has_mic INTEGER NOT NULL DEFAULT 0,
  has_sysaudio INTEGER NOT NULL DEFAULT 1,
  thumb_path TEXT,
  drive_file_id TEXT,
  drive_link TEXT,
  upload_status TEXT NOT NULL DEFAULT 'none',
  upload_error TEXT,
  exports TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC);
"#,
    ),
```

- [ ] **Step 3: Update the schema-version assertion that now changes to 13**

In `src-tauri/src/db/schema.rs`, the test `migration_v7_creates_meetings_tables` asserts the current `schema_version` is `"12"`. Adding migration 13 makes it `"13"`. Update that assertion:

```rust
        assert_eq!(version, "13");
```

- [ ] **Step 4: Write the failing CRUD + migration test**

Create `src-tauri/src/db/recordings.rs`:

```rust
use crate::db::DbError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingRow {
    pub id: String,
    pub created_at: i64,
    pub file_path: String,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub size_bytes: Option<i64>,
    pub source_label: Option<String>,
    pub has_mic: bool,
    pub has_sysaudio: bool,
    pub thumb_path: Option<String>,
    pub drive_file_id: Option<String>,
    pub drive_link: Option<String>,
    pub upload_status: String,
    pub upload_error: Option<String>,
    /// JSON array of export variants: `[{"quality":"1080","path":"...","size":123}]`.
    pub exports: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::run_migrations;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn sample() -> RecordingRow {
        RecordingRow {
            id: "rec-1".into(),
            created_at: 1_716_300_000_000,
            file_path: "/tmp/rec-1.mp4".into(),
            duration_ms: Some(4000),
            width: Some(3456),
            height: Some(2234),
            size_bytes: Some(1_234_567),
            source_label: Some("Entire screen".into()),
            has_mic: false,
            has_sysaudio: true,
            thumb_path: Some("/tmp/rec-1.jpg".into()),
            drive_file_id: None,
            drive_link: None,
            upload_status: "none".into(),
            upload_error: None,
            exports: "[]".into(),
        }
    }

    #[test]
    fn migration_creates_recordings_table() {
        let conn = setup();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='recordings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn insert_list_delete_round_trip() {
        let conn = setup();
        insert(&conn, &sample()).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "rec-1");
        assert_eq!(rows[0].source_label.as_deref(), Some("Entire screen"));
        assert!(rows[0].has_sysaudio);
        assert!(!rows[0].has_mic);

        let got = get(&conn, "rec-1").unwrap().unwrap();
        assert_eq!(got.file_path, "/tmp/rec-1.mp4");

        delete(&conn, "rec-1").unwrap();
        assert!(list(&conn).unwrap().is_empty());
        assert!(get(&conn, "rec-1").unwrap().is_none());
    }
}
```

- [ ] **Step 5: Run the test to verify it fails (functions undefined)**

Run: `cd src-tauri && cargo test --lib db::recordings 2>&1 | head -30; cd ..`
Expected: FAIL — `cannot find function 'insert'`/`list`/`get`/`delete` in this scope.

- [ ] **Step 6: Implement the CRUD functions**

In `src-tauri/src/db/recordings.rs`, add above the `#[cfg(test)]` module:

```rust
pub fn insert(conn: &Connection, r: &RecordingRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO recordings (
            id, created_at, file_path, duration_ms, width, height, size_bytes,
            source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
            drive_link, upload_status, upload_error, exports
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<RecordingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT id, created_at, file_path, duration_ms, width, height, size_bytes,
                source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
                drive_link, upload_status, upload_error, exports
         FROM recordings
         ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_recording)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<RecordingRow>, DbError> {
    conn.query_row(
        "SELECT id, created_at, file_path, duration_ms, width, height, size_bytes,
                source_label, has_mic, has_sysaudio, thumb_path, drive_file_id,
                drive_link, upload_status, upload_error, exports
         FROM recordings WHERE id = ?1",
        [id],
        row_to_recording,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM recordings WHERE id = ?1", [id])?;
    Ok(())
}

fn row_to_recording(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecordingRow> {
    Ok(RecordingRow {
        id: row.get(0)?,
        created_at: row.get(1)?,
        file_path: row.get(2)?,
        duration_ms: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
        size_bytes: row.get(6)?,
        source_label: row.get(7)?,
        has_mic: row.get::<_, i64>(8)? != 0,
        has_sysaudio: row.get::<_, i64>(9)? != 0,
        thumb_path: row.get(10)?,
        drive_file_id: row.get(11)?,
        drive_link: row.get(12)?,
        upload_status: row.get(13)?,
        upload_error: row.get(14)?,
        exports: row.get(15)?,
    })
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib db::recordings 2>&1 | tail -20; cd ..`
Expected: PASS — `migration_creates_recordings_table` and `insert_list_delete_round_trip` both pass.

- [ ] **Step 8: Run the full DB test module to confirm the version bump didn't break others**

Run: `cd src-tauri && cargo test --lib db:: 2>&1 | tail -20; cd ..`
Expected: all `db::*` tests pass (including the updated `migration_v7_creates_meetings_tables` asserting `"13"`).

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/db/recordings.rs src-tauri/src/db/mod.rs src-tauri/src/db/schema.rs
git commit -m "feat(db): add recordings table + CRUD (migration v13)"
```

---

## Task 5: Rust supervisor module (`screenrec/mod.rs`)

Supervise the sidecar process: resolve the binary, spawn it, parse the `stopped` event from stderr, send SIGTERM to stop. Mirrors `src-tauri/src/meeting/syscap.rs`.

**Files:**
- Create: `src-tauri/src/screenrec/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod screenrec;`)

- [ ] **Step 1: Write the failing event-parse test**

Create `src-tauri/src/screenrec/mod.rs`:

```rust
//! Supervises the `echo-scribe-screenrec` sidecar: spawn, read stderr JSON
//! events, finalize on SIGTERM. Mirrors `meeting/syscap.rs`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

/// Parsed `stopped` event payload from the sidecar.
#[derive(Debug, Clone, PartialEq)]
pub struct StoppedInfo {
    pub path: String,
    pub dur_ms: i64,
    pub width: i64,
    pub height: i64,
    pub size: i64,
    pub thumb: String,
}

/// Parse one line of sidecar stderr JSON into a `StoppedInfo`, if it is the
/// `stopped` event. Returns `None` for any other event or malformed line.
pub fn parse_stopped(line: &str) -> Option<StoppedInfo> {
    let val: serde_json::Value = serde_json::from_str(line).ok()?;
    if val.get("event")?.as_str()? != "stopped" {
        return None;
    }
    Some(StoppedInfo {
        path: val.get("path")?.as_str()?.to_string(),
        dur_ms: val.get("dur_ms").and_then(|v| v.as_i64()).unwrap_or(0),
        width: val.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        height: val.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        size: val.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
        thumb: val.get("thumb").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    })
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
}
```

- [ ] **Step 2: Run the test to verify it fails (module not declared)**

In `src-tauri/src/lib.rs`, find the module declarations near the top (e.g. `mod meeting;` / `pub mod ...;`) and add:

```rust
pub mod screenrec;
```

Run: `cd src-tauri && cargo test --lib screenrec::tests::parse_stopped 2>&1 | tail -20; cd ..`
Expected: PASS (these two tests are self-contained). If the module wasn't declared, compilation fails — declaring it in lib.rs fixes that.

- [ ] **Step 3: Add binary resolution + recordings directory helpers**

In `src-tauri/src/screenrec/mod.rs`, add above the `#[cfg(test)]` module:

```rust
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
```

- [ ] **Step 4: Add the supervisor handle (spawn + stop)**

In `src-tauri/src/screenrec/mod.rs`, add below the helpers:

```rust
/// A running screen recording. Holds the child process and the path it is
/// writing to. Dropping it does not stop the recording — call `stop()`.
pub struct ScreenrecHandle {
    child: Child,
    pub out_path: PathBuf,
    stopped_rx: mpsc::Receiver<StoppedInfo>,
}

impl ScreenrecHandle {
    /// Spawn the sidecar to record the primary display + system audio to
    /// `out_path`. Returns once the process is spawned (not when capture is
    /// confirmed ready — `ready` is logged but not awaited).
    pub fn start(out_path: PathBuf) -> std::io::Result<Self> {
        let bin = resolve_binary()?;
        info!(path = %bin.display(), out = %out_path.display(), "spawning screenrec");
        let mut child = Command::new(&bin)
            .arg("record")
            .arg("--out")
            .arg(&out_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()?;

        let (tx, rx) = mpsc::channel::<StoppedInfo>();
        let stderr = child.stderr.take().expect("piped");
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(info) = parse_stopped(&line) {
                    let _ = tx.send(info);
                    break;
                } else if line.contains("\"event\":\"error\"") {
                    warn!(line, "screenrec error event");
                }
            }
        });

        Ok(Self { child, out_path, stopped_rx: rx })
    }

    /// SIGTERM the sidecar and wait up to 10s for the `stopped` event (which
    /// arrives after AVAssetWriter finishes finalizing the MP4). Returns the
    /// finalized recording info.
    pub fn stop(mut self) -> Result<StoppedInfo, String> {
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
```

- [ ] **Step 5: Run tests + build to confirm the module compiles**

Run: `cd src-tauri && cargo test --lib screenrec 2>&1 | tail -20; cd ..`
Expected: the two `parse_stopped` tests PASS and the crate compiles (confirms `ScreenrecHandle`, `resolve_binary`, `recordings_dir` type-check). `libc` is already a dependency (used by `meeting/syscap.rs`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/screenrec/mod.rs src-tauri/src/lib.rs
git commit -m "feat(screenrec): add sidecar supervisor (spawn/stop/parse)"
```

---

## Task 6: Tauri commands + state wiring

Expose start/stop/list/delete/reveal to the frontend. Hold the active recording handle in `AppState`.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the active-recording field to `AppState`**

In `src-tauri/src/commands.rs`, find the `AppState` struct and add a field:

```rust
    pub active_recording: std::sync::Arc<std::sync::Mutex<Option<crate::screenrec::ScreenrecHandle>>>,
```

Then find where `AppState` is constructed (in `lib.rs` setup) and initialize the new field — see Step 4.

- [ ] **Step 2: Add the commands**

In `src-tauri/src/commands.rs`, add (near the other `#[tauri::command]` functions). These mirror the existing command style (`State<'_, AppState>`, `Result<_, String>`, `db.with_conn`):

```rust
#[tauri::command]
pub fn start_screen_recording(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.active_recording.lock().map_err(|_| "lock poisoned".to_string())?;
    if guard.is_some() {
        return Err("a recording is already in progress".into());
    }
    let dir = crate::screenrec::recordings_dir().map_err(|e| e.to_string())?;
    let id = format!(
        "rec-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let out_path = dir.join(format!("{id}.mp4"));
    let handle = crate::screenrec::ScreenrecHandle::start(out_path).map_err(|e| e.to_string())?;
    *guard = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn is_screen_recording(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state.active_recording.lock().map_err(|_| "lock poisoned".to_string())?;
    Ok(guard.is_some())
}

#[tauri::command]
pub fn stop_screen_recording(
    state: State<'_, AppState>,
) -> Result<crate::db::recordings::RecordingRow, String> {
    let handle = {
        let mut guard = state.active_recording.lock().map_err(|_| "lock poisoned".to_string())?;
        guard.take().ok_or("no recording in progress")?
    };
    let info = handle.stop()?;
    let id = std::path::Path::new(&info.path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("rec-unknown")
        .to_string();
    let row = crate::db::recordings::RecordingRow {
        id,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64,
        file_path: info.path.clone(),
        duration_ms: Some(info.dur_ms),
        width: Some(info.width),
        height: Some(info.height),
        size_bytes: Some(info.size),
        source_label: Some("Entire screen".into()),
        has_mic: false,
        has_sysaudio: true,
        thumb_path: if info.thumb.is_empty() { None } else { Some(info.thumb) },
        drive_file_id: None,
        drive_link: None,
        upload_status: "none".into(),
        upload_error: None,
        exports: "[]".into(),
    };
    state
        .db
        .with_conn(|c| crate::db::recordings::insert(c, &row))
        .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub fn list_recordings(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::recordings::RecordingRow>, String> {
    state
        .db
        .with_conn(|c| crate::db::recordings::list(c))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_recording(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let row = state
        .db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?;
    if let Some(row) = row {
        let _ = std::fs::remove_file(&row.file_path);
        if let Some(thumb) = &row.thumb_path {
            let _ = std::fs::remove_file(thumb);
        }
    }
    state
        .db
        .with_conn(|c| crate::db::recordings::delete(c, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_recording(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let row = state
        .db
        .with_conn(|c| crate::db::recordings::get(c, &id))
        .map_err(|e| e.to_string())?
        .ok_or("recording not found")?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(&row.file_path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Register the commands**

In `src-tauri/src/lib.rs`, find the `tauri::generate_handler![ ... ]` list and add the new command names (use the bare function names, matching how `list_meetings` etc. are listed):

```rust
            start_screen_recording,
            stop_screen_recording,
            is_screen_recording,
            list_recordings,
            delete_recording,
            reveal_recording,
```

- [ ] **Step 4: Initialize the `active_recording` field**

In `src-tauri/src/lib.rs`, find where `AppState { ... }` is constructed and add the field initializer alongside the others:

```rust
            active_recording: std::sync::Arc::new(std::sync::Mutex::new(None)),
```

- [ ] **Step 5: Build the backend**

Run: `cd src-tauri && cargo build --lib 2>&1 | tail -25; cd ..`
Expected: compiles cleanly. (If `start_screen_recording` etc. aren't found by `generate_handler!`, confirm they're `pub` and that any `use crate::commands::*;` / explicit import in `lib.rs` includes them — match how existing commands are imported.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(screenrec): tauri commands for start/stop/list/delete/reveal"
```

---

## Task 7: Frontend — API wrappers + Recordings view + nav

**Files:**
- Modify: `src/lib/api.ts`
- Create: `src/views/sections/RecordingsView.tsx`
- Modify: `src/views/Main.tsx`

- [ ] **Step 1: Add typed API wrappers**

In `src/lib/api.ts`, add (mirrors the `invoke("snake_case", {...})` pattern used by `listMeetings` etc.):

```ts
export type RecordingRow = {
  id: string;
  created_at: number;
  file_path: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  source_label: string | null;
  has_mic: boolean;
  has_sysaudio: boolean;
  thumb_path: string | null;
  drive_file_id: string | null;
  drive_link: string | null;
  upload_status: string;
  upload_error: string | null;
  exports: string;
};

export const startScreenRecording = (): Promise<void> =>
  invoke("start_screen_recording");
export const stopScreenRecording = (): Promise<RecordingRow> =>
  invoke("stop_screen_recording");
export const isScreenRecording = (): Promise<boolean> =>
  invoke("is_screen_recording");
export const listRecordings = (): Promise<RecordingRow[]> =>
  invoke("list_recordings");
export const deleteRecording = (id: string): Promise<void> =>
  invoke("delete_recording", { id });
export const revealRecording = (id: string): Promise<void> =>
  invoke("reveal_recording", { id });
```

- [ ] **Step 2: Create the Recordings view**

Create `src/views/sections/RecordingsView.tsx`. Uses `convertFileSrc` to play local files in a `<video>` element:

```tsx
import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  isScreenRecording,
  startScreenRecording,
  stopScreenRecording,
  listRecordings,
  deleteRecording,
  revealRecording,
  type RecordingRow,
} from "../../lib/api";

function fmtDuration(ms: number | null): string {
  if (!ms) return "0:00";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function RecordingsView() {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<RecordingRow | null>(null);

  const refresh = useCallback(async () => {
    setRows(await listRecordings());
    setRecording(await isScreenRecording());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (recording) {
        await stopScreenRecording();
      } else {
        await startScreenRecording();
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [recording, refresh]);

  const onDelete = useCallback(
    async (id: string) => {
      await deleteRecording(id);
      if (selected?.id === id) setSelected(null);
      await refresh();
    },
    [refresh, selected],
  );

  return (
    <div className="flex h-full flex-col bg-canvas text-fg">
      <div className="flex items-center justify-between border-b border-line px-6 py-4">
        <h1 className="text-[15px] font-semibold tracking-tight">Recordings</h1>
        <button
          onClick={onToggle}
          disabled={busy}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
            recording ? "bg-red-600 text-white" : "bg-accent text-white"
          } disabled:opacity-50`}
        >
          {recording ? "Stop recording" : "Record screen"}
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-[320px] shrink-0 overflow-y-auto border-r border-line">
          {rows.length === 0 ? (
            <div className="p-6 text-[13px] text-muted">No recordings yet.</div>
          ) : (
            rows.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r)}
                className={`flex w-full gap-3 border-b border-line p-3 text-left hover:bg-surface ${
                  selected?.id === r.id ? "bg-surface" : ""
                }`}
              >
                {r.thumb_path ? (
                  <img
                    src={convertFileSrc(r.thumb_path)}
                    alt=""
                    className="h-12 w-20 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-12 w-20 shrink-0 rounded bg-elevated" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">
                    {r.source_label ?? "Recording"}
                  </div>
                  <div className="text-[11px] text-muted">
                    {new Date(r.created_at).toLocaleString()} ·{" "}
                    {fmtDuration(r.duration_ms)} · {fmtSize(r.size_bytes)}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto p-6">
          {selected ? (
            <>
              <video
                key={selected.id}
                src={convertFileSrc(selected.file_path)}
                controls
                className="w-full rounded-lg bg-black"
              />
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => revealRecording(selected.id)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
                >
                  Reveal in Finder
                </button>
                <button
                  onClick={() => onDelete(selected.id)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] text-red-500 hover:bg-surface"
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-[13px] text-muted">
              Select a recording to play it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register the view in `Main.tsx`**

In `src/views/Main.tsx`:

(a) Add the import alongside the other section imports:

```tsx
import { RecordingsView } from "./sections/RecordingsView";
```

(b) Add `recordings` to the `MainSection` union:

```tsx
  | { kind: "recordings" }
```

(c) Add a nav item after the "Meetings" `NavItem` (reuse an existing lucide icon already imported, or add `Video` to the `lucide-react` import):

```tsx
          <NavItem
            icon={Video}
            label="Recordings"
            active={section.kind === "recordings"}
            onClick={() => setSection({ kind: "recordings" })}
          />
```

Add `Video` to the existing `lucide-react` import block:

```tsx
  Video,
```

(d) Add the route case in `renderContent`'s `switch`, after the `meetings` case:

```tsx
      case "recordings":
        return <RecordingsView />;
```

- [ ] **Step 4: Type-check the frontend**

Run: `bun run build 2>&1 | tail -25` (or the project's typecheck script if `bun run build` is too heavy; check `package.json` scripts)
Expected: no TypeScript errors referencing the new files.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/views/sections/RecordingsView.tsx src/views/Main.tsx
git commit -m "feat(screenrec): Recordings library view + record button"
```

---

## Task 8: End-to-end verification + capability/permission check

**Files:** none (verification only)

- [ ] **Step 1: Build the full app bundle**

Run: `bun tauri build --bundles app 2>&1 | tail -30`
Expected: builds an `.app` at `src-tauri/target/release/bundle/macos/Echo Scribe.app`. The build runs `build-screenrec.sh` (release mode) and bundles `echo-scribe-screenrec-<triple>`.

- [ ] **Step 2: Reinstall (skip-TCC — no permission code changed this phase)**

This phase adds no new Info.plist usage strings, no new entitlements, and no new webview window (the setup window is Phase 2), so per `CLAUDE.md` use the default skip-TCC reinstall:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 3: Manual end-to-end test**

In the running app:
1. Open the **Recordings** section from the left nav.
2. Click **Record screen**, interact with the screen ~5s (play a sound to test system audio), click **Stop recording**.
3. Confirm a new row appears with a thumbnail, duration, and size.
4. Select it — the `<video>` plays with picture **and** system audio.
5. **Reveal in Finder** opens the file in `~/Library/Application Support/EchoScribe/recordings/`.
6. **Delete** removes the row and the underlying `.mp4` + `.jpg`.

Expected: all six pass. If video records but is silent, system audio capture failed (check the sidecar's `excludesCurrentProcessAudio`/`capturesAudio` config). If "no shareable display"/`stream_stopped` appears in logs, Screen Recording permission needs granting — then a **full TCC reset reinstall** (per `CLAUDE.md`) may be required.

- [ ] **Step 4: Final commit (only if verification surfaced fixes)**

```bash
git add -A
git commit -m "fix(screenrec): phase 1 end-to-end verification fixes"
```

---

## Self-Review Notes

- **Spec coverage (Phase 1 subset):** capture display+system audio → MP4 (Tasks 1–3), `recordings` table (Task 4), supervisor (Task 5), commands (Task 6), library list/play/delete/reveal (Task 7), native-resolution + native aspect (Task 2 uses `display.width*2`/`height*2`, no conform). Deferred to later phases per spec: source picker/setup window, mic+mixing, menubar red state, hotkey, export presets, Drive — all explicitly out of Phase 1 scope.
- **Type consistency:** `RecordingRow` fields are identical across `db/recordings.rs`, the `stop_screen_recording` constructor, and `api.ts` (`RecordingRow` TS type). `StoppedInfo` fields (`path/dur_ms/width/height/size/thumb`) match the sidecar's `stopped` JSON keys and `parse_stopped`. Command names match between `commands.rs`, `generate_handler!`, and `api.ts` invoke strings.
- **Known verify-against-compiler spots:** (1) Swift `SCStreamFrameInfo`/`SCFrameStatus` attachment reading in `frameIsComplete`; (2) exact construction site of `AppState` in `lib.rs` (field initializer placement); (3) how `lib.rs` imports command fns for `generate_handler!`. Each step says to match the existing pattern.
```
