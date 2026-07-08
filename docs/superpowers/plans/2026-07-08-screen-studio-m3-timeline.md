# Screen Studio Parity — M3: Timeline Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the zoom system visible and editable (zoom blocks on the timeline, live zoom in the preview, manual blocks, per-block tweaks), add per-segment speed (e.g. 2× a boring stretch) applied to video AND audio at export, and render a keystroke overlay (⌘-combos) from the captured key events.

**Architecture:** Zoom becomes project state: generated once from events, materialized into `project_json` on first edit (mode auto/custom/off). The editor preview gains the same `zoomStateAt`/`drawCompositeV2` pathway the export uses (one compositor, zero drift). Speed = non-overlapping source-time ranges; preview via `video.playbackRate`, export via frame re-timing (TS) + piecewise WAV resampling (Rust, pure, TDD). Keystroke overlay = pure keycode→symbol mapping + a badge layer in the compositor, modifier-combos only by default (never render raw typing — privacy).

**Tech Stack:** unchanged. Suites baseline: cargo **478**, bun **119**, build clean.

## Global Constraints

- All M2/M2.1 conventions hold: SOURCE-time for every effect lookup; only emitted timestamps re-anchor; CLAUDE.md logging/friendly-error discipline; sidecar binary committed with Swift changes (none expected this milestone).
- Next free DB migration number is **24** (verify against MIGRATIONS tail first — collisions have happened).
- Never break the trim/cursor/webcam/aspect behavior shipped in M2/M2.1; the pinned tests must keep passing.
- Privacy: keystroke overlay renders ONLY modifier combos (⌘/⌃/⌥ + key) unless the user opts into "all keys"; never render plain typed characters by default.
- Branch: `feat/screen-studio-m3-timeline`.

## Data contracts

**EditorProject v1 additions** (tolerant parse: missing → defaults, unknown mode → "auto"):

```ts
zoom: {
  mode: "auto" | "custom" | "off";   // default "auto"
  blocks: ZoomBlock[] | null;         // null while mode==="auto"; materialized on first edit
};
speed: Array<{ startMs: number; endMs: number; rate: number }>; // default []; source-time; non-overlapping; rate ∈ [0.5, 4], step 0.25
keystrokes: { enabled: boolean; allKeys: boolean };             // default { enabled: false, allKeys: false }
```

`ZoomBlock` gains `mode: "auto" | "manual"` as already typed in autoZoom.ts (extend the union if needed) and an `id: string` (stable key for UI editing; generate `z1, z2…` at materialization).

**Migration 24:** `ALTER TABLE recordings ADD COLUMN n_events INTEGER; ALTER TABLE recordings ADD COLUMN n_clicks INTEGER;` — populated at stop from StoppedInfo (already parsed since M1 final fixes); used by the editor to gate zoom/keystroke sections without reading the events file.

**Speed math (pure, both sides):** for ranges R over source time, define `outT(srcT) = Σ over elapsed source time of dt/rate(t)`. TS: `buildSpeedMap(ranges, durationMs)` → `{ srcToOut(srcMs): number; outDurationMs: number }` with tests (identity when no ranges; 2× halves a range's contribution; boundaries exact). Rust: `retime_wav_samples(wav_in, wav_out, ranges)` — piecewise linear-interpolation resample per range (2× consumes 2 input samples per output sample), pure, TDD (identity; 2× halves sample count of that span; boundary continuity; overlapping/invalid ranges rejected).

**Keycode map:** `src/lib/keycodes.ts` — macOS virtual keycode → display glyph (US layout; cover letters, digits, F-keys, arrows ←↑↓→, space ␣, return ⏎, esc ⎋, tab ⇥, delete ⌫; mods cmd→⌘ shift→⇧ alt→⌥ ctrl→⌃ fn). Pure + tests. Unknown keycode → null (badge skipped).

---

### Task 1: Migration 24 + zoom/speed/keystrokes project model (Sonnet-scale plumbing)

**Files:** `src-tauri/src/db/schema.rs` (migration 24 + version tests 23→24), `src-tauri/src/db/recordings.rs` (RecordingRow + insert/select/mapper — 26 columns now, count indices; round-trip tests), `src-tauri/src/commands.rs` (`stop_screen_recording_inner` populates from `info.n_events`/`info.n_clicks`), `src/lib/api.ts` (row type), `src/lib/editorProject.ts` + `tests/editorProject.test.ts` (TDD: the three new fields per the contract, tolerant parse, defaults; `clampSpeedRanges(ranges, durationMs)` — sort, clamp to [0,duration], drop invalid/overlapping (keep earlier), rate clamp [0.5,4]).

### Task 2: Zoom in the editor preview + zoom project state (Opus)

**Files:** `src/views/sections/EditorView.tsx`, `src/lib/autoZoom.ts` (ZoomBlock id/mode extension + `materializeBlocks(header, events, durationMs)` helper), `src/lib/render/renderPipeline.ts` (consume project.zoom instead of always generating; mode off → no zoom; custom → project blocks; auto → generate as today), `tests/` for the pure parts.

Preview: the rAF draw currently passes identity zoom — compute effective blocks once (memoized on project.zoom + events) and pass `zoomStateAt(currentTimeMs, blocks)` so the preview zooms exactly like the export. Effective-blocks resolution lives in ONE exported function used by both preview and export (`resolveZoomBlocks(project, header, events, durationMs)`). While here: fix the stale "Render (beta)" doc comment at the top of renderPipeline.ts (M2-carried).

### Task 3: Zoom timeline lane + block editing (Opus)

**Files:** `src/views/sections/EditorView.tsx` (+ small components if the file is getting unwieldy — flag it), `src/lib/editorProject.ts` helpers + tests.

Timeline area becomes lanes under the preview: existing trim lane + new **Zoom lane**: effective blocks rendered as draggable/resizable chips (reuse the trim-handle drag patterns incl. the crossover-swap lesson); click a block → inspector row (zoom level 1.5–3, delete, auto/manual badge); "Add zoom" button creates a manual block at the playhead (default 2s/2×) — center picked by clicking the preview canvas while the block is selected (map click → content-rect → normalized capture coords via the inverse of the compositor mapping — reuse/extract the existing forward math, don't duplicate); first edit materializes (mode→custom); zoom section header gets mode select (Auto / Custom / Off) with "Reset to auto" affordance. Timeline lane also gains click-to-seek on the track body (M2-carried backlog). Gate the whole zoom lane on `n_clicks > 0 || mode==="custom"` (use the new columns).

### Task 4: Keystroke overlay (Sonnet)

**Files:** `src/lib/keycodes.ts` + `tests/keycodes.test.ts` (TDD), `src/lib/render/compositor.ts` (+tests for the pure grouping: `keystrokeBadgeAt(tMs, keyEvents, {allKeys})` → `{ label: string } | null` — combos grouped within 800ms display window, latest wins; modifier-only filter unless allKeys; label like "⌘⇧S"), badge drawn bottom-center of the content rect (pill, matches ripple color const — extract the shared const while here, M2-carried), `src/views/sections/EditorView.tsx` (Keystrokes toggle + "show all keys" sub-toggle, gated on events), `src/lib/render/renderPipeline.ts` (same badge at export, source-time).

### Task 5: Speed segments (Opus — riskiest; video+audio retiming)

**Files:** `src/lib/editorProject.ts` (buildSpeedMap + tests per contract), `src/views/sections/EditorView.tsx` (Speed lane: ranges as chips, add-at-playhead (default 5s @2×), drag edges, rate stepper per chip; preview playbackRate switches at boundaries in the rAF loop — and webcam preview element must follow the same rate), `src/lib/render/renderPipeline.ts` (frame re-timing: emitted timestamp = srcToOut(srcT) − srcToOut(trimStart); drop frames when effective output interval < 1/30s so CFR holds; zoom/cursor/webcam lookups STAY source-time), `src-tauri/src/screenrec/mod.rs` + `commands.rs` (`retime_wav_samples` per contract, applied after trim in `finalize_rendered_recording`; ranges passed as a JSON header `x-speed-ranges` — parse defensively, malformed → no retiming, log warn), tests both sides.

Audio caveat (decided): naive per-range resample pitch-shifts sped audio (chipmunk at 2×). Acceptable v1 — document in code + report; time-stretch is future work.

### Task 6: E2E + manual QA (Sonnet)

Suites (478+ / 119+), build, skip-TCC install, boot + migration 24 live check, updated `m3-manual-qa.md`: zoom lane shows blocks from a clicky recording; drag/resize/add manual block with center-pick; preview zooms live; keystroke badge on ⌘-combos; 2× speed range previews faster and exports retimed with (pitch-shifted) audio; trim+speed+zoom+webcam+16:9 all together exports coherently; pre-M3 recordings unaffected.

## Self-review notes

- One `resolveZoomBlocks` + one `buildSpeedMap` keep preview/export in lockstep — same single-source discipline that worked for `outputLayout`.
- Speed × trim × zoom interaction: all defined in source time; only output timestamps move. Export re-timing must apply trim FIRST (existing [start,end) skip), then srcToOut for emitted stamps — Task 5's reviewer must trace this.
- Privacy default (modifier combos only) is a Global Constraint, not a preference.
- Migration 24 is additive; editor gates read the new columns with NULL-safe fallbacks (pre-M3 rows → sections still gate on events file presence as today).
