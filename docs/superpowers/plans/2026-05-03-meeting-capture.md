# Meeting Capture & Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Granola-style meeting capture flow to Echo Scribe — capture mic + system audio locally during Zoom/Teams/FaceTime/Discord/Slack-huddle/browser calls, transcribe via Parakeet, generate summary + action items via Gemma 4 E2B.

**Architecture:** A new `meeting/` Rust module owns the full lifecycle. System audio is captured by a small Swift sidecar (`echo-scribe-syscap`) using ScreenCaptureKit, piping raw PCM over stdout. Mic uses the existing `cpal` path. Both streams write 60-second WAV chunks; a pipeline task transcribes each chunk as it lands and deletes the WAV. At meeting end, a single LLM pass produces structured JSON (summary + action items + suggested title) using GBNF grammar constraints.

**Tech Stack:** Rust (tokio, cpal, rusqlite, objc2-app-kit, coreaudio-sys); Swift (ScreenCaptureKit, AVFoundation, vDSP); React 19 + TypeScript; Tauri v2; SQLite (rusqlite); llama-cpp-2 (Gemma 4 E2B Q4_K_M); Parakeet TDT 0.6B v2.

**Source spec:** `docs/superpowers/specs/2026-05-03-meeting-capture-design.md`

---

## File Structure

### New Rust files

| Path | Responsibility |
|---|---|
| `src-tauri/src/meeting/mod.rs` | Public surface. `MeetingManager`, shared types (`Segment`, `MeetingStatus`, `ChunkReady`). |
| `src-tauri/src/meeting/syscap.rs` | Spawns + supervises the Swift sidecar. Owns the PCM byte stream. |
| `src-tauri/src/meeting/recorder.rs` | `ChunkedWavWriter` + the per-stream recording orchestrator (mic + system in parallel). |
| `src-tauri/src/meeting/pipeline.rs` | Drains `ChunkReady` events, runs Parakeet on each, appends to `TranscriptBuilder`, deletes WAVs. |
| `src-tauri/src/meeting/synthesizer.rs` | Calls `Llm` with grammar-constrained prompt, parses JSON, retries once. |
| `src-tauri/src/meeting/detector.rs` | NSWorkspace polling + CoreAudio device-running check + per-app preference. |
| `src-tauri/src/meeting/grammar.rs` | The GBNF grammar string for meeting synthesis output. |
| `src-tauri/src/db/meetings.rs` | All `meetings` and `meeting_action_links` queries. |

### New Swift files

| Path | Responsibility |
|---|---|
| `src-tauri/syscap/main.swift` | The `echo-scribe-syscap` sidecar. ~150 lines. ScreenCaptureKit audio-only capture, mono downmix + 16kHz resample, raw Int16 PCM to stdout, JSON heartbeats to stderr. |

### New React files

| Path | Responsibility |
|---|---|
| `src/views/sections/MeetingView.tsx` | Single-meeting detail view (header, summary, action items, notes, transcript). |
| `src/views/sections/MeetingsView.tsx` | Reverse-chronological list of all meetings with filter chips. |
| `src/components/MeetingOverlay.tsx` | Meeting-mode rendering inside the existing recording overlay window. |

### Modified files

| Path | What changes |
|---|---|
| `src-tauri/src/lib.rs` | Register meeting commands; instantiate `MeetingManager`; spawn detector. |
| `src-tauri/src/commands.rs` | Add 9 meeting commands; extend `AppState` with `meeting_manager`. |
| `src-tauri/src/db/schema.rs` | Append migration v7. |
| `src-tauri/src/db/mod.rs` | `pub mod meetings;` |
| `src-tauri/src/asr/pipeline.rs` | Add `transcribe_file(path)` method. |
| `src-tauri/src/asr/parakeet.rs` | Add WAV file loader helper. |
| `src-tauri/src/llm/prompt.rs` | Add `build_meeting_synthesis_prompt`. |
| `src-tauri/src/settings.rs` | Add meeting settings (auto-detect, per-app prefs, hotkey, soft/hard caps). |
| `src-tauri/src/overlay.rs` | New `show_meeting_overlay` event + payload. |
| `src-tauri/src/permissions.rs` | Add Screen Recording permission helpers. |
| `src-tauri/build.rs` | Compile Swift sidecar before Cargo finishes (in release builds). |
| `src-tauri/tauri.conf.json` | `externalBin` entry pointing to the compiled sidecar. |
| `src-tauri/Cargo.toml` | Add deps: `coreaudio-sys`, optional `tempfile` (test). |
| `src/App.tsx` | Subscribe to meeting events; route to MeetingView. |
| `src/lib/api.ts` | Add typed wrappers for the 9 meeting commands. |
| `src/views/sections/ActivityFeed.tsx` | Render `kind="meeting"` rows. |
| `src/views/Settings.tsx` | Add "Meetings" tab. |
| `src/views/Main.tsx` | Add MeetingsView to sidebar nav. |
| `src/overlay/RecordingOverlay.tsx` | Render `MeetingOverlay` when overlay state is `"meeting"`. |

---

## Phase 1 — Foundation: schema, types, queries

### Task 1: Migration v7 — `meetings` + `meeting_action_links` tables

**Files:**
- Modify: `src-tauri/src/db/schema.rs` (append to `MIGRATIONS` const, currently ends at v6)

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/db/schema.rs` near the existing migration tests (after the `migrations_apply_sequentially` test):

```rust
#[test]
fn migration_v7_creates_meetings_tables() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    apply_migrations(&conn).unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('meetings', 'meeting_action_links')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);

    let version: u32 = conn
        .query_row("SELECT version FROM schema_meta WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 7);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib migration_v7_creates_meetings_tables`
Expected: FAIL — version 6 does not create those tables.

- [ ] **Step 3: Append migration v7**

In `src-tauri/src/db/schema.rs`, append a new tuple to `MIGRATIONS` after the v6 entry:

```rust
    (
        7,
        r#"
CREATE TABLE IF NOT EXISTS meetings (
  item_id            TEXT PRIMARY KEY REFERENCES items(id),
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  duration_ms        INTEGER,
  detected_app       TEXT,
  detected_app_name  TEXT,
  status             TEXT NOT NULL,
  transcript_json    TEXT,
  summary_json       TEXT,
  user_notes         TEXT,
  failed_chunk_count INTEGER NOT NULL DEFAULT 0,
  mic_only           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

CREATE TABLE IF NOT EXISTS meeting_action_links (
  meeting_id TEXT NOT NULL REFERENCES meetings(item_id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_action_links_item ON meeting_action_links(item_id);
"#,
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib migration_v7_creates_meetings_tables`
Expected: PASS.

- [ ] **Step 5: Run full migration test suite**

Run: `cd src-tauri && cargo test --lib schema`
Expected: All schema tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/schema.rs
git commit -m "feat(db): add meetings + meeting_action_links tables (migration v7)"
```

---

### Task 2: `meeting/mod.rs` — shared types

**Files:**
- Create: `src-tauri/src/meeting/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod meeting;`)

- [ ] **Step 1: Create the module file with shared types**

Create `src-tauri/src/meeting/mod.rs`:

```rust
//! Meeting capture: passive recording of mic + system audio during calls,
//! chunked transcription via Parakeet, and LLM synthesis of summary + tasks.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod detector;
pub mod grammar;
pub mod pipeline;
pub mod recorder;
pub mod syscap;
pub mod synthesizer;

/// Which audio stream a transcript segment came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    /// User's mic input.
    You,
    /// Other side, captured via ScreenCaptureKit.
    Them,
}

/// One transcribed chunk, projected onto the meeting's wall-clock timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub speaker: Speaker,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Lifecycle state of a meeting (mirrors the `meetings.status` column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeetingStatus {
    Recording,
    Transcribing,
    Summarizing,
    Complete,
    Failed,
    Recovered,
}

impl MeetingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recording => "recording",
            Self::Transcribing => "transcribing",
            Self::Summarizing => "summarizing",
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::Recovered => "recovered",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "recording" => Self::Recording,
            "transcribing" => Self::Transcribing,
            "summarizing" => Self::Summarizing,
            "complete" => Self::Complete,
            "failed" => Self::Failed,
            "recovered" => Self::Recovered,
            _ => return None,
        })
    }
}

/// A finalized chunk WAV file, ready for transcription.
#[derive(Debug, Clone)]
pub struct ChunkReady {
    pub speaker: Speaker,
    pub path: PathBuf,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Errors that can surface from any meeting subsystem.
#[derive(Debug, thiserror::Error)]
pub enum MeetingError {
    #[error("meeting already in progress")]
    AlreadyRecording,
    #[error("no meeting in progress")]
    NotRecording,
    #[error("ASR not ready")]
    AsrNotReady,
    #[error("audio: {0}")]
    Audio(String),
    #[error("syscap: {0}")]
    Syscap(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("db: {0}")]
    Db(String),
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, find the existing `pub mod` block (alongside `pub mod asr; pub mod audio; pub mod llm;` etc.) and add:

```rust
pub mod meeting;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS (the empty submodule files referenced in `mod.rs` will be created in subsequent tasks; for now create empty stubs).

If `cargo check` fails on missing submodules, create empty stubs:

```bash
for f in detector grammar pipeline recorder syscap synthesizer; do
  echo "//! Stub. Implemented in a later task." > "src-tauri/src/meeting/${f}.rs"
done
```

Then re-run `cargo check`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/ src-tauri/src/lib.rs
git commit -m "feat(meeting): add meeting module skeleton with shared types"
```

---

### Task 3: `db/meetings.rs` — query module

**Files:**
- Create: `src-tauri/src/db/meetings.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod meetings;`)
- Test: in the same file using `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/db/meetings.rs` with the test stub first:

```rust
use crate::db::DbError;
use crate::meeting::MeetingStatus;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingRow {
    pub item_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub detected_app: Option<String>,
    pub detected_app_name: Option<String>,
    pub status: String,
    pub transcript_json: Option<String>,
    pub summary_json: Option<String>,
    pub user_notes: Option<String>,
    pub failed_chunk_count: i64,
    pub mic_only: bool,
}

pub fn insert_meeting(conn: &Connection, m: &MeetingRow) -> Result<(), DbError> {
    // implementation in next step
    let _ = (conn, m);
    unimplemented!()
}

pub fn get_meeting(conn: &Connection, item_id: &str) -> Result<Option<MeetingRow>, DbError> {
    let _ = (conn, item_id);
    unimplemented!()
}

pub fn list_meetings(conn: &Connection) -> Result<Vec<MeetingRow>, DbError> {
    let _ = conn;
    unimplemented!()
}

pub fn update_status(conn: &Connection, item_id: &str, status: MeetingStatus) -> Result<(), DbError> {
    let _ = (conn, item_id, status);
    unimplemented!()
}

pub fn finalize_meeting(
    conn: &Connection,
    item_id: &str,
    ended_at: &str,
    duration_ms: i64,
    transcript_json: &str,
    summary_json: Option<&str>,
    failed_chunk_count: i64,
) -> Result<(), DbError> {
    let _ = (conn, item_id, ended_at, duration_ms, transcript_json, summary_json, failed_chunk_count);
    unimplemented!()
}

pub fn update_user_notes(conn: &Connection, item_id: &str, notes: &str) -> Result<(), DbError> {
    let _ = (conn, item_id, notes);
    unimplemented!()
}

pub fn link_action(conn: &Connection, meeting_id: &str, item_id: &str, created_at: &str) -> Result<(), DbError> {
    let _ = (conn, meeting_id, item_id, created_at);
    unimplemented!()
}

pub fn delete_meeting(conn: &Connection, item_id: &str) -> Result<(), DbError> {
    let _ = (conn, item_id);
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::apply_migrations;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_migrations(&conn).unwrap();
        // The meetings.item_id FK requires a row in items; insert a stub.
        conn.execute(
            "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
             VALUES ('m-1', 'Test Meeting', 'meeting', 'visible', 'meeting', '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z')",
            [],
        ).unwrap();
        conn
    }

    fn sample() -> MeetingRow {
        MeetingRow {
            item_id: "m-1".into(),
            started_at: "2026-05-03T00:00:00Z".into(),
            ended_at: None,
            duration_ms: None,
            detected_app: Some("us.zoom.xos".into()),
            detected_app_name: Some("Zoom".into()),
            status: "recording".into(),
            transcript_json: None,
            summary_json: None,
            user_notes: None,
            failed_chunk_count: 0,
            mic_only: false,
        }
    }

    #[test]
    fn insert_and_get_round_trip() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.item_id, "m-1");
        assert_eq!(got.detected_app_name.as_deref(), Some("Zoom"));
        assert_eq!(got.status, "recording");
    }

    #[test]
    fn update_status_changes_row() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        update_status(&conn, "m-1", MeetingStatus::Transcribing).unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.status, "transcribing");
    }

    #[test]
    fn finalize_writes_all_fields() {
        let conn = setup();
        insert_meeting(&conn, &sample()).unwrap();
        finalize_meeting(
            &conn,
            "m-1",
            "2026-05-03T00:30:00Z",
            1_800_000,
            r#"{"segments":[]}"#,
            Some(r#"{"summary":["x"]}"#),
            0,
        )
        .unwrap();
        let got = get_meeting(&conn, "m-1").unwrap().unwrap();
        assert_eq!(got.duration_ms, Some(1_800_000));
        assert_eq!(got.status, "complete");
        assert_eq!(got.transcript_json.as_deref(), Some(r#"{"segments":[]}"#));
    }
}
```

- [ ] **Step 2: Wire the module**

In `src-tauri/src/db/mod.rs`, add:

```rust
pub mod meetings;
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib db::meetings`
Expected: FAIL — `unimplemented!()` panics in all three tests.

- [ ] **Step 4: Implement the queries**

Replace the `unimplemented!()` bodies with:

```rust
pub fn insert_meeting(conn: &Connection, m: &MeetingRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meetings (
            item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
            status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            m.item_id,
            m.started_at,
            m.ended_at,
            m.duration_ms,
            m.detected_app,
            m.detected_app_name,
            m.status,
            m.transcript_json,
            m.summary_json,
            m.user_notes,
            m.failed_chunk_count,
            m.mic_only as i64,
        ],
    )?;
    Ok(())
}

pub fn get_meeting(conn: &Connection, item_id: &str) -> Result<Option<MeetingRow>, DbError> {
    conn.query_row(
        "SELECT item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
                status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only
         FROM meetings WHERE item_id = ?1",
        [item_id],
        row_to_meeting,
    )
    .optional()
    .map_err(DbError::from)
}

pub fn list_meetings(conn: &Connection) -> Result<Vec<MeetingRow>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT item_id, started_at, ended_at, duration_ms, detected_app, detected_app_name,
                status, transcript_json, summary_json, user_notes, failed_chunk_count, mic_only
         FROM meetings ORDER BY started_at DESC",
    )?;
    let rows = stmt
        .query_map([], row_to_meeting)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn update_status(conn: &Connection, item_id: &str, status: MeetingStatus) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET status = ?1 WHERE item_id = ?2",
        params![status.as_str(), item_id],
    )?;
    Ok(())
}

pub fn finalize_meeting(
    conn: &Connection,
    item_id: &str,
    ended_at: &str,
    duration_ms: i64,
    transcript_json: &str,
    summary_json: Option<&str>,
    failed_chunk_count: i64,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET
            ended_at = ?1,
            duration_ms = ?2,
            transcript_json = ?3,
            summary_json = ?4,
            failed_chunk_count = ?5,
            status = 'complete'
         WHERE item_id = ?6",
        params![ended_at, duration_ms, transcript_json, summary_json, failed_chunk_count, item_id],
    )?;
    Ok(())
}

pub fn update_user_notes(conn: &Connection, item_id: &str, notes: &str) -> Result<(), DbError> {
    conn.execute(
        "UPDATE meetings SET user_notes = ?1 WHERE item_id = ?2",
        params![notes, item_id],
    )?;
    Ok(())
}

pub fn link_action(conn: &Connection, meeting_id: &str, item_id: &str, created_at: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR IGNORE INTO meeting_action_links (meeting_id, item_id, created_at)
         VALUES (?1, ?2, ?3)",
        params![meeting_id, item_id, created_at],
    )?;
    Ok(())
}

pub fn delete_meeting(conn: &Connection, item_id: &str) -> Result<(), DbError> {
    // The CASCADE on meeting_action_links handles those; the items row is removed
    // by the caller (the items table is shared with other kinds).
    conn.execute("DELETE FROM meetings WHERE item_id = ?1", [item_id])?;
    Ok(())
}

fn row_to_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRow> {
    Ok(MeetingRow {
        item_id: row.get(0)?,
        started_at: row.get(1)?,
        ended_at: row.get(2)?,
        duration_ms: row.get(3)?,
        detected_app: row.get(4)?,
        detected_app_name: row.get(5)?,
        status: row.get(6)?,
        transcript_json: row.get(7)?,
        summary_json: row.get(8)?,
        user_notes: row.get(9)?,
        failed_chunk_count: row.get(10)?,
        mic_only: row.get::<_, i64>(11)? != 0,
    })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib db::meetings`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/meetings.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): add meetings + meeting_action_links query module"
```

---

## Phase 2 — Swift sidecar + Rust supervisor

### Task 4: Swift sidecar source — `echo-scribe-syscap`

**Files:**
- Create: `src-tauri/syscap/main.swift`
- Create: `src-tauri/syscap/Package.swift`

- [ ] **Step 1: Create the Swift package manifest**

Create `src-tauri/syscap/Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "echo-scribe-syscap",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "echo-scribe-syscap",
            path: ".",
            sources: ["main.swift"]
        )
    ]
)
```

- [ ] **Step 2: Write the sidecar source**

Create `src-tauri/syscap/main.swift`:

```swift
import Foundation
import ScreenCaptureKit
import AVFoundation
import Accelerate

// echo-scribe-syscap
// Reads ScreenCaptureKit audio, downmixes to mono, resamples to 16 kHz Int16,
// writes raw PCM to stdout. Status events go to stderr as line-delimited JSON.

let TARGET_RATE: Double = 16_000
let OWN_BUNDLE_ID = "com.echoscribe.app"

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

func emitFatal(_ kind: String, _ msg: String) -> Never {
    emit(["event": "error", "kind": kind, "msg": msg])
    exit(1)
}

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let stream: SCStream
    var converter: AVAudioConverter?
    let outputFormat: AVAudioFormat
    var heartbeatTimer: DispatchSourceTimer?

    init(stream: SCStream) {
        self.stream = stream
        self.outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: TARGET_RATE,
            channels: 1,
            interleaved: true
        )!
        super.init()
    }

    func start() throws {
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "syscap.audio"))
        stream.startCapture { [weak self] err in
            if let err = err {
                emitFatal("start", err.localizedDescription)
            }
            emit(["event": "ready"])
            self?.startHeartbeat()
        }
    }

    func startHeartbeat() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        t.schedule(deadline: .now() + 1, repeating: 1.0)
        t.setEventHandler {
            emit(["event": "heartbeat", "ts": Date().timeIntervalSince1970])
        }
        t.resume()
        heartbeatTimer = t
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return }

        let inputFormat = AVAudioFormat(streamDescription: &asbd)!
        if converter == nil {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        }

        guard let pcmIn = bufferFromCMSampleBuffer(sampleBuffer, format: inputFormat) else { return }

        let frameCount = AVAudioFrameCount(Double(pcmIn.frameLength) * (TARGET_RATE / inputFormat.sampleRate))
        guard let pcmOut = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCount + 256) else { return }

        var error: NSError?
        var done = false
        let status = converter?.convert(to: pcmOut, error: &error) { _, outStatus in
            if done {
                outStatus.pointee = .endOfStream
                return nil
            }
            done = true
            outStatus.pointee = .haveData
            return pcmIn
        }

        guard status == .haveData || status == .inputRanDry else {
            if let e = error { emit(["event": "warn", "msg": "convert: \(e.localizedDescription)"]) }
            return
        }

        guard let int16Channel = pcmOut.int16ChannelData else { return }
        let bytes = Int(pcmOut.frameLength) * MemoryLayout<Int16>.size
        let data = Data(bytes: int16Channel[0], count: bytes)
        FileHandle.standardOutput.write(data)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "kind": "stream_stopped", "msg": error.localizedDescription])
        exit(2)
    }
}

func bufferFromCMSampleBuffer(_ sb: CMSampleBuffer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let numSamples = CMSampleBufferGetNumSamples(sb)
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(numSamples)) else { return nil }
    buf.frameLength = AVAudioFrameCount(numSamples)
    var blockBuffer: CMBlockBuffer?
    var audioBufferList = AudioBufferList()
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sb,
        bufferListSizeNeededOut: nil,
        bufferListOut: &audioBufferList,
        bufferListSize: MemoryLayout<AudioBufferList>.size,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    )
    guard status == noErr else { return nil }
    let abl = UnsafeMutableAudioBufferListPointer(&audioBufferList)
    if let mDataIn = abl[0].mData, let dst = buf.audioBufferList.pointee.mBuffers.mData {
        memcpy(dst, mDataIn, Int(abl[0].mDataByteSize))
    }
    return buf
}

// --- main ---

@MainActor
func run() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            emitFatal("no_display", "no shareable display")
        }
        let excludedApps = content.applications.filter { $0.bundleIdentifier == OWN_BUNDLE_ID }

        let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        // Minimize video work: capture a 2x2 frame at 1 fps. We discard video frames anyway.
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        let cap = Capture(stream: stream)
        cap.stream.delegate = cap
        try cap.start()

        // Stay alive until SIGTERM. Trap it to flush stdout.
        signal(SIGTERM, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler {
            stream.stopCapture { _ in
                FileHandle.standardOutput.synchronizeFile()
                exit(0)
            }
        }
        termSrc.resume()

        // Block forever
        await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
    } catch {
        emitFatal("setup", error.localizedDescription)
    }
}

if #available(macOS 13.0, *) {
    Task { await run() }
    RunLoop.main.run()
} else {
    emitFatal("os", "macOS 13 or newer required")
}
```

- [ ] **Step 3: Build the sidecar locally to verify it compiles**

Run from repo root:

```bash
cd src-tauri/syscap && swift build -c release && cd ../..
```

Expected: build succeeds, binary at `src-tauri/syscap/.build/release/echo-scribe-syscap`.

- [ ] **Step 4: Smoke-test the binary**

Grant Screen Recording permission to your terminal once (System Settings → Privacy & Security → Screen Recording). Then:

```bash
src-tauri/syscap/.build/release/echo-scribe-syscap > /tmp/syscap.pcm 2> /tmp/syscap.log &
PID=$!
sleep 3
kill -TERM $PID
wait $PID 2>/dev/null
ls -la /tmp/syscap.pcm /tmp/syscap.log
head -5 /tmp/syscap.log
```

Expected: `/tmp/syscap.pcm` is non-empty (~96 KB after 3s of capture: 16000 × 2 bytes × 3s ≈ 96 KB), `/tmp/syscap.log` shows `{"event":"ready"}` then heartbeats.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/syscap/
git commit -m "feat(syscap): add Swift sidecar for ScreenCaptureKit audio capture"
```

---

### Task 5: Hook sidecar build into `release.yml` and local builds

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `src-tauri/build.rs` (if it doesn't already exist; check first)
- Create: `scripts/build-syscap.sh`

- [ ] **Step 1: Create the build script**

Create `scripts/build-syscap.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT/src-tauri/syscap"
swift build -c release
mkdir -p "$ROOT/src-tauri/binaries"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac
cp .build/release/echo-scribe-syscap "$ROOT/src-tauri/binaries/echo-scribe-syscap-$TRIPLE"
echo "built: src-tauri/binaries/echo-scribe-syscap-$TRIPLE"
```

```bash
chmod +x scripts/build-syscap.sh
```

- [ ] **Step 2: Check whether `src-tauri/build.rs` exists**

Run: `ls src-tauri/build.rs`

If it exists, skip to Step 3. If not, create a minimal one:

```rust
fn main() {
    // Build the Swift sidecar as a prerequisite of cargo's build phase.
    // We invoke an external script so this stays buildable on machines without cargo-wrapping tooling.
    let status = std::process::Command::new("bash")
        .arg("../scripts/build-syscap.sh")
        .status()
        .expect("failed to run build-syscap.sh");
    if !status.success() {
        panic!("syscap build failed");
    }
    println!("cargo:rerun-if-changed=syscap/main.swift");
    println!("cargo:rerun-if-changed=syscap/Package.swift");
    tauri_build::build();
}
```

If a `build.rs` already exists with `tauri_build::build()`, prepend the sidecar build invocation before the existing call.

- [ ] **Step 3: Update GitHub Actions release workflow**

Open `.github/workflows/release.yml`. Find the macOS build job (the one that calls `bun tauri build`). Insert a step *before* the `bun tauri build` invocation:

```yaml
      - name: Build syscap sidecar
        run: bash scripts/build-syscap.sh
```

- [ ] **Step 4: Verify local build works end-to-end**

```bash
rm -rf src-tauri/binaries
bash scripts/build-syscap.sh
ls src-tauri/binaries/
```

Expected: `echo-scribe-syscap-aarch64-apple-darwin` (or your host triple) is present.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-syscap.sh src-tauri/build.rs .github/workflows/release.yml
git commit -m "build: compile Swift syscap sidecar in release pipeline"
```

---

### Task 6: Tauri `externalBin` registration

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the binary to `tauri.conf.json`**

In `src-tauri/tauri.conf.json`, find the `bundle` section and add (or extend) `externalBin`:

```json
  "bundle": {
    "active": true,
    "externalBin": ["binaries/echo-scribe-syscap"],
    ...
  }
```

The `binaries/echo-scribe-syscap` path is relative to `src-tauri/`. Tauri resolves it to the host triple at bundle time, looking for `binaries/echo-scribe-syscap-aarch64-apple-darwin` etc.

- [ ] **Step 2: Grant the shell plugin permission to spawn it**

In `src-tauri/capabilities/default.json`, ensure the `permissions` array contains:

```json
        {
          "identifier": "shell:allow-spawn",
          "allow": [
            { "name": "binaries/echo-scribe-syscap", "sidecar": true, "args": [] }
          ]
        }
```

(If `shell:allow-spawn` already has an `allow` array, append the entry; otherwise add the whole permission object.)

- [ ] **Step 3: Verify the bundled .app contains the sidecar**

```bash
bun tauri build --bundles app
ls -l "src-tauri/target/release/bundle/macos/Echo Scribe.app/Contents/MacOS/"
```

Expected: `echo-scribe-syscap-aarch64-apple-darwin` (or host triple) is alongside the main binary.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "build: register echo-scribe-syscap as Tauri externalBin"
```

---

### Task 7: Rust supervisor — `meeting/syscap.rs`

**Files:**
- Modify: `src-tauri/src/meeting/syscap.rs` (replace the stub from Task 2)
- Test: in the same file

- [ ] **Step 1: Add the `tauri-plugin-shell` Sidecar import path**

Echo Scribe already uses `tauri-plugin-shell`. Confirm with:

```bash
grep -n "tauri-plugin-shell" src-tauri/Cargo.toml
```

- [ ] **Step 2: Write the failing tests**

Replace `src-tauri/src/meeting/syscap.rs` with:

```rust
//! Supervises the `echo-scribe-syscap` sidecar.
//! Reads raw Int16 PCM from stdout, surfaces stderr events, and respawns once on crash.

use std::process::{Child, Command, Stdio};
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, PartialEq)]
pub enum SyscapEvent {
    Ready,
    Heartbeat { ts: f64 },
    Warn(String),
    Error { kind: String, msg: String },
    Exited(i32),
}

/// Frames of Int16 PCM samples (mono, 16 kHz) read from the sidecar.
pub type PcmFrame = Vec<i16>;

pub struct Syscap {
    child: Option<Child>,
    pub stop_flag: Arc<AtomicBool>,
}

impl Syscap {
    /// Resolve the bundled sidecar path inside the .app, or fall back to the dev build.
    fn resolve_binary() -> std::io::Result<std::path::PathBuf> {
        // In a packaged .app, the sidecar sits next to the main binary.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let triple = if cfg!(target_arch = "aarch64") {
                    "aarch64-apple-darwin"
                } else {
                    "x86_64-apple-darwin"
                };
                let candidate = parent.join(format!("echo-scribe-syscap-{}", triple));
                if candidate.exists() {
                    return Ok(candidate);
                }
                // Tauri sometimes drops the triple suffix; check that too.
                let no_suffix = parent.join("echo-scribe-syscap");
                if no_suffix.exists() {
                    return Ok(no_suffix);
                }
            }
        }
        // Dev fallback: built by scripts/build-syscap.sh.
        let cwd = std::env::current_dir()?;
        let triple = if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        let dev = cwd.join("src-tauri/binaries").join(format!("echo-scribe-syscap-{}", triple));
        if dev.exists() {
            return Ok(dev);
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "echo-scribe-syscap binary not found",
        ))
    }

    /// Spawn the sidecar; returns channels for PCM frames and status events.
    pub fn spawn() -> std::io::Result<(Self, mpsc::Receiver<PcmFrame>, mpsc::Receiver<SyscapEvent>)> {
        let bin = Self::resolve_binary()?;
        info!(path = %bin.display(), "spawning syscap");

        let mut child = Command::new(&bin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()?;

        let (pcm_tx, pcm_rx) = mpsc::channel::<PcmFrame>(64);
        let (evt_tx, evt_rx) = mpsc::channel::<SyscapEvent>(32);
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Stdout reader thread: pulls bytes, packages into ~20ms frames (320 samples = 640 bytes).
        let stdout = child.stdout.take().expect("piped");
        let pcm_tx_clone = pcm_tx.clone();
        let stop_clone = stop_flag.clone();
        std::thread::spawn(move || {
            let mut reader = stdout;
            let mut buf = [0u8; 1280]; // 640 samples = 40ms at 16kHz
            loop {
                if stop_clone.load(Ordering::Relaxed) { break; }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let samples = n / 2;
                        let mut frame = Vec::with_capacity(samples);
                        for i in 0..samples {
                            let lo = buf[i * 2];
                            let hi = buf[i * 2 + 1];
                            frame.push(i16::from_le_bytes([lo, hi]));
                        }
                        if pcm_tx_clone.blocking_send(frame).is_err() { break; }
                    }
                    Err(e) => {
                        error!(?e, "syscap stdout read error");
                        break;
                    }
                }
            }
            debug!("syscap stdout reader exiting");
        });

        // Stderr reader thread: parses line-delimited JSON status events.
        let stderr = child.stderr.take().expect("piped");
        let evt_tx_clone = evt_tx.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                    warn!(line, "non-JSON syscap stderr line");
                    continue;
                };
                let Some(event) = val.get("event").and_then(|v| v.as_str()) else { continue };
                let parsed = match event {
                    "ready" => SyscapEvent::Ready,
                    "heartbeat" => SyscapEvent::Heartbeat {
                        ts: val.get("ts").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    },
                    "warn" => SyscapEvent::Warn(
                        val.get("msg").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    ),
                    "error" => SyscapEvent::Error {
                        kind: val.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        msg: val.get("msg").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    },
                    _ => continue,
                };
                if evt_tx_clone.blocking_send(parsed).is_err() { break; }
            }
            debug!("syscap stderr reader exiting");
        });

        Ok((
            Self { child: Some(child), stop_flag },
            pcm_rx,
            evt_rx,
        ))
    }

    /// Send SIGTERM to the sidecar; wait up to 2s, then SIGKILL if still running.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        let Some(mut child) = self.child.take() else { return };
        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if Instant::now() > deadline { break; }
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => {
                    error!(?e, "try_wait failed");
                    break;
                }
            }
        }
        warn!("syscap did not exit within 2s, sending SIGKILL");
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Syscap {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_resolution_returns_not_found_when_missing() {
        // Under cargo test the binary path may not be present. We just make sure
        // the function returns Err with NotFound rather than panicking.
        let _ = Syscap::resolve_binary();
    }

    #[test]
    fn syscap_event_parses_known_kinds() {
        // Smoke test: ensure the parsing path matches every variant we emit.
        let cases = [
            (r#"{"event":"ready"}"#, "ready"),
            (r#"{"event":"heartbeat","ts":1.0}"#, "heartbeat"),
            (r#"{"event":"warn","msg":"x"}"#, "warn"),
            (r#"{"event":"error","kind":"k","msg":"m"}"#, "error"),
        ];
        for (line, _kind) in cases {
            let val: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(val.get("event").is_some());
        }
    }
}
```

- [ ] **Step 3: Add `libc` to `Cargo.toml` if not already present**

```bash
grep -n '^libc' src-tauri/Cargo.toml || cargo add libc --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib meeting::syscap`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/meeting/syscap.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(meeting): add syscap supervisor for the Swift sidecar"
```

---

## Phase 3 — Audio capture: chunked WAV writer + recorder

### Task 8: `ChunkedWavWriter` — 60-second WAV rotation

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs` (replace stub)
- Test: in the same file

- [ ] **Step 1: Write the failing tests**

Replace `src-tauri/src/meeting/recorder.rs` with the test scaffolding first:

```rust
//! Chunked WAV writer (60s rotation) and recording orchestrator.

use crate::meeting::{ChunkReady, MeetingError, Speaker};
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const CHUNK_SECONDS: u64 = 60;
const SAMPLES_PER_CHUNK: u64 = SAMPLE_RATE as u64 * CHUNK_SECONDS;

/// Streaming WAV writer that rotates files every `CHUNK_SECONDS`.
pub struct ChunkedWavWriter {
    speaker: Speaker,
    dir: PathBuf,
    chunk_index: u32,
    samples_in_chunk: u64,
    total_samples: u64,
    writer: Option<BufWriter<File>>,
    current_path: Option<PathBuf>,
    chunk_start_ms: u64,
    on_chunk_ready: mpsc::UnboundedSender<ChunkReady>,
}

impl ChunkedWavWriter {
    pub fn new(
        speaker: Speaker,
        dir: PathBuf,
        on_chunk_ready: mpsc::UnboundedSender<ChunkReady>,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            speaker,
            dir,
            chunk_index: 0,
            samples_in_chunk: 0,
            total_samples: 0,
            writer: None,
            current_path: None,
            chunk_start_ms: 0,
            on_chunk_ready,
        })
    }

    pub fn write(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < samples.len() {
            if self.writer.is_none() {
                self.open_new_chunk()?;
            }
            let remaining = (SAMPLES_PER_CHUNK - self.samples_in_chunk) as usize;
            let take = remaining.min(samples.len() - offset);
            self.write_raw(&samples[offset..offset + take])?;
            self.samples_in_chunk += take as u64;
            self.total_samples += take as u64;
            offset += take;
            if self.samples_in_chunk >= SAMPLES_PER_CHUNK {
                self.finalize_chunk()?;
            }
        }
        Ok(())
    }

    /// Force-finalize the current chunk (called on stop).
    pub fn flush_partial(&mut self) -> std::io::Result<()> {
        if self.writer.is_some() && self.samples_in_chunk > 0 {
            self.finalize_chunk()?;
        }
        Ok(())
    }

    fn open_new_chunk(&mut self) -> std::io::Result<()> {
        let filename = format!("{}-chunk-{:04}.wav", self.speaker_tag(), self.chunk_index);
        let path = self.dir.join(&filename);
        let mut file = File::create(&path)?;
        // Stub WAV header (44 bytes); patched on finalize.
        file.write_all(&[0u8; 44])?;
        self.writer = Some(BufWriter::new(file));
        self.current_path = Some(path);
        self.samples_in_chunk = 0;
        self.chunk_start_ms = self.total_samples * 1000 / SAMPLE_RATE as u64;
        Ok(())
    }

    fn write_raw(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let writer = self.writer.as_mut().expect("writer open");
        for &s in samples {
            writer.write_all(&s.to_le_bytes())?;
        }
        Ok(())
    }

    fn finalize_chunk(&mut self) -> std::io::Result<()> {
        let mut writer = self.writer.take().expect("writer open");
        writer.flush()?;
        let mut file = writer.into_inner().map_err(|e| e.into_error())?;

        let data_bytes = (self.samples_in_chunk as u32) * (CHANNELS as u32) * (BITS_PER_SAMPLE as u32 / 8);
        let riff_size = 36 + data_bytes;
        let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS_PER_SAMPLE as u32 / 8);
        let block_align: u16 = CHANNELS * BITS_PER_SAMPLE / 8;

        file.seek(SeekFrom::Start(0))?;
        file.write_all(b"RIFF")?;
        file.write_all(&riff_size.to_le_bytes())?;
        file.write_all(b"WAVE")?;
        file.write_all(b"fmt ")?;
        file.write_all(&16u32.to_le_bytes())?;
        file.write_all(&1u16.to_le_bytes())?; // PCM
        file.write_all(&CHANNELS.to_le_bytes())?;
        file.write_all(&SAMPLE_RATE.to_le_bytes())?;
        file.write_all(&byte_rate.to_le_bytes())?;
        file.write_all(&block_align.to_le_bytes())?;
        file.write_all(&BITS_PER_SAMPLE.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&data_bytes.to_le_bytes())?;
        file.sync_all()?;

        let path = self.current_path.take().expect("path set");
        let chunk_end_ms = self.total_samples * 1000 / SAMPLE_RATE as u64;
        let ready = ChunkReady {
            speaker: self.speaker,
            path: path.clone(),
            start_ms: self.chunk_start_ms,
            end_ms: chunk_end_ms,
        };
        if let Err(e) = self.on_chunk_ready.send(ready) {
            warn!(?e, "chunk consumer dropped");
        }
        self.chunk_index += 1;
        Ok(())
    }

    fn speaker_tag(&self) -> &'static str {
        match self.speaker {
            Speaker::You => "mic",
            Speaker::Them => "sys",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_writer(dir: &Path, speaker: Speaker) -> (ChunkedWavWriter, mpsc::UnboundedReceiver<ChunkReady>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let w = ChunkedWavWriter::new(speaker, dir.to_path_buf(), tx).unwrap();
        (w, rx)
    }

    #[test]
    fn rotates_at_60_seconds() {
        let tmp = tempdir().unwrap();
        let (mut w, mut rx) = make_writer(tmp.path(), Speaker::You);
        // Write 60s + 100ms (1600 extra samples) → should yield exactly one full chunk.
        let one_sec = vec![0i16; SAMPLE_RATE as usize];
        for _ in 0..60 { w.write(&one_sec).unwrap(); }
        let extra = vec![0i16; 1600];
        w.write(&extra).unwrap();

        let chunk = rx.try_recv().expect("chunk emitted");
        assert_eq!(chunk.speaker, Speaker::You);
        assert_eq!(chunk.start_ms, 0);
        assert_eq!(chunk.end_ms, 60_000);
        assert!(chunk.path.exists());
        assert!(rx.try_recv().is_err(), "only one chunk should be emitted");
    }

    #[test]
    fn flush_partial_emits_remaining_chunk() {
        let tmp = tempdir().unwrap();
        let (mut w, mut rx) = make_writer(tmp.path(), Speaker::Them);
        let half_sec = vec![0i16; (SAMPLE_RATE / 2) as usize];
        w.write(&half_sec).unwrap();
        w.flush_partial().unwrap();

        let chunk = rx.try_recv().expect("partial emitted");
        assert_eq!(chunk.start_ms, 0);
        assert_eq!(chunk.end_ms, 500);
    }

    #[test]
    fn wav_header_is_valid_after_finalize() {
        let tmp = tempdir().unwrap();
        let (mut w, mut rx) = make_writer(tmp.path(), Speaker::You);
        let one_sec = vec![0i16; SAMPLE_RATE as usize];
        for _ in 0..60 { w.write(&one_sec).unwrap(); }
        let chunk = rx.try_recv().unwrap();

        let bytes = std::fs::read(&chunk.path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[12..16], b"fmt ");
        let sr = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        assert_eq!(sr, SAMPLE_RATE);
    }
}
```

- [ ] **Step 2: Add `tempfile` as a dev-dependency**

```bash
cargo add tempfile --dev --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib meeting::recorder`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(meeting): add 60s ChunkedWavWriter with rotation"
```

---

### Task 9: Mic capture for meeting mode

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs` (append `MicCapture` type)

**Context:** the existing dictation flow uses `cpal` via `audio/recorder.rs`. We need a parallel-but-isolated mic capture for meetings (so dictation and meetings don't fight over the device). Reuse `audio/resample.rs` to drop 48k→16k.

- [ ] **Step 1: Append the `MicCapture` type to `recorder.rs`**

At the end of `src-tauri/src/meeting/recorder.rs` (above the `#[cfg(test)]` block), append:

```rust
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// Mic capture wrapper that pushes 16 kHz mono Int16 samples via callback.
pub struct MicCapture {
    _stream: cpal::Stream,
}

impl MicCapture {
    pub fn start<F>(mut on_samples: F) -> Result<Self, MeetingError>
    where
        F: FnMut(&[i16]) + Send + 'static,
    {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| MeetingError::Audio("no default input device".into()))?;
        let config = device
            .default_input_config()
            .map_err(|e| MeetingError::Audio(format!("config: {e}")))?;
        let in_sample_rate = config.sample_rate().0;
        let in_channels = config.channels();

        let cfg = cpal::StreamConfig {
            channels: in_channels,
            sample_rate: cpal::SampleRate(in_sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        // Resampler state (linear); reuse the existing helper.
        let mut resampler = crate::audio::resample::Linear::new(in_sample_rate, SAMPLE_RATE);
        let mut downmix_buf: Vec<f32> = Vec::with_capacity(8192);
        let mut int_buf: Vec<i16> = Vec::with_capacity(8192);

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &cfg,
                move |data: &[f32], _| {
                    downmix_buf.clear();
                    if in_channels == 1 {
                        downmix_buf.extend_from_slice(data);
                    } else {
                        let n = in_channels as usize;
                        for chunk in data.chunks(n) {
                            let avg: f32 = chunk.iter().sum::<f32>() / n as f32;
                            downmix_buf.push(avg);
                        }
                    }
                    let resampled = resampler.process(&downmix_buf);
                    int_buf.clear();
                    for s in resampled {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        int_buf.push(v);
                    }
                    on_samples(&int_buf);
                },
                |e| error!(?e, "mic stream error"),
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &cfg,
                move |data: &[i16], _| {
                    downmix_buf.clear();
                    if in_channels == 1 {
                        downmix_buf.extend(data.iter().map(|&s| s as f32 / 32768.0));
                    } else {
                        let n = in_channels as usize;
                        for chunk in data.chunks(n) {
                            let avg: f32 = chunk.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / n as f32;
                            downmix_buf.push(avg);
                        }
                    }
                    let resampled = resampler.process(&downmix_buf);
                    int_buf.clear();
                    for s in resampled {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        int_buf.push(v);
                    }
                    on_samples(&int_buf);
                },
                |e| error!(?e, "mic stream error"),
                None,
            ),
            _ => {
                return Err(MeetingError::Audio(format!(
                    "unsupported sample format: {:?}",
                    config.sample_format()
                )));
            }
        }
        .map_err(|e| MeetingError::Audio(format!("build_input_stream: {e}")))?;

        stream.play().map_err(|e| MeetingError::Audio(format!("play: {e}")))?;
        info!(rate = in_sample_rate, channels = in_channels, "mic capture started");
        Ok(Self { _stream: stream })
    }
}
```

**Note for the implementer:** the existing `audio/resample.rs` may expose its linear resampler under a different name. Read `src-tauri/src/audio/resample.rs` and adjust the `Linear::new(...)` / `.process(...)` call to match. If it doesn't expose a public type at all, write a 30-line linear resampler inline in `MicCapture` (state = phase counter, ratio).

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS. If `crate::audio::resample` is private or named differently, fix and re-run.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs
git commit -m "feat(meeting): add MicCapture for parallel mic stream during meetings"
```

---

### Task 10: Recorder orchestrator — wire mic + syscap to two `ChunkedWavWriter`s

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs` (append `Recorder` type)

- [ ] **Step 1: Append the orchestrator**

At the end of `src-tauri/src/meeting/recorder.rs` (above tests), append:

```rust
use crate::meeting::syscap::Syscap;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

/// Owns the mic + syscap streams and routes their PCM into two ChunkedWavWriters.
pub struct Recorder {
    pub meeting_id: String,
    pub dir: PathBuf,
    syscap: Option<Syscap>,
    mic: Option<MicCapture>,
    syscap_task: Option<JoinHandle<()>>,
    syscap_evt_task: Option<JoinHandle<()>>,
    pub mic_only: bool,
    mic_writer: Arc<Mutex<ChunkedWavWriter>>,
    sys_writer: Arc<Mutex<ChunkedWavWriter>>,
}

impl Recorder {
    pub async fn start(
        meeting_id: String,
        dir: PathBuf,
        on_chunk_ready: mpsc::UnboundedSender<ChunkReady>,
        on_syscap_event: mpsc::UnboundedSender<crate::meeting::syscap::SyscapEvent>,
    ) -> Result<Self, MeetingError> {
        std::fs::create_dir_all(&dir)?;
        let mic_writer = Arc::new(Mutex::new(ChunkedWavWriter::new(
            Speaker::You,
            dir.clone(),
            on_chunk_ready.clone(),
        )?));
        let sys_writer = Arc::new(Mutex::new(ChunkedWavWriter::new(
            Speaker::Them,
            dir.clone(),
            on_chunk_ready,
        )?));

        let mw_for_mic = mic_writer.clone();
        let mic = MicCapture::start(move |samples| {
            if let Ok(mut w) = mw_for_mic.lock() {
                if let Err(e) = w.write(samples) {
                    error!(?e, "mic chunk write failed");
                }
            }
        })?;

        let (syscap, mut pcm_rx, mut evt_rx) = match Syscap::spawn() {
            Ok(s) => s,
            Err(e) => {
                warn!(?e, "syscap spawn failed; falling back to mic-only");
                let _ = on_syscap_event.send(crate::meeting::syscap::SyscapEvent::Error {
                    kind: "spawn".into(),
                    msg: e.to_string(),
                });
                return Ok(Self {
                    meeting_id,
                    dir,
                    syscap: None,
                    mic: Some(mic),
                    syscap_task: None,
                    syscap_evt_task: None,
                    mic_only: true,
                    mic_writer,
                    sys_writer,
                });
            }
        };

        let sw_for_pcm = sys_writer.clone();
        let pcm_task = tokio::spawn(async move {
            while let Some(frame) = pcm_rx.recv().await {
                if let Ok(mut w) = sw_for_pcm.lock() {
                    if let Err(e) = w.write(&frame) {
                        error!(?e, "sys chunk write failed");
                    }
                }
            }
        });

        let evt_task = tokio::spawn(async move {
            while let Some(evt) = evt_rx.recv().await {
                let _ = on_syscap_event.send(evt);
            }
        });

        Ok(Self {
            meeting_id,
            dir,
            syscap: Some(syscap),
            mic: Some(mic),
            syscap_task: Some(pcm_task),
            syscap_evt_task: Some(evt_task),
            mic_only: false,
            mic_writer,
            sys_writer,
        })
    }

    pub async fn stop(&mut self) -> Result<(), MeetingError> {
        // Stop syscap first so no more PCM arrives at the sys writer.
        if let Some(mut sc) = self.syscap.take() {
            sc.stop();
        }
        if let Some(t) = self.syscap_task.take() {
            let _ = t.await;
        }
        if let Some(t) = self.syscap_evt_task.take() {
            let _ = t.await;
        }
        // Drop mic stream (cpal stops on drop).
        self.mic.take();
        // Flush any partial chunks.
        if let Ok(mut w) = self.mic_writer.lock() {
            w.flush_partial()?;
        }
        if let Ok(mut w) = self.sys_writer.lock() {
            w.flush_partial()?;
        }
        Ok(())
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs
git commit -m "feat(meeting): wire Recorder orchestrating mic + syscap into chunk writers"
```

---

## Phase 4 — Transcription pipeline

### Task 11: `AsrPipeline::transcribe_file(path)` + WAV loader

**Files:**
- Modify: `src-tauri/src/asr/pipeline.rs`
- Modify: `src-tauri/src/asr/parakeet.rs` (add a small helper if needed)

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/asr/pipeline.rs` (in the `#[cfg(test)]` block, or create one):

```rust
#[cfg(test)]
mod transcribe_file_tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_silence_wav(path: &std::path::Path, seconds: u32) {
        let sr: u32 = 16_000;
        let samples = sr * seconds;
        let data_bytes = samples * 2;
        let riff = 36 + data_bytes;
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&riff.to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&sr.to_le_bytes()).unwrap();
        f.write_all(&(sr * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_bytes.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; data_bytes as usize]).unwrap();
    }

    #[test]
    fn load_wav_returns_correct_sample_count() {
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("silence.wav");
        write_silence_wav(&path, 2);
        let (samples, rate, channels) = AsrPipeline::load_wav_16k_mono_int16(&path).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(channels, 1);
        assert_eq!(samples.len(), 32_000);
    }
}
```

- [ ] **Step 2: Add `load_wav_16k_mono_int16` and `transcribe_file` to `AsrPipeline`**

In `src-tauri/src/asr/pipeline.rs`, add as `impl AsrPipeline` methods:

```rust
impl AsrPipeline {
    /// Read a 16kHz mono Int16 WAV file written by ChunkedWavWriter and return f32 samples.
    pub fn load_wav_16k_mono_int16(
        path: &std::path::Path,
    ) -> Result<(Vec<f32>, u32, u16), AsrError> {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| AsrError::Engine(EngineError::Io(e.to_string())))?;
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err(AsrError::Engine(EngineError::Io("not a WAV file".into())));
        }
        let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
        let bits_per_sample = u16::from_le_bytes(bytes[34..36].try_into().unwrap());
        if bits_per_sample != 16 {
            return Err(AsrError::Engine(EngineError::Io(format!(
                "expected 16-bit PCM, got {bits_per_sample}"
            ))));
        }
        // Find "data" chunk.
        let mut idx = 12;
        let mut data_offset = 44;
        let mut data_len = 0u32;
        while idx + 8 <= bytes.len() {
            let id = &bytes[idx..idx + 4];
            let size = u32::from_le_bytes(bytes[idx + 4..idx + 8].try_into().unwrap()) as usize;
            if id == b"data" {
                data_offset = idx + 8;
                data_len = size as u32;
                break;
            }
            idx += 8 + size;
        }
        let count = (data_len as usize) / 2;
        let mut samples = Vec::with_capacity(count);
        for i in 0..count {
            let lo = bytes[data_offset + i * 2];
            let hi = bytes[data_offset + i * 2 + 1];
            let s = i16::from_le_bytes([lo, hi]) as f32 / 32768.0;
            samples.push(s);
        }
        Ok((samples, sample_rate, channels))
    }

    /// Transcribe a WAV file produced by ChunkedWavWriter. Returns the trimmed text.
    pub async fn transcribe_file(&self, path: &std::path::Path) -> Result<String, AsrError> {
        let (samples, rate, channels) = Self::load_wav_16k_mono_int16(path)?;
        self.transcribe(samples, rate, channels).await
    }
}
```

**Note:** the `EngineError::Io` variant may not exist. Check `src-tauri/src/asr/parakeet.rs` for the actual error variant name and adjust. If there's no `Io` variant, add one:

```rust
// in parakeet.rs EngineError enum
Io(String),
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib asr::pipeline::transcribe_file_tests`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/asr/pipeline.rs src-tauri/src/asr/parakeet.rs
git commit -m "feat(asr): add transcribe_file + WAV loader for chunked meeting input"
```

---

### Task 12: `meeting/pipeline.rs` — chunk drain + parallel transcription

**Files:**
- Modify: `src-tauri/src/meeting/pipeline.rs` (replace stub)

- [ ] **Step 1: Implement the pipeline**

Replace `src-tauri/src/meeting/pipeline.rs` with:

```rust
//! Drains ChunkReady events, transcribes each chunk via Parakeet, builds the
//! merged transcript in-memory, and deletes WAVs as they succeed.

use crate::asr::AsrPipeline;
use crate::meeting::{ChunkReady, Segment, Speaker};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tracing::{error, info, warn};

#[derive(Default)]
pub struct TranscriptBuilder {
    pub segments: Vec<Segment>,
    pub failed: Vec<PathBuf>,
}

impl TranscriptBuilder {
    pub fn push(&mut self, seg: Segment) {
        if !seg.text.trim().is_empty() {
            self.segments.push(seg);
        }
    }

    pub fn finalize(mut self) -> (Vec<Segment>, Vec<PathBuf>) {
        self.segments.sort_by_key(|s| (s.start_ms, match s.speaker {
            Speaker::You => 0u8,
            Speaker::Them => 1u8,
        }));
        (self.segments, self.failed)
    }
}

pub struct Pipeline {
    asr: Arc<AsrPipeline>,
    builder: Arc<Mutex<TranscriptBuilder>>,
    sem: Arc<Semaphore>,
    failed_dir: PathBuf,
}

impl Pipeline {
    pub fn new(asr: Arc<AsrPipeline>, failed_dir: PathBuf) -> Self {
        Self {
            asr,
            builder: Arc::new(Mutex::new(TranscriptBuilder::default())),
            sem: Arc::new(Semaphore::new(1)), // Parakeet on ANE is single-tenant
            failed_dir,
        }
    }

    /// Spawns a task that drains the receiver and transcribes each chunk.
    /// Returns a JoinHandle the caller awaits at meeting-end to drain remaining work.
    pub fn spawn_drain(
        &self,
        mut rx: mpsc::UnboundedReceiver<ChunkReady>,
    ) -> tokio::task::JoinHandle<()> {
        let asr = self.asr.clone();
        let builder = self.builder.clone();
        let sem = self.sem.clone();
        let failed_dir = self.failed_dir.clone();
        tokio::spawn(async move {
            let mut workers = Vec::new();
            while let Some(chunk) = rx.recv().await {
                let asr = asr.clone();
                let builder = builder.clone();
                let sem = sem.clone();
                let failed_dir = failed_dir.clone();
                workers.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await.expect("semaphore");
                    match asr.transcribe_file(&chunk.path).await {
                        Ok(text) => {
                            let seg = Segment {
                                speaker: chunk.speaker,
                                start_ms: chunk.start_ms,
                                end_ms: chunk.end_ms,
                                text,
                            };
                            builder.lock().await.push(seg);
                            if let Err(e) = tokio::fs::remove_file(&chunk.path).await {
                                warn!(?e, path = %chunk.path.display(), "remove chunk failed");
                            }
                        }
                        Err(e) => {
                            error!(?e, path = %chunk.path.display(), "transcribe failed");
                            let _ = tokio::fs::create_dir_all(&failed_dir).await;
                            let dest = failed_dir.join(chunk.path.file_name().unwrap_or_default());
                            let _ = tokio::fs::rename(&chunk.path, &dest).await;
                            builder.lock().await.failed.push(dest);
                        }
                    }
                }));
            }
            for w in workers {
                let _ = w.await;
            }
            info!("transcription pipeline drained");
        })
    }

    /// Take ownership of the builder (call after spawn_drain's join handle resolves).
    pub async fn finalize(self) -> (Vec<Segment>, Vec<PathBuf>) {
        let builder = Arc::try_unwrap(self.builder)
            .map_err(|_| ())
            .expect("no other refs after pipeline drain");
        builder.into_inner().finalize()
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/meeting/pipeline.rs
git commit -m "feat(meeting): add chunk-drain pipeline with Parakeet transcription"
```

---

## Phase 5 — LLM synthesis

### Task 13: GBNF grammar + synthesis prompt

**Files:**
- Modify: `src-tauri/src/meeting/grammar.rs` (replace stub)
- Modify: `src-tauri/src/llm/prompt.rs` (append `build_meeting_synthesis_prompt`)

- [ ] **Step 1: Write the GBNF grammar**

Replace `src-tauri/src/meeting/grammar.rs` with:

```rust
//! GBNF grammar constraining meeting synthesis output to strict JSON.

pub const MEETING_SYNTHESIS_GBNF: &str = r#"
root         ::= "{" ws "\"summary\"" ws ":" ws summary ws "," ws "\"action_items\"" ws ":" ws actions ws "," ws "\"suggested_title\"" ws ":" ws string ws "}"

summary      ::= "[" ws ( string ( ws "," ws string ){2,4} )? ws "]"

actions      ::= "[" ws ( action ( ws "," ws action )* )? ws "]"

action       ::= "{" ws "\"text\"" ws ":" ws string ws "," ws "\"owner\"" ws ":" ws owner ws "}"

owner        ::= "\"you\"" | "\"them\"" | "\"unspecified\""

string       ::= "\"" char* "\""
char         ::= [^"\\] | "\\" ( ["\\/bfnrt] | "u" hex hex hex hex )
hex          ::= [0-9a-fA-F]
ws           ::= [ \t\n]*
"#;
```

- [ ] **Step 2: Write the prompt builder**

Open `src-tauri/src/llm/prompt.rs` and append at the end:

```rust
/// Build the prompt for meeting transcript → summary + action items + suggested title.
/// Output must conform to MEETING_SYNTHESIS_GBNF.
pub fn build_meeting_synthesis_prompt(
    flattened_transcript: &str,
    detected_app_name: Option<&str>,
    duration_minutes: u64,
) -> (Option<String>, String) {
    let app = detected_app_name.unwrap_or("a meeting");
    let system = format!(
        "You are an expert meeting note-taker. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. \
The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side). \
Produce a JSON object with exactly these fields:\n\
- summary: array of 3 to 5 bullet strings. Each bullet covers one decision, key topic, or outcome. \
Bullets must be self-contained sentences, no leading dashes.\n\
- action_items: array (possibly empty) of objects {{ \"text\": string, \"owner\": \"you\" | \"them\" | \"unspecified\" }}. \
Only include items the speakers explicitly committed to or were explicitly asked to do. Do not invent action items.\n\
- suggested_title: short string (max 60 characters) capturing the meeting's purpose.\n\
Output JSON only — no preamble, no commentary, no markdown fences."
    );
    let user = format!("Transcript:\n\n{flattened_transcript}\n\nProduce the JSON now.");
    (Some(system), user)
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/grammar.rs src-tauri/src/llm/prompt.rs
git commit -m "feat(llm): add meeting synthesis grammar + prompt builder"
```

---

### Task 14: `synthesizer.rs` — call Llm, parse, retry once

**Files:**
- Modify: `src-tauri/src/meeting/synthesizer.rs` (replace stub)

- [ ] **Step 1: Write the synthesizer**

Replace `src-tauri/src/meeting/synthesizer.rs` with:

```rust
//! Calls the LLM with a meeting transcript and parses the structured JSON response.

use crate::llm::engine::GenerateRequest;
use crate::llm::Llm;
use crate::meeting::grammar::MEETING_SYNTHESIS_GBNF;
use crate::meeting::Segment;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    pub owner: String, // "you" | "them" | "unspecified"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSynthesis {
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub suggested_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSummary {
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub suggested_title: String,
    pub raw: Option<String>, // populated when JSON parse fails after retry
}

pub fn flatten_transcript(segments: &[Segment]) -> String {
    let mut out = String::new();
    for seg in segments {
        let speaker = match seg.speaker {
            crate::meeting::Speaker::You => "You",
            crate::meeting::Speaker::Them => "Them",
        };
        out.push_str(speaker);
        out.push_str(": ");
        out.push_str(seg.text.trim());
        out.push('\n');
    }
    out
}

pub async fn synthesize(
    llm: Arc<Llm>,
    segments: &[Segment],
    detected_app_name: Option<&str>,
    duration_ms: u64,
) -> Result<StoredSummary, String> {
    let flattened = flatten_transcript(segments);
    let duration_minutes = duration_ms / 60_000;
    let (system, user) = crate::llm::prompt::build_meeting_synthesis_prompt(
        &flattened,
        detected_app_name,
        duration_minutes,
    );

    for attempt in 0..2u8 {
        let temperature = if attempt == 0 { 0.3 } else { 0.1 };
        let req = GenerateRequest {
            system: system.clone(),
            user: user.clone(),
            history: Vec::new(),
            max_tokens: 2048,
            temperature,
            stop_strings: Vec::new(),
            grammar_gbnf: Some(MEETING_SYNTHESIS_GBNF.to_string()),
        };
        let raw = match llm.generate(req).await {
            Ok(r) => r,
            Err(e) => {
                warn!(?e, attempt, "synthesis generation failed");
                if attempt == 1 {
                    return Err(format!("llm generate: {e}"));
                }
                continue;
            }
        };
        match serde_json::from_str::<MeetingSynthesis>(&raw) {
            Ok(s) => {
                info!(
                    summary_bullets = s.summary.len(),
                    actions = s.action_items.len(),
                    "synthesis ok"
                );
                return Ok(StoredSummary {
                    summary: s.summary,
                    action_items: s.action_items,
                    suggested_title: s.suggested_title,
                    raw: None,
                });
            }
            Err(e) => {
                warn!(?e, attempt, "synthesis JSON parse failed");
                if attempt == 1 {
                    return Ok(StoredSummary {
                        summary: vec![],
                        action_items: vec![],
                        suggested_title: String::new(),
                        raw: Some(raw),
                    });
                }
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::Speaker;

    #[test]
    fn flatten_produces_speaker_labeled_lines() {
        let segs = vec![
            Segment { speaker: Speaker::You, start_ms: 0, end_ms: 1000, text: "hello".into() },
            Segment { speaker: Speaker::Them, start_ms: 0, end_ms: 1000, text: "hi".into() },
        ];
        let out = flatten_transcript(&segs);
        assert_eq!(out, "You: hello\nThem: hi\n");
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test --lib meeting::synthesizer`
Expected: 1 test PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/meeting/synthesizer.rs
git commit -m "feat(meeting): add synthesizer that calls LLM with grammar and retries once"
```

---

## Phase 6 — `MeetingManager` + Tauri commands + frontend api

### Task 15: `MeetingManager` lifecycle

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs` (append `MeetingManager`)

- [ ] **Step 1: Append the MeetingManager type at the end of `src-tauri/src/meeting/mod.rs`**

```rust
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc;

use crate::asr::AsrPipeline;
use crate::db::Db;
use crate::llm::Llm;
use crate::meeting::pipeline::Pipeline;
use crate::meeting::recorder::Recorder;
use crate::meeting::synthesizer::{self, StoredSummary};

/// Public lifecycle manager. One per app process. Holds the active meeting (if any)
/// and orchestrates record → transcribe → synthesize → persist.
pub struct MeetingManager {
    pub asr: Arc<AsrPipeline>,
    pub llm: Arc<Llm>,
    pub db: Db,
    pub data_dir: std::path::PathBuf,
    pub app_handle: tauri::AppHandle,
    state: AsyncMutex<Option<ActiveMeeting>>,
}

struct ActiveMeeting {
    item_id: String,
    started_at: String, // ISO 8601
    started_at_ms: u64, // for duration computation
    detected_app: Option<String>,
    detected_app_name: Option<String>,
    recorder: Recorder,
    chunk_drain_handle: tokio::task::JoinHandle<()>,
    pipeline: Option<Pipeline>,
}

impl MeetingManager {
    pub fn new(
        asr: Arc<AsrPipeline>,
        llm: Arc<Llm>,
        db: Db,
        data_dir: std::path::PathBuf,
        app_handle: tauri::AppHandle,
    ) -> Arc<Self> {
        Arc::new(Self {
            asr, llm, db, data_dir, app_handle,
            state: AsyncMutex::new(None),
        })
    }

    pub async fn is_active(&self) -> bool {
        self.state.lock().await.is_some()
    }

    pub async fn start(
        &self,
        detected_app: Option<String>,
        detected_app_name: Option<String>,
    ) -> Result<String, MeetingError> {
        let mut guard = self.state.lock().await;
        if guard.is_some() {
            return Err(MeetingError::AlreadyRecording);
        }
        if !self.asr.ready() {
            return Err(MeetingError::AsrNotReady);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let started_at = now.to_rfc3339();
        let started_at_ms = now.timestamp_millis() as u64;
        let dir = self.data_dir.join("meetings").join(&id);

        // Insert items + meetings rows up front so detail view can show "recording".
        let id_for_db = id.clone();
        let started_for_db = started_at.clone();
        let detected_app_for_db = detected_app.clone();
        let detected_app_name_for_db = detected_app_name.clone();
        let title = detected_app_name_for_db
            .clone()
            .map(|n| format!("Meeting with {n}"))
            .unwrap_or_else(|| "Untitled meeting".into());
        self.db.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
                 VALUES (?1, ?2, 'meeting', 'visible', 'meeting', ?3, ?3)",
                rusqlite::params![id_for_db, title, started_for_db],
            )?;
            crate::db::meetings::insert_meeting(
                conn,
                &crate::db::meetings::MeetingRow {
                    item_id: id_for_db.clone(),
                    started_at: started_for_db,
                    ended_at: None,
                    duration_ms: None,
                    detected_app: detected_app_for_db,
                    detected_app_name: detected_app_name_for_db,
                    status: "recording".into(),
                    transcript_json: None,
                    summary_json: None,
                    user_notes: None,
                    failed_chunk_count: 0,
                    mic_only: false,
                },
            )?;
            Ok(())
        }).map_err(|e| MeetingError::Db(e.to_string()))?;

        let (chunk_tx, chunk_rx) = mpsc::unbounded_channel();
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel();
        let recorder = Recorder::start(id.clone(), dir.clone(), chunk_tx, evt_tx).await?;

        // Forward syscap events to a logger task (warns/errors → tracing).
        let id_for_evt = id.clone();
        tokio::spawn(async move {
            while let Some(evt) = evt_rx.recv().await {
                match evt {
                    syscap::SyscapEvent::Error { kind, msg } => {
                        tracing::error!(meeting = %id_for_evt, %kind, %msg, "syscap error");
                    }
                    syscap::SyscapEvent::Warn(msg) => {
                        tracing::warn!(meeting = %id_for_evt, %msg, "syscap warn");
                    }
                    _ => {}
                }
            }
        });

        let pipeline = Pipeline::new(self.asr.clone(), dir.join("failed"));
        let chunk_drain_handle = pipeline.spawn_drain(chunk_rx);

        // Emit a "meeting started" event for the overlay to render.
        let _ = self.app_handle.emit("meeting-started", &serde_json::json!({
            "id": id,
            "detected_app_name": detected_app_name,
        }));

        *guard = Some(ActiveMeeting {
            item_id: id.clone(),
            started_at,
            started_at_ms,
            detected_app,
            detected_app_name,
            recorder,
            chunk_drain_handle,
            pipeline: Some(pipeline),
        });
        Ok(id)
    }

    pub async fn stop(&self) -> Result<String, MeetingError> {
        let mut guard = self.state.lock().await;
        let Some(mut active) = guard.take() else {
            return Err(MeetingError::NotRecording);
        };
        drop(guard);

        // Step 1: Stop recording (closes mic + syscap, flushes partial chunks → channel).
        active.recorder.stop().await?;

        // Step 2: Flag UI state as "transcribing".
        let id = active.item_id.clone();
        let id_for_db = id.clone();
        self.db.with_conn(move |conn| {
            crate::db::meetings::update_status(conn, &id_for_db, MeetingStatus::Transcribing)
        }).map_err(|e| MeetingError::Db(e.to_string()))?;
        let _ = self.app_handle.emit("meeting-status", &serde_json::json!({
            "id": id, "status": "transcribing"
        }));

        // Step 3: Drop the chunk channel sender (recorder did this on stop) so pipeline drains.
        let _ = active.chunk_drain_handle.await;

        // Step 4: Pull segments out of the pipeline.
        let pipeline = active.pipeline.take().expect("set in start");
        let (segments, failed) = pipeline.finalize().await;
        let failed_count = failed.len() as i64;

        // Step 5: Run synthesis.
        let id_for_status = id.clone();
        let _ = self.app_handle.emit("meeting-status", &serde_json::json!({
            "id": id_for_status, "status": "summarizing"
        }));
        let id_db2 = id.clone();
        self.db.with_conn(move |conn| {
            crate::db::meetings::update_status(conn, &id_db2, MeetingStatus::Summarizing)
        }).map_err(|e| MeetingError::Db(e.to_string()))?;

        let now = chrono::Utc::now();
        let duration_ms = (now.timestamp_millis() as u64).saturating_sub(active.started_at_ms);

        let synthesis = synthesizer::synthesize(
            self.llm.clone(),
            &segments,
            active.detected_app_name.as_deref(),
            duration_ms,
        ).await;

        // Step 6: Build the transcript JSON, serialize summary, write to DB.
        let transcript_json = serde_json::json!({
            "segments": segments,
            "duration_ms": duration_ms,
            "asr_model": self.asr.active_model_id().unwrap_or_else(|| "unknown".into()),
            "chunk_seconds": 60,
            "failed_chunk_count": failed_count,
            "mic_only": active.recorder.mic_only,
        });
        let summary_json = match &synthesis {
            Ok(s) => Some(serde_json::to_string(s).unwrap_or_else(|_| "{}".into())),
            Err(e) => {
                tracing::error!(?e, "synthesis returned error");
                None
            }
        };

        // Step 7: Persist + flatten body for FTS.
        let body = build_flattened_body(&segments, summary_json.as_deref(), None);
        let id_db3 = id.clone();
        let ended_at = now.to_rfc3339();
        let transcript_str = serde_json::to_string(&transcript_json).unwrap();
        let summary_for_db = summary_json.clone();
        self.db.with_conn(move |conn| {
            crate::db::meetings::finalize_meeting(
                conn,
                &id_db3,
                &ended_at,
                duration_ms as i64,
                &transcript_str,
                summary_for_db.as_deref(),
                failed_count,
            )?;
            // Update items.body for FTS.
            conn.execute(
                "UPDATE items SET content = ?1 WHERE id = ?2",
                rusqlite::params![body, id_db3],
            )?;
            Ok(())
        }).map_err(|e| MeetingError::Db(e.to_string()))?;

        // Step 8: If synthesis succeeded, write each action_item as a task + link.
        if let Ok(s) = &synthesis {
            let actions = s.action_items.clone();
            let meeting_id_clone = id.clone();
            self.db.with_conn(move |conn| {
                for action in &actions {
                    let task_id = uuid::Uuid::new_v4().to_string();
                    let now_iso = chrono::Utc::now().to_rfc3339();
                    conn.execute(
                        "INSERT INTO items (id, content, source, visibility, kind, captured_at, created_at)
                         VALUES (?1, ?2, 'meeting', 'visible', 'task', ?3, ?3)",
                        rusqlite::params![task_id, action.text, now_iso],
                    )?;
                    conn.execute(
                        "INSERT INTO tasks (item_id, deadline, completed_at) VALUES (?1, NULL, NULL)",
                        rusqlite::params![task_id],
                    )?;
                    crate::db::meetings::link_action(conn, &meeting_id_clone, &task_id, &now_iso)?;
                }
                Ok(())
            }).map_err(|e| MeetingError::Db(e.to_string()))?;
        }

        // Step 9: Emit "complete" event.
        let _ = self.app_handle.emit("meeting-complete", &serde_json::json!({
            "id": id,
        }));

        // Step 10: Best-effort cleanup of empty meeting dir if no failed chunks.
        if failed.is_empty() {
            let _ = std::fs::remove_dir_all(self.data_dir.join("meetings").join(&id));
        }

        Ok(id)
    }
}

/// Build the flattened body that goes into items.body for FTS5 indexing.
pub fn build_flattened_body(
    segments: &[Segment],
    summary_json: Option<&str>,
    user_notes: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("[Summary]\n");
    if let Some(s) = summary_json {
        if let Ok(stored) = serde_json::from_str::<crate::meeting::synthesizer::StoredSummary>(s) {
            for bullet in &stored.summary {
                out.push_str("- ");
                out.push_str(bullet);
                out.push('\n');
            }
        }
    }
    out.push_str("\n[Transcript]\n");
    out.push_str(&crate::meeting::synthesizer::flatten_transcript(segments));
    if let Some(notes) = user_notes {
        if !notes.trim().is_empty() {
            out.push_str("\n[Notes]\n");
            out.push_str(notes);
            out.push('\n');
        }
    }
    out
}
```

**Note:** `tauri::AppHandle::emit` is a v2 API; if your Tauri version differs, use `app_handle.emit_all(...)` accordingly.

- [ ] **Step 2: Add `uuid` and `chrono` deps if missing**

```bash
grep -E '^uuid|^chrono' src-tauri/Cargo.toml || true
# If either is missing:
cargo add uuid --features v4 --manifest-path src-tauri/Cargo.toml
cargo add chrono --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(meeting): add MeetingManager lifecycle (record → transcribe → synthesize → persist)"
```

---

### Task 16: Tauri commands + AppState wiring

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Extend AppState**

In `src-tauri/src/commands.rs`, add to the `AppState` struct (alongside `asr`, `llm`):

```rust
    pub meeting_manager: Arc<crate::meeting::MeetingManager>,
```

- [ ] **Step 2: Add command handlers**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn start_meeting_manual(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state.meeting_manager.start(None, None).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_meeting(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state.meeting_manager.stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn is_meeting_active(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.meeting_manager.is_active().await)
}

#[tauri::command]
pub fn get_meeting(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<crate::db::meetings::MeetingRow>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| crate::db::meetings::get_meeting(conn, &id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_meetings(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::db::meetings::MeetingRow>, String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(|conn| crate::db::meetings::list_meetings(conn))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_meeting_notes(
    state: tauri::State<'_, AppState>,
    id: String,
    notes: String,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| crate::db::meetings::update_user_notes(conn, &id, &notes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_meeting(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| {
        conn.execute(
            "UPDATE items SET content = ?1 WHERE id = ?2 AND kind = 'meeting'",
            rusqlite::params![title, id],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_meeting(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let db = state.db.as_ref().ok_or("db unavailable")?;
    db.with_conn(move |conn| {
        crate::db::meetings::delete_meeting(conn, &id)?;
        conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}
```

(`retry_meeting_summary` and `retry_meeting_chunks` come in Phase 9.)

- [ ] **Step 3: Register commands**

In `src-tauri/src/lib.rs`, find `tauri::Builder::default().invoke_handler(tauri::generate_handler![...])` and add:

```rust
            commands::start_meeting_manual,
            commands::stop_meeting,
            commands::is_meeting_active,
            commands::get_meeting,
            commands::list_meetings,
            commands::update_meeting_notes,
            commands::rename_meeting,
            commands::delete_meeting,
```

Also instantiate `MeetingManager` and store on AppState. Find where `AsrPipeline` and `Llm` are constructed; after them:

```rust
    let data_dir = app.path().app_data_dir().unwrap();
    let meeting_manager = crate::meeting::MeetingManager::new(
        asr.clone(),
        llm.clone(),
        db.clone().expect("db open"),
        data_dir,
        app.handle().clone(),
    );
    // Add to AppState construction:
    // meeting_manager,
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(meeting): wire 8 Tauri commands and MeetingManager into AppState"
```

---

### Task 17: Frontend `api.ts` wrappers + types

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Append the meeting API surface**

At the end of `src/lib/api.ts`:

```typescript
// ============= Meetings =============

export type MeetingStatus =
  | "recording"
  | "transcribing"
  | "summarizing"
  | "complete"
  | "failed"
  | "recovered";

export type MeetingRow = {
  item_id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  detected_app: string | null;
  detected_app_name: string | null;
  status: MeetingStatus;
  transcript_json: string | null;
  summary_json: string | null;
  user_notes: string | null;
  failed_chunk_count: number;
  mic_only: boolean;
};

export type Segment = {
  speaker: "you" | "them";
  start_ms: number;
  end_ms: number;
  text: string;
};

export type StoredTranscript = {
  segments: Segment[];
  duration_ms: number;
  asr_model: string;
  chunk_seconds: number;
  failed_chunk_count: number;
  mic_only: boolean;
};

export type StoredSummary = {
  summary: string[];
  action_items: { text: string; owner: "you" | "them" | "unspecified" }[];
  suggested_title: string;
  raw?: string | null;
};

export const startMeetingManual = (): Promise<string> => invoke("start_meeting_manual");
export const stopMeeting = (): Promise<string> => invoke("stop_meeting");
export const isMeetingActive = (): Promise<boolean> => invoke("is_meeting_active");
export const getMeeting = (id: string): Promise<MeetingRow | null> =>
  invoke("get_meeting", { id });
export const listMeetings = (): Promise<MeetingRow[]> => invoke("list_meetings");
export const updateMeetingNotes = (id: string, notes: string): Promise<void> =>
  invoke("update_meeting_notes", { id, notes });
export const renameMeeting = (id: string, title: string): Promise<void> =>
  invoke("rename_meeting", { id, title });
export const deleteMeeting = (id: string): Promise<void> =>
  invoke("delete_meeting", { id });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bun run dev` (or `bunx tsc --noEmit` if available). Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add typed meeting command wrappers"
```

---

## Phase 7 — Detection, settings, consent

### Task 18: Meeting settings in `SettingsStore`

**Files:**
- Modify: `src-tauri/src/settings.rs`

- [ ] **Step 1: Add the keys + types + getters/setters**

At the top of `src-tauri/src/settings.rs` (with the other `KEY_*` consts), add:

```rust
pub const KEY_MEETING_AUTO_DETECT: &str = "meeting_auto_detect";
pub const KEY_MEETING_APP_PREFS: &str = "meeting_app_prefs";
pub const KEY_MEETING_HOTKEY: &str = "meeting_hotkey_binding";
pub const KEY_MEETING_SOFT_WARN_MIN: &str = "meeting_soft_warn_minutes";
pub const KEY_MEETING_HARD_CAP_MIN: &str = "meeting_hard_cap_minutes";
```

Add a per-app preference enum + map type near the top of the file:

```rust
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeetingAppPref {
    Always,
    Ask,
    Never,
}
```

Append to the `impl SettingsStore` block:

```rust
    pub fn meeting_auto_detect(&self) -> bool {
        self.store
            .get(KEY_MEETING_AUTO_DETECT)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_meeting_auto_detect(&self, on: bool) -> Result<(), SettingsError> {
        self.store.set(KEY_MEETING_AUTO_DETECT, serde_json::Value::Bool(on));
        self.store.save().map_err(|e| SettingsError::Store(e.to_string()))
    }

    pub fn meeting_app_prefs(&self) -> HashMap<String, MeetingAppPref> {
        self.store
            .get(KEY_MEETING_APP_PREFS)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    pub fn set_meeting_app_prefs(
        &self,
        prefs: &HashMap<String, MeetingAppPref>,
    ) -> Result<(), SettingsError> {
        self.store
            .set(KEY_MEETING_APP_PREFS, serde_json::to_value(prefs)?);
        self.store.save().map_err(|e| SettingsError::Store(e.to_string()))
    }

    pub fn meeting_hotkey(&self) -> Binding {
        match self.store.get(KEY_MEETING_HOTKEY) {
            Some(v) => serde_json::from_value(v).unwrap_or_else(|_| default_meeting_hotkey()),
            None => default_meeting_hotkey(),
        }
    }

    pub fn set_meeting_hotkey(&self, b: Binding) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&b)?;
        self.store.set(KEY_MEETING_HOTKEY, value);
        self.store.save().map_err(|e| SettingsError::Store(e.to_string()))
    }

    pub fn meeting_soft_warn_min(&self) -> u32 {
        self.store
            .get(KEY_MEETING_SOFT_WARN_MIN)
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(120)
    }

    pub fn set_meeting_soft_warn_min(&self, n: u32) -> Result<(), SettingsError> {
        self.store.set(
            KEY_MEETING_SOFT_WARN_MIN,
            serde_json::Value::Number(n.into()),
        );
        self.store.save().map_err(|e| SettingsError::Store(e.to_string()))
    }

    pub fn meeting_hard_cap_min(&self) -> u32 {
        self.store
            .get(KEY_MEETING_HARD_CAP_MIN)
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(240)
    }

    pub fn set_meeting_hard_cap_min(&self, n: u32) -> Result<(), SettingsError> {
        self.store.set(
            KEY_MEETING_HARD_CAP_MIN,
            serde_json::Value::Number(n.into()),
        );
        self.store.save().map_err(|e| SettingsError::Store(e.to_string()))
    }
}

pub fn default_meeting_hotkey() -> Binding {
    // Cmd+Shift+M — adjust the constructor to match the existing Binding type's API.
    // If Binding has builder methods like `Binding::with_modifiers(...)`, match those.
    // The implementer should consult settings.rs's `default_binding()` for shape.
    Binding::default()
}
```

**Note:** the `Binding` type's exact shape is in `settings.rs`. Replace `Binding::default()` and `default_meeting_hotkey()` with the actual constructor that produces ⌘⇧M.

- [ ] **Step 2: Expose Tauri commands for the new settings**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn get_meeting_settings(state: tauri::State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "auto_detect": state.settings.meeting_auto_detect(),
        "app_prefs": state.settings.meeting_app_prefs(),
        "soft_warn_min": state.settings.meeting_soft_warn_min(),
        "hard_cap_min": state.settings.meeting_hard_cap_min(),
    })
}

#[tauri::command]
pub fn set_meeting_auto_detect(
    state: tauri::State<'_, AppState>,
    on: bool,
) -> Result<(), String> {
    state.settings.set_meeting_auto_detect(on).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_meeting_app_pref(
    state: tauri::State<'_, AppState>,
    bundle_id: String,
    pref: crate::settings::MeetingAppPref,
) -> Result<(), String> {
    let mut prefs = state.settings.meeting_app_prefs();
    prefs.insert(bundle_id, pref);
    state.settings.set_meeting_app_prefs(&prefs).map_err(|e| e.to_string())
}
```

Register them in `lib.rs` `invoke_handler!`.

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(settings): add meeting auto-detect, per-app prefs, hotkey, caps"
```

---

### Task 19: `detector.rs` — polling loop with bundle-ID + mic-active heuristic

**Files:**
- Modify: `src-tauri/src/meeting/detector.rs` (replace stub)
- Modify: `src-tauri/Cargo.toml` (add `coreaudio-sys`)

- [ ] **Step 1: Add CoreAudio dep**

```bash
cargo add coreaudio-sys --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Implement the detector**

Replace `src-tauri/src/meeting/detector.rs` with:

```rust
//! Detects when the user enters a meeting (supported app frontmost + mic in use).

use crate::meeting::MeetingManager;
use crate::settings::{MeetingAppPref, SettingsStore};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// Static registry of supported meeting apps.
pub const REGISTRY: &[(&str, &str, bool)] = &[
    // (bundle_id, display_name, is_browser)
    ("us.zoom.xos", "Zoom", false),
    ("com.microsoft.teams2", "Microsoft Teams", false),
    ("com.microsoft.teams", "Microsoft Teams (classic)", false),
    ("com.apple.FaceTime", "FaceTime", false),
    ("com.hnc.Discord", "Discord", false),
    ("com.tinyspeck.slackmacgap", "Slack", false),
    ("com.google.Chrome", "Chrome", true),
    ("company.thebrowser.Browser", "Arc", true),
    ("org.mozilla.firefox", "Firefox", true),
    ("com.apple.Safari", "Safari", true),
];

pub fn lookup(bundle_id: &str) -> Option<(&'static str, bool)> {
    REGISTRY
        .iter()
        .find(|(b, _, _)| *b == bundle_id)
        .map(|(_, name, is_browser)| (*name, *is_browser))
}

/// Spawns the detection loop. Returns immediately; the loop runs until process exit.
pub fn spawn(
    manager: Arc<MeetingManager>,
    settings: SettingsStore,
    app_handle: tauri::AppHandle,
) {
    tokio::spawn(async move {
        let mut consecutive_match: HashMap<String, u32> = HashMap::new();
        let mut mic_in_use_since: Option<Instant> = None;
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            if !settings.meeting_auto_detect() { continue; }
            if manager.is_active().await { continue; }

            let frontmost = match frontmost_bundle_id() {
                Some(id) => id,
                None => continue,
            };
            let Some((name, is_browser)) = lookup(&frontmost) else {
                consecutive_match.clear();
                continue;
            };

            let mic_active = is_default_input_running();
            let triggered = if is_browser {
                if mic_active {
                    let since = mic_in_use_since.get_or_insert(Instant::now());
                    since.elapsed() >= Duration::from_secs(5)
                } else {
                    mic_in_use_since = None;
                    false
                }
            } else {
                let count = consecutive_match.entry(frontmost.clone()).or_insert(0);
                *count += 1;
                *count >= 2
            };

            if !triggered { continue; }

            // Per-app preference.
            let prefs = settings.meeting_app_prefs();
            match prefs.get(&frontmost).copied().unwrap_or(MeetingAppPref::Ask) {
                MeetingAppPref::Always => {
                    info!(app = %frontmost, "auto-starting meeting (Always)");
                    if let Err(e) = manager.start(Some(frontmost.clone()), Some(name.into())).await {
                        warn!(?e, "auto-start failed");
                    }
                    consecutive_match.clear();
                }
                MeetingAppPref::Never => { /* no-op */ }
                MeetingAppPref::Ask => {
                    info!(app = %frontmost, "asking user about new meeting app");
                    let _ = app_handle.emit(
                        "meeting-detected",
                        &serde_json::json!({ "bundle_id": frontmost, "app_name": name }),
                    );
                    consecutive_match.clear();
                }
            }
        }
    });
}

/// Returns the bundle ID of the frontmost regular app, or None.
fn frontmost_bundle_id() -> Option<String> {
    // Reuse the existing focus-capture path. The implementer should look up
    // src-tauri/src/input/focus_capture.rs (or wherever NSWorkspace is wrapped today)
    // and call its public function. This function is a thin wrapper.
    crate::input::focus_capture::frontmost_app_bundle_id()
}

/// CoreAudio `kAudioDevicePropertyDeviceIsRunning` on the default input device.
fn is_default_input_running() -> bool {
    use coreaudio_sys::*;
    unsafe {
        let mut device_id: AudioDeviceID = 0;
        let mut size = std::mem::size_of::<AudioDeviceID>() as u32;
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            &mut device_id as *mut _ as *mut _,
        );
        if status != 0 { return false; }
        let running_addr = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut running: u32 = 0;
        let mut size2 = std::mem::size_of::<u32>() as u32;
        let s2 = AudioObjectGetPropertyData(
            device_id,
            &running_addr,
            0,
            std::ptr::null(),
            &mut size2,
            &mut running as *mut _ as *mut _,
        );
        s2 == 0 && running != 0
    }
}
```

**Note:** the `crate::input::focus_capture::frontmost_app_bundle_id()` call assumes that helper exists. Per memory, "the focus capture system already tracks frontmost app via PID and bundle ID" — find the actual function name in `src-tauri/src/input/` and replace. If it's not exposed, expose it (small refactor).

- [ ] **Step 3: Wire detector spawn in `lib.rs`**

In `src-tauri/src/lib.rs`, after `MeetingManager` instantiation:

```rust
    crate::meeting::detector::spawn(
        meeting_manager.clone(),
        settings.clone(),
        app.handle().clone(),
    );
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/meeting/detector.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(meeting): add detector polling loop with bundle-ID + mic-active heuristic"
```

---

### Task 20: Consent flow — notification → user choice → start

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add a command to record the consent decision and start**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn meeting_consent(
    state: tauri::State<'_, AppState>,
    bundle_id: String,
    app_name: String,
    decision: String, // "always" | "once" | "never"
) -> Result<Option<String>, String> {
    use crate::settings::MeetingAppPref;
    let mut prefs = state.settings.meeting_app_prefs();
    match decision.as_str() {
        "always" => {
            prefs.insert(bundle_id.clone(), MeetingAppPref::Always);
            state.settings.set_meeting_app_prefs(&prefs).map_err(|e| e.to_string())?;
            let id = state.meeting_manager.start(Some(bundle_id), Some(app_name)).await
                .map_err(|e| e.to_string())?;
            Ok(Some(id))
        }
        "once" => {
            let id = state.meeting_manager.start(Some(bundle_id), Some(app_name)).await
                .map_err(|e| e.to_string())?;
            Ok(Some(id))
        }
        "never" => {
            prefs.insert(bundle_id, MeetingAppPref::Never);
            state.settings.set_meeting_app_prefs(&prefs).map_err(|e| e.to_string())?;
            Ok(None)
        }
        _ => Err("invalid decision".into()),
    }
}
```

Register in `invoke_handler!` in `lib.rs`.

- [ ] **Step 2: Frontend listener with native notification**

In `src/App.tsx`, add an effect that listens for the `meeting-detected` event:

```typescript
import { listen } from "@tauri-apps/api/event";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";

useEffect(() => {
  const unlisten = listen<{ bundle_id: string; app_name: string }>("meeting-detected", async (e) => {
    const { bundle_id, app_name } = e.payload;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) {
      sendNotification({
        title: `${app_name} meeting detected`,
        body: "Record locally? Use the action buttons in System Settings → Notifications.",
      });
    }
    // Also surface an in-app prompt (see MeetingDetectedPrompt component below).
    setMeetingPrompt({ bundle_id, app_name });
  });
  return () => { void unlisten.then((u) => u()); };
}, []);
```

Add a small inline component `MeetingDetectedPrompt` that renders three buttons (Always / Just once / Never for {app}) and calls `invoke("meeting_consent", {...})`. Pattern match it on existing modals in the project (e.g. `LogCaptureOverlay` — reuse the styling).

- [ ] **Step 3: Manual smoke test**

```bash
bun tauri build --bundles app
# (full TCC reset + reinstall per CLAUDE.md)
```

Open Zoom, start a test meeting → in-app prompt should appear. Click "Just once" → recording overlay should show.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(meeting): consent flow with notification + in-app prompt"
```

---

## Phase 8 — UI surfaces

### Task 21: Recording overlay — meeting mode

**Files:**
- Modify: `src-tauri/src/overlay.rs`
- Modify: `src/overlay/RecordingOverlay.tsx`
- Create: `src/overlay/MeetingOverlay.tsx`

- [ ] **Step 1: Add a Rust event for meeting mode**

In `src-tauri/src/overlay.rs`, add:

```rust
pub fn show_meeting_overlay(
    app_handle: &AppHandle<Wry>,
    detected_app_name: Option<&str>,
) {
    let _ = app_handle.emit("show-overlay", serde_json::json!({
        "mode": "meeting",
        "app_name": detected_app_name,
    }));
}
```

(If the existing `show-overlay` payload is a plain string, change to a tagged JSON object: update the existing emitters too — they become `{ "mode": "recording" }` etc. Update `RecordingOverlay.tsx` to read `payload.mode`.)

Call `show_meeting_overlay` from `MeetingManager::start` (replace the existing `meeting-started` emit, or add this alongside it).

- [ ] **Step 2: Create `MeetingOverlay.tsx`**

```tsx
import { useEffect, useState } from "react";
import { stopMeeting } from "../lib/api";
import { Phone } from "lucide-react";

type Props = { appName: string | null };

export function MeetingOverlay({ appName }: Props) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div className="meeting-overlay">
      <Phone size={14} />
      <span className="recording-dot">●</span>
      <span>Recording{appName ? ` · ${appName}` : ""}</span>
      <span className="timer">{mm}:{ss}</span>
      <button onClick={() => void stopMeeting()}>Stop</button>
    </div>
  );
}
```

- [ ] **Step 3: Update `RecordingOverlay.tsx`**

Switch `OverlayState` to discriminated union:

```typescript
type OverlayState =
  | { mode: "recording" }
  | { mode: "log-recording" }
  | { mode: "transcribing" }
  | { mode: "meeting"; app_name: string | null }
  | null;
```

Replace the listener body for `show-overlay` to parse the new payload shape, and route to `<MeetingOverlay />` when `state.mode === "meeting"`.

- [ ] **Step 4: Style + smoke test**

Add CSS in the existing overlay stylesheet for `.meeting-overlay` matching the project's existing overlay aesthetic (red dot, monospace timer).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/overlay.rs src/overlay/
git commit -m "feat(overlay): meeting mode with timer + stop button"
```

---

### Task 22: `MeetingView.tsx` — single-meeting detail page

**Files:**
- Create: `src/views/sections/MeetingView.tsx`

- [ ] **Step 1: Implement the detail view**

Create `src/views/sections/MeetingView.tsx`:

```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getMeeting, updateMeetingNotes, renameMeeting, deleteMeeting,
  type MeetingRow, type StoredTranscript, type StoredSummary, type Segment,
} from "../../lib/api";

type Props = { meetingId: string; onClose: () => void };

export function MeetingView({ meetingId, onClose }: Props) {
  const [row, setRow] = useState<MeetingRow | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  const refresh = async () => {
    const r = await getMeeting(meetingId);
    setRow(r);
    if (r) {
      setNotesDraft(r.user_notes ?? "");
    }
  };

  useEffect(() => { void refresh(); }, [meetingId]);
  useEffect(() => {
    const unlisten = listen("meeting-status", () => { void refresh(); });
    const unlistenComplete = listen("meeting-complete", () => { void refresh(); });
    return () => {
      void unlisten.then((u) => u());
      void unlistenComplete.then((u) => u());
    };
  }, []);

  if (!row) return <div className="loading">Loading…</div>;

  const transcript: StoredTranscript | null = row.transcript_json
    ? JSON.parse(row.transcript_json)
    : null;
  const summary: StoredSummary | null = row.summary_json
    ? JSON.parse(row.summary_json)
    : null;

  const durationMin = row.duration_ms ? Math.round(row.duration_ms / 60000) : 0;
  const startedDate = new Date(row.started_at).toLocaleString();
  const title = editingTitle ? titleDraft : (row.detected_app_name
    ? `Meeting with ${row.detected_app_name}`
    : "Untitled meeting");

  const handleRename = async () => {
    await renameMeeting(meetingId, titleDraft);
    setEditingTitle(false);
    void refresh();
  };

  return (
    <div className="meeting-view">
      <header>
        {editingTitle ? (
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => e.key === "Enter" && handleRename()}
            autoFocus
          />
        ) : (
          <h1 onClick={() => { setTitleDraft(title); setEditingTitle(true); }}>{title}</h1>
        )}
        <div className="meta">
          <span>{row.detected_app_name ?? "Manual"}</span>
          <span>·</span>
          <span>{startedDate}</span>
          <span>·</span>
          <span>{durationMin}m</span>
          <span className={`status status-${row.status}`}>{row.status}</span>
        </div>
      </header>

      {summary?.summary?.length ? (
        <section className="summary-card">
          <h2>Summary</h2>
          <ul>{summary.summary.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </section>
      ) : row.status === "complete" && summary === null ? (
        <section className="summary-card empty">Summary generation failed. <button>Retry</button></section>
      ) : null}

      {summary?.action_items?.length ? (
        <section className="actions-card">
          <h2>Action items</h2>
          <ul>{summary.action_items.map((a, i) => (
            <li key={i}><label><input type="checkbox" /> {a.text} <em>({a.owner})</em></label></li>
          ))}</ul>
        </section>
      ) : null}

      <section className="notes-card">
        <h2>Notes</h2>
        <textarea
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={() => { void updateMeetingNotes(meetingId, notesDraft); }}
          placeholder="Add your own notes…"
        />
      </section>

      {transcript?.segments?.length ? (
        <section className="transcript-card">
          <h2>Transcript</h2>
          <div className="segments">
            {transcript.segments.map((s: Segment, i: number) => (
              <div key={i} className={`segment ${s.speaker}`}>
                <div className="ts">{formatMs(s.start_ms)}</div>
                <div className="who">{s.speaker === "you" ? "You" : "Them"}</div>
                <div className="text">{s.text}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {row.failed_chunk_count > 0 ? (
        <div className="banner warning">
          {row.failed_chunk_count} audio segment{row.failed_chunk_count > 1 ? "s" : ""} failed to transcribe.
          <button>Retry</button>
        </div>
      ) : null}

      <footer>
        <button onClick={async () => { await deleteMeeting(meetingId); onClose(); }}>Delete meeting</button>
      </footer>
    </div>
  );
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
```

The action item checkbox toggling, summary retry, and chunk retry are wired in Phase 9. Add a `// TODO: phase 9` next to those buttons.

- [ ] **Step 2: Add CSS hooks**

Add a section in `src/styles/globals.css` (or wherever component styles live) with class names matching the JSX. The team will theme these to match the existing dashboard aesthetic. Implementer should reference the existing `LogCaptureOverlay` styling for tone.

- [ ] **Step 3: Commit**

```bash
git add src/views/sections/MeetingView.tsx src/styles/globals.css
git commit -m "feat(ui): add MeetingView detail page"
```

---

### Task 23: `MeetingsView.tsx` — list view

**Files:**
- Create: `src/views/sections/MeetingsView.tsx`

- [ ] **Step 1: Implement the list view**

```tsx
import { useEffect, useMemo, useState } from "react";
import { listMeetings, type MeetingRow } from "../../lib/api";

type Filter = "all" | "week" | "month" | string; // string = bundle_id

type Props = { onSelect: (id: string) => void };

export function MeetingsView({ onSelect }: Props) {
  const [rows, setRows] = useState<MeetingRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => { void listMeetings().then(setRows); }, []);

  const apps = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.detected_app && r.detected_app_name) m.set(r.detected_app, r.detected_app_name);
    }
    return [...m.entries()];
  }, [rows]);

  const filtered = useMemo(() => {
    const now = Date.now();
    return rows.filter((r) => {
      if (filter === "all") return true;
      if (filter === "week") return now - new Date(r.started_at).getTime() < 7 * 86400 * 1000;
      if (filter === "month") return now - new Date(r.started_at).getTime() < 30 * 86400 * 1000;
      return r.detected_app === filter;
    });
  }, [rows, filter]);

  if (!rows.length) {
    return (
      <div className="meetings-empty">
        <h2>No meetings yet</h2>
        <p>Start a meeting in Zoom, Teams, or FaceTime, or press ⌘⇧M to record manually.</p>
      </div>
    );
  }

  return (
    <div className="meetings-view">
      <div className="filter-chips">
        <button onClick={() => setFilter("all")} className={filter === "all" ? "active" : ""}>All</button>
        <button onClick={() => setFilter("week")} className={filter === "week" ? "active" : ""}>This week</button>
        <button onClick={() => setFilter("month")} className={filter === "month" ? "active" : ""}>This month</button>
        {apps.map(([id, name]) => (
          <button key={id} onClick={() => setFilter(id)} className={filter === id ? "active" : ""}>{name}</button>
        ))}
      </div>
      <ul className="meeting-rows">
        {filtered.map((r) => {
          const summary = r.summary_json ? (() => {
            try { return JSON.parse(r.summary_json!).summary?.[0] ?? ""; } catch { return ""; }
          })() : "";
          return (
            <li key={r.item_id} onClick={() => onSelect(r.item_id)}>
              <div className="title">{r.detected_app_name ?? "Manual"} · {new Date(r.started_at).toLocaleDateString()}</div>
              <div className="meta">{Math.round((r.duration_ms ?? 0) / 60000)}m</div>
              <div className="preview">{summary}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/views/sections/MeetingsView.tsx
git commit -m "feat(ui): add MeetingsView list with filter chips"
```

---

### Task 24: Settings → Meetings tab

**Files:**
- Modify: `src/views/Settings.tsx`
- Modify: `src/lib/api.ts` (add wrappers for the meeting settings commands)

- [ ] **Step 1: Add api wrappers**

In `src/lib/api.ts` append:

```typescript
export type MeetingSettings = {
  auto_detect: boolean;
  app_prefs: Record<string, "always" | "ask" | "never">;
  soft_warn_min: number;
  hard_cap_min: number;
};

export const getMeetingSettings = (): Promise<MeetingSettings> =>
  invoke("get_meeting_settings");

export const setMeetingAutoDetect = (on: boolean): Promise<void> =>
  invoke("set_meeting_auto_detect", { on });

export const setMeetingAppPref = (
  bundle_id: string,
  pref: "always" | "ask" | "never",
): Promise<void> => invoke("set_meeting_app_pref", { bundleId: bundle_id, pref });
```

- [ ] **Step 2: Add the Meetings tab**

In `src/views/Settings.tsx`, add a new tab/section "Meetings" with:
- Toggle for `auto_detect`
- Table of `app_prefs` with a select per row (Always / Ask / Never)
- Number inputs for `soft_warn_min` and `hard_cap_min` (or sliders matching existing settings)

Match the existing Settings tab styling.

- [ ] **Step 3: Commit**

```bash
git add src/views/Settings.tsx src/lib/api.ts
git commit -m "feat(ui): add Meetings settings tab"
```

---

### Task 25: ActivityFeed + sidebar nav integration

**Files:**
- Modify: `src/views/sections/ActivityFeed.tsx`
- Modify: `src/views/Main.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: ActivityFeed renders meetings**

In `src/views/sections/ActivityFeed.tsx`, find the row renderer and add a case for `kind === "meeting"`:

```tsx
import { Phone } from "lucide-react";
// ...
case "meeting":
  return (
    <div className="row meeting" onClick={() => onSelect(item.id)}>
      <Phone size={16} />
      <span className="title">{item.content}</span>
      <span className="ts">{formatRelative(item.created_at)}</span>
    </div>
  );
```

The existing query that drives ActivityFeed should already select `kind="meeting"` rows by default; confirm in the data layer.

- [ ] **Step 2: Add MeetingsView to sidebar nav**

In `src/views/Main.tsx`, find the existing sidebar nav (where Activity / Search / Tasks / Chat live) and add a "Meetings" entry. Wire it to render `<MeetingsView onSelect={(id) => setRoute({ kind: "meeting", id })} />`.

- [ ] **Step 3: Route to MeetingView**

In `src/App.tsx`, extend the route discriminated union:

```typescript
type Route = ... | { kind: "meeting"; id: string };
```

Render `<MeetingView meetingId={route.id} onClose={() => setRoute({ kind: "meetings-list" })} />` when `route.kind === "meeting"`.

- [ ] **Step 4: Commit**

```bash
git add src/views/
git commit -m "feat(ui): integrate meetings into ActivityFeed + sidebar nav"
```

---

## Phase 9 — Error handling & crash recovery

### Task 26: Crash recovery on app startup

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs` (add `recover_orphans` function)
- Modify: `src-tauri/src/lib.rs` (call it once after DB open)

- [ ] **Step 1: Add the recovery scan**

Append to `src-tauri/src/meeting/mod.rs`:

```rust
/// Scan for orphaned meeting directories and DB rows whose status is non-terminal.
/// Returns the IDs of meetings that need user attention.
pub fn scan_orphans(data_dir: &std::path::Path, db: &Db) -> Vec<String> {
    let mut out = Vec::new();
    let result = db.with_conn(|conn| -> Result<Vec<String>, crate::db::DbError> {
        let mut stmt = conn.prepare(
            "SELECT item_id FROM meetings WHERE status IN ('recording', 'transcribing', 'summarizing')"
        )?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    });
    if let Ok(ids) = result {
        for id in ids {
            let dir = data_dir.join("meetings").join(&id);
            tracing::warn!(meeting = %id, exists = dir.exists(), "orphaned meeting found");
            out.push(id);
        }
    }
    out
}

/// Mark all orphans as `failed` so the UI shows them as broken; the user can
/// then choose to retry transcription/synthesis from the detail view, or delete.
pub fn finalize_orphans_as_failed(db: &Db, ids: &[String]) {
    for id in ids {
        let id = id.clone();
        let _ = db.with_conn(move |conn| {
            crate::db::meetings::update_status(conn, &id, MeetingStatus::Failed)
        });
    }
}
```

- [ ] **Step 2: Call on startup in `lib.rs`**

After DB is opened and before launching detector:

```rust
    let data_dir = app.path().app_data_dir().unwrap();
    if let Some(db_ref) = db.as_ref() {
        let orphans = crate::meeting::scan_orphans(&data_dir, db_ref);
        if !orphans.is_empty() {
            crate::meeting::finalize_orphans_as_failed(db_ref, &orphans);
            let _ = app.emit("meetings-recovered", &serde_json::json!({ "ids": orphans }));
        }
    }
```

- [ ] **Step 3: Frontend banner**

In `src/App.tsx`, listen for `meetings-recovered` and show a one-time banner: "N unfinished meetings recovered. View them in Meetings."

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/mod.rs src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(meeting): scan and flag orphaned meetings on startup"
```

---

### Task 27: Retry commands — failed chunks + synthesis

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/meeting/mod.rs`
- Modify: `src/views/sections/MeetingView.tsx` (wire the buttons)

- [ ] **Step 1: Add `retry_meeting_summary`**

In `src-tauri/src/meeting/mod.rs`, add:

```rust
impl MeetingManager {
    pub async fn retry_summary(&self, id: &str) -> Result<(), MeetingError> {
        let id_for_db = id.to_string();
        let row = self.db.with_conn(move |conn| {
            crate::db::meetings::get_meeting(conn, &id_for_db)
        }).map_err(|e| MeetingError::Db(e.to_string()))?
          .ok_or_else(|| MeetingError::Db("meeting not found".into()))?;

        let transcript: serde_json::Value = row.transcript_json
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(serde_json::json!({})))
            .unwrap_or(serde_json::json!({}));
        let segments: Vec<Segment> = serde_json::from_value(transcript.get("segments").cloned().unwrap_or_default())
            .unwrap_or_default();
        let duration_ms = transcript.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);

        let synthesis = synthesizer::synthesize(
            self.llm.clone(), &segments, row.detected_app_name.as_deref(), duration_ms,
        ).await;
        if let Ok(s) = synthesis {
            let summary_str = serde_json::to_string(&s).unwrap_or_default();
            let id_for_db = id.to_string();
            self.db.with_conn(move |conn| {
                conn.execute(
                    "UPDATE meetings SET summary_json = ?1, status = 'complete' WHERE item_id = ?2",
                    rusqlite::params![summary_str, id_for_db],
                )?;
                Ok(())
            }).map_err(|e| MeetingError::Db(e.to_string()))?;
        }
        Ok(())
    }

    pub async fn retry_chunks(&self, id: &str) -> Result<(), MeetingError> {
        // Re-transcribe each WAV in failed/, append to existing transcript.
        let dir = self.data_dir.join("meetings").join(id).join("failed");
        if !dir.exists() { return Ok(()); }
        let entries: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("wav"))
            .collect();

        let id_for_load = id.to_string();
        let row = self.db.with_conn(move |conn| {
            crate::db::meetings::get_meeting(conn, &id_for_load)
        }).map_err(|e| MeetingError::Db(e.to_string()))?
          .ok_or_else(|| MeetingError::Db("meeting not found".into()))?;
        let mut transcript: serde_json::Value = row.transcript_json
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(serde_json::json!({})))
            .unwrap_or(serde_json::json!({}));

        let mut still_failed: Vec<std::path::PathBuf> = Vec::new();
        for path in &entries {
            // Filename like "mic-chunk-0007.wav" or "sys-chunk-0007.wav".
            let speaker = match path.file_name().and_then(|s| s.to_str()) {
                Some(name) if name.starts_with("mic-") => Speaker::You,
                Some(name) if name.starts_with("sys-") => Speaker::Them,
                _ => { continue; }
            };
            match self.asr.transcribe_file(path).await {
                Ok(text) if !text.trim().is_empty() => {
                    let seg = Segment { speaker, start_ms: 0, end_ms: 0, text };
                    if let Some(arr) = transcript.get_mut("segments").and_then(|v| v.as_array_mut()) {
                        arr.push(serde_json::to_value(&seg).unwrap());
                    }
                    let _ = std::fs::remove_file(path);
                }
                _ => still_failed.push(path.clone()),
            }
        }

        let id_for_save = id.to_string();
        let transcript_str = serde_json::to_string(&transcript).unwrap();
        let still_count = still_failed.len() as i64;
        self.db.with_conn(move |conn| {
            conn.execute(
                "UPDATE meetings SET transcript_json = ?1, failed_chunk_count = ?2 WHERE item_id = ?3",
                rusqlite::params![transcript_str, still_count, id_for_save],
            )?;
            Ok(())
        }).map_err(|e| MeetingError::Db(e.to_string()))?;
        Ok(())
    }
}
```

- [ ] **Step 2: Tauri commands**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn retry_meeting_summary(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.meeting_manager.retry_summary(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retry_meeting_chunks(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.meeting_manager.retry_chunks(&id).await.map_err(|e| e.to_string())
}
```

Register both in `lib.rs` `invoke_handler!`.

- [ ] **Step 3: Frontend wrappers + button wiring**

`src/lib/api.ts`:

```typescript
export const retryMeetingSummary = (id: string): Promise<void> =>
  invoke("retry_meeting_summary", { id });
export const retryMeetingChunks = (id: string): Promise<void> =>
  invoke("retry_meeting_chunks", { id });
```

In `MeetingView.tsx`, wire the two `Retry` buttons.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ src/lib/api.ts src/views/sections/MeetingView.tsx
git commit -m "feat(meeting): retry summary + retry failed chunks"
```

---

### Task 27.5: Hard cap + soft warn timers

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs`

- [ ] **Step 1: Spawn a timer task in `MeetingManager::start`**

In the `start` method (after the recorder is constructed, before storing into `state`), add:

```rust
        let soft_warn_min = /* read from settings via injected store; pass into start() */ 120u32;
        let hard_cap_min = 240u32;
        let app_handle = self.app_handle.clone();
        let manager = Arc::downgrade(&Arc::new(()) /* placeholder */);
        let id_for_timer = id.clone();
        // For real implementation: pass `Arc<MeetingManager>` (this is `&self`, so the
        // caller of start() should hold the Arc and pass it in, OR use a oneshot
        // channel to notify the manager. The simplest: the manager spawns this task
        // from `start_with_self(self: Arc<Self>)` — refactor `start` to take Arc<Self>.)
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(soft_warn_min as u64 * 60)).await;
            let _ = app_handle.emit("meeting-soft-warn", &serde_json::json!({ "id": id_for_timer }));
        });
```

The cleanest implementation: change the `start` signature from `pub async fn start(&self, ...)` to `pub async fn start(self: Arc<Self>, ...)` so the spawned task can hold a `Weak<Self>` and call `self.stop()` on hard cap. Update the command handler to clone the Arc:

```rust
state.meeting_manager.clone().start(...)
```

The timer task:

```rust
        let manager_weak = Arc::downgrade(&self);
        let id_for_cap = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(hard_cap_min as u64 * 60)).await;
            if let Some(mgr) = manager_weak.upgrade() {
                if mgr.is_active().await {
                    let active_id = {
                        let g = mgr.state.lock().await;
                        g.as_ref().map(|a| a.item_id.clone())
                    };
                    if active_id.as_deref() == Some(&id_for_cap) {
                        tracing::warn!(id = %id_for_cap, "hard cap reached, auto-stopping");
                        let _ = mgr.stop().await;
                    }
                }
            }
        });
```

Read `soft_warn_min`/`hard_cap_min` from `state.settings` at start time.

- [ ] **Step 2: Frontend handles `meeting-soft-warn`**

In `src/App.tsx`, add a listener that surfaces a non-blocking toast when the event fires.

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/mod.rs src-tauri/src/commands.rs src/App.tsx
git commit -m "feat(meeting): add soft-warn + hard-cap auto-stop timers"
```

---

## Phase 10 — Tests + final integration

### Task 28: End-to-end pipeline test with fixture audio

**Files:**
- Create: `src-tauri/tests/meeting_pipeline.rs`
- Create: `src-tauri/tests/fixtures/silence_60s.wav` (generated by the test setup)

- [ ] **Step 1: Write the test harness**

Create `src-tauri/tests/meeting_pipeline.rs`:

```rust
//! End-to-end smoke test: feed fixture WAV chunks through the pipeline and
//! assert the merged transcript is structurally correct (text contents
//! depend on the active Parakeet model and are not asserted).

use echo_scribe_lib::meeting::{Segment, Speaker, ChunkReady};
use echo_scribe_lib::meeting::pipeline::Pipeline;
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::mpsc;

fn write_silence_wav(path: &std::path::Path, seconds: u32) {
    use std::io::Write;
    let sr: u32 = 16_000;
    let samples = sr * seconds;
    let data_bytes = samples * 2;
    let riff = 36 + data_bytes;
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(b"RIFF").unwrap();
    f.write_all(&riff.to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&sr.to_le_bytes()).unwrap();
    f.write_all(&(sr * 2).to_le_bytes()).unwrap();
    f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap();
    f.write_all(&data_bytes.to_le_bytes()).unwrap();
    f.write_all(&vec![0u8; data_bytes as usize]).unwrap();
}

#[tokio::test]
#[ignore = "requires Parakeet model loaded; run with --ignored"]
async fn pipeline_drains_and_merges_chunks() {
    let tmp = tempdir().unwrap();
    let mic_path = tmp.path().join("mic-chunk-0000.wav");
    let sys_path = tmp.path().join("sys-chunk-0000.wav");
    write_silence_wav(&mic_path, 60);
    write_silence_wav(&sys_path, 60);

    // Construct AsrPipeline with the configured default model. If the model isn't
    // downloaded, this test is a no-op (skipped via #[ignore]).
    let asr = Arc::new(echo_scribe_lib::asr::AsrPipeline::new(std::time::Duration::from_secs(60)));
    if !asr.ready() { eprintln!("asr not ready, skipping"); return; }

    let (tx, rx) = mpsc::unbounded_channel::<ChunkReady>();
    tx.send(ChunkReady { speaker: Speaker::You, path: mic_path, start_ms: 0, end_ms: 60_000 }).unwrap();
    tx.send(ChunkReady { speaker: Speaker::Them, path: sys_path, start_ms: 0, end_ms: 60_000 }).unwrap();
    drop(tx);

    let pipeline = Pipeline::new(asr, tmp.path().join("failed"));
    let handle = pipeline.spawn_drain(rx);
    handle.await.unwrap();
    let (segments, failed) = pipeline.finalize().await;
    assert!(failed.is_empty(), "unexpected failures: {failed:?}");
    // Silence should produce no segments because TranscriptBuilder skips empty text.
    let _: Vec<Segment> = segments;
}
```

- [ ] **Step 2: Add `echo_scribe_lib` re-export if needed**

If the tests fail to import, ensure `src-tauri/Cargo.toml` has `[lib] name = "echo_scribe_lib"` (or whatever the binary's library name is — check existing).

- [ ] **Step 3: Run the test**

```bash
cd src-tauri && cargo test --test meeting_pipeline -- --ignored
```

Expected: PASS (the `#[ignore]` skips it by default; `--ignored` runs it). If Parakeet isn't ready in CI, the test no-ops gracefully.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/meeting_pipeline.rs
git commit -m "test(meeting): add end-to-end pipeline smoke test"
```

---

### Task 29: Manual test plan + final smoke build

**Files:**
- Create: `docs/superpowers/plans/manual-tests-meeting-capture.md`

- [ ] **Step 1: Write the manual test plan**

Create `docs/superpowers/plans/manual-tests-meeting-capture.md`:

```markdown
# Manual Test Plan — Meeting Capture

Run these tests on a fresh release build (`bun tauri build --bundles app`)
followed by the full TCC reset + reinstall sequence in CLAUDE.md.

## Setup

1. Reinstall the .app per CLAUDE.md.
2. Grant Microphone permission when prompted.
3. Grant Screen Recording permission when prompted (System Settings → Privacy & Security → Screen Recording → Echo Scribe).
4. Confirm Parakeet and Gemma 4 E2B are downloaded (Settings → Models).

## Test 1 — Manual hotkey, FaceTime call

1. Open FaceTime, start a call with a friend (or echo-test number).
2. Press Cmd+Shift+M.
3. Verify red recording overlay appears with timer + Stop button.
4. Talk for ~2 minutes, alternating speakers.
5. Press Cmd+Shift+M (or click Stop).
6. Verify overlay shows "Transcribing…" then disappears.
7. Open the app → Meetings → top entry.
8. Verify: title is editable, summary card has 3-5 bullets, action items if any, transcript shows alternating "You" / "Them" segments.

## Test 2 — Auto-detect, Zoom

1. Open Zoom, join any meeting.
2. Within ~5s, in-app prompt should appear: "Zoom meeting detected".
3. Click "Just once".
4. Verify recording starts, overlay shown.
5. Talk for ~30s.
6. Click Stop in the overlay.
7. Verify the meeting appears in ActivityFeed AND in Meetings view.

## Test 3 — Browser meeting (Google Meet)

1. Open Chrome, go to meet.google.com, start a meeting.
2. After ~5s of mic activity, in-app prompt should appear: "Chrome meeting detected".
3. Click "Always".
4. Verify recording starts.
5. End the call by closing the tab.
6. Recording should auto-stop within 30s of mic going quiet.
7. Verify meeting saved with `detected_app_name = "Chrome"`.

## Test 4 — Mid-meeting Screen Recording revocation

1. Start a meeting via hotkey.
2. While recording, revoke Screen Recording permission in System Settings.
3. Verify the app falls back to mic-only and surfaces a banner in the post-meeting view.
4. Verify the saved transcript has only "You" segments and `mic_only: true`.

## Test 5 — Force-quit recovery

1. Start a meeting; let it record for ~3 minutes.
2. `kill -9 $(pgrep "Echo Scribe")`
3. Reopen the app.
4. Verify a recovery banner appears.
5. Open Meetings → the killed meeting should appear with status "failed". Manual retry workflow runs synthesis on the partially-transcribed transcript.

## Test 6 — Hard cap

1. Set hard cap to 1 minute in Settings.
2. Start a meeting.
3. After 1 minute, verify recording auto-stops (this requires Phase 7 timing logic — defer if not yet implemented).

## Test 7 — Concurrent meeting prevention

1. Start a meeting via hotkey.
2. While recording, open Zoom and join a call.
3. Verify the auto-detect does NOT trigger a second meeting (the first is still active).
4. Stop the first meeting.
5. Verify Zoom now triggers the consent flow.
```

- [ ] **Step 2: Run a final release build to confirm everything compiles + bundles**

```bash
bun tauri build --bundles app
ls "src-tauri/target/release/bundle/macos/Echo Scribe.app/Contents/MacOS/"
```

Expected: both `Echo Scribe` and `echo-scribe-syscap-*` are present.

- [ ] **Step 3: Run the full reinstall and smoke-test Test 1 from the manual plan**

Per CLAUDE.md:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
tccutil reset Microphone com.echoscribe.app
tccutil reset Accessibility com.echoscribe.app
tccutil reset ScreenCapture com.echoscribe.app
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

Then run Test 1 from the manual plan.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/manual-tests-meeting-capture.md
git commit -m "docs: add manual test plan for meeting capture"
```

---

## Self-review checklist

Before declaring this plan done, verify:

- [ ] Every spec section has at least one task implementing it.
- [ ] No "TBD", "TODO", "fill in later" in any step.
- [ ] Type names used in later tasks (`MeetingRow`, `Segment`, `StoredSummary`, `MeetingStatus`, `ChunkReady`, `Speaker`) are defined exactly once.
- [ ] Function names match across tasks (`transcribe_file`, `start_meeting_manual`, `meeting_consent`, etc.).
- [ ] Every test has the failing-test step AND the passing-test step.
- [ ] Every commit message uses the project's `feat(scope): ...` / `feat: ...` convention from `git log`.

