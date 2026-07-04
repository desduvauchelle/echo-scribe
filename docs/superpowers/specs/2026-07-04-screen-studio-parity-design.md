# Screen Studio Parity — Feature Map & Architecture Design

**Date:** 2026-07-04
**Status:** Approved direction; Milestone 1 plan at `docs/superpowers/plans/2026-07-04-screen-studio-m1-foundation.md`

## Goal

Bring Screen Studio's (https://screen.studio) feature set into Echo Scribe's existing screen-recording feature, architected so the editing/rendering layer is cross-platform (macOS + Windows) even though capture is per-platform.

## Current state (investigated 2026-07-04)

Echo Scribe already has: display/window capture (Swift sidecar `src-tauri/screenrec/main.swift`, ScreenCaptureKit → AVAssetWriter H.264 MP4), system-audio + mic capture with software mixing, thumbnails, recordings library UI (`src/views/sections/RecordingsView.tsx`), setup picker window, auto audio denoise (nnnoiseless), on-demand transcription (local ASR), quality export presets (AVAssetExportSession), Google Drive upload, tray controls. 453 Rust tests pass.

Known issues found:
1. `release.yml` builds only the syscap sidecar — screenrec/calmatch ship stale committed binaries; **no x86_64 binaries are tracked at all**, so Intel releases are broken/missing sidecars.
2. Auto-denoise failures after stop are logged but never surfaced to the user.
3. The AVAssetWriter status-3 window-resize bug is already fixed (`ced60d1`); resized-window frames are dropped, not re-encoded (accepted trade-off).

Not present today (all greenfield): event metadata capture, any editing (trim/zoom/crop/speed), appearance compositing (background/padding/radius/shadow), webcam, captions burn-in, GIF export, area capture, pause/resume.

## Feature map: Screen Studio → Echo Scribe

Legend: ✅ have · 🟡 partial · ❌ missing · ⛔ out of scope

| Screen Studio feature | Status | Parity route |
|---|---|---|
| Display / window capture | ✅ | — |
| Custom area capture | ❌ | M5: SCContentFilter display + `sourceRect` crop |
| System audio + mic (mixed) | ✅ | Per-app audio subset: later, low priority |
| Mic noise removal + normalization | 🟡 | Denoise exists (RNNoise); loudness normalization → M4 |
| Pause/resume, countdown | ❌ | M5 |
| Webcam overlay + dynamic layouts + auto-shrink on zoom | ❌ | M6 (AVCaptureSession video in sidecar; separate track/file) |
| iPhone/iPad recording | ⛔ | Skip (low value for our users) |
| **Auto-zoom on clicks** | ❌ | M1 (event capture + generator) + M2 (render) |
| Manual zoom blocks + zoom timeline | ❌ | M3 editor UI |
| Cursor smoothing / resize / custom cursors / hide-idle | ❌ | M4 — requires hidden-cursor capture mode + synthetic cursor render |
| Click ripple effects, click sounds | ❌ | M3/M4 (render layer) |
| Keystroke overlay | ❌ | M1 captures key events; M3 renders |
| Motion blur | ❌ | M4 (render layer, velocity-based) |
| Trim/cut, per-segment speed, speed-up-typing | ❌ | M3 |
| Masking / highlight | ❌ | M5 |
| Background (wallpaper/gradient/color/image), padding, rounded corners, shadow, inset | ❌ | M2 appearance system |
| Aspect-ratio presets + reflow | ❌ | M2 (basic) / M3 (follow-cursor reflow) |
| Captions (on-device ASR) + transcript editor | 🟡 | Transcription exists; timed captions + burn-in → M4 |
| Background music library | ⛔ | Skip for now (licensing) — custom audio file M5 |
| MP4 export up to 4K/60 | 🟡 | Today: AVAssetExportSession presets; render pipeline replaces this (M2) |
| GIF export | ❌ | M5 |
| Export to clipboard | ❌ | M5 (cheap) |
| Shareable hosted links | 🟡 | We have Drive upload + share link — good enough, keep |
| Presets / project files | ❌ | M3 (project persisted in DB per recording) |
| Windows support | ❌ | MW: Rust capture sidecar (`windows-capture` crate + Win32 hooks), same event/IPC schema |

## Architecture

The one architectural idea that unlocks nearly everything Screen Studio does: **recording = video file + timestamped input-event metadata; every "magic" effect is a deterministic post-process over that metadata.** Auto-zoom is click clustering; cursor smoothing is path interpolation; keystroke overlay is key events; typing speed-up is key-event density.

### Layers

1. **Capture (per-platform).** Swift sidecar gains an input-event recorder (NSEvent global monitors) writing `<id>.events.jsonl` next to the MP4 — platform-neutral schema (header line with capture geometry; then `move/click/scroll/key` events with ms offsets aligned to the first video frame's host-clock timestamp). Windows later ships a Rust sidecar emitting the same schema. Cursor stays baked-in (`showsCursor = true`) until M4's opt-in hidden-cursor mode.

2. **Edit model (cross-platform TS).** A per-recording project: appearance config (background, padding, radius, shadow, aspect), zoom blocks (auto-generated from events + manual), later trim/speed/captions. Pure TS modules with unit tests (`bun test`). Persisted in SQLite.

3. **Render (cross-platform TS).** Preview: canvas compositor in the webview. Export: WebCodecs (`VideoDecoder`/`VideoEncoder` + mp4 demux/mux libs) — works in WKWebView (macOS 14+ floor) and WebView2 (Windows). **Risk:** H.264 encode support in WKWebView — M1 includes a spike that proves decode→composite→encode end-to-end. Fallback if the spike fails: Swift sidecar `render` subcommand (AVVideoComposition) behind the same project schema, macOS-first.

### Why not ffmpeg / Remotion
Consistent with the original design decision (no ffmpeg: heavy + licensing). WebCodecs uses the OS hardware encoders on both platforms with zero bundled binaries.

## Milestones

- **M1 — Foundation (this session):** CI sidecar fix, denoise-failure surfacing, event capture in sidecar, DB/API plumbing, auto-zoom generator (pure TS + tests), WebCodecs render spike producing a real "Render (beta)" export with background + auto-zoom.
- **M2 — Appearance & export v1:** full appearance system UI, aspect presets, render pipeline hardened (audio passthrough, progress, cancellation), replaces quality-preset export.
- **M3 — Editor:** timeline UI (zoom blocks, trim, speed), keystroke overlay, click effects, project persistence/presets.
- **M4 — Cursor & captions:** hidden-cursor capture mode, synthetic cursor render (smoothing/resize/hide-idle), motion blur, timed captions + burn-in, loudness normalization.
- **M5 — Capture & export extras:** area capture, pause/resume, countdown, masking/highlight, GIF export, copy-to-clipboard, custom audio track.
- **M6 — Webcam:** camera capture track, overlay layouts, auto-shrink on zoom.
- **MW — Windows capture sidecar:** same schemas; app-wide Windows port is a separate effort (tracked in the existing Windows-compat investigation).

Each milestone gets its own plan file under `docs/superpowers/plans/` and merges to main independently.
