# Meeting Capture & Notes — Design

**Status:** Draft → ready for implementation planning
**Date:** 2026-05-03
**Owner:** @denisduvauchelle

## Summary

Add a Granola-style meeting capture flow to Echo Scribe. When the user is in a Zoom / Teams / FaceTime / Slack-huddle / Discord / browser-based call, Echo Scribe records both sides of the audio locally, transcribes them with Parakeet, and uses the existing Gemma 4 E2B LLM to produce a summary and action items. Everything runs on-device; no bots join the call.

This spec covers the v1 feature only. Items explicitly out of scope are listed at the bottom.

## Goals

- Capture mic + system audio for any of the supported meeting apps with a single OS permission (Screen Recording).
- Produce a usable post-meeting note: AI summary, extracted action items (as `tasks` rows), full searchable transcript with "You" / "Them" labels, app + duration metadata, free-form user notes, and editable title.
- Trigger automatically when supported apps go into a call, plus a manual hotkey fallback.
- Reuse existing Echo Scribe infrastructure: Parakeet ASR, llama-cpp-2 LLM, SQLite/FTS5, recording overlay, settings store, hotkey manager.

## Non-goals (v1)

See `Section 9 — Out of scope` at the end. Calling out the headline ones here so they aren't quietly assumed: no calendar integration, no live transcript during the call, no in-call notepad, no per-participant speaker identification, no audio retention after transcription.

---

## Section 1 — Process & component architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Echo Scribe (existing Rust/Tauri process)                    │
│                                                              │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────┐ │
│  │ Coordinator│──▶│ MeetingMgr   │──▶│ AsrPipeline (Para- │ │
│  │ (existing) │   │   (new)      │   │ keet, existing)    │ │
│  └────────────┘   └──────┬───────┘   └────────────────────┘ │
│                          │                                   │
│                          ▼                                   │
│                  ┌───────────────┐    ┌─────────────────┐   │
│                  │ Mic capture   │    │ Llm (existing,  │   │
│                  │ (cpal,        │    │ llama-cpp-2)    │   │
│                  │  existing)    │    └─────────────────┘   │
│                  └───────────────┘                           │
│                          ▲                                   │
│                          │ stdout PCM frames                 │
│                          │                                   │
│  ─────────────── spawned child process ─────────────         │
│                                                              │
│  ┌─────────────────────────────────────────────┐            │
│  │ echo-scribe-syscap (new Swift sidecar)      │            │
│  │ - ScreenCaptureKit SCStream (audio-only)    │            │
│  │ - Excludes Echo Scribe's own audio output   │            │
│  │ - Writes raw 16kHz mono Int16 PCM to stdout │            │
│  │ - Heartbeat on stderr                       │            │
│  └─────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────┘
```

### New Rust module: `meeting/` (peer to `asr/`, `audio/`, `llm/`)

- `meeting/mod.rs` — public surface, `MeetingManager` type
- `meeting/detector.rs` — NSWorkspace polling for known meeting bundle IDs, mic-in-use checks
- `meeting/syscap.rs` — supervises the Swift sidecar process, owns the PCM stream
- `meeting/recorder.rs` — owns the two `ChunkedWavWriter`s (mic + system), 10-min chunk rotation
- `meeting/pipeline.rs` — orchestrates: chunk-finalized → transcribe → delete → append to in-memory transcript
- `meeting/synthesizer.rs` — at meeting-end, calls `Llm` with the merged transcript to produce summary + action items + suggested title

### New Swift binary: `echo-scribe-syscap`

- ~150 lines of Swift, single source file, lives at `src-tauri/syscap/main.swift`
- Built via `xcrun swiftc` invocation in `release.yml` (and a `cargo build` script step for local builds)
- Bundled via Tauri's `externalBin` config so it lives at `Contents/MacOS/echo-scribe-syscap` in the .app
- Inherits the parent's TCC scope (codesigning carries through)

### Why a separate `MeetingManager` instead of extending `Coordinator`

The existing coordinator handles the dictation lifecycle (push-to-talk, paste, overlay). Meetings are long-running, multi-stream, and have entirely different state transitions (`idle → recording → finalizing → transcribing → summarizing`). Mixing them would make the coordinator's state machine unreadable. They communicate via a small `mpsc` channel — the coordinator is the source of truth for "what is the app doing right now" and refuses to start a dictation while a meeting is recording, and vice versa.

---

## Section 2 — Audio capture & chunked pipeline

### Format & rate

- Both streams: **16 kHz, mono, Int16 PCM** (matches Parakeet's input).
- Mic via `cpal` (existing path, reused as-is) — typically delivers 48 kHz, resampled in-process to 16 kHz mono via the existing `audio/resample.rs`.
- System audio via SCK in the sidecar — SCK delivers 48 kHz stereo `CMSampleBuffer`s; the sidecar mixes stereo → mono and resamples to 16 kHz before writing to stdout. Resampling in Swift (vDSP) keeps the stdout pipe bandwidth low (~32 KB/s instead of ~192 KB/s).

### Sidecar protocol

- **stdout:** raw little-endian Int16 PCM frames, no framing header. The Rust side reads byte-aligned chunks.
- **stderr (line-delimited JSON):** `{"event":"ready"}` once at startup; `{"event":"heartbeat","ts":...}` every 1s; `{"event":"error","kind":"...","msg":"..."}` on fatal errors followed by non-zero exit.
- **stdin:** unused in v1. (v2: graceful-stop signal. v1 just sends SIGTERM.)
- Sidecar excludes Echo Scribe's own bundle ID from the SCK content filter (so we don't capture our own UI sounds or playback).

### Chunked recording

A single `ChunkedWavWriter` per stream. Each writer:

- Starts a new `chunk-NNNN.wav` every **600 seconds** of *captured* audio.
- On rotation, the just-finalized chunk filename is sent over an `mpsc::UnboundedSender<ChunkReady>` channel to the transcription pipeline.
- WAV header is patched and the file is `fsync`'d before the channel send, so the consumer always sees a valid file.

**Why 10-minute chunks:**
- Crash safety: each finalized chunk is durable, so a crash loses ≤10 min of audio.
- Pipelined transcription: chunk N transcribes while chunk N+1 records; by the time the user stops, most transcription is already done.
- Rolling deletion: each WAV is deleted right after its transcription succeeds, so peak disk usage stays ~40 MB rather than ~230 MB for an hour-long meeting.

### Pipelined transcription

- A dedicated tokio task drains `ChunkReady` events.
- For each chunk: invoke `AsrPipeline::transcribe_file(path)` (a new method — the existing pipeline transcribes from a `Vec<f32>` buffer, so we add a thin file-loading wrapper that reuses the same engine).
- Two streams = two parallel transcription tasks (one per stream) with a shared semaphore of size 1 — Parakeet on ANE can only run one inference at a time, so they queue but don't fight. Mic transcription gets priority.
- On success: append the timestamped, speaker-labeled segments to an in-memory `TranscriptBuilder`, then `tokio::fs::remove_file(chunk_path)`.
- On failure: chunk path is moved to `meetings/<id>/failed/`, `failed_chunk_count` incremented on the meeting record. The WAV is **not** deleted — user can manually retry from the detail view.

### Timestamps

- Each chunk records its `wall_clock_start_ms` (relative to meeting start) when the rotation happens.
- Parakeet returns segment offsets within the chunk; we add `wall_clock_start_ms` to project them onto the meeting timeline.
- Final transcript is sorted by absolute timestamp, with each segment tagged `speaker: "you" | "them"`.

### Stop semantics

User stops via the overlay button, hotkey, or auto-stop trigger. `MeetingManager`:

1. Sends SIGTERM to sidecar; waits up to 2s for clean exit, else SIGKILL.
2. Stops mic stream.
3. Finalizes the current (partial) chunk on each writer.
4. Waits for the transcription queue to drain (UI shows "Transcribing remaining audio…" spinner — typically 5–30s).
5. Hands the merged transcript to `synthesizer.rs` for summary/action-items LLM pass.
6. Inserts the final `items`/`meetings` rows, deletes any remaining successful chunk WAVs.

---

## Section 3 — Transcript merge & LLM synthesis

### Transcript merge

The two parallel transcription streams produce segments like:

```
mic: [00:14.2 - 00:17.8] "Hey, can you hear me okay?"
sys: [00:18.5 - 00:21.0] "Yeah, loud and clear."
```

Merge: collect all segments from both into one `Vec<Segment>`, sort by `start_ms`, tag each with `speaker`. Overlapping segments (interruptions) are kept as-is and rendered side-by-side in the UI; they are not merged into a single line.

### Stored transcript shape (JSON in `meetings.transcript_json`)

```json
{
  "segments": [
    { "speaker": "you",  "start_ms": 14200, "end_ms": 17800, "text": "Hey, can you hear me okay?" },
    { "speaker": "them", "start_ms": 18500, "end_ms": 21000, "text": "Yeah, loud and clear." }
  ],
  "duration_ms": 1834000,
  "asr_model": "parakeet-tdt-0.6b-v2",
  "failed_chunk_count": 0,
  "mic_only": false
}
```

Plain-text view of the transcript is also written to `items.body` so the existing FTS5 search picks it up for free.

### LLM synthesis pass

Once the transcript is finalized, `synthesizer.rs` runs a single LLM pass that produces summary, action items, and suggested title in one call.

- **Model:** the existing active LLM via `Llm` — Gemma 4 E2B (Q4_K_M, 131K context) is the default. No new model registry entry. If the user has switched to another model, that model is used.
- **Context budget:** 131K context covers any meeting up to the 4h hard cap. No map-reduce fallback in v1. If the transcript ever overflows (extremely long, dense meetings), we truncate the oldest segments and tag the summary with a `"transcript_truncated": true` flag.
- **Prompt:** stored in `llm/prompt.rs` (existing module). Asks for strict JSON:
  ```json
  {
    "summary": ["bullet 1", "bullet 2", "bullet 3"],
    "action_items": [
      { "text": "...", "owner": "you" | "them" | "unspecified" }
    ],
    "suggested_title": "..."
  }
  ```
  - 3–5 summary bullets covering decisions, key topics, outcomes.
  - 0–N action items (skip if none).
  - Suggested title: max 60 chars.
- **Output format:** strict JSON via grammar-constrained sampling (the same approach already used for dictation post-processing in `llm/engine.rs`). On parse failure: retry once with a stricter prompt; if still bad, store the raw text in `summary_json.raw` and surface a "summary parse failed" badge in the UI.

### Action items → tasks table

Each extracted action item becomes a row in the existing `tasks` table, linked to the meeting via the existing `item_session_links` table. Checking them off in `TasksView.tsx` updates the same rows. On meeting deletion, links cascade-clear but the tasks survive.

### Suggested title

If the LLM produces a `suggested_title`, it becomes the meeting's default title. The user can rename inline in the meeting detail view. If no title is produced, default to `"Meeting with <app>" — Mon, May 5, 2:30pm`.

### Latency & UI feedback

- Typical 30-min meeting transcript: ~3–5k tokens → single-pass synthesis runs in 10–30s on a 4–8B model with Metal.
- During synthesis, the UI shows the meeting as `status: "Summarizing…"` in both ActivityFeed and MeetingsView. Once done, status flips to `complete`.

---

## Section 4 — Data model & DB schema

The existing `items` table already has a `kind TEXT` column, so meetings slot in cleanly as `kind="meeting"`. We add a sibling `meetings` table for meeting-specific fields rather than overloading `items` with sparse columns.

### New table: `meetings` (1:1 with `items` rows of `kind="meeting"`)

```sql
CREATE TABLE IF NOT EXISTS meetings (
  item_id            INTEGER PRIMARY KEY,
  started_at_ms      INTEGER NOT NULL,
  ended_at_ms        INTEGER,
  duration_ms        INTEGER,
  detected_app       TEXT,
  detected_app_name  TEXT,
  status             TEXT NOT NULL,
    -- "recording" | "transcribing" | "summarizing" | "complete" | "failed" | "recovered"
  transcript_json    TEXT,
  summary_json       TEXT,
  user_notes         TEXT,
  failed_chunk_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX idx_meetings_started_at ON meetings(started_at_ms DESC);
CREATE INDEX idx_meetings_status ON meetings(status);
```

### Action item linkage

Action items are rows in the existing `tasks` table, linked to the meeting via the existing `item_session_links` table. No new foreign key columns on `tasks`. On meeting deletion, `item_session_links` rows cascade-clear; the `tasks` rows survive.

### Search integration

`items.body` for `kind="meeting"` rows is populated with a flattened plain-text view:

```
[Summary]
- bullet 1
- bullet 2
[Transcript]
You: hey, can you hear me okay?
Them: yeah, loud and clear.
[Notes]
<user_notes>
```

The existing FTS5 `search` index already indexes `items.body` — meetings show up in `SearchView` for free, no schema changes to search infrastructure. The `body` is regenerated whenever transcript, summary, or notes change.

### Activity feed integration

`ActivityFeed.tsx` queries `items` by `kind` and renders a row per item. Adding `kind="meeting"` to its filter and an icon mapping is a one-line change.

### Migration

The project's migration system is "in-code `(version, sql)` list applied sequentially" (per `CODE_STRUCTURE.md`). We append:

```rust
(N, "CREATE TABLE meetings (...); CREATE INDEX idx_meetings_started_at ...; CREATE INDEX idx_meetings_status ...;")
```

where `N` is the next unused version. No data backfill needed.

### What lives on disk vs. in DB

- **DB:** everything except chunk WAVs (transcript JSON, summary, metadata, user notes).
- **Disk:** chunk WAVs only during recording + transcription. Each chunk is deleted as it transcribes successfully. Failed chunks are kept in `~/Library/Application Support/EchoScribe/meetings/<meeting-id>/failed/` so the user can manually retry; surfaced in the meeting detail view as a banner.

---

## Section 5 — UI surfaces

### 1. During recording — menu bar + floating overlay

- **Tray icon** (existing tray handle in `AppState`): swap to a red recording variant. Tooltip: "Recording meeting (mm:ss) — click to stop".
- **Recording overlay** (existing `recording-overlay` window, currently used for dictation): repurposed for meeting mode via a new `mode: "dictation" | "meeting"` prop driven by a Tauri event from the Rust side.
  - Dictation mode (existing): waveform + "release to send".
  - Meeting mode (new): app icon (Zoom logo, etc.) + "● Recording • mm:ss" + Stop button. Click-through everywhere except the Stop button.
- Overlay stays always visible during recording (privacy commitment).

### 2. Post-meeting — Meeting detail view (new)

`src/views/sections/MeetingView.tsx`, opened when the user clicks a meeting in either ActivityFeed or MeetingsView.

Layout (single column, top to bottom):

- **Header:** editable title (click to rename) · detected app icon + name · `started_at` formatted · duration · status badge (`Complete` / `Transcribing…` / `Summarizing…` / `Failed`).
- **Summary card:** the 3–5 bullets. Empty state if status != complete.
- **Action items card:** checkboxes — these are real `tasks` rows; checking them here updates them in `TasksView` too. Inline `+ add` for manual additions.
- **User notes card:** textarea bound to `meetings.user_notes`. Auto-saves on blur (matches the `LogCapture` auto-save pattern).
- **Transcript:** scrollable, two-column visual treatment — "You" left-aligned, "Them" right-aligned, with timestamps. Cmd+F (browser-native) for search-within-transcript. A `Copy transcript` button copies plain text.
- **Failed chunks banner** (only if `failed_chunk_count > 0`): "1 audio segment failed to transcribe. [Retry] [Discard]".

### 3. Meetings list view (new)

`src/views/sections/MeetingsView.tsx`, added to the sidebar nav alongside Activity / Search / Tasks / Chat.

- Reverse-chronological list of all meetings.
- Each row: title · app icon + name · date · duration · summary first-bullet preview.
- Filter chips at top: All / This week / This month · By app (chip per detected app present in the data).
- Empty state: "No meetings yet. Start a meeting in Zoom, Teams, or FaceTime, or press Cmd+Shift+M to record manually."

### 4. ActivityFeed integration

Existing `ActivityFeed.tsx` adds `kind="meeting"` to its query and renders meeting rows with a distinct icon (Lucide `Video` or `Phone`). Click → MeetingView. No layout changes — just one new kind in the existing renderer.

### 5. Settings additions

A new "Meetings" tab in `Settings.tsx`:

- Toggle: **Auto-detect meetings** (on by default). When off, only manual hotkey works.
- App allowlist: list of detected apps with per-app preference (`Always` / `Ask` / `Never`), populated as the user encounters them.
- Hotkey for manual start/stop (default `Cmd+Shift+M`) — uses existing hotkey infrastructure.
- Soft warning at: 2h (slider 30m–4h).
- Hard cap at: 4h (slider 1h–4h).

### 6. Consent prompt (first-detected-app)

When a meeting is auto-detected for an app whose preference is unset:

- Native macOS notification (via `tauri-plugin-notification`, already a dep): "Zoom meeting detected — record locally? [Always] [Just once] [Never for Zoom]".
- "Just once" starts recording without saving a preference.
- "Always" / "Never for Zoom" persists the preference.
- If notification permission isn't granted, fall back to bringing the main window forward with an inline prompt.

---

## Section 6 — Detection logic

### Polling loop

A tokio task in `meeting/detector.rs` polls every 2 seconds:

1. Fetch frontmost-and-running app list via `NSWorkspace.runningApplications` (through `objc2-app-kit` — already in the dep tree from focus-capture work; the existing focus-capture system already tracks frontmost app via PID and bundle ID, so we reuse that path).
2. Match each running bundle ID against the meeting-app registry (below).
3. For matches, query whether **the default input device is currently running** via CoreAudio (`kAudioDevicePropertyDeviceIsRunning` on `kAudioObjectSystemObject`'s default input). This tells us *some* process is actively recording from the mic — combined with the bundle-ID match from step 2, we attribute it to the matched app. (Per-process audio attribution requires private API, so this device-level signal is the public-API substitute.) If even this proves unreliable in practice, fall back to `app is running + window visible + in our known-meeting-app list`.
4. Edge-debounce: an app must register as "in meeting" for **two consecutive polls** (4s) before triggering, to avoid recording-app-launch flickers.
5. On state transition `idle → in_meeting`, consult per-app preference:
   - **Always** → start recording immediately.
   - **Never** → no-op.
   - **Ask** (default for first encounter) → fire consent notification (Section 5).

### v1 meeting-app registry (hardcoded, not user-editable)

| Bundle ID | Display name | Notes |
|---|---|---|
| `us.zoom.xos` | Zoom | Native client |
| `com.microsoft.teams2` | Microsoft Teams | New Teams (post-2024) |
| `com.microsoft.teams` | Microsoft Teams (classic) | Older builds |
| `com.apple.FaceTime` | FaceTime | |
| `com.hnc.Discord` | Discord | Voice channels |
| `com.tinyspeck.slackmacgap` | Slack | Huddles |
| `com.google.Chrome`, `company.thebrowser.Browser` (Arc), `org.mozilla.firefox`, `com.apple.Safari` | (browser) | Mic-active heuristic, see below |

### Browser-based meetings (Meet, Zoom-web, Teams-web)

v1 punts on browser tab inspection (which would need either a browser extension, AppleScript, or the Accessibility API). Instead:

- A browser bundle ID alone is **not** sufficient to trigger.
- The detector adds a "browser is using mic" check (same `kAudioDevicePropertyDeviceIsRunning` signal as above) — if a browser is the frontmost app AND the mic is active for >5s, treat that as an in-meeting signal.
- `detected_app` is recorded as the browser ("Chrome") with a "(browser meeting)" note in the UI. Not perfect, but covers the common case.
- Manual hotkey is the always-available fallback.

### Manual trigger

`Cmd+Shift+M` (configurable) — a global hotkey registered via the existing hotkey infrastructure. Toggles between start/stop. When manually triggered, `detected_app` records the bundle ID of the current frontmost app at start time.

### Stop conditions

A meeting ends when **any** of:

1. User clicks Stop in the overlay.
2. User invokes the hotkey again.
3. The detected app exits or stops using the mic for **30 seconds** (debounced).
4. Hard cap (4h) is reached.

### Privacy guardrails

- The detector itself does *not* listen to audio — only checks app-running and mic-in-use status. No audio is captured until recording is explicitly started (consent granted, manual trigger, or Always preference).
- The overlay is always visible during recording. No silent mode.
- The menu-bar icon doubles as a recording indicator, redundant with the overlay.

---

## Section 7 — Error handling & crash recovery

### Failure matrix

| Failure | Detection | Behavior |
|---|---|---|
| Screen Recording permission not granted | Sidecar exits with `{"event":"error","kind":"permission"}` on stderr | Stop recording immediately. Show modal: "Screen Recording permission needed for system audio. [Open System Settings] [Just record my mic]". Per-app preference is **not** persisted (so we ask again next time). If user picks mic-only, recording continues with `mic_only: true` flag on the meeting record. |
| Sidecar crashes mid-recording | stderr closes / exit code != 0 / heartbeat times out (>5s) | Mark current chunk as truncated. Try to respawn sidecar **once**. If respawn succeeds within 3s, continue (gap noted in transcript: `[system audio resumed]`). If respawn fails, fall back to mic-only and surface a banner in the post-meeting view. |
| Mic stream errors (device unplugged) | `cpal` callback error | Try to reopen the default input device once. If it fails, continue with system-audio-only and flag it. |
| Disk full | Chunk write returns `ENOSPC` | Stop recording immediately, finalize whatever's already on disk, surface error. Do not silently drop audio. |
| Parakeet transcription fails on a chunk | `transcribe_file` returns `Err` | Increment `failed_chunk_count`, move WAV to `meetings/<id>/failed/chunk-NNNN.wav`, continue with next chunk. Banner in detail view offers retry. |
| LLM synthesis fails (parse error after retry) | `synthesizer.rs` returns `Err` | Set status to `complete` (transcript is valid) but `summary_json = null`. Detail view shows "Summary generation failed. [Retry]" — retry runs only the synthesis pass, not transcription. |
| App quit during recording | Tauri `on_close_requested` + process-shutdown handlers | If a meeting is active: prompt "Stop recording and save meeting?" with [Stop & save] [Cancel quit]. If user force-quits or the system kills the process, see crash recovery below. |
| App crashes / killed mid-recording | On next launch, scan `meetings/` for orphaned chunk dirs (no corresponding `complete` row, or status stuck on `recording`/`transcribing`) | Show one-time recovery banner: "Recover unfinished meeting from <date>?" [Recover] [Discard]. Recover transcribes any un-transcribed chunks, runs synthesis, marks status `recovered`. Discard deletes the directory. |

### Resource invariants

- At most **one active meeting** at a time. Starting a second (manual or auto-detect) while one is active is a no-op with a brief overlay flash.
- Sidecar is supervised: if `MeetingManager` drops, its `Drop` impl SIGKILLs the sidecar. No orphan helpers.
- Chunk directory shares its name with the meeting's primary key, set at meeting start. Directory ⟷ DB row by primary key — recovery is deterministic.
- Transcription queue is bounded (16 chunks ≈ 2.5h of buffered audio). If the backlog exceeds that, recording is paused with a UI warning.

### Non-recoverable errors

- **LLM model not loaded / not downloaded:** synthesis is skipped with a clear message. Transcript still saves. User can retry synthesis later.
- **Parakeet model not loaded:** fatal — there's no point recording a meeting we can't transcribe. Detector refuses to trigger; manual hotkey shows an error toast.

### Testing approach

- Unit tests for `ChunkedWavWriter` rotation behavior, transcript merge ordering, LLM JSON parse + retry path, recovery scan.
- Integration test for the full happy path with fixture audio files (no actual SCK / mic): inject pre-recorded PCM into both stream sinks, run through the pipeline, assert the final `meetings` row.
- Manual test plan in `docs/superpowers/plans/...` for: real Zoom call, mid-meeting permission revocation, force-quit during transcription.
- Swift sidecar gets a `swift test` target that runs an SCK capture against a known-source app and asserts byte rate on stdout. Lightweight smoke test only.

---

## Section 8 — Key files touched

New files:

- `src-tauri/src/meeting/{mod,detector,syscap,recorder,pipeline,synthesizer}.rs`
- `src-tauri/src/db/meetings.rs` (queries; matches existing `db/items.rs` pattern)
- `src-tauri/syscap/main.swift` (the sidecar)
- `src-tauri/build.rs` step (or `release.yml` step) compiling the sidecar
- `src/views/sections/MeetingView.tsx`
- `src/views/sections/MeetingsView.tsx`
- `src/lib/api.ts` additions for new `invoke()` calls

Modified files:

- `src-tauri/src/lib.rs` — register new commands + state
- `src-tauri/src/commands.rs` — meeting commands (`start_meeting_manual`, `stop_meeting`, `retry_meeting_summary`, `retry_meeting_chunks`, `delete_meeting`, `update_meeting_notes`, `rename_meeting`, `recover_meeting`, `get_meeting`, `list_meetings`)
- `src-tauri/src/db/schema.rs` — append migration for `meetings` table
- `src-tauri/src/settings.rs` — meeting settings (auto-detect toggle, per-app prefs, hotkey, caps)
- `src-tauri/src/asr/pipeline.rs` — add `transcribe_file(path)` wrapper
- `src-tauri/src/llm/prompt.rs` — meeting synthesis prompt
- `src-tauri/tauri.conf.json` — `externalBin` entry for `echo-scribe-syscap`
- `src/App.tsx` — meeting events subscription, route to MeetingView
- `src/views/sections/ActivityFeed.tsx` — handle `kind="meeting"`
- `src/views/Settings.tsx` — Meetings tab
- `src/overlay/main.tsx` — meeting mode rendering

---

## Section 9 — Out of scope (v2+)

- **Calendar integration.** No EventKit, no auto-scheduling around events.
- **Live transcript display during the call.** Transcription runs in the background; user sees nothing transcript-related until the meeting ends.
- **In-call note-taking surface.** No notepad window during the call. User-notes field is edited before or after.
- **Speaker diarization within a single stream.** Speaker labels come from stream identity (mic = "you", system = "them"). Multiple remote participants all label "them".
- **Per-participant identification by name.** No "Sarah said X" — just "Them".
- **Map-reduce summarization of very long transcripts.** Gemma 4 E2B's 131K context covers any 4h meeting. Truncation fallback only.
- **Browser tab title detection.** Browser meetings detected by mic-active, not URL inspection.
- **Editing the transcript.** Read-only.
- **Re-running synthesis with a different prompt or model.** Single prompt, single model, no UI to tweak. Retry uses the same prompt.
- **Audio retention.** WAVs delete the moment their chunk transcribes. No "keep audio for N days" option.
- **Multi-track export.** No Markdown / DOCX / SRT export. Plain-text copy from detail view is the only export.
- **Search by speaker.** FTS hits flattened transcript text; no name metadata to query against.
- **Pause/resume during a meeting.** Stop ends the meeting.
- **Concurrent meetings.** One active meeting at a time, hard rule.
- **iCloud / cross-device sync.** Local-only, like the rest of Echo Scribe.
