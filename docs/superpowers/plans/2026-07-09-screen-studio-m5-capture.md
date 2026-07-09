# Screen Studio Parity — M5: Capture & Export Extras

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Area (region-of-display) capture with a drag-to-select picker; pause/resume during recording; a pre-record countdown; masking/highlight regions in the editor; GIF export; copy-exported-file-to-clipboard; and a custom background-music track mixed at export.

**Architecture:** Area capture = a `--rect` crop on the sidecar's display path whose events-header `capture.rect` IS the crop rect — the existing normalization (`nx=(e.x−rx)/rw`) then works untouched. Pause/resume = SIGUSR1/SIGUSR2 signals (mirroring the existing SIGTERM stop pattern; sidecar stdin is not piped), with one central pause-clock that shifts every appended PTS (video/audio/events) by cumulative paused time; the webcam file uses AVCaptureFileOutput's native `pauseRecording()`. Countdown is a frontend overlay window that delays the start call. Masks are project state (source-time ranges + normalized capture-space rects) drawn INSIDE the frame layer's zoom transform so they track content under zoom; kinds are `pixelate` and `highlight` only (canvas `ctx.filter` blur is not reliable in WKWebView — do not use it). GIF export is a render-pipeline output branch (gifenc, incremental frame writes). Clipboard copy uses NSPasteboard `writeObjects([NSURL])` via objc2 (arboard does text/images only — not files). Music mixing is a pure Rust WAV step after loudness normalization, before mux.

**Tech Stack:** unchanged + `gifenc` (bun dep, pure JS). Suites baseline (merged main bac7fcb): cargo **528**, bun **408**, build clean.

## Global Constraints

- All M1–M6 conventions hold: SOURCE-time lookups; only emitted timestamps re-anchor/retime; ONE shared fn per effect for preview/export parity; CLAUDE.md logging/friendly-error discipline (`target:"screenrec"` etc.); sidecar Swift changes rebuild + commit the aarch64 binary in the same commit (`bash scripts/build-screenrec.sh`).
- **Work in the M5 worktree** (this checkout), branch `feat/screen-studio-m5-capture`. The user's other sessions are editing the primary checkout — never touch it.
- No DB migration expected (masks/music live in project_json; area/pause are capture-side). If one becomes necessary verify the MIGRATIONS tail first (26 was free at plan time).
- New fields/flags default OFF/neutral: recordings and projects made before M5 behave byte-identically; the sidecar spawned without new flags must produce the exact argv it does today.
- Events timestamps remain ms offsets on the recording's OUTPUT clock: during pause, nothing is captured and the clock does not advance — a resumed recording's events/video/audio stay aligned with no gap.
- Privacy/robustness: pause must gate the input-event monitors too (no keystrokes/mouse logged while paused).

## Data contracts

**Sidecar `record` additions:**
- `--rect x,y,w,h` (GLOBAL points, top-left origin; valid only with `--display`): crop via `SCStreamConfiguration.sourceRect` (convert global→display-local points by subtracting `display.frame.origin`); `cfg.width/height` = rect size in pixels (× pxScale, even-rounded, 3840 cap preserved); events header `capture.rect = [x,y,w,h]` (the crop, global points) and `kind` stays `"display"`. `stopped.width/height` report the cropped pixel size. Malformed/out-of-bounds rect → clamp to the display, warn-log; zero-area after clamp → error event `bad_rect`.
- SIGUSR1 = pause, SIGUSR2 = resume (idempotent; pause while paused is a no-op, warn-logged). One monotonic pause clock: cumulative `pausedDuration`; every appended sample's PTS (video, audio mixer, and the events recorder's offset math) subtracts it; while paused, sample handlers drop buffers and the event monitors are gated. Webcam: `AVCaptureMovieFileOutput.pauseRecording()`/`resumeRecording()`. Heartbeats continue while paused with an added `"paused":true` field; `stopped.dur_ms` excludes paused time. Emit `{"event":"paused"}` / `{"event":"resumed"}` on transitions.

**Rust:** `RecordParams.rect: Option<(f64,f64,f64,f64)>` (appended as `--rect` only when Some — spawn argv otherwise byte-identical); `ScreenrecHandle.pause()/resume()` send the signals (log result); `pause_screen_recording`/`resume_screen_recording` commands + `is_screen_recording_paused`; tray gains a "Pause recording" item (label flips to "Resume recording"; only visible while recording); `screenrec-changed` emitted on pause state flips.

**Area picker (frontend):** SetupWindow's source picker gains a third kind `"area"`: pick a display, click "Select area" → a borderless, transparent, full-screen always-on-top picker window on that display (created in overlay.rs following camera_preview's pattern, sized to the display's full frame) where the user drags a rectangle (dimmed backdrop, live W×H readout, Esc cancels, Enter/mouse-up confirms); result returned as GLOBAL points via an event, stored in SetupWindow state, forwarded to `start_screen_recording` as `rect`. Show the chosen rect ("1200×800") with a "re-select" affordance.

**Countdown:** SetupWindow gains "Countdown" toggle (off/3 s, persisted with the audio prefs). When on: Start hides the setup window, shows a small frameless countdown overlay (center of the target display) ticking 3-2-1 (Esc cancels → re-shows setup), THEN invokes the existing start command. No sidecar involvement.

**Masks (EditorProject):**
```ts
masks: Array<{ id: string; startMs: number; endMs: number;
               rect: { x: number; y: number; w: number; h: number };  // normalized capture coords [0,1]
               kind: "pixelate" | "highlight" }>;   // default []
```
`clampMasks(masks, durationMs)` mirrors clampWebcamScenes (+rect clamped into [0,1], zero-area dropped). Masks MAY overlap in time with each other (unlike lanes' ranges — multiple masks can be active at once; the lane uses `moveRange`/`resizeRange` semantics per-chip WITHOUT the neighbor-stop… use free move/resize clamped only to [0,duration] and min length 500 ms). `masksAt(tMs, masks) -> Mask[]` (all active, source-time, half-open). Draw INSIDE the frame layer's zoom transform, after the frame, before cursor: `pixelate` = draw the region into a small offscreen (≈1/24 scale) and scale back up with `imageSmoothingEnabled=false`; `highlight` = dim the frame outside the union of active highlight rects (single overlay fill with even-odd cutouts), never dim inside. Hidden during camera scenes (screen hidden). Editor: Masks lane (chips over time, add-at-playhead 3 s), selected mask's rect drawn as a draggable/resizable box on the preview canvas via the existing `canvasToCapture` inverse mapping; kind select + delete in the inspector.

**GIF export:** export UI gains a format select (MP4 default | GIF). GIF path: `TARGET_GIF_FPS = 15` (frame-drop on the CFR grid exactly like speed does), output width capped at 960 (proportional, even), gifenc incremental `writeFrame` with per-frame palette (quality-first v1), no audio, same progress reporting. Result bytes go to a new small command `save_rendered_gif(recording_id, bytes via IPC body)` → `<id>.rendered.gif` next to the recordings + `screenrec-changed` (mirror the rendered-mp4 DB export-row idiom if trivially reusable; otherwise file-only + log, note it).

**Clipboard:** command `copy_export_to_clipboard(path)` — NSPasteboard `clearContents` + `writeObjects([NSURL fileURLWithPath])` via objc2/objc2-app-kit; success/failure logged + friendly error returned. UI: a "Copy" button wherever the finished export is surfaced (next to the existing reveal affordance in RecordingsView/EditorView — find it and match idiom).

**Music (EditorProject):** `audio.music: { path: string; volume: number } | null` (default null; volume 0..1, default 0.5; tolerant parse). Editor Audio section: "Background music" file picker (`.mp3/.m4a/.wav/.aac` via the existing dialog plugin), volume slider, clear button. Export: finalize gains `x-music` header (JSON `{path, volume}`, defensive parse → skip+warn); Rust: `extract_audio_at(music, wav, 48000)` (AVFoundation decodes mp3/m4a fine) → `mix_wav_samples(voice, music, out, music_gain)` — pure, TDD: music scaled by gain, added to voice, hard-clamped; music longer than voice → truncated; shorter → remaining tail is voice-only (no looping v1 — document); mixing runs AFTER normalize, BEFORE mux; any music failure → export continues without music + warn (fail-safe like loudness).

---

### Task 1: Sidecar area capture + Rust plumbing (Opus — Swift + geometry)

**Files:** `src-tauri/screenrec/main.swift` (`--rect` parse + display-path sourceRect + header/stopped changes), `src-tauri/src/screenrec/mod.rs` (RecordParams.rect + spawn arg + a pure rect-clamp helper with tests), `src-tauri/src/commands.rs` (`start_screen_recording` gains `rect: Option<Vec<f64>>` param, validated len-4), `src/lib/api.ts` (param plumbed). Rebuild + commit sidecar binary. Verify with a real 10 s cropped recording via the built sidecar run directly (log evidence in report): stopped width/height = crop px, events header rect = crop.

### Task 2: Area picker UI + countdown (Sonnet — windows + setup flow)

**Files:** `src-tauri/src/overlay.rs` (area-picker window + countdown window, camera_preview as the pattern), new `src/area-picker/` page, new `src/countdown/` page (tiny), `src/screenrec-setup/SetupWindow.tsx` ("Area" source kind + rect state + re-select; countdown toggle persisted with prefs), `src-tauri/src/commands.rs` (show/close picker + result event; countdown window show/hide), capabilities json if new windows need entries (check how camera-preview was registered). Esc cancels both. Countdown delays the existing start call — no new record semantics.

### Task 3: Sidecar pause/resume + tray/UI (Opus — riskiest)

**Files:** `src-tauri/screenrec/main.swift` (SIGUSR1/2 sources on main queue; central pause clock; sample-handler gating for video+audio; events-recorder gate + offset math; webcam pauseRecording/resumeRecording; paused heartbeats; paused/resumed events; dur_ms excl. pauses), `src-tauri/src/screenrec/mod.rs` (pause()/resume() + paused-state tracking from events), `src-tauri/src/commands.rs` + `lib.rs` (pause/resume/is-paused commands), `src-tauri/src/ui/tray.rs` (Pause/Resume item, visible only while recording), RecordingsView (pause state in the recording indicator — match existing idiom). Rebuild + commit binary. E2E evidence required in the report: a real recording with a mid-recording pause whose video duration ≈ active time (not wall time), events aligned across the pause boundary (n_events sane), webcam still muxable.

### Task 4: Editor masks — model + render (Opus)

**Files:** `src/lib/editorProject.ts` (+tests: masks contract + clampMasks), `src/lib/render/compositor.ts` (+tests: `masksAt`; pixelate block math pure where expressible; highlight cutout geometry), `src/lib/render/renderPipeline.ts` + `src/views/sections/EditorView.tsx` preview (shared fns, both consumers, inside-zoom-transform placement, hidden during camera scenes). No lane UI yet (Task 5).

### Task 5: Masks lane UI + rect editing on canvas (Sonnet)

**Files:** `src/views/sections/EditorView.tsx`. Masks lane (chips; free move/resize — no neighbor-stop — min 500 ms, clamped [0,duration]); add-at-playhead (3 s, kind pixelate, centered default rect 0.25×0.25); inspector (kind select, delete); selected mask's rect rendered on the preview as a draggable/resizable box via `canvasToCapture` (reuse the zoom center-pick mapping); all writes through `clampMasks` + debounced save.

### Task 6: GIF export (Opus — encoder integration + perf)

**Files:** `package.json` (+gifenc), `src/lib/render/renderPipeline.ts` (format branch per contract: 15 fps grid, ≤960 w, incremental writeFrame, no audio path), `src/views/sections/EditorView.tsx` (format select + wiring), `src-tauri/src/commands.rs` + `lib.rs` (`save_rendered_gif`), `src/lib/api.ts`. Memory discipline: never hold all frames; encode as you go. Report must include a real exported GIF's size/duration from an E2E run in the dev harness or note precisely why deferred to Task 8's E2E.

### Task 7: Clipboard copy + background music (Sonnet)

**Files:** `src-tauri/src/commands.rs` + `lib.rs` (`copy_export_to_clipboard` via objc2 NSPasteboard — check objc2-app-kit is already a dep, add feature flags minimally if not), export-surface UI button (find the reveal-export idiom and sit next to it), `src/lib/editorProject.ts` (+tests: `audio.music` contract), `src/views/sections/EditorView.tsx` (Audio section: picker via the existing dialog plugin, volume slider, clear), `src-tauri/src/screenrec/mod.rs` (`mix_wav_samples` pure + TDD per contract), `finalize_rendered_recording` (`x-music` defensive parse; extract → mix after normalize, before mux; fail-safe), `src/lib/api.ts`/renderPipeline flag plumbing.

### Task 8: E2E + manual QA (Sonnet)

Suites (528+/408+), build, **install only after checking no recording is in progress**, boot + log check, `.superpowers/sdd/m5-manual-qa.md`: area-record a region (picker feel; cropped file; auto-zoom still lands on clicks inside the crop); pause mid-recording → resume → no gap/desync, duration excludes pause; countdown 3-2-1 + Esc cancel; masks (pixelate over a region tracks under zoom; highlight dims outside); GIF export plays (size sane); Copy button → paste in Finder; music track mixed under voice at the chosen volume, fail-safe when file missing; pre-M5 recordings/projects unchanged. Remind: Screen Recording re-grant after reinstall.

## Self-review notes

- Task 3 is the milestone's risk center: the pause clock must be the ONE time authority (video PTS, audio PTS, events offsets, dur_ms) — a reviewer should trace a pause across all four consumers. Swift has no unit harness here; the E2E evidence contract substitutes.
- Area capture leans on the header-rect-is-crop trick so zoom/cursor/keystroke math is untouched — the reviewer should confirm no compositor change was needed.
- Masks intentionally allow temporal overlap (multiple simultaneous masks) — they use free-move semantics, NOT the lanes' neighbor-stop helpers; don't force them through moveRange/resizeRange.
- GIF quality v1 = per-frame palettes (bigger files, better color) — document; global palette is future work.
- Clipboard via NSPasteboard is macOS-only by nature; the command should compile-gate cleanly for future Windows work (cfg target_os).
- Music mixing after normalize means music volume is relative to normalized speech — that's the desired UX (set music level once, speech always consistent).
