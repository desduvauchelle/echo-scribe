# Editor: Global Defaults, Zoom Controls, Audio Cleanup — Design

**Date:** 2026-07-22
**Status:** Approved (design), pending implementation plan
**Area:** Screen-recording editor (`src/editor/`, `src/views/sections/EditorView.tsx`, `src/lib/editorProject.ts`, `src/lib/render/`, `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs`)

## Summary

Three independent improvements to the recording editor:

1. **Global editor defaults ("auto-remember").** Persist a small set of editor preferences across recordings so the user doesn't re-set them every time. Auto-remembered on change; applied only when seeding a brand-new project.
2. **Zoom controls.** A top-level On/Off toggle (default On), the ability to delete a single auto-zoom while the rest stay automatic ("suppress just that one"), and a "Remove all zooms" button.
3. **Audio cleanup in export.** Add a denoise toggle alongside the existing loudness-normalize toggle in the editor's MP4 export path.

Each piece rides existing codebase patterns. No new export path, no change to the render compositor's video output.

## Background — how the editor works today

- The editor is a separate Tauri window (`src/editor/`) hosting one large component, `EditorView` (`src/views/sections/EditorView.tsx`).
- All edit state is one TS model, `EditorProject` (`src/lib/editorProject.ts`), persisted opaquely in the SQLite column `recordings.project_json`. `defaultProject()` (editorProject.ts:144) is the look a new/unedited recording opens with.
- Preview (canvas) and export (WebCodecs, `src/lib/render/`) share the same compositor math (`src/lib/render/compositor.ts`), so a change honored in `drawComposite` shows identically in both.
- App-wide settings live in the Tauri plugin-store JSON (`src-tauri/src/settings.rs`, file `settings.json`), accessed from the frontend only through per-key Tauri commands + `api.ts` wrappers. `FormatTemplate` (settings.rs:75) is the existing example of a structured value stored as JSON.
- MP4 export audio is muxed post-render in `finalize_rendered_recording` (commands.rs:4743), the single chokepoint for trim/retime/normalize/mux. It already applies loudness-normalize conditionally via the `x-normalize-loudness` header. Denoise exists as a separate core (`src-tauri/src/denoise/mod.rs`) invoked outside the editor today. GIF export has no audio.

## Piece 1 — Global editor defaults ("auto-remember")

### Storage

Add a single structured JSON blob `editor_defaults` to the settings store, following the `FormatTemplate` pattern:

- `src-tauri/src/settings.rs`: an `EditorDefaults` struct (all fields optional / defaulted), a getter/setter pair on `SettingsStore`, serialized as JSON under one key.
- Tauri commands `get_editor_defaults` / `set_editor_defaults` registered in `lib.rs`.
- `api.ts` wrappers `getEditorDefaults()` / `setEditorDefaults(partial)`.

The blob is deliberately a *subset* of `EditorProject` — only the remembered fields — not the whole project.

### Remembered fields

| Preference | Project path |
|---|---|
| Zoom on/off | `zoom.mode` (auto ↔ off) |
| Camera size | `webcam.sizeFrac` |
| Camera position | `webcam.corner` |
| Cursor size | `cursor.scale` |
| Cursor shown | `cursor.enabled` |
| Aspect ratio | `appearance.aspect` |
| Background | `appearance.background` |
| Padding | `appearance.padding` |
| Corner radius | `appearance.cornerRadius` |

Note: camera fields are only meaningful when the recording has a webcam (`project.webcam !== null`); the defaults are captured/applied only for the webcam-bearing case.

### Behavior

- **Auto-remember:** whenever the user changes one of the remembered fields in the editor, the new value is written to the `editor_defaults` blob. This is debounced and runs alongside the existing project autosave (`EditorView.tsx:845`) — a lightweight `setEditorDefaults` of just the changed subset.
- **Applied only to brand-new projects:** when the editor opens a recording whose `project_json` is empty/absent, the initial project is `defaultProject()` overlaid with the loaded `editor_defaults`. Because the current `defaultProject()` is synchronous and also used as a parse fallback, the overlay happens at editor-open time (after an async `getEditorDefaults()`), **not** inside `defaultProject()` itself.
- **Never reaches back:** a recording that already has a saved `project_json` keeps its own settings verbatim. Auto-remember only seeds *new* projects; it never overwrites prior per-recording edits.

### Edge cases

- Missing / malformed `editor_defaults` → treated as empty; new projects fall back to the hardcoded `defaultProject()` look. Tolerant parsing, same spirit as `parseProject`.
- A remembered value out of current bounds (e.g. a later build tightens a slider range) → clamped by the existing per-field clamps when applied.
- Opening a recording with no webcam does not clear or alter the remembered camera size/position.

## Piece 2 — Zoom controls

Current state: Auto/Custom/Off mode select and per-block delete exist (`EditorView.tsx:3105`), but delete only works in Custom mode. `ZoomMode = "auto"|"custom"|"off"`; `ZoomSettings = { mode, blocks|null }`. Auto blocks are generated on the fly by `resolveZoomBlocks` (autoZoom.ts:319) with stable ids.

### Additions

1. **Top-level On/Off toggle** at the top of the Zoom inspector section. On = `auto`, Off = `off`. Default On (matches current `defaultProject`), and remembered globally per Piece 1. The existing Auto/Custom/Off selector remains available beneath it for power users (Custom = manual block authoring, unchanged).

2. **Delete a single auto-zoom → suppress just that one.**
   - Model: add `suppressed: number[]` to `ZoomSettings` (default `[]` / absent). Each entry is a block's **rounded start-time in ms** — robust to minor re-generation differences, unlike generated ids.
   - Resolver: `resolveZoomBlocks` drops any auto-generated block whose rounded start matches a `suppressed` entry (within a small tolerance). The remaining blocks stay fully automatic.
   - UI: a delete "×" appears on **auto**-zoom chips in the timeline zoom lane (today only Custom chips have it). Clicking it appends the block's start to `suppressed`.
   - Suppression is per-recording (stored in that recording's project), not global.

3. **"Remove all zooms" button** in the Zoom section: sets this recording's `zoom.mode = "off"` and clears `suppressed` (and any custom `blocks`) — a clean no-zoom slate for this recording. (Because Off is remembered globally, note in the UI copy that this affects this recording; the global default only changes if the user leaves it off — acceptable and matches "auto-remember last used".)

### Non-goals

- No change to zoom generation heuristics (`generateAutoZoom`).
- No change to the eased zoom rendering (`zoomStateAt` in compositor.ts).
- Custom-mode add/resize/move stays exactly as-is.

## Piece 3 — Audio cleanup in export ("both")

Add denoise beside the existing normalize toggle; both run in the single MP4 audio chokepoint.

### Model & UI

- `AudioSettings` gains `denoise: boolean` (default `false`), next to `normalizeLoudness`. Parsed tolerantly by `parseAudio`.
- Editor Audio section (`EditorView.tsx:3473`) gets a **"Reduce background noise (denoise)"** checkbox beside the existing "Normalize loudness" checkbox, with a matching `setDenoise` updater.
- Both audio toggles stay **per-recording**; not added to the global `editor_defaults` (user did not request remembering audio). Defaults remain off, matching today.

### Export path

- `finalizeRenderedRecording` (api.ts) passes an `x-denoise` header (mirroring `x-normalize-loudness`).
- `finalize_rendered_recording` (commands.rs:4743): after trim + retime and **before** normalize, if `x-denoise` is set, run the existing denoise core (`src-tauri/src/denoise/mod.rs`) on the voice WAV.
- **Order:** denoise → normalize → mux. Denoise cleans noise first, normalize then evens loudness of the cleaned signal.
- **Best-effort, per project error-handling rules:** on denoise failure, log with `error!`/`warn!` (`target: "export"` or similar) and continue muxing the un-denoised audio; surface a short friendly message in the UI, full detail in the log. Same contract the existing normalize step already uses.
- GIF export: no audio, unchanged.

## Testing

- **editorProject.ts:** unit tests for parsing/serialization round-trips of the new fields — `zoom.suppressed`, `audio.denoise` — and tolerant fallback on malformed input. Test the `defaultProject() + editorDefaults` overlay logic (new projects seeded, existing projects untouched).
- **autoZoom.ts:** unit test that `resolveZoomBlocks` drops suppressed blocks by rounded start (with tolerance) and leaves the rest, and that an empty/absent `suppressed` is a no-op.
- **settings.rs:** Rust unit test for `EditorDefaults` get/set round-trip through the store, including the empty/malformed → default path.
- **Manual / integration:** open a fresh recording → change camera size, cursor size, aspect, background, zoom off → close → open a *second* never-edited recording and confirm it inherits them; confirm an already-edited recording is unchanged. Delete one auto-zoom and confirm the others still fire. Export MP4 with denoise+normalize and confirm audio is cleaned and level; confirm a denoise failure still produces a valid export (log shows the fallback).

## Files touched (anticipated)

- `src/lib/editorProject.ts` — `ZoomSettings.suppressed`, `AudioSettings.denoise`, parsers/clamps, editor-defaults overlay helper.
- `src/lib/autoZoom.ts` — suppression in `resolveZoomBlocks`.
- `src/views/sections/EditorView.tsx` — zoom On/Off toggle, auto-chip delete, "Remove all zooms", denoise checkbox, auto-remember writes, seed-from-defaults on open.
- `src/lib/api.ts` — `getEditorDefaults`/`setEditorDefaults`, `x-denoise` header on `finalizeRenderedRecording`.
- `src-tauri/src/settings.rs` — `EditorDefaults` struct + getter/setter.
- `src-tauri/src/lib.rs` — register new commands.
- `src-tauri/src/commands.rs` — `get_editor_defaults`/`set_editor_defaults`; denoise step in `finalize_rendered_recording`.

## Out of scope

- Remembering audio toggles globally.
- Changing zoom generation heuristics or zoom rendering.
- Legacy quick-export path (`export_recording`) — unchanged.
- Any new compositor visual layer.
