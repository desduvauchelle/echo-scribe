# Screen Studio Parity — Milestone 2: The Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-recording Editor: trim the video, enlarge the cursor (rendered from event metadata), set padding + background (color/gradient/image), and overlay a webcam bubble (circle or rounded) — with all edits persisted per recording and applied on export (which now includes audio).

**Architecture:** Extends M1's foundation. New capture inputs (webcam file, hidden-cursor mode) live in the Swift sidecar; the editor is a canvas compositor in the webview reusing `drawComposite`/`renderRecording`; audio reaches exports via the existing sidecar `extract-audio`/`mux-audio` plumbing (WebCodecs stays video-only). Per-recording edits persist as one JSON column. Design context: `docs/superpowers/specs/2026-07-04-screen-studio-parity-design.md`.

**Tech Stack:** Swift (sidecar), Rust (Tauri v2), React/TS, `bun test`, WebCodecs + mp4box + mp4-muxer (existing).

## Global Constraints

- **Task 1 (events bug) gates Tasks 6+**: cursor rendering consumes the event stream; do not build on it until a harness proves handlers fire. Diagnosis report: `.superpowers/sdd/events-bug-diagnosis.md`.
- Next free DB migration number is **23** (22 = events_path; verify against `MIGRATIONS` tail in `src-tauri/src/db/schema.rs` before numbering).
- Swift sidecar changes rebuild + commit the binary in the same commit (`bash scripts/build-screenrec.sh`).
- CLAUDE.md error discipline everywhere: `tracing` with `target:`, friendly UI strings, log success AND failure of boundary ops. Toast API: `useToasts()` → `toasts.push({tone, message})`.
- Rust suite baseline **460**; TS suite baseline **22**; `bun run build` clean. Never break them.
- Reinstalls drop the Screen Recording TCC grant — never run `tccutil`; end-of-milestone install notes must remind Denis to re-grant.
- Design defaults (decided): hide-system-cursor is a **setup-window toggle, default OFF** (a hidden-cursor recording with a broken event stream would have no cursor at all — opt-in until battle-tested); webcam is **opt-in at record time** (can't be added post-hoc); the editor never mutates the source video — edits live in `project_json` and apply at export.
- Branch: `feat/screen-studio-m2-editor`.

## Data contracts (used across tasks)

**Project settings JSON** (column `recordings.project_json`, NULL = defaults; TS type is source of truth, Rust treats it as opaque TEXT):

```ts
// src/lib/editorProject.ts
export type EditorProject = {
  v: 1;
  trim: { startMs: number; endMs: number } | null;   // null = full length
  appearance: {
    padding: number;                                   // 0..256 px output-space
    cornerRadius: number;                              // 0..64 px
    background:
      | { type: "solid"; color: string }
      | { type: "gradient"; from: string; to: string }
      | { type: "image"; path: string };               // absolute path under recordings dir
  };
  cursor: { enabled: boolean; scale: number };         // scale 1..3; enabled only honored when recording has hidden cursor + events
  webcam: {
    show: boolean;
    shape: "circle" | "rounded";
    corner: "br" | "bl" | "tr" | "tl";
    sizeFrac: number;                                  // 0.1..0.35 of output width
  } | null;                                            // null when recording has no webcam file
};
export function defaultProject(): EditorProject;
export function parseProject(json: string | null): EditorProject; // tolerant: bad JSON/missing fields -> defaults (never throw)
```

**Sidecar additions** (Task 1 fix + Tasks 6/7): `record` gains `--hide-cursor` (sets `cfg.showsCursor = false`) and `--camera <uid>` (records `<out-stem>.webcam.mp4`, video-only H.264, via AVCaptureSession + AVCaptureMovieFileOutput). `stopped` event gains optional `"webcam": <path or "">`, `"webcam_offset_ms": <int>` (host-clock delta: webcam file start − first main frame; consumers shift webcam timeline by it). New subcommand `--list-cameras` → stdout JSON `{"cameras":[{"uid":"...","name":"..."}]}`.

**DB migration 23:** `ALTER TABLE recordings ADD COLUMN project_json TEXT; ALTER TABLE recordings ADD COLUMN webcam_path TEXT; ALTER TABLE recordings ADD COLUMN cursor_hidden INTEGER NOT NULL DEFAULT 0;`

**Compositor extension** (Task 3/6/8, `src/lib/render/compositor.ts` — keep pure/testable):

```ts
export type CursorSample = { t: number; x: number; y: number };       // capture-space points
export type OverlayState = {
  cursor: { x: number; y: number; clickAge: number | null } | null;   // normalized 0..1 capture space; clickAge ms since last down, null if none recent
  webcam: { frame: CanvasImageSource; shape: "circle" | "rounded"; corner: string; sizeFrac: number } | null;
};
export function cursorStateAt(tMs: number, moves: CursorSample[], downs: CursorSample[], header: EventsHeader): OverlayState["cursor"]; // binary-search + lerp between samples; null if no samples within 2000ms
export function drawCompositeV2(ctx, frame, frameW, frameH, outW, outH, appearance, zoom, overlay: OverlayState, cursorScale: number, bgImage: CanvasImageSource | null): void;
// drawCompositeV2 wraps the existing drawComposite layers, then draws cursor (arrow glyph path, scaled, with a fading click-ripple ring when clickAge < 400ms) and webcam (masked circle/rounded-rect, corner-anchored with 24px margin) INSIDE the padded frame area.
```

---

### Task 1: Fix zero-events capture (gates cursor work)

**Files:** `src-tauri/screenrec/InputEvents.swift` (and `main.swift` only if the fix requires init-order changes); Create: `src-tauri/screenrec/harness/` throwaway NOT committed.

**Requirements:** Implement the fix recommended by `.superpowers/sdd/events-bug-diagnosis.md` (expected: NSApplication init in record path, or switch `InputEventRecorder` to a listen-only `CGEventTap` preserving its public interface — init/start/markFirstFrame/finish and identical JSONL output + diag event, which now must also report the mechanism used). Preserve graceful degradation without Accessibility.

- [ ] **Step 1:** Read the diagnosis report; implement the minimal recommended fix.
- [ ] **Step 2:** Verify with the harness from the diagnosis (synthesized CGEventPost input → handler count > 0) rebuilt against the FIXED InputEvents.swift. Paste harness output in the report.
- [ ] **Step 3:** `bash scripts/build-screenrec.sh`; commit source + binary: `fix(screenrec): input-event monitors actually receive events (<mechanism>)`.
- [ ] **Step 4:** Live re-verify at end of milestone (Task 9): a real recording must produce `n_events > 0`.

### Task 2: Migration 23 + project/webcam plumbing (Rust + api.ts)

**Files:** `src-tauri/src/db/schema.rs` (append migration 23 exactly as the contract above; bump the two latest-version tests 22→23), `src-tauri/src/db/recordings.rs` (RecordingRow + insert/select/mapper + `set_project_json(conn, id, json)` helper + tests), `src-tauri/src/commands.rs` (`get_recording_project(id) -> Option<String>`, `set_recording_project(id, json: String)` commands with `target:"screenrec"` logging; `stop_screen_recording_inner` populates `webcam_path`/`cursor_hidden` from StoppedInfo; `delete_recording` also removes the webcam file), `src-tauri/src/screenrec/mod.rs` (StoppedInfo + parse_stopped: optional `webcam`, `webcam_offset_ms`; start() signature gains `hide_cursor: bool`, `camera_uid: Option<String>` → flags; `list_cameras()` + parse + command), `src/lib/api.ts` (RecordingRow: `project_json`, `webcam_path`, `cursor_hidden`; wrappers `getRecordingProject`, `setRecordingProject`, `listCameras`).

TDD: parse_stopped webcam fields (present/absent/empty), recordings round-trip for the three new columns, project get/set round-trip. Follow M1 Task 4's exact test patterns. Full suite + tsc green; commit.

### Task 3: Editor view scaffold + appearance controls

**Files:** Create `src/views/sections/EditorView.tsx` (route/modal opened from a new "Edit" button in RecordingsView's action row), Create `src/lib/editorProject.ts` (contract above) + `tests/editorProject.test.ts` (TDD: defaults, tolerant parse of null/garbage/partial JSON, round-trip), Modify `src/lib/render/compositor.ts` (add `drawCompositeV2` + bgImage support; keep old `drawComposite` working), `tests/compositor.test.ts` (extend: drawCompositeV2 is canvas-side — test only the pure layout helpers you extract, e.g. `webcamRect(outW,outH,corner,sizeFrac)` math).

Editor layout: left = canvas preview (a hidden `<video>` element seeked/played, drawn per rAF via drawCompositeV2 with the project's appearance; use `convertFileSrc`), right = controls: padding slider (0–256), corner radius slider (0–64), background picker (solid color input / gradient two colors / image via `@tauri-apps/plugin-dialog` open() → command `import_editor_background(id, src_path) -> String` that copies the file into the recordings dir as `<id>.bg.<ext>` — add this small command in commands.rs with logging). Save on change (debounced) via `setRecordingProject`. All controls work on recordings with `events_path` NULL (pre-M1 rows).

### Task 4: Trim

**Files:** `src/views/sections/EditorView.tsx` (timeline strip under the preview: duration-proportional bar with draggable in/out handles + numeric readouts; playback clamps to [start,end] and loops within), `src/lib/editorProject.ts` (trim already in type), pure helper `clampTrim(trim, durationMs)` with tests (start<end, both within [0,duration], min length 500ms).

### Task 5: Export from the editor (with audio)

**Files:** `src/lib/render/renderPipeline.ts` (accept `project: EditorProject` + optional webcam decode source (Task 8 wires it); skip frames outside trim, re-anchor timestamps to trim start; use project appearance + bgImage), `src-tauri/src/commands.rs` + `src-tauri/src/screenrec/mod.rs`: new command `finalize_rendered_recording(id, bytes, trim_start_ms, trim_end_ms)` replacing M1's `save_rendered_recording` flow: (1) write video-only render to a temp mp4, (2) `extract-audio` from the recording's playable file, (3) trim the WAV in Rust (sample-range copy — pure function `trim_wav_samples`, unit-tested), (4) sidecar `mux-audio` temp video + trimmed WAV → `<id>.rendered.mp4`, (5) update exports JSON ("rendered" entry, replace-not-duplicate), cleanup temps on every failure path with logging. If the recording has no audio track (`extract-audio` → `no_audio`), fall back to saving the video-only render — never fail the export for missing audio.
UI: "Export" button in the editor with the existing progress pattern; success toast with Reveal button; the old "Render (beta)" button in RecordingsView is removed (the editor replaces it).

### Task 6: Synthetic cursor (enlarged cursor + click ripple)

**Files:** `src/screenrec-setup/SetupWindow.tsx` (toggle "Enhance cursor in editor (hides the system cursor while recording)" default OFF, persisted with audio prefs — extend `ScreenrecAudioPrefs` or a sibling pref), `src-tauri/src/commands.rs`/`screenrec/mod.rs` (thread `hide_cursor` through start_screen_recording; persist `cursor_hidden` on the row — plumbing from Task 2), `src-tauri/screenrec/main.swift` (`--hide-cursor` → `cfg.showsCursor = false`), `src/lib/render/compositor.ts` (`cursorStateAt` per contract + arrow glyph + ripple; TDD the interpolation: exact-sample hit, lerp midpoint, gap >2000ms → null, clickAge decay), `src/views/sections/EditorView.tsx` (cursor section: enable checkbox + size slider ×1.0–×3.0; disabled with explanatory tooltip when `!cursor_hidden || !events_path`), `src/lib/render/renderPipeline.ts` (draw cursor layer at export). Events are loaded once via existing `readRecordingEvents` and parsed with `parseEventsJsonl`; moves+downs pre-split.

### Task 7: Webcam capture

**Files:** `src-tauri/screenrec/main.swift` (`--camera <uid>`: AVCaptureSession(sessionPreset .high) + AVCaptureMovieFileOutput → `<out-stem>.webcam.mp4` video-only; start before SCStream, record `webcam_offset_ms` = (first main frame host PTS − didStartRecording host time)×1000 rounded; stop + finalize in finalize(); extend BOTH stopped payloads; `--list-cameras` subcommand per contract; degrade gracefully: camera failure emits a `warn` event and the recording continues without webcam), `src/screenrec-setup/SetupWindow.tsx` (Camera checkbox + device `<select>` from `listCameras()`, persisted pref, threaded through `startScreenRecording`), Rust plumbing from Task 2 carries the paths. Rebuild + commit binary. NOTE: camera use adds `NSCameraUsageDescription` — check `src-tauri/Info.plist`; if missing, ADD it (this is a permission-related change: the end-of-milestone install will trigger a camera prompt; do NOT reset TCC).

### Task 8: Webcam overlay in editor + export

**Files:** `src/views/sections/EditorView.tsx` (webcam section shown only when `webcam_path`: show/hide, circle/rounded, corner 4-way picker, size slider; preview uses a second hidden `<video>` element time-synced to main − `webcam_offset_ms`… offset persisted where? → store in project_json at first open if absent: extend EditorProject.webcam with `offsetMs: number`, defaulting from the stopped event via a new StoppedInfo→row column? DECISION: simplest is a 4th column in migration 23 — `webcam_offset_ms INTEGER` — Task 2 adds it and this task reads it), `src/lib/render/compositor.ts` (webcam layer in drawCompositeV2 — already contracted; pure `webcamRect` tested in Task 3), `src/lib/render/renderPipeline.ts` (second mp4box+VideoDecoder instance for the webcam file; per output frame pick nearest webcam frame ≤ t+offset; close frames promptly; if webcam decode fails mid-render, log to console and continue without overlay).

### Task 9: E2E verification + manual QA

Build (`bun tauri build --bundles app`), skip-TCC install, boot check, migration 23 live check. Scripted checks where possible; everything interactive goes to `.superpowers/sdd/m2-manual-qa.md`: (1) re-grant Screen Recording (reinstall drops it) + first camera prompt, (2) record with cursor-enhance ON + camera ON, moving/clicking — verify `n_events > 0` (Task 1 live gate) and `.webcam.mp4` exists, (3) open Editor: trim, padding+image background, cursor ×2, webcam circle bottom-right — preview reflects all live, (4) Export → plays with audio, trimmed, all layers baked, (5) pre-M1 recording opens in editor with cursor/webcam sections correctly disabled.

---

## Self-review notes

- Task ordering respects the two hard dependencies: 1→6 (events), 2→{3,5,6,7,8} (columns/plumbing), 7→8 (webcam file).
- Migration 23 carries all four columns (project_json, webcam_path, cursor_hidden, webcam_offset_ms) so it ships once — Task 2 owns it entirely; Task 8's DECISION note is resolved in Task 2's favor.
- Export keeps WebCodecs video-only; audio rides existing, battle-tested sidecar plumbing (macOS-first; the pure-WebCodecs AAC path is a documented M3+ candidate for Windows).
- Type names (`EditorProject`, `drawCompositeV2`, `cursorStateAt`, `webcamRect`, `finalize_rendered_recording`) are used consistently across Tasks 2-8.
