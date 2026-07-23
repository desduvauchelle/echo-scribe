// Pure canvas compositor for the WebCodecs render pipeline.
//
// Two responsibilities, both pure (no I/O, no globals beyond the passed-in
// canvas context):
//   1. `zoomStateAt` — given the auto-zoom timeline, return the interpolated
//      pan/zoom state (cx, cy, scale) for a single frame at time `t`.
//   2. `drawComposite` — paint one output frame: background, then the (possibly
//      zoomed) source video frame inset by `padding` with rounded corners.
//
// `zoomStateAt` is unit-tested (tests/compositor.test.ts); `drawComposite` is a
// canvas draw and is exercised live in the render pipeline (Task 7).

import type { ZoomBlock, EventsHeader, RecEvent } from "../autoZoom";
// `AspectPreset`/`CaptionSegment` are owned by editorProject.ts (part of the
// persisted project schema); type-only import keeps zero runtime coupling.
import type { AspectPreset, CaptionSegment, Mask, WebcamScene } from "../editorProject";
import { keyLabel, modsLabel } from "../keycodes";

export type Appearance = {
  padding: number; // px in OUTPUT space (uniform inset around the video)
  cornerRadius: number; // px, applied to the video frame's corners
  aspect: AspectPreset; // output canvas aspect; "auto" = frame + padding
  background:
    | { type: "solid"; color: string }
    | { type: "gradient"; from: string; to: string }
    | { type: "image"; path: string };
};

/** Cap on the output canvas' long edge (px). Mirrors renderPipeline's encoder
 *  guard; a 5K capture would otherwise blow up encode time/memory. */
const MAX_LONG_EDGE = 3840;

/** The resolved output geometry for one recording: the encoder canvas size plus
 *  the rectangle inside it where the (padded) source frame is drawn. All
 *  overlay/zoom/cursor math positions relative to the CONTENT rect; `webcamRect`
 *  is the one exception (canvas-anchored — see its doc). */
export type OutputLayout = {
  outW: number;
  outH: number;
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
};

/** Round `n` down to the nearest even integer (encoders require even dims). */
function even(n: number): number {
  const r = Math.round(n);
  return r - (r % 2);
}

/** Target width/height ratio for a fixed aspect preset (w / h). */
function aspectRatio(aspect: Exclude<AspectPreset, "auto">): number {
  switch (aspect) {
    case "16:9":
      return 16 / 9;
    case "9:16":
      return 9 / 16;
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
  }
}

/**
 * Resolve the output canvas size and the content rect (where the padded frame
 * is drawn) for a given source frame, padding, and aspect preset. Pure.
 *
 * Semantics:
 *   - The **content box** is the frame plus `padding` on every side:
 *     `(frameW + 2p) × (frameH + 2p)`. The frame itself sits inside it inset by
 *     `p` — so the returned `contentX/contentY` fold in both the box's position
 *     and that padding inset.
 *   - `"auto"`: the canvas IS the content box (legacy behavior). Content rect =
 *     `(p, p, outW - 2p, outH - 2p)` — byte-for-byte the old
 *     `drawFrameLayer` inset, so `auto` composites are pixel-identical to the
 *     pre-aspect pipeline.
 *   - Fixed aspect: the canvas is the **smallest rect of the target aspect that
 *     contains the content box**; the box is centered inside it. Whichever axis
 *     has slack gets the letterbox band (a 16:9 canvas around a tallish window
 *     ⇒ extra left/right; around a wide-short window ⇒ extra top/bottom). The
 *     frame stays inset by `p` within the (centered) box.
 *
 * Long-edge cap: if the canvas' long edge exceeds `MAX_LONG_EDGE`, the ENTIRE
 * layout — canvas, content box, centering bands, AND padding — is scaled by
 * `k = MAX_LONG_EDGE / longEdge`. So the returned `contentW/contentH` shrink by
 * `k` and the padding gaps shrink to `padding*k` (documented decision: padding
 * scales with the cap, it is not held nominal). The composition is visually
 * identical, just at a smaller pixel resolution.
 *
 * `outW/outH` are rounded down to even integers (encoder requirement).
 */
export function outputLayout(
  frameW: number,
  frameH: number,
  padding: number,
  aspect: AspectPreset,
): OutputLayout {
  const p = Math.max(0, padding);
  const boxW = frameW + 2 * p; // content-box (frame + padding) dimensions
  const boxH = frameH + 2 * p;

  // Unrounded canvas size + the content box's top-left within it.
  let canvasW: number;
  let canvasH: number;
  let boxX: number;
  let boxY: number;

  if (aspect === "auto") {
    canvasW = boxW;
    canvasH = boxH;
    boxX = 0;
    boxY = 0;
  } else {
    const target = aspectRatio(aspect); // w / h
    const boxAspect = boxH > 0 ? boxW / boxH : target;
    if (boxAspect > target) {
      // Box is wider than the target → width drives; grow height to match.
      canvasW = boxW;
      canvasH = boxW / target;
    } else {
      // Box is taller (or equal) → height drives; grow width to match.
      canvasH = boxH;
      canvasW = boxH * target;
    }
    boxX = (canvasW - boxW) / 2;
    boxY = (canvasH - boxH) / 2;
  }

  // Content rect (the frame) = box position + the padding inset.
  let contentX = boxX + p;
  let contentY = boxY + p;
  let contentW = frameW;
  let contentH = frameH;

  // Long-edge cap: scale the whole layout down uniformly so the composition is
  // preserved (padding included) at a capped resolution.
  const longEdge = Math.max(canvasW, canvasH);
  const capped = longEdge > MAX_LONG_EDGE;
  if (capped) {
    const k = MAX_LONG_EDGE / longEdge;
    canvasW *= k;
    canvasH *= k;
    contentX *= k;
    contentY *= k;
    contentW *= k;
    contentH *= k;
  }

  const outW = even(canvasW);
  const outH = even(canvasH);

  // "auto" must be byte-for-byte the legacy pipeline: the old `drawFrameLayer`
  // computed the content rect as `(pad, pad, outW - 2*pad, outH - 2*pad)` using
  // the NOMINAL padding against the even-rounded canvas — even under the cap
  // (legacy scaled outW/outH by k but left padding nominal). Reproduce exactly,
  // so no existing auto-mode composite changes by a single pixel.
  if (aspect === "auto") {
    return {
      outW,
      outH,
      contentX: p,
      contentY: p,
      contentW: outW - 2 * p,
      contentH: outH - 2 * p,
    };
  }

  return { outW, outH, contentX, contentY, contentW, contentH };
}

// ---- Overlay contracts (cursor + webcam) --------------------------------
// Tasks 6/8 populate these; Task 3 accepts them but only draws a layer when it
// is non-null, so a recording with no events / no webcam renders identically to
// the plain `drawComposite` output.

export type CursorSample = { t: number; x: number; y: number }; // capture-space points

export type OverlayState = {
  /** Normalized 0..1 capture-space cursor position; `clickAge` = ms since the
   *  last mouse-down (null if none recent); `alpha` = draw opacity 0..1 (1 =
   *  fully opaque, the default; < 1 only when `hideIdle` is fading the cursor
   *  out before an idle gap — the compositor multiplies it into the glyph +
   *  ripple opacity). null = no cursor to draw. */
  cursor: { x: number; y: number; clickAge: number | null; alpha: number } | null;
  /** A webcam frame to composite as a corner PiP. null = no webcam (bubble off,
   *  or no co-occurring webcam frame). Ignored while `scene` is active (a scene
   *  replaces the whole layout — the bubble is not also drawn). */
  webcam: {
    frame: CanvasImageSource;
    shape: "circle" | "rounded";
    corner: string;
    sizeFrac: number;
    /** Auto-shrink multiplier on the bubble size (`webcamShrinkFactor` of the
     *  frame's primary zoom scale) — 1 when `autoShrink` is off, so the rect is
     *  byte-identical to pre-M6. Applied inside `webcamRect`, corner-anchored. */
    scaleFactor: number;
    /** Flip the bubble horizontally (mirror) inside its clip. false pre-M6. */
    mirror: boolean;
  } | null;
  /** A "cut to camera" scene active this frame (M6): the webcam frame is drawn
   *  cover-cropped into the FULL content rect instead of the screen frame, and
   *  the screen frame / cursor / keystroke badge / zoom are all suppressed
   *  (captions still draw). null = not in a scene (normal layout). The CALLER
   *  sets this non-null ONLY when a scene covers this SOURCE time AND a webcam
   *  frame is available — so a null-frame instant falls back to the normal
   *  screen layout automatically (never a black frame). */
  scene: {
    frame: CanvasImageSource;
    /** Flip horizontally (mirror) inside the scene clip. Mirrors the bubble. */
    mirror: boolean;
  } | null;
  /** The keystroke badge to draw this frame (label text + fade alpha), or
   *  null when no qualifying key event is in the display window. Callers
   *  derive `alpha` from the event's age via `keystrokeBadgeAlpha` (kept out
   *  of the pure `keystrokeBadgeAt` grouping function so that stays a clean
   *  label lookup independent of the fade curve). */
  keystroke: { label: string; alpha: number } | null;
  /** The caption text to draw this frame (from `captionAt`), or null when no
   *  segment covers the current SOURCE time / captions are disabled. When
   *  non-null, the keystroke badge (if also drawn) shifts up by one strip
   *  height so the two never collide — see `keystrokeBottomMargin`. */
  caption: string | null;
  /** The masks active this frame (from `masksAt`), in normalized CAPTURE coords
   *  — drawn INSIDE the frame layer's transformed space (after the frame, before
   *  the cursor) so they track content under zoom. May contain multiple
   *  simultaneously-active masks (overlaps are legal). Empty `[]` draws nothing
   *  (pre-M5 projects render byte-identically). Suppressed entirely during a
   *  camera scene (the screen is hidden — handled by the scene early-return). */
  masks: Mask[];
};

export type WebcamCorner = "br" | "bl" | "tr" | "tl";

// ---- Cursor state lookup -------------------------------------------------

/** Longest gap (ms) either side of `tMs` we'll still draw a cursor for. Beyond
 *  this the sampling is too sparse to trust, so the cursor is hidden (null)
 *  rather than snapped to a stale position. */
const CURSOR_MAX_GAP_MS = 2000;

/** Ripple window (ms): a mouse-down produces a fading ring for this long. A
 *  down older than this yields `clickAge = null` (no ripple). Kept in sync with
 *  the compositor's `CLICK_RIPPLE_MS`. */
const CURSOR_CLICK_WINDOW_MS = 400;

/** Hide-when-idle fade window (ms): with `hideIdle`, the cursor's alpha ramps
 *  1→0 over the last this-many ms before it would vanish at an idle gap edge
 *  (`CURSOR_MAX_GAP_MS`), rather than popping out abruptly. */
const CURSOR_IDLE_FADE_MS = 500;

/**
 * Interpolated cursor state at time `tMs`, in normalized 0..1 capture-space
 * coords (mapped through `header.capture.rect` = `[x, y, w, h]` in the same
 * point/global-top-left space the recorded event x/y live in).
 *
 * Position: binary-search the sorted `moves` for the samples bracketing `tMs`
 * and linearly interpolate between them. Before the first / after the last
 * sample, hold the nearest sample — but only if it's within `CURSOR_MAX_GAP_MS`;
 * beyond that (or if the two bracketing samples are themselves more than
 * `CURSOR_MAX_GAP_MS` apart) return null, so a stretch with no cursor data
 * hides the synthetic cursor instead of freezing it at a stale point.
 *
 * `clickAge`: `tMs` minus the timestamp of the most recent `down` at or before
 * `tMs`; null when there is no such down, or it's more than
 * `CURSOR_CLICK_WINDOW_MS` old (ripple has faded), or the age is negative
 * (down is in the future — shouldn't happen given the ≤ tMs filter, but clamped
 * defensively).
 *
 * `alpha` (draw opacity, 0..1): always 1 unless `opts.hideIdle` is set. With
 * `hideIdle`, while the cursor is being HELD on a lone sample across a coming
 * idle gap, its alpha ramps 1→0 over the last `CURSOR_IDLE_FADE_MS` before it
 * would vanish (at `CURSOR_MAX_GAP_MS` from that sample) — so it fades out
 * instead of popping. During real motion (interpolating between two close
 * samples) there is no idle gap ahead, so alpha stays 1. Default off ⇒ alpha is
 * always 1 (pre-M4 projects render identically).
 *
 * Pure; `moves` and `downs` are assumed sorted ascending by `t` (they are as
 * written by the sidecar and split by the caller).
 */
export function cursorStateAt(
  tMs: number,
  moves: CursorSample[],
  downs: CursorSample[],
  header: EventsHeader,
  opts?: { hideIdle?: boolean },
): OverlayState["cursor"] {
  if (moves.length === 0) return null;

  const hideIdle = opts?.hideIdle === true;
  const [rx, ry, rw, rh] = header.capture.rect;
  const norm = (m: CursorSample): { x: number; y: number } => ({
    x: rw > 0 ? (m.x - rx) / rw : 0,
    y: rh > 0 ? (m.y - ry) / rh : 0,
  });

  /** Idle-fade opacity while HELD `distToVanishMs` before the vanish edge:
   *  1 outside the fade window, ramping linearly to 0 as it closes on 0. */
  const heldAlpha = (distToVanishMs: number): number => {
    if (!hideIdle) return 1;
    if (distToVanishMs >= CURSOR_IDLE_FADE_MS) return 1;
    if (distToVanishMs <= 0) return 0;
    return distToVanishMs / CURSOR_IDLE_FADE_MS;
  };

  const clickAge = clickAgeAt(tMs, downs);

  // Binary search: largest index `lo` with moves[lo].t <= tMs.
  let lo = -1;
  {
    let a = 0;
    let b = moves.length - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      if (moves[mid].t <= tMs) {
        lo = mid;
        a = mid + 1;
      } else {
        b = mid - 1;
      }
    }
  }

  // Before the first sample: hold the first if within the gap. Fading in as we
  // approach the first sample would be surprising (the cursor is arriving, not
  // idling out), so this hold stays full-alpha — the idle fade is a trailing
  // effect (see the after-last branch).
  if (lo < 0) {
    const first = moves[0];
    if (first.t - tMs > CURSOR_MAX_GAP_MS) return null;
    const p = norm(first);
    return { x: p.x, y: p.y, clickAge, alpha: 1 };
  }

  const left = moves[lo];

  // Exact hit on a sample is always real recorded data — return it directly,
  // regardless of how far the neighbors are (the gap check only governs
  // *interpolation* between two samples, below). When holding it across a
  // coming idle gap (no next sample within CURSOR_MAX_GAP_MS), fade toward the
  // vanish edge so hideIdle dissolves rather than pops.
  if (left.t === tMs) {
    const p = norm(left);
    const next = moves[lo + 1];
    const idleAhead = next === undefined || next.t - tMs > CURSOR_MAX_GAP_MS;
    const alpha = idleAhead ? heldAlpha(CURSOR_MAX_GAP_MS) : 1;
    return { x: p.x, y: p.y, clickAge, alpha };
  }

  // After the last sample: hold it if within the gap, fading out over the last
  // CURSOR_IDLE_FADE_MS before the vanish edge (tMs - left.t == CURSOR_MAX_GAP_MS).
  if (lo === moves.length - 1) {
    if (tMs - left.t > CURSOR_MAX_GAP_MS) return null;
    const p = norm(left);
    const distToVanish = CURSOR_MAX_GAP_MS - (tMs - left.t);
    return { x: p.x, y: p.y, clickAge, alpha: heldAlpha(distToVanish) };
  }

  // Interpolate between `left` (t < tMs) and `right` (t > tMs). If the two
  // bracketing samples straddle a gap wider than CURSOR_MAX_GAP_MS, the data is
  // too sparse to trust across it — hide the cursor.
  const right = moves[lo + 1];
  if (right.t - left.t > CURSOR_MAX_GAP_MS) return null;

  const span = right.t - left.t;
  const f = span > 0 ? (tMs - left.t) / span : 0;
  const pl = norm(left);
  const pr = norm(right);
  // Real motion between two close samples: no idle gap ahead, full alpha.
  return {
    x: pl.x + (pr.x - pl.x) * f,
    y: pl.y + (pr.y - pl.y) * f,
    clickAge,
    alpha: 1,
  };
}

/** Age (ms) of the most recent down at or before `tMs`, or null when there is
 *  none, it's older than the ripple window, or the age is negative. `downs`
 *  is assumed sorted ascending by `t`. */
function clickAgeAt(tMs: number, downs: CursorSample[]): number | null {
  // Binary search for the largest index with downs[i].t <= tMs.
  let idx = -1;
  let a = 0;
  let b = downs.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (downs[mid].t <= tMs) {
      idx = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  if (idx < 0) return null;
  const age = tMs - downs[idx].t;
  if (age < 0 || age > CURSOR_CLICK_WINDOW_MS) return null;
  return age;
}

// ---- Cursor path smoothing -----------------------------------------------

/** Half-width (in samples) of the smoothing window at full strength. The window
 *  spans `2 * SMOOTH_HALF_WINDOW + 1` samples (here 5 → a 11-tap triangular
 *  kernel), a light de-jitter that softens hand-jitter without lagging the
 *  cursor noticeably. Kept small on purpose: cursor moves are sampled densely,
 *  and a wide window would round off intentional fast flicks. */
const SMOOTH_HALF_WINDOW = 5;

/**
 * Smooth a cursor move path to take the hand-jitter off the synthetic cursor,
 * `strength` in [0,1] (0 = off). Pure; precomputed ONCE per events load
 * (memoized like the zoom blocks) and consumed by `cursorStateAt` unchanged —
 * the smoothed samples keep their original timestamps, so this never shifts the
 * source-time track (the binding SOURCE-time invariant).
 *
 * Algorithm — triangular (weighted) moving average, blended by strength:
 *   - For each interior sample `i`, compute a triangular-weighted average of the
 *     x/y of the samples in `[i - w, i + w]` (`w = SMOOTH_HALF_WINDOW`), with
 *     weights falling off linearly from the center. The window is clamped at the
 *     ends so it never reads out of bounds.
 *   - The output point is `lerp(original, average, strength)` — so strength 0 is
 *     a byte-for-byte identity (the pinned test), and higher strength blends
 *     progressively more of the smoothed average in.
 *   - The FIRST and LAST samples are always returned unchanged (endpoints
 *     pinned) so the path starts/ends exactly where it really did.
 *
 * Chosen over centripetal Catmull-Rom / one-euro because a moving average (a)
 * keeps the original timestamps (Catmull-Rom resampling would invent new ones,
 * and one-euro introduces phase lag — both fight the source-time invariant),
 * (b) can never overshoot the local coordinate range (bounded deviation — a
 * spline can ring/overshoot), and (c) pins endpoints trivially. `strength` is
 * clamped to [0,1]; a path of ≤ 2 samples (all endpoints) is returned as-is.
 */
export function smoothCursorPath(moves: CursorSample[], strength: number): CursorSample[] {
  const s = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  const n = moves.length;
  // Nothing to smooth: strength 0 (identity), or a path that is all endpoints.
  if (s <= 0 || n <= 2) return moves.map((m) => ({ ...m }));

  const w = SMOOTH_HALF_WINDOW;
  const out: CursorSample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Pin the endpoints exactly.
    if (i === 0 || i === n - 1) {
      out[i] = { ...moves[i] };
      continue;
    }
    // Triangular-weighted average over the clamped window. Weight for offset k
    // (|k| <= w) is `w + 1 - |k|`, peaking at the center and falling to 1 at the
    // window edge; clamping at the array bounds keeps it in range.
    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const weight = w + 1 - Math.abs(k);
      sumX += moves[j].x * weight;
      sumY += moves[j].y * weight;
      sumW += weight;
    }
    const avgX = sumX / sumW;
    const avgY = sumY / sumW;
    // Blend original → average by strength.
    out[i] = {
      t: moves[i].t,
      x: moves[i].x + (avgX - moves[i].x) * s,
      y: moves[i].y + (avgY - moves[i].y) * s,
    };
  }
  return out;
}

// ---- Keystroke badge lookup ----------------------------------------------

/** How long a qualifying key event's badge stays on screen after its
 *  timestamp (ms). Also the window `keystrokeBadgeAt` searches for
 *  candidates within. */
const KEYSTROKE_DISPLAY_MS = 800;

/** The trailing slice of the display window (ms) over which the badge fades
 *  out (alpha 1 -> 0). Kept as its own const since the fade curve is a
 *  drawing concern, not part of the pure grouping function's contract. */
const KEYSTROKE_FADE_MS = 200;

/**
 * Which keystroke badge (if any) should be shown at source time `tMs`, given
 * the recording's parsed key events. Pure — no drawing, no Date.now().
 *
 * Candidate events are those with `t <= tMs` AND `tMs - t <= 800`
 * (`KEYSTROKE_DISPLAY_MS`) — i.e. still inside the display window. Among
 * candidates, "qualifying" ones are filtered by the PRIVACY RULE:
 *   - default (`allKeys: false`): the event's `mods` must contain at least
 *     one of cmd/ctrl/alt/fn. A shift-only combo (or no mods at all) is
 *     PLAIN TYPING and is excluded — this is the non-negotiable default that
 *     keeps typed text off the recording.
 *   - `allKeys: true`: every candidate event qualifies (the user opted in to
 *     "show all keys").
 * The LATEST qualifying candidate wins (later events in the array are
 * assumed to have `t` >= earlier ones, matching the sidecar's append-only
 * JSONL order). An event whose `code` has no `keyLabel` (unmapped keycode)
 * is skipped entirely — as if it were never recorded — so a run of
 * [qualifying, unmapped] still shows the earlier qualifying event's badge
 * rather than going blank.
 *
 * Label = `modsLabel(mods) + keyLabel(code)`. Returns `null` when there is no
 * qualifying, labelable candidate in the window.
 */
export function keystrokeBadgeAt(
  tMs: number,
  keyEvents: RecEvent[],
  opts: { allKeys: boolean },
): { label: string } | null {
  for (let i = keyEvents.length - 1; i >= 0; i--) {
    const e = keyEvents[i];
    if (e.k !== "key") continue;
    if (e.t > tMs) continue;
    if (tMs - e.t > KEYSTROKE_DISPLAY_MS) continue;

    const hasModCombo = e.mods.some(
      (m) => m === "cmd" || m === "ctrl" || m === "alt" || m === "fn",
    );
    if (!opts.allKeys && !hasModCombo) continue;

    const glyph = keyLabel(e.code);
    if (glyph === null) continue; // unmapped keycode: skip, keep scanning back

    return { label: modsLabel(e.mods) + glyph };
  }
  return null;
}

/** Fade alpha (0..1) for a keystroke badge given the AGE (ms, `tMs - event.t`,
 *  always >= 0 for a qualifying candidate) of the event driving it: opaque
 *  for the first `KEYSTROKE_DISPLAY_MS - KEYSTROKE_FADE_MS`, then linearly
 *  fades to 0 over the final `KEYSTROKE_FADE_MS` of the display window.
 *  Ages outside [0, KEYSTROKE_DISPLAY_MS] clamp to the nearest end (fully
 *  opaque / fully transparent) rather than extrapolating. */
export function keystrokeBadgeAlpha(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= KEYSTROKE_DISPLAY_MS - KEYSTROKE_FADE_MS) return 1;
  if (ageMs >= KEYSTROKE_DISPLAY_MS) return 0;
  const intoFade = ageMs - (KEYSTROKE_DISPLAY_MS - KEYSTROKE_FADE_MS);
  return 1 - intoFade / KEYSTROKE_FADE_MS;
}

// ---- Caption lookup --------------------------------------------------------

/**
 * The caption text visible at SOURCE time `tMs`, given a recording's caption
 * segments — or `null` when no segment covers it. Segments are assumed
 * non-overlapping and sorted ascending by `startMs` (the invariant
 * `clampCaptionSegments` maintains — this function does not re-sort or
 * de-overlap). Each segment is a half-open `[startMs, endMs)` window, mirroring
 * `activeSpeedRate`'s convention: the start edge is inside, the end edge is
 * not, so touching segments resolve unambiguously to the later one at their
 * shared boundary.
 *
 * Binary search: O(log n) largest index with `segments[i].startMs <= tMs`,
 * then a single check that `tMs` still falls before that segment's `endMs`
 * (handles gaps between segments, which are legal and common). Pure — no
 * drawing, no globals. Both the preview (EditorView) and the export
 * (renderPipeline) call this exact function so captions render identically.
 */
export function captionAt(tMs: number, segments: CaptionSegment[]): string | null {
  if (segments.length === 0) return null;

  let lo = -1;
  let a = 0;
  let b = segments.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (segments[mid].startMs <= tMs) {
      lo = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  if (lo < 0) return null;

  const seg = segments[lo];
  return tMs < seg.endMs ? seg.text : null;
}

/**
 * The camera "cut to camera" scene active at SOURCE time `tMs`, given a
 * recording's webcam scenes — or `null` when none covers it. Returns just the
 * scene `id` (the caller needs only "are we in a scene, and which one"; the
 * render treats every scene identically). Scenes are assumed non-overlapping
 * and sorted ascending by `startMs` (the invariant `clampWebcamScenes`
 * maintains — this function does not re-sort or de-overlap). Each scene is a
 * half-open `[startMs, endMs)` window, mirroring `captionAt`: the start edge is
 * inside, the end edge is not, so touching scenes resolve unambiguously to the
 * later one at their shared boundary.
 *
 * Binary search: O(log n) largest index with `scenes[i].startMs <= tMs`, then a
 * single check that `tMs` still falls before that scene's `endMs` (handles gaps
 * between scenes, which are legal). Pure — no drawing, no globals. Both the
 * preview (EditorView) and the export (renderPipeline) call this exact function
 * so scenes render identically. Empty `scenes` → always null (pre-M6 projects
 * render byte-identically).
 */
export function webcamSceneAt(tMs: number, scenes: WebcamScene[]): { id: string } | null {
  if (scenes.length === 0) return null;

  let lo = -1;
  let a = 0;
  let b = scenes.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (scenes[mid].startMs <= tMs) {
      lo = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  if (lo < 0) return null;

  const scene = scenes[lo];
  return tMs < scene.endMs ? { id: scene.id } : null;
}

/**
 * ALL masks active at SOURCE time `tMs`, given a recording's masks — in INPUT
 * ORDER (stable). Unlike `captionAt` / `webcamSceneAt` (which return the single
 * covering segment via binary search), masks MAY overlap in time, so several
 * can be simultaneously active; a plain forward scan collecting every mask
 * whose half-open `[startMs, endMs)` window contains `tMs` is both correct and
 * order-preserving (masks are NOT sorted — see `clampMasks`). Half-open on the
 * end mirrors `captionAt`: the start edge is inside, the end edge is not.
 *
 * Pure — no drawing, no globals. Both the preview (EditorView) and the export
 * (renderPipeline) call this exact function so masks render identically. Empty
 * `masks` → always `[]` (pre-M5 projects render byte-identically). The lists are
 * small (a handful of masks), so the linear scan is fine.
 */
export function masksAt(tMs: number, masks: Mask[]): Mask[] {
  const active: Mask[] = [];
  for (const m of masks) {
    if (tMs >= m.startMs && tMs < m.endMs) active.push(m);
  }
  return active;
}

/** Margin (px, output space) between the webcam PiP and the frame edge. */
const WEBCAM_MARGIN = 24;

/** clamp `n` into [0, 1]. */
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Auto-shrink multiplier for the webcam bubble given the frame's current zoom
 * `scale`. `1 − 0.45 · clamp01((scale − 1)/(2 − 1))`: at no zoom (scale ≤ 1) the
 * factor is 1 (bubble unshrunk); at ≥2× zoom it saturates at 0.55; between 1×
 * and 2× it ramps linearly. Because `zoomStateAt`'s scale is already eased over
 * the transition ramps, feeding it here makes the shrink animate for free.
 * Pure math. Applied as a multiplier on the bubble size ONLY when
 * `webcam.autoShrink` is on (the caller passes 1 otherwise, leaving the rect
 * byte-identical to pre-M6).
 */
export function webcamShrinkFactor(zoomScale: number): number {
  return 1 - 0.45 * clamp01((zoomScale - 1) / (2 - 1));
}

/**
 * Cover-fit ("aspect-fill") source-rect math: the largest centered
 * sub-rectangle of a `srcW`×`srcH` image that has the destination's aspect
 * ratio, so drawing it into `dstW`×`dstH` fills the destination with no
 * letterboxing and no stretching (the overflowing axis is center-cropped).
 *
 * Returns `{sx, sy, sw, sh}` — the source rectangle to sample. Feed it to
 * `ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dstW, dstH)`.
 *
 * This is the inverse framing of the background cover-fit (which scales the
 * whole image up and crops in *destination* space); here we crop in *source*
 * space instead, which keeps the webcam draw a single `drawImage` inside a
 * clip path without needing an extra transform. Pure math.
 *
 * Degenerate inputs (any dimension ≤ 0) fall back to the full source rect.
 */
export function coverCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    return { sx: 0, sy: 0, sw: srcW, sh: srcH };
  }
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    // Source is wider than the destination → crop the sides (sample full height).
    const sh = srcH;
    const sw = srcH * dstAspect;
    const sx = (srcW - sw) / 2;
    return { sx, sy: 0, sw, sh };
  }
  // Source is taller than (or equal to) the destination → crop top/bottom.
  const sw = srcW;
  const sh = srcW / dstAspect;
  const sy = (srcH - sh) / 2;
  return { sx: 0, sy, sw, sh };
}

/**
 * Corner-anchored placement rect for the webcam picture-in-picture, in output
 * pixels. Width is `sizeFrac * outW * scaleFactor`; height derives from the
 * shape's aspect:
 *   - `circle`  → 1:1 (square; the caller masks it to a circle)
 *   - `rounded` → 4:3 (height = width * 3/4)
 * The rect sits `WEBCAM_MARGIN` px from the two edges of the chosen corner.
 *
 * `scaleFactor` (default 1) is the auto-shrink multiplier (`webcamShrinkFactor`)
 * — applied to w AND h. Crucially the anchor stays the CORNER, not the center:
 * x/y are re-derived from the margin against the SHRUNK size, so the bubble
 * shrinks toward its corner (its far edge stays flush to the margin) rather than
 * collapsing about its midpoint. At `scaleFactor = 1` the rect is byte-identical
 * to the pre-M6 result (the arg is omitted on the no-shrink path).
 *
 * Pure math — no drawing.
 */
export function webcamRect(
  outW: number,
  outH: number,
  corner: string,
  sizeFrac: number,
  shape: "circle" | "rounded" = "rounded",
  scaleFactor: number = 1,
): { x: number; y: number; w: number; h: number } {
  const w = sizeFrac * outW * scaleFactor;
  const h = shape === "circle" ? w : w * 0.75; // 1:1 for circle, 4:3 for rounded
  const right = corner === "br" || corner === "tr";
  const bottom = corner === "br" || corner === "bl";
  const x = right ? outW - WEBCAM_MARGIN - w : WEBCAM_MARGIN;
  const y = bottom ? outH - WEBCAM_MARGIN - h : WEBCAM_MARGIN;
  return { x, y, w, h };
}

export type ZoomState = { cx: number; cy: number; scale: number };

const IDENTITY: ZoomState = { cx: 0.5, cy: 0.5, scale: 1 };

const DEFAULT_TRANSITION_MS = 500;

/** Cubic ease-in-out on t in [0,1]. Monotonic, f(0)=0, f(1)=1. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Linear interpolate between identity and a block's target by eased fraction f in [0,1]. */
function lerpState(block: ZoomBlock, f: number): ZoomState {
  return {
    cx: IDENTITY.cx + (block.cx - IDENTITY.cx) * f,
    cy: IDENTITY.cy + (block.cy - IDENTITY.cy) * f,
    scale: IDENTITY.scale + (block.scale - IDENTITY.scale) * f,
  };
}

/**
 * Which source rect is visible at time `tMs`, expressed as a pan/zoom state in
 * normalized capture coords. Identity `{cx:.5, cy:.5, scale:1}` outside any
 * block; eases in over `transitionMs` at each block's leading edge and eases
 * back out over `transitionMs` at its trailing edge (cubic ease-in-out).
 *
 * Blocks are assumed non-overlapping and ordered (as produced by
 * `generateAutoZoom`); the first block whose [startMs, endMs] contains `tMs`
 * wins. The transition ramps live INSIDE the block window ([startMs,
 * startMs+transitionMs] rising, [endMs-transitionMs, endMs] falling), so the
 * state is exactly identity at the instant the block begins/ends — no abrupt
 * jump at the boundary.
 */
export function zoomStateAt(
  tMs: number,
  blocks: ZoomBlock[],
  transitionMs: number = DEFAULT_TRANSITION_MS,
): ZoomState {
  for (const block of blocks) {
    if (tMs < block.startMs || tMs > block.endMs) continue;

    const dur = block.endMs - block.startMs;
    // Clamp the transition so a very short block still behaves: each ramp gets
    // at most half the block so they never overlap.
    const ramp = Math.max(0, Math.min(transitionMs, dur / 2));

    if (ramp <= 0) return { cx: block.cx, cy: block.cy, scale: block.scale };

    const intoBlock = tMs - block.startMs; // ms since block start
    const untilEnd = block.endMs - tMs; // ms until block end

    if (intoBlock < ramp) {
      // Rising edge.
      return lerpState(block, easeInOutCubic(intoBlock / ramp));
    }
    if (untilEnd < ramp) {
      // Falling edge.
      return lerpState(block, easeInOutCubic(untilEnd / ramp));
    }
    // Fully inside the plateau.
    return { cx: block.cx, cy: block.cy, scale: block.scale };
  }
  return { ...IDENTITY };
}

/** Two zoom states are the "same" (no visible motion between them) when their
 *  pan/zoom differs by less than this. Used to collapse a motion-blur request
 *  on a static stretch (plateau / outside any block) back to a single sample. */
const ZOOM_STATE_EPSILON = 1e-6;

function zoomStatesEqual(a: ZoomState, b: ZoomState): boolean {
  return (
    Math.abs(a.cx - b.cx) < ZOOM_STATE_EPSILON &&
    Math.abs(a.cy - b.cy) < ZOOM_STATE_EPSILON &&
    Math.abs(a.scale - b.scale) < ZOOM_STATE_EPSILON
  );
}

/**
 * The zoom states to composite for a motion-blurred frame at time `tMs`. Pure —
 * the render loop (preview + export) draws the SAME decoded frame once per
 * returned state with `globalAlpha = 1/samples.length` and accumulates, which
 * smears the pan/zoom motion during a transition ramp (Screen-Studio-style
 * motion blur) without needing extra decoded frames.
 *
 * Contract:
 *   - Returns the CURRENT-time state first (`samples[0] === zoomStateAt(tMs)`),
 *     then `n - 1` earlier states at `tMs - k·Δ` where `Δ = frameIntervalMs / n`
 *     (`k = 1..n-1`) — i.e. the blur trails BACKWARD from the present frame over
 *     roughly one frame interval, split into `n` sub-steps.
 *   - On a STATIC stretch — outside every block, or fully inside a block's
 *     plateau — every sub-sample resolves to the same zoom state, so there is no
 *     motion to blur: it collapses to a SINGLE sample (draw cost ×1, not ×n).
 *     This is what keeps blur's cost confined to the ~2·transition ramps per
 *     block (the only place the state actually changes frame-to-frame).
 *   - `n <= 1` (blur off / degenerate) also yields the single current sample.
 * `transitionMs` matches `zoomStateAt`'s default so preview and export agree.
 */
export function motionBlurSamples(
  tMs: number,
  blocks: ZoomBlock[],
  n: number,
  frameIntervalMs: number,
  transitionMs: number = DEFAULT_TRANSITION_MS,
): ZoomState[] {
  const current = zoomStateAt(tMs, blocks, transitionMs);
  const count = Math.floor(n);
  if (count <= 1 || !(frameIntervalMs > 0)) return [current];

  const dt = frameIntervalMs / count;
  const samples: ZoomState[] = [current];
  let allSame = true;
  for (let k = 1; k < count; k++) {
    const s = zoomStateAt(tMs - k * dt, blocks, transitionMs);
    if (!zoomStatesEqual(s, current)) allSame = false;
    samples.push(s);
  }
  // Static window (plateau / outside any block): nothing moved across the
  // sub-sample span → collapse to a single draw (no blur cost).
  return allSame ? [current] : samples;
}

/**
 * Inverse of the compositor's frame/cursor forward mapping: given a click at
 * output-canvas pixel `(clickX, clickY)` and the current pan/zoom, return the
 * normalized capture-space coords `{nx, ny}` (0..1 relative to `capture.rect`)
 * that sit under that pixel — UNCLAMPED, i.e. still returned (and still
 * mathematically meaningful) even when the point lands outside the drawn
 * content rect (padding / letterbox band) or outside [0,1] in capture space.
 * Only a degenerate content rect (`contentW`/`contentH` <= 0) yields `null`.
 *
 * This is the exact inverse of the forward math `drawFrameLayer` and the
 * `drawCompositeV2` cursor overlay use, kept here beside them so the two never
 * drift:
 *   forward: visible source fraction `[sfx, sfx+1/scale]` maps onto the content
 *            rect `[contentX, contentX+contentW]`, where
 *            `sfx = clamp(cx - (1/scale)/2, 0, 1 - 1/scale)`.
 *   inverse: `u = (clickX - contentX) / contentW` (fraction across the content
 *            rect), then `nx = sfx + u * (1/scale)`.
 *
 * At scale 1 / center 0.5 this reduces to a plain content-rect → [0,1] map.
 * The result is NOT viewport-clamped in either direction (in-bounds or out) —
 * see `clampZoomCenter` for the caller's own clamping when it wants one.
 *
 * `canvasToCapture` (below) wraps this with the in-bounds guard for callers
 * that want the padding/letterbox band rejected (e.g. "click to set a zoom
 * center" — clicking the letterbox shouldn't move anything). This unclamped
 * form exists for callers that need the true capture point of a grab that may
 * have started just outside the drawn content (e.g. a mask corner-resize
 * handle sitting on a zoom-clipped edge) — see `EditorView`'s
 * `onMaskRectPointerDown`. Pure.
 */
export function canvasToCaptureUnclamped(
  clickX: number,
  clickY: number,
  layout: OutputLayout,
  zoom: ZoomState,
): { nx: number; ny: number } | null {
  const { contentX, contentY, contentW, contentH } = layout;
  if (contentW <= 0 || contentH <= 0) return null;

  // Fraction across the drawn content rect — NOT clamped to [0,1] here.
  const u = (clickX - contentX) / contentW;
  const v = (clickY - contentY) / contentH;

  const scale = zoom.scale > 0 ? zoom.scale : 1;
  const sampleFracW = 1 / scale;
  const sampleFracH = 1 / scale;
  // The visible source window's top-left (mirrors drawFrameLayer's clamp).
  let sfx = zoom.cx - sampleFracW / 2;
  let sfy = zoom.cy - sampleFracH / 2;
  sfx = Math.max(0, Math.min(sfx, 1 - sampleFracW));
  sfy = Math.max(0, Math.min(sfy, 1 - sampleFracH));

  return {
    nx: sfx + u * sampleFracW,
    ny: sfy + v * sampleFracH,
  };
}

/**
 * Same inverse mapping as `canvasToCaptureUnclamped`, but returns `null` when
 * the click lands outside the drawn content rect (padding / letterbox band) —
 * used by the editor's "click the preview to set a zoom block's center" flow
 * (Task 3), where a click on the padding must be a no-op. Pure.
 */
export function canvasToCapture(
  clickX: number,
  clickY: number,
  layout: OutputLayout,
  zoom: ZoomState,
): { nx: number; ny: number } | null {
  const { contentX, contentY, contentW, contentH } = layout;
  if (contentW <= 0 || contentH <= 0) return null;

  // Fraction across the drawn content rect. Outside [0,1] on either axis means
  // the click hit the padding / letterbox band, not the video.
  const u = (clickX - contentX) / contentW;
  const v = (clickY - contentY) / contentH;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;

  return canvasToCaptureUnclamped(clickX, clickY, layout, zoom);
}

/**
 * `ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)` that actually honors the
 * source rect for EVERY CanvasImageSource — including WebCodecs `VideoFrame`s.
 *
 * WHY: WKWebView's 2D canvas IGNORES the 9-arg drawImage source rectangle when
 * the source is a `VideoFrame` (WebKit's `drawImage(WebCodecsVideoFrame&, …)`
 * takes the srcRect parameter unnamed/unused and paints the full frame into
 * the dest rect). The export pipeline draws decoded
 * `VideoFrame`s, so every source-rect draw silently became a full-frame
 * stretch: the webcam bubble squished the whole 4:3 frame into its square
 * instead of cover-cropping, and pan/zoom (a source-window sample) wouldn't
 * magnify. The preview draws `HTMLVideoElement`s (unaffected), which is why
 * preview and export disagreed.
 *
 * FIX: express the identical crop in DESTINATION space, which WebKit handles
 * for all sources — clip to the dest rect, then draw the FULL source scaled by
 * `dw/sw` (and `dh/sh`) and offset by `-sx`/`-sy` in that scale, so the wanted
 * source window lands exactly on `(dx,dy,dw,dh)` and everything else is
 * clipped away. Mathematically identical to the 9-arg form, so using it for
 * ALL sources keeps preview and export on the same code path (WYSIWYG).
 *
 * Fast path: a full-source draw (sx=sy=0, sw/sh = intrinsic size) needs no
 * crop → plain 4-arg draw, no clip (the common no-zoom case stays cheap). An
 * unknown intrinsic size (0×0) falls back to the plain stretch — same as the
 * pre-fix behavior for a not-yet-decodable source.
 */
function drawImageSourceRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  const iw = imgWidth(src);
  const ih = imgHeight(src);
  if (iw <= 0 || ih <= 0) {
    // Unknown intrinsic size — plain stretch (pre-fix fallback behavior).
    ctx.drawImage(src, dx, dy, dw, dh);
    return;
  }
  if (sx === 0 && sy === 0 && sw === iw && sh === ih) {
    // Full-source draw: no crop needed, skip the clip.
    ctx.drawImage(src, dx, dy, dw, dh);
    return;
  }
  const kx = dw / sw;
  const ky = dh / sh;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.drawImage(src, dx - sx * kx, dy - sy * ky, iw * kx, ih * ky);
  ctx.restore();
}

/** Trace a rounded-rectangle path on `ctx` (does not fill/stroke). */
function roundedRectPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Paint one output frame onto `ctx` (sized `outW`×`outH`):
 *   1. Fill the full canvas with the background (solid or top→bottom gradient).
 *   2. Draw the source `frame` into the content rect resolved by
 *      `outputLayout` (padding inset within the content box; a fixed aspect
 *      centers that box with letterbox bands), clipped to a rounded rect
 *      (`appearance.cornerRadius`).
 *   3. Apply the pan/zoom: `scale` magnifies around the normalized center
 *      (`cx`,`cy`); at scale 1 / center 0.5 this is the whole frame.
 *
 * The inner (video) area is the `contentW`×`contentH` rect at
 * (`contentX`,`contentY`) from `outputLayout` (for `auto` that reduces to the
 * legacy `outW - 2*padding` × `outH - 2*padding` inset). Zoom is done by
 * choosing the source sub-rectangle to sample: a `scale`× zoom samples
 * `1/scale` of the source, centered on (`cx`,`cy`) and clamped so the sample
 * window stays inside the source (no out-of-bounds sampling / edge smear).
 */
export function drawComposite(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  frameW: number,
  frameH: number,
  outW: number,
  outH: number,
  appearance: Appearance,
  zoom: ZoomState,
): void {
  // 1. Background (image support: only cover-fit when a decoded image is
  //    supplied; the pure `drawComposite` path never has one, so an image
  //    background falls back to a neutral fill here — `drawCompositeV2` passes
  //    the decoded image).
  drawBackground(ctx, appearance.background, outW, outH, null);
  // 2 + 3. Padded, rounded, zoomed video frame.
  drawFrameLayer(ctx, frame, frameW, frameH, outW, outH, appearance, zoom);
}

// ---- Shared layers (used by both drawComposite and drawCompositeV2) ------

const IMAGE_FALLBACK_FILL = "#0f1b2d";

/**
 * Fill the whole canvas with the appearance background. For `image`, cover-fit
 * `bgImage` (largest scale that covers `outW×outH`, centered, cropped); if no
 * decoded image is supplied, fall back to a neutral fill so nothing is left
 * transparent.
 */
function drawBackground(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bg: Appearance["background"],
  outW: number,
  outH: number,
  bgImage: CanvasImageSource | null,
): void {
  if (bg.type === "gradient") {
    const grad = ctx.createLinearGradient(0, 0, 0, outH);
    grad.addColorStop(0, bg.from);
    grad.addColorStop(1, bg.to);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, outW, outH);
    return;
  }
  if (bg.type === "solid") {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, outW, outH);
    return;
  }
  // image
  if (bgImage) {
    const iw = imgWidth(bgImage);
    const ih = imgHeight(bgImage);
    if (iw > 0 && ih > 0) {
      const scale = Math.max(outW / iw, outH / ih); // cover
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (outW - dw) / 2;
      const dy = (outH - dh) / 2;
      ctx.fillStyle = IMAGE_FALLBACK_FILL;
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(bgImage, dx, dy, dw, dh);
      return;
    }
  }
  ctx.fillStyle = IMAGE_FALLBACK_FILL;
  ctx.fillRect(0, 0, outW, outH);
}

/** Natural width of a decoded image source (0 if unknown).
 *
 * Checks, in order: `videoWidth` (HTMLVideoElement — the preview path),
 * `displayWidth` (WebCodecs `VideoFrame` — the export path; this is the
 * frame's dimensions after any rotation/aspect adjustment), `codedWidth`
 * (`VideoFrame` fallback — the raw decoded buffer size), then `width`
 * (HTMLImageElement / ImageBitmap / OffscreenCanvas). Exported so its
 * VideoFrame-shaped-input behavior is directly unit-testable without a real
 * decoder (see tests/compositor.test.ts).
 */
export function imgWidth(src: CanvasImageSource): number {
  const s = src as {
    width?: number;
    videoWidth?: number;
    displayWidth?: number;
    codedWidth?: number;
  };
  return s.videoWidth || s.displayWidth || s.codedWidth || s.width || 0;
}
export function imgHeight(src: CanvasImageSource): number {
  const s = src as {
    height?: number;
    videoHeight?: number;
    displayHeight?: number;
    codedHeight?: number;
  };
  return s.videoHeight || s.displayHeight || s.codedHeight || s.height || 0;
}

/** The content rect (where the padded source frame is drawn) for this frame +
 *  appearance, in the canvas' pixel space. Centralized so `drawFrameLayer`, the
 *  cursor overlay, and the webcam mapping all share the identical rect. */
function contentRect(
  frameW: number,
  frameH: number,
  appearance: Appearance,
): { dx: number; dy: number; dw: number; dh: number } {
  const L = outputLayout(frameW, frameH, appearance.padding, appearance.aspect);
  return { dx: L.contentX, dy: L.contentY, dw: Math.max(0, L.contentW), dh: Math.max(0, L.contentH) };
}

/** Draw the padded + rounded + zoomed source frame into the inner area. */
function drawFrameLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  frameW: number,
  frameH: number,
  _outW: number,
  _outH: number,
  appearance: Appearance,
  zoom: ZoomState,
): void {
  const { dx, dy, dw, dh } = contentRect(frameW, frameH, appearance);
  if (dw <= 0 || dh <= 0) return;

  // Source sub-rectangle (zoom): sample 1/scale of the source, centered on
  // (cx, cy), clamped inside [0, frameW] × [0, frameH].
  const scale = zoom.scale > 0 ? zoom.scale : 1;
  const sampleW = frameW / scale;
  const sampleH = frameH / scale;
  let sx = zoom.cx * frameW - sampleW / 2;
  let sy = zoom.cy * frameH - sampleH / 2;
  sx = Math.max(0, Math.min(sx, frameW - sampleW));
  sy = Math.max(0, Math.min(sy, frameH - sampleH));

  ctx.save();
  roundedRectPath(ctx, dx, dy, dw, dh, appearance.cornerRadius);
  ctx.clip();
  // Source-rect draw via the dest-space helper: WKWebView ignores the 9-arg
  // drawImage source rect for VideoFrame sources (the export path), which
  // silently disabled zoom in exports — see `drawImageSourceRect`.
  drawImageSourceRect(ctx, frame, sx, sy, sampleW, sampleH, dx, dy, dw, dh);
  ctx.restore();
}

// ---- Masks (pixelate / highlight) ---------------------------------------
//
// Masks are stored in normalized CAPTURE coords ([0,1]) and must track the
// content under zoom. `drawFrameLayer` leaves NO persistent ctx transform (it
// maps source→content-rect inside a single `drawImage` and restores), so —
// exactly like the cursor overlay — we compute each mask's on-screen rect
// EXPLICITLY through the same forward pan/zoom map, rather than drawing inside a
// (non-existent) transform. `maskRectToContent` is that forward map, extracted
// pure + tested.

/**
 * Map a mask's normalized-capture rect (`x,y,w,h` in [0,1]) to on-screen
 * content-rect pixels under the current pan/zoom, intersected with the content
 * rect `(dx,dy,dw,dh)`. Returns `null` when the rect is entirely outside the
 * visible source window (fully scrolled off under zoom) — nothing to draw.
 *
 * The forward map mirrors `drawFrameLayer` / the cursor overlay exactly: under
 * `scale`× zoom the visible source fraction is `[sfx, sfx+1/scale]` on X (and
 * likewise Y), clamped inside the source, and that window maps onto the content
 * rect. So a normalized capture coordinate `nx` lands at content fraction
 * `u = (nx - sfx) / (1/scale)`, i.e. output pixel `dx + u*dw`. We map the rect's
 * two X edges and two Y edges, then intersect the resulting box with the content
 * rect. Kept pure (no ctx) so the geometry is unit-testable without a canvas.
 */
export function maskRectToContent(
  rect: { x: number; y: number; w: number; h: number },
  zoom: ZoomState,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): { x: number; y: number; w: number; h: number } | null {
  if (dw <= 0 || dh <= 0) return null;
  const scale = zoom.scale > 0 ? zoom.scale : 1;
  const sampleFracW = 1 / scale;
  const sampleFracH = 1 / scale;
  let sfx = zoom.cx - sampleFracW / 2;
  let sfy = zoom.cy - sampleFracH / 2;
  sfx = Math.max(0, Math.min(sfx, 1 - sampleFracW));
  sfy = Math.max(0, Math.min(sfy, 1 - sampleFracH));

  // Forward-map the rect's edges (normalized capture → content fraction → px).
  const x0 = dx + ((rect.x - sfx) / sampleFracW) * dw;
  const x1 = dx + ((rect.x + rect.w - sfx) / sampleFracW) * dw;
  const y0 = dy + ((rect.y - sfy) / sampleFracH) * dh;
  const y1 = dy + ((rect.y + rect.h - sfy) / sampleFracH) * dh;

  // Intersect with the content rect (clip off any part scrolled out of view).
  const left = Math.max(dx, Math.min(x0, x1));
  const right = Math.min(dx + dw, Math.max(x0, x1));
  const top = Math.max(dy, Math.min(y0, y1));
  const bottom = Math.min(dy + dh, Math.max(y0, y1));

  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null; // entirely off-screen under this zoom
  return { x: left, y: top, w, h };
}

/** Downscale factor for the pixelate mosaic: the region is drawn into an
 *  offscreen ≈1/24 its size then scaled back up with smoothing off, so each
 *  ~24px source block becomes one flat mosaic cell. Chosen to read as a clear
 *  privacy mosaic at typical output resolutions without being so coarse it
 *  loses the region's shape. */
const PIXELATE_DIVISOR = 24;

/** Offscreen buffer size (px) for a pixelate region of on-screen size
 *  `regionW`×`regionH`: each axis is `round(size / PIXELATE_DIVISOR)`, floored
 *  at 1 so a tiny region still produces a valid ≥1×1 buffer (a single flat
 *  cell). Pure — the block geometry is unit-testable without a canvas. */
export function pixelateBufferSize(
  regionW: number,
  regionH: number,
): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(regionW / PIXELATE_DIVISOR)),
    h: Math.max(1, Math.round(regionH / PIXELATE_DIVISOR)),
  };
}

/** Opacity of the highlight dim overlay (the fill drawn OUTSIDE the highlight
 *  rects). ~0.5 reads as a clear "focus here" darkening without hiding the
 *  dimmed content entirely. */
const HIGHLIGHT_DIM_ALPHA = 0.5;

/** A small offscreen drawing surface for the pixelate downscale. Prefers
 *  `OffscreenCanvas` (the export worker path); falls back to a DOM `<canvas>`
 *  (the preview). Returns null if neither is available (masks then skip the
 *  pixelate silently rather than throwing). */
function makeScratchCanvas(
  w: number,
  h: number,
):
  | { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D }
  | null {
  const cw = Math.max(1, w);
  const ch = Math.max(1, h);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  return null;
}

/**
 * Draw the active masks over the ALREADY-DRAWN frame, inside the content rect
 * `(dx,dy,dw,dh)`, under the current pan/zoom `zoom`. Called from
 * `drawCompositeV2`'s NORMAL (non-scene) path, AFTER the frame and BEFORE the
 * cursor — masks are content, so they sit under the synthetic cursor/badges.
 * Empty `masks` is a complete no-op (no ctx state touched) so `masks: []`
 * renders byte-identically to pre-M5.
 *
 * Two kinds, both mapped to on-screen pixels via `maskRectToContent` (so they
 * track content under zoom) and clipped to the rounded content rect:
 *   - `pixelate`: read the region back from the canvas into an offscreen ≈1/24
 *     its size, then draw it back scaled up with `imageSmoothingEnabled = false`
 *     → a mosaic. NO `ctx.filter` (unreliable in WKWebView). Each pixelate mask
 *     is an independent read-back+redraw.
 *   - `highlight`: dim everything OUTSIDE the union of all active highlight rects
 *     in ONE fill pass — an even-odd path (outer content rect + each highlight
 *     rect as a hole) filled with `rgba(0,0,0,HIGHLIGHT_DIM_ALPHA)`, so the
 *     interior of every highlight rect stays undimmed. Multiple highlights =
 *     multiple holes in the single pass (never stacked fills → no double-dim).
 *
 * Respects the ambient `ctx.globalAlpha` (the motion-blur accumulation weight)
 * by never assigning it — the pixelate redraw and the dim fill inherit it, so
 * under N-sample accumulation they average to the same value the frame does (no
 * double-dim / no residual darkening). Pure w.r.t. inputs beyond the ctx it
 * draws to.
 */
function drawMasksLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  masks: Mask[],
  zoom: ZoomState,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  cornerRadius: number,
): void {
  if (masks.length === 0) return; // no-op ⇒ pre-M5 byte-identical

  // Resolve every active mask to its on-screen rect once (drop fully off-screen).
  const pixelateRects: { x: number; y: number; w: number; h: number }[] = [];
  const highlightRects: { x: number; y: number; w: number; h: number }[] = [];
  for (const m of masks) {
    const r = maskRectToContent(m.rect, zoom, dx, dy, dw, dh);
    if (!r) continue;
    if (m.kind === "pixelate") pixelateRects.push(r);
    else highlightRects.push(r);
  }
  if (pixelateRects.length === 0 && highlightRects.length === 0) return;

  // --- Pixelate: mosaic each region independently (read-back + upscale). ---
  for (const r of pixelateRects) {
    const buf = pixelateBufferSize(r.w, r.h);
    const scratch = makeScratchCanvas(buf.w, buf.h);
    if (!scratch) continue; // no drawing surface available — skip silently
    // Downscale the on-screen region into the tiny buffer. Smoothing stays ON
    // for the DOWNSCALE so each mosaic cell is the AVERAGE of its ~24px block
    // (a cleaner privacy mosaic than nearest-neighbor's single-pixel pick); the
    // blocky look comes from the smoothing-OFF UPSCALE below.
    scratch.ctx.imageSmoothingEnabled = true;
    scratch.ctx.clearRect(0, 0, buf.w, buf.h);
    scratch.ctx.drawImage(
      ctx.canvas as CanvasImageSource,
      r.x,
      r.y,
      r.w,
      r.h,
      0,
      0,
      buf.w,
      buf.h,
    );
    // Draw it back upscaled with smoothing off (blocky mosaic), clipped to the
    // rounded content rect so it never bleeds past the frame's corners.
    ctx.save();
    roundedRectPath(ctx, dx, dy, dw, dh, cornerRadius);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch.canvas as CanvasImageSource, 0, 0, buf.w, buf.h, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // --- Highlight: ONE dim pass outside the union of highlight rects. ---
  if (highlightRects.length > 0) {
    ctx.save();
    // Clip to the rounded content rect so the dim respects the frame corners.
    roundedRectPath(ctx, dx, dy, dw, dh, cornerRadius);
    ctx.clip();
    // Even-odd path: the full content rect as the outer boundary, each highlight
    // rect punched as a hole. Filling even-odd leaves the holes' interiors
    // untouched — so the dim covers everything EXCEPT the highlight rects, in a
    // single fill (multiple highlights = multiple holes, never overlapping
    // fills → no double-darkening).
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    for (const r of highlightRects) ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = `rgba(0,0,0,${HIGHLIGHT_DIM_ALPHA})`;
    ctx.fill("evenodd");
    ctx.restore();
  }
}

// ---- Cursor + webcam overlays -------------------------------------------

/** Ripple window (ms): the fading click ring lives this long after a down.
 *  Kept in sync with `CURSOR_CLICK_WINDOW_MS` (the `clickAge` producer). */
const CLICK_RIPPLE_MS = 400;

/** Shared accent color (soft blue) for the cursor click ripple. Extracted
 *  from what was previously two duplicated `rgba(96,176,255,…)` literals
 *  (M2-carried cleanup) — pass the desired alpha in separately since each
 *  call site animates it differently (fill vs. stroke, different curves). */
const RIPPLE_COLOR_RGB = "96,176,255";

/**
 * Draw a macOS-style arrow cursor glyph with its tip at (px,py), scaled by
 * `scale`. The unit path (below) is ~12 wide × ~19 tall; a base scale is folded
 * in by the caller so `scale = 1` renders the arrow at a sensible on-screen
 * size for the recording's pixel density.
 *
 * Visibility on *any* background is the key requirement (an earlier white-only
 * fill vanished on light content): the glyph gets (a) a soft drop shadow, (b) a
 * dark 2-unit outline, and (c) a white fill — so it stays legible on white,
 * black, or busy imagery.
 */
function drawCursorGlyph(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  px: number,
  py: number,
  scale: number,
): void {
  // Classic arrow outline with the hot-spot (tip) at (0,0). Proportions follow
  // the macOS pointer: a tall left edge, a notch, and the tail flag.
  const pts: [number, number][] = [
    [0, 0],
    [0, 16.2],
    [3.9, 12.5],
    [6.4, 18.6],
    [8.9, 17.5],
    [6.4, 11.5],
    [11.4, 11.5],
  ];
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(scale, scale);

  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  // Soft drop shadow (in unit space, so it scales with the glyph). Applied to
  // the dark outline pass; cleared before the white fill so the fill stays crisp.
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 2.5;
  ctx.shadowOffsetX = 0.6;
  ctx.shadowOffsetY = 1.2;

  // Dark outline pass (also lays down the shadow).
  trace();
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();

  // White fill, no shadow.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  trace();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  // Thin crisp dark edge on top of the fill for definition.
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();

  ctx.restore();
}

/** On-screen size (source pixels) of the arrow at `cursorScale = 1` and
 *  `px_scale = 1`. The unit glyph path is ~19 tall, so a base scale of ~1.15
 *  yields a ~22px arrow — a touch larger than the real ~19px macOS pointer so
 *  the synthetic cursor reads clearly. */
const CURSOR_BASE_SCALE = 1.15;

/**
 * Fold the user's `cursorScale` (1..3), the recording's `px_scale` (so the
 * glyph is proportional on Retina captures), and the fixed base size into the
 * single scale factor `drawCursorGlyph`/the ripple use. Exposed so the preview
 * and export paths compute the identical size. `px_scale <= 0` is treated as 1.
 */
export function cursorDrawScale(cursorScale: number, pxScale: number): number {
  const s = Number.isFinite(cursorScale) && cursorScale > 0 ? cursorScale : 1;
  const px = Number.isFinite(pxScale) && pxScale > 0 ? pxScale : 1;
  return CURSOR_BASE_SCALE * s * px;
}

/**
 * Cover-fill a webcam `frame` into the rect `x,y,w,h`, optionally mirrored
 * (horizontal flip). Assumes the caller has ALREADY set up the destination clip
 * path (circle / rounded-rect / content rect) and wrapped the call in
 * save/restore — this only sets the flip transform and draws. Mirror is a
 * negative-x scale about the rect's horizontal center (`translate(2x+w) →
 * scale(-1,1)`), so the flip happens INSIDE the clip and the frame stays pinned
 * to the same rect. Cover-crop keeps the camera un-stretched (center-cropped to
 * the rect's aspect); a frame with unknown intrinsic size falls back to a plain
 * stretch (mirrors the pre-M6 bubble behavior). Pure draw.
 */
function drawWebcamCover(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  mirror: boolean,
): void {
  if (mirror) {
    // Reflect across the rect's vertical center line so the mirrored draw lands
    // back on [x, x+w] (not off-canvas): x' = (2x + w) − x.
    ctx.translate(2 * x + w, 0);
    ctx.scale(-1, 1);
  }
  const iw = imgWidth(frame);
  const ih = imgHeight(frame);
  if (iw > 0 && ih > 0) {
    const c = coverCrop(iw, ih, w, h);
    // Source-rect draw via the dest-space helper: WKWebView ignores the 9-arg
    // drawImage source rect for VideoFrame sources (the export path), which
    // squished the full webcam frame into the bubble instead of cover-cropping
    // — see `drawImageSourceRect`.
    drawImageSourceRect(ctx, frame, c.sx, c.sy, c.sw, c.sh, x, y, w, h);
  } else {
    // Unknown intrinsic size (e.g. a not-yet-decoded VideoFrame) — plain stretch.
    ctx.drawImage(frame, x, y, w, h);
  }
}

/**
 * Draw a "cut to camera" scene: the webcam frame cover-cropped into the full
 * CONTENT rect (rounded by the appearance corner radius, optionally mirrored),
 * replacing the screen frame. Background/padding are already painted by the
 * caller; the screen frame, cursor, keystroke badge, and zoom are all suppressed
 * for the scene (captions still draw, handled by the caller). Extracted so
 * `drawCompositeV2`'s scene branch stays readable. Pure draw.
 */
function drawSceneLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  cornerRadius: number,
  mirror: boolean,
): void {
  ctx.save();
  roundedRectPath(ctx, dx, dy, dw, dh, cornerRadius);
  ctx.clip();
  drawWebcamCover(ctx, frame, dx, dy, dw, dh, mirror);
  ctx.restore();
}

/**
 * Paint one output frame with the M2 layer stack:
 *   1. Background (solid / gradient / cover-fit `bgImage`).
 *   2. Padded + rounded + zoomed source frame.
 *   3. Cursor overlay (arrow glyph + fading click ripple) — only when
 *      `overlay.cursor` is non-null.
 *   4. Webcam PiP (masked circle / rounded-rect, corner-anchored) — only when
 *      `overlay.webcam` is non-null.
 * The cursor overlay is drawn inside the CONTENT rect (the drawn frame) so it
 * tracks the video under any aspect/letterbox. The webcam PiP is corner-anchored
 * to the CANVAS (it may sit in the letterbox band — Screen-Studio-like). With
 * both overlays null this is pixel-identical to `drawComposite` (aside from
 * image-background support).
 *
 * `cursorScale` is the FINAL glyph draw scale (base size × user 1..3 × the
 * recording's px_scale) — compute it with `cursorDrawScale(...)` so the preview
 * and export paths render the cursor at an identical size.
 */
export function drawCompositeV2(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  frameW: number,
  frameH: number,
  outW: number,
  outH: number,
  appearance: Appearance,
  zoom: ZoomState,
  overlay: OverlayState,
  cursorScale: number,
  bgImage: CanvasImageSource | null,
): void {
  drawBackground(ctx, appearance.background, outW, outH, bgImage);

  // The CONTENT rect (padded/letterboxed frame area) — the scene fills it, and
  // the cursor / caption / keystroke overlays position relative to it (never the
  // full canvas) so a letterboxed aspect doesn't shift them.
  const { dx, dy, dw, dh } = contentRect(frameW, frameH, appearance);

  // "Cut to camera" scene (M6): the webcam frame REPLACES the screen frame,
  // filling the content rect; the screen frame, cursor overlay, webcam bubble,
  // keystroke badge, and zoom are all suppressed. Captions still draw (below).
  // The caller only sets `overlay.scene` when a webcam frame is available at
  // this instant, so a null-frame moment falls through to the normal layout
  // (never a black frame). Motion blur collapses during a scene (zoom ignored ⇒
  // every sub-sample is identical) — see `drawCompositeBlurred`.
  if (overlay.scene) {
    if (dw > 0 && dh > 0) {
      drawSceneLayer(ctx, overlay.scene.frame, dx, dy, dw, dh, appearance.cornerRadius, overlay.scene.mirror);
    }
    // Captions still overlay a scene (bottom-center of the content rect). The
    // keystroke badge is intentionally suppressed during a scene, so it never
    // needs to shift up here.
    if (overlay.caption && dw > 0 && dh > 0) {
      drawCaptionPill(ctx, overlay.caption, dx, dy, dw, dh);
    }
    return;
  }

  drawFrameLayer(ctx, frame, frameW, frameH, outW, outH, appearance, zoom);

  if (dw <= 0 || dh <= 0) return;

  // 2.5. Masks (pixelate / highlight): drawn INSIDE the frame's transformed
  //      space (mapped via `maskRectToContent` under the same pan/zoom), AFTER
  //      the frame and BEFORE the cursor — masks are content, so the synthetic
  //      cursor/badges sit on top of them. Suppressed during a camera scene (the
  //      scene branch returned above). Empty `masks` is a no-op ⇒ pre-M5
  //      byte-identical. Under motion blur this runs per sub-sample at the
  //      ambient accumulation alpha, averaging correctly (see `drawMasksLayer`).
  drawMasksLayer(ctx, overlay.masks, zoom, dx, dy, dw, dh, appearance.cornerRadius);

  // 3. Cursor overlay. `overlay.cursor` is in normalized capture space; map it
  //    into the on-screen position accounting for the current pan/zoom so it
  //    tracks the magnified content.
  if (overlay.cursor) {
    const scale = zoom.scale > 0 ? zoom.scale : 1;
    // Which source fraction is visible (mirrors drawFrameLayer's clamp).
    const sampleFracW = 1 / scale;
    const sampleFracH = 1 / scale;
    let sfx = zoom.cx - sampleFracW / 2;
    let sfy = zoom.cy - sampleFracH / 2;
    sfx = Math.max(0, Math.min(sfx, 1 - sampleFracW));
    sfy = Math.max(0, Math.min(sfy, 1 - sampleFracH));
    // Cursor position within the visible window → output pixels.
    const u = (overlay.cursor.x - sfx) / sampleFracW;
    const v = (overlay.cursor.y - sfy) / sampleFracH;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      const cx = dx + u * dw;
      const cy = dy + v * dh;
      ctx.save();
      roundedRectPath(ctx, dx, dy, dw, dh, appearance.cornerRadius);
      ctx.clip();
      // Hide-when-idle fade: multiply the whole cursor layer (glyph + ripple)
      // by the overlay's alpha (1 by default, < 1 only while `hideIdle` dissolves
      // the idle cursor). Multiply into any existing globalAlpha (the motion-blur
      // accumulation path sets 1/N before calling) rather than assigning, so the
      // two compose. Guarded so a value of 1 leaves the context untouched
      // (pre-M4 output byte-identical).
      if (overlay.cursor.alpha < 1) ctx.globalAlpha *= Math.max(0, overlay.cursor.alpha);
      // Click ripple: an expanding, fading ring anchored at the cursor point
      // (which, at a click, sits on the down coords) for CLICK_RIPPLE_MS after a
      // down. Radius/opacity animate over clickAge/CLICK_RIPPLE_MS; the size is
      // proportional to the glyph draw scale so it tracks cursor size / density.
      const age = overlay.cursor.clickAge;
      if (age !== null && age >= 0 && age < CLICK_RIPPLE_MS) {
        const f = age / CLICK_RIPPLE_MS; // 0..1 progress
        const baseR = 6 * cursorScale;
        const radius = baseR + f * (baseR * 2.6);
        const alpha = (1 - f) * 0.85;
        // Soft filled core early in the ripple, fading fast.
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${RIPPLE_COLOR_RGB},${alpha * 0.22})`;
        ctx.fill();
        // Expanding stroked ring.
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.5, 2.2 * cursorScale * (1 - f));
        ctx.strokeStyle = `rgba(${RIPPLE_COLOR_RGB},${alpha})`;
        ctx.stroke();
      }
      drawCursorGlyph(ctx, cx, cy, cursorScale);
      ctx.restore();
    }
  }

  // 4. Webcam PiP: sized AND margin-anchored against the FULL canvas — padding
  //    and letterbox bands included — never the content rect. With a letterboxed
  //    aspect the bubble may sit in the band, flush to the canvas corner,
  //    matching Screen Studio (the webcam is a canvas-level overlay, independent
  //    of where the recording is centered). NOTE: this deliberately changed in
  //    M2.1 from M2's content-anchored placement — even in "auto" the canvas is
  //    the frame + 2*padding, so at padding 96 the bubble is ~10% larger and
  //    sits in the padding gutter vs. M2. Ratified, not a bug: the M2 data
  //    contract defines `sizeFrac` as a fraction of OUTPUT width (outW), and no
  //    webcam projects predate M2.1 (webcam capture was broken until M2.1
  //    Task 1). Pinned by "ratified M2.1" test in tests/compositor.test.ts.
  if (overlay.webcam) {
    const shape = overlay.webcam.shape;
    // Auto-shrink (M6): `scaleFactor` (1 when off) multiplies the bubble size
    // inside `webcamRect`, corner-anchored so the bubble shrinks toward its
    // corner (its far edge stays flush to the margin), not about its center.
    const r = webcamRect(
      outW,
      outH,
      overlay.webcam.corner,
      overlay.webcam.sizeFrac,
      shape,
      overlay.webcam.scaleFactor,
    );
    const wx = r.x;
    const wy = r.y;
    ctx.save();
    if (shape === "circle") {
      ctx.beginPath();
      ctx.arc(wx + r.w / 2, wy + r.h / 2, Math.min(r.w, r.h) / 2, 0, Math.PI * 2);
      ctx.closePath();
    } else {
      roundedRectPath(ctx, wx, wy, r.w, r.h, 16);
    }
    ctx.clip();
    // Aspect-fill the webcam frame into the PiP rect (cover-crop, never
    // stretched), optionally mirrored (M6) inside the clip.
    drawWebcamCover(ctx, overlay.webcam.frame, wx, wy, r.w, r.h, overlay.webcam.mirror);
    ctx.restore();
  }

  // 5. Caption pill: a rounded pill, bottom-center of the CONTENT rect,
  //    drawn BEFORE the keystroke badge so the badge (below) can shift up to
  //    clear it. Shares the keystroke badge's style constants/pill shape.
  const captionShowing = !!overlay.caption;
  if (overlay.caption) {
    drawCaptionPill(ctx, overlay.caption, dx, dy, dw, dh);
  }

  // 6. Keystroke badge: a rounded pill, bottom-center of the CONTENT rect (so
  //    it tracks the video under any aspect/letterbox, like the cursor), sat
  //    safely above the webcam's own margin zone so the two never collide.
  //    Fades per `overlay.keystroke.alpha` (driven by `keystrokeBadgeAlpha`,
  //    computed by the caller from the source-time event age). When a caption
  //    is also showing this frame, `keystrokeBottomMargin` shifts the badge up
  //    by one strip height so the two pills never overlap.
  if (overlay.keystroke && overlay.keystroke.alpha > 0) {
    drawKeystrokeBadge(
      ctx,
      overlay.keystroke.label,
      overlay.keystroke.alpha,
      dx,
      dy,
      dw,
      dh,
      captionShowing,
    );
  }
}

/** Number of motion-blur sub-samples composited during a zoom transition ramp.
 *  Matches the `n` passed to `motionBlurSamples`; kept here so preview and
 *  export use the identical sample count (no drift). */
export const MOTION_BLUR_SAMPLES = 4;

/**
 * Paint one output frame, optionally motion-blurred across a zoom transition.
 * The SINGLE composite entry point both the preview (EditorView rAF) and the
 * export (renderPipeline) call, so the two never drift.
 *
 * `zoomSamples` is the list from `motionBlurSamples(tMsSource, blocks, N, …)`:
 *   - length 1 (blur off, or a static plateau/outside-block stretch where every
 *     sub-sample resolved to the same zoom) → a SINGLE `drawCompositeV2` at that
 *     state. This is byte-for-byte the pre-M4 path, so blur-off / non-transition
 *     frames render identically.
 *   - length N (inside a transition ramp) → draw the SAME decoded frame once per
 *     zoom sub-sample and INCREMENTALLY AVERAGE them: sub-sample `k` is drawn
 *     with `globalAlpha = 1/(k+1)` (source-over). Pass 0 is fully opaque, then
 *     each later pass blends in so the buffer holds the exact equal-weight
 *     average of all sub-samples drawn so far — `(F0+…+Fk)/(k+1)`. This avoids
 *     the residual-darkening a flat `1/N` would leave over the opaque backdrop
 *     (`(1-1/N)^N` of black would survive), so the letterbox/background bands
 *     keep their full brightness while the frame/cursor smear across the
 *     changing pan/zoom. Cost is ×N ONLY on ramp frames.
 *
 * The overlays are drawn on every sub-sample (folded into the same average) so
 * they smear with the same motion as the frame — correct for the cursor (which
 * tracks the zoom) and visually coherent for the pills/webcam during the brief
 * ramp.
 */
export function drawCompositeBlurred(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  frameW: number,
  frameH: number,
  outW: number,
  outH: number,
  appearance: Appearance,
  zoomSamples: ZoomState[],
  overlay: OverlayState,
  cursorScale: number,
  bgImage: CanvasImageSource | null,
): void {
  if (zoomSamples.length <= 1) {
    drawCompositeV2(
      ctx,
      frame,
      frameW,
      frameH,
      outW,
      outH,
      appearance,
      zoomSamples[0] ?? { ...IDENTITY },
      overlay,
      cursorScale,
      bgImage,
    );
    return;
  }
  const prevAlpha = ctx.globalAlpha;
  // Incremental averaging: pass k at 1/(k+1) yields an exact equal-weight mean
  // of the sub-samples (pass 0 opaque → no black residue), see the doc above.
  for (let k = 0; k < zoomSamples.length; k++) {
    ctx.globalAlpha = 1 / (k + 1);
    drawCompositeV2(ctx, frame, frameW, frameH, outW, outH, appearance, zoomSamples[k], overlay, cursorScale, bgImage);
  }
  ctx.globalAlpha = prevAlpha;
}

/** Font size (px) for the keystroke badge / caption pill as a fraction of the
 *  content width, clamped to a sane on-screen range regardless of output
 *  resolution. Shared by both pills so their text reads at the same size. */
const KEYSTROKE_FONT_MIN_PX = 14;
const KEYSTROKE_FONT_MAX_PX = 34;
const KEYSTROKE_FONT_FRAC = 0.022;

/** Vertical gap (px, content-rect space) between a bottom-anchored pill's
 *  bottom edge and the content rect's bottom edge — clears the webcam PiP's
 *  own margin band (`WEBCAM_MARGIN`) plus its own height would be excessive,
 *  so this is sized independently as a fraction of content height,
 *  floor-clamped. Shared by the caption pill (which always sits here) and the
 *  keystroke badge (which sits here only when no caption is showing). */
const KEYSTROKE_BOTTOM_MARGIN_FRAC = 0.06;
const KEYSTROKE_BOTTOM_MARGIN_MIN_PX = 28;

/** Height (as a fraction of content height) reserved for the caption strip —
 *  the shared layout constant that both the caption pill's own vertical size
 *  and the keystroke badge's extra upward shift derive from, so the two never
 *  collide regardless of output resolution. Exported so preview and export
 *  callers (and tests) can reason about the offset without duplicating it. */
export const CAPTION_STRIP_HEIGHT_FRAC = 0.1;
const CAPTION_STRIP_HEIGHT_MIN_PX = 44;

/** Bottom margin (px, content-rect space) for the keystroke badge given the
 *  content height `dh` and whether a caption pill is ALSO showing this frame.
 *  Without a caption this is the plain `KEYSTROKE_BOTTOM_MARGIN_*` floor
 *  (unchanged pre-M4 behavior). With a caption, the badge shifts up by one
 *  caption-strip height (`CAPTION_STRIP_HEIGHT_FRAC`, floor-clamped) so the
 *  two pills stack without overlapping. Pure — the single source of truth for
 *  this offset, shared by the draw code and covered directly by tests. */
export function keystrokeBottomMargin(dh: number, captionShowing: boolean): number {
  const base = Math.max(KEYSTROKE_BOTTOM_MARGIN_MIN_PX, dh * KEYSTROKE_BOTTOM_MARGIN_FRAC);
  if (!captionShowing) return base;
  const stripHeight = Math.max(CAPTION_STRIP_HEIGHT_MIN_PX, dh * CAPTION_STRIP_HEIGHT_FRAC);
  return base + stripHeight;
}

/**
 * Draw the keystroke badge: a dark translucent rounded pill with white text,
 * horizontally centered and anchored near the bottom of the content rect
 * `(dx, dy, dw, dh)`. `alpha` (0..1, from `keystrokeBadgeAlpha`) scales the
 * whole layer's opacity uniformly (background + text) so the fade-out is a
 * clean dissolve rather than the bg and text fading at different rates.
 * `captionShowing` shifts the badge up via `keystrokeBottomMargin` so it never
 * collides with a caption pill drawn the same frame.
 */
function drawKeystrokeBadge(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  label: string,
  alpha: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  captionShowing: boolean,
): void {
  if (dw <= 0 || dh <= 0 || !label) return;
  const a = Math.max(0, Math.min(1, alpha));

  const fontPx = Math.max(KEYSTROKE_FONT_MIN_PX, Math.min(KEYSTROKE_FONT_MAX_PX, dw * KEYSTROKE_FONT_FRAC));
  const paddingX = fontPx * 0.7;
  const paddingY = fontPx * 0.45;

  ctx.save();
  ctx.font = `600 ${fontPx}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textWidth = ctx.measureText(label).width;

  const pillW = textWidth + paddingX * 2;
  const pillH = fontPx + paddingY * 2;
  const bottomMargin = keystrokeBottomMargin(dh, captionShowing);

  const pillX = dx + dw / 2 - pillW / 2;
  const pillY = dy + dh - bottomMargin - pillH;

  // Multiply into the ambient globalAlpha (1 normally; 1/(k+1) inside the
  // motion-blur accumulation) rather than assigning, so the badge composes with
  // the averaging weight during a zoom ramp. At ambient 1 this is exactly `a`
  // (pre-M4 output unchanged).
  ctx.globalAlpha *= a;
  roundedRectPath(ctx, pillX, pillY, pillW, pillH, pillH / 2);
  ctx.fillStyle = "rgba(20,20,24,0.72)";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, pillX + pillW / 2, pillY + pillH / 2 + 1);
  ctx.restore();
}

/**
 * Draw the caption pill: mirrors `drawKeystrokeBadge`'s style (dark
 * translucent rounded pill, white text, same font sizing) but always sits at
 * the FLOOR bottom margin (`KEYSTROKE_BOTTOM_MARGIN_*`) — it never shifts for
 * the keystroke badge, since the badge is the one that yields. Captions don't
 * fade (no age-based alpha curve — they're either the active segment's text
 * or not drawn at all), and can wrap to multiple lines for long text, each
 * line stacked and centered within the pill.
 */
function drawCaptionPill(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (dw <= 0 || dh <= 0 || !text) return;

  const fontPx = Math.max(KEYSTROKE_FONT_MIN_PX, Math.min(KEYSTROKE_FONT_MAX_PX, dw * KEYSTROKE_FONT_FRAC));
  const paddingX = fontPx * 0.9;
  const paddingY = fontPx * 0.5;
  const lineHeight = fontPx * 1.25;
  // Cap line width to most of the content rect so long captions wrap rather
  // than overflow the frame edges.
  const maxLineWidth = dw * 0.86;

  ctx.save();
  ctx.font = `600 ${fontPx}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = wrapText(ctx, text, maxLineWidth);
  const textWidth = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);

  const pillW = Math.min(dw, textWidth + paddingX * 2);
  const pillH = lineHeight * lines.length + paddingY * 2;
  const bottomMargin = Math.max(KEYSTROKE_BOTTOM_MARGIN_MIN_PX, dh * KEYSTROKE_BOTTOM_MARGIN_FRAC);

  const pillX = dx + dw / 2 - pillW / 2;
  const pillY = dy + dh - bottomMargin - pillH;

  roundedRectPath(ctx, pillX, pillY, pillW, pillH, Math.min(pillH / 2, 18));
  ctx.fillStyle = "rgba(20,20,24,0.72)";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  const firstLineY = pillY + paddingY + lineHeight / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, pillX + pillW / 2, firstLineY + i * lineHeight);
  });
  ctx.restore();
}

/** Greedy word-wrap: split `text` into lines whose measured width (in the
 *  context's currently-set font) does not exceed `maxWidth`, breaking on
 *  whitespace. A single word longer than `maxWidth` is kept whole on its own
 *  line (never mid-word split) so it isn't silently mangled. Pure given the
 *  context's font state. */
function wrapText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}
