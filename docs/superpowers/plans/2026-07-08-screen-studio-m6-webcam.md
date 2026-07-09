# Screen Studio Parity — M6: Webcam Layouts, Auto-Shrink on Zoom, Camera Scenes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The webcam bubble automatically shrinks while a zoom block is active; a **Camera scenes** timeline lane lets the user mark time ranges where the webcam goes full-frame (screen hidden) — the Screen Studio "cut to camera" move; and a mirror toggle flips the webcam horizontally (matching how people see themselves in the self-view).

**Architecture:** All three are pure render-layer features over the existing webcam track (captured in M2; `webcam_path` + `webcam_offset_ms`, webcamTime = mainTime + offset). Scenes are project state (`webcam.scenes`, source-time non-overlapping ranges) edited on a timeline lane that reuses M3's zoom-lane drag/resize/place machinery — extracted into generic range helpers so zoom and scenes share one core instead of duplicating it. Auto-shrink derives the bubble scale from the frame's already-eased `zoomStateAt` scale, so it follows zoom ramps with zero new easing code. One shared lookup/sizing path for preview and export, as always.

**Tech Stack:** unchanged. Suites baseline: cargo **517**, bun **326**, build clean.

## Global Constraints

- All M2–M4 conventions hold: SOURCE-time for every effect lookup; only emitted timestamps re-anchor/retime; ONE shared resolver/helper per effect for preview/export parity; CLAUDE.md logging/friendly-error discipline.
- **No DB migration** (scenes live in `project_json`). If one becomes necessary, verify the MIGRATIONS tail first (26 was free at plan time; collisions have happened twice).
- New fields default OFF/neutral: pre-M6 projects render byte-identically (autoShrink false, mirror false, scenes []).
- **Zoom-helper extraction must not change zoom behavior:** existing zoom editing tests keep passing unchanged; the zoom helpers' public APIs stay identical.
- Never break M2–M4 behavior (trim/cursor/webcam bubble/aspect/zoom/keystroke/speed/captions/loudness/blur); pinned tests keep passing.
- Sidecar changes NOT expected. Branch: `feat/screen-studio-m6-webcam`.

## Data contracts

**WebcamSettings additions** (tolerant parse: missing → defaults):

```ts
webcam: {
  show; shape; corner; sizeFrac;          // existing, unchanged
  autoShrink: boolean;                     // default false
  mirror: boolean;                         // default false
  scenes: Array<{ id: string; startMs: number; endMs: number }>; // default []
};
```

- `clampWebcamScenes(scenes, durationMs)` — sort by startMs, clamp to [0,duration], drop invalid (endMs<=startMs)/overlapping (keep earlier), mirror the caption/speed clamp idiom. Scene min length `SCENE_MIN_LENGTH_MS = 500`.
- **Generic range helpers** extracted from the zoom block editors (editorProject.ts:714-831): `nextRangeId(ranges, prefix)`, `moveRange`, `resizeRange`, `placeRange` operating on `{ id; startMs; endMs }` with min-length + stop-at-neighbor semantics identical to today's zoom behavior. Zoom helpers become thin wrappers preserving their exact signatures and semantics (cx/cy/scale/mode fields pass through untouched); scene editing uses the same core with `SCENE_MIN_LENGTH_MS` and prefix `"s"`. Existing zoom tests unchanged and green prove the extraction.

**Auto-shrink (pure):** `webcamShrinkFactor(zoomScale) -> number` — `1 − 0.45 · clamp01((zoomScale − 1)/(2 − 1))`: no zoom → 1, at ≥2× zoom → 0.55. Because `zoomScaleAt` is already eased over ramps, the factor animates for free. Applied as a multiplier on `sizeFrac` inside the webcam sizing (`webcamRect` gains an optional `scaleFactor = 1` last param; margin unchanged). Active only when `webcam.autoShrink`.

**Camera scenes (pure):** `webcamSceneAt(tMs, scenes) -> { id } | null` — binary search, source-time, half-open `[startMs, endMs)` (mirror `captionAt`). During an active scene, `drawCompositeV2`:
- draws the webcam frame cover-cropped into the full CONTENT rect (appearance corner radius applied; background/padding as usual);
- hides the screen frame, the cursor overlay, the keystroke badge, and ignores zoom (zoom is a screen-space concept);
- still draws captions (they're speech, not screen);
- if the webcam frame is unavailable at that instant (null lookup), falls back to the normal screen layout for that frame (never a black frame).
Scenes are independent of the bubble: a scene renders even when `webcam.show` is false. Export must therefore open the webcam source when `show || scenes.length > 0` (today's gate is `show` only, renderPipeline.ts:564). Motion blur during a scene is skipped (zoom is ignored, so the sub-samples would be identical draws) — collapse to a single draw.

**Mirror (pure draw):** when `webcam.mirror`, flip the webcam horizontally (negative-x scale inside the existing clip) in BOTH the bubble and scene layouts, preview and export.

---

### Task 1: Model fields + generic range-helper extraction (Sonnet — TDD, behavior-pinning)

**Files:** `src/lib/editorProject.ts` + `tests/editorProject.test.ts`.

The WebcamSettings additions, `clampWebcamScenes`, and the generic range-helper extraction per the contracts. TDD. The binding requirement: zoom editing behavior is UNCHANGED — existing zoom helper tests must pass without modification; add scene-helper tests covering the same edge cases the zoom tests cover (clamp at edges, min length, stop-at-neighbor, place-past-overlap, deterministic ids from empty and non-empty). Pre-M6 project JSON fixture pins the new defaults.

### Task 2: Render — auto-shrink, camera scenes, mirror (Opus — compositor + both consumers)

**Files:** `src/lib/render/compositor.ts` (+tests: `webcamShrinkFactor` endpoints/midpoint/clamp; `webcamSceneAt` boundary semantics; scene-layout content-rect math if expressible purely), `src/lib/render/renderPipeline.ts` (webcam-source gate `show || scenes.length>0`; scene-aware composite; blur collapse during scenes), `src/views/sections/EditorView.tsx` (preview consumption only — the lane UI is Task 3; preview must render shrink/scene/mirror identically to export via the shared fns).

Contracts above. Named risks to verify in-code: the webcam bubble currently ignores zoom entirely (compositor.ts:612-626 canvas-anchored) — shrink must scale the rect around its corner anchor (bubble stays pinned to its corner, not its center); scene fallback when `frameAt` returns null; `wantWebcam` gate change doesn't regress bubble-off exports.

### Task 3: Webcam lane UI + toggles (Sonnet — mirrors the zoom lane)

**Files:** `src/views/sections/EditorView.tsx`.

Timeline gains a **Camera lane** (gated on `webcamAvailable`): scene chips draggable/resizable copying the zoom lane's pointer machinery (same `timelineRef`/`msFromClientX`; chips render via the same x-mapping); "Add camera scene" at playhead (default 3 s) via `placeRange`; click chip → inspector row (delete; shows range). Webcam section gains "Auto-shrink on zoom" and "Mirror" toggles. All writes through the debounced setProject applying `clampWebcamScenes`. Reuse the M3 lesson: overlap = stop-at-neighbor, never drop.

### Task 4: E2E + manual QA (Sonnet)

Suites (517+/326+), build, skip-TCC install (Screen Recording re-grant reminder), boot + log check, `.superpowers/sdd/m6-manual-qa.md`: record with camera ON (verifies the camera-TCC fix prompt if still ungranted); bubble shrinks during a zoom block (eased, corner-pinned); add a camera scene → preview cuts to full-frame camera (captions still visible, cursor/badge/zoom absent), export matches; mirror flips both bubble and scene; scene with bubble hidden still renders; pre-M6 recordings/projects unchanged; combined trim+speed+zoom+scene+captions export coherent.

## Self-review notes

- The range-helper extraction is the one place this milestone touches M3 code — the "existing zoom tests pass unchanged" pin is the guardrail, and the reviewer should treat any zoom-test edit as a red flag.
- Scene-vs-zoom interaction is defined by fiat (scene wins; zoom ignored during scenes) — simpler than composing them, and matches Screen Studio's behavior.
- Auto-shrink reuses the eased zoom scale rather than introducing a second easing timeline — one source of animation truth.
- The webcam-source gate change (`show || scenes.length>0`) is the likeliest regression point for existing exports; Task 2's reviewer should trace the bubble-off + no-scenes path end-to-end.
