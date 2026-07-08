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
// `AspectPreset` is owned by editorProject.ts (it's part of the persisted
// project schema); type-only import keeps zero runtime coupling.
import type { AspectPreset } from "../editorProject";
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
   *  last mouse-down (null if none recent). null = no cursor to draw. */
  cursor: { x: number; y: number; clickAge: number | null } | null;
  /** A webcam frame to composite as a corner PiP. null = no webcam. */
  webcam: {
    frame: CanvasImageSource;
    shape: "circle" | "rounded";
    corner: string;
    sizeFrac: number;
  } | null;
  /** The keystroke badge to draw this frame (label text + fade alpha), or
   *  null when no qualifying key event is in the display window. Callers
   *  derive `alpha` from the event's age via `keystrokeBadgeAlpha` (kept out
   *  of the pure `keystrokeBadgeAt` grouping function so that stays a clean
   *  label lookup independent of the fade curve). */
  keystroke: { label: string; alpha: number } | null;
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
 * Pure; `moves` and `downs` are assumed sorted ascending by `t` (they are as
 * written by the sidecar and split by the caller).
 */
export function cursorStateAt(
  tMs: number,
  moves: CursorSample[],
  downs: CursorSample[],
  header: EventsHeader,
): OverlayState["cursor"] {
  if (moves.length === 0) return null;

  const [rx, ry, rw, rh] = header.capture.rect;
  const norm = (m: CursorSample): { x: number; y: number } => ({
    x: rw > 0 ? (m.x - rx) / rw : 0,
    y: rh > 0 ? (m.y - ry) / rh : 0,
  });

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

  // Before the first sample: hold the first if within the gap.
  if (lo < 0) {
    const first = moves[0];
    if (first.t - tMs > CURSOR_MAX_GAP_MS) return null;
    const p = norm(first);
    return { x: p.x, y: p.y, clickAge };
  }

  const left = moves[lo];

  // Exact hit on a sample is always real recorded data — return it directly,
  // regardless of how far the neighbors are (the gap check only governs
  // *interpolation* between two samples, below).
  if (left.t === tMs) {
    const p = norm(left);
    return { x: p.x, y: p.y, clickAge };
  }

  // After the last sample: hold it if within the gap.
  if (lo === moves.length - 1) {
    if (tMs - left.t > CURSOR_MAX_GAP_MS) return null;
    const p = norm(left);
    return { x: p.x, y: p.y, clickAge };
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
  return {
    x: pl.x + (pr.x - pl.x) * f,
    y: pl.y + (pr.y - pl.y) * f,
    clickAge,
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

/** Margin (px, output space) between the webcam PiP and the frame edge. */
const WEBCAM_MARGIN = 24;

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
 * pixels. Width is `sizeFrac * outW`; height derives from the shape's aspect:
 *   - `circle`  → 1:1 (square; the caller masks it to a circle)
 *   - `rounded` → 4:3 (height = width * 3/4)
 * The rect sits `WEBCAM_MARGIN` px from the two edges of the chosen corner.
 * Pure math — no drawing.
 */
export function webcamRect(
  outW: number,
  outH: number,
  corner: string,
  sizeFrac: number,
  shape: "circle" | "rounded" = "rounded",
): { x: number; y: number; w: number; h: number } {
  const w = sizeFrac * outW;
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

/**
 * Inverse of the compositor's frame/cursor forward mapping: given a click at
 * output-canvas pixel `(clickX, clickY)` and the current pan/zoom, return the
 * normalized capture-space coords `{nx, ny}` (0..1 relative to `capture.rect`)
 * that sit under that pixel — or `null` when the click lands outside the drawn
 * content rect (padding / letterbox band).
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
 * At scale 1 / center 0.5 this reduces to a plain content-rect → [0,1] map. The
 * result is NOT viewport-clamped (that's the caller's concern — see
 * `clampZoomCenter`); it's the true capture point under the cursor.
 *
 * Used by the editor's "click the preview to set a zoom block's center" flow
 * (Task 3). Pure.
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
  ctx.drawImage(frame, sx, sy, sampleW, sampleH, dx, dy, dw, dh);
  ctx.restore();
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
  drawFrameLayer(ctx, frame, frameW, frameH, outW, outH, appearance, zoom);

  // Cursor + webcam overlays position relative to the CONTENT rect (the drawn
  // frame), not the full canvas — so a letterboxed aspect doesn't shift them.
  const { dx, dy, dw, dh } = contentRect(frameW, frameH, appearance);
  if (dw <= 0 || dh <= 0) return;

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
    const r = webcamRect(outW, outH, overlay.webcam.corner, overlay.webcam.sizeFrac, shape);
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
    // Aspect-fill the webcam frame into the PiP rect: crop the source (a
    // 16:9-ish camera frame) to the mask's aspect (1:1 circle / 4:3 rounded)
    // and draw it edge-to-edge — center-cropped, never stretched.
    const iw = imgWidth(overlay.webcam.frame);
    const ih = imgHeight(overlay.webcam.frame);
    if (iw > 0 && ih > 0) {
      const c = coverCrop(iw, ih, r.w, r.h);
      ctx.drawImage(overlay.webcam.frame, c.sx, c.sy, c.sw, c.sh, wx, wy, r.w, r.h);
    } else {
      // Frame with unknown intrinsic size (e.g. a not-yet-decoded VideoFrame) —
      // fall back to a plain stretch into the rect rather than dropping it.
      ctx.drawImage(overlay.webcam.frame, wx, wy, r.w, r.h);
    }
    ctx.restore();
  }

  // 5. Keystroke badge: a rounded pill, bottom-center of the CONTENT rect (so
  //    it tracks the video under any aspect/letterbox, like the cursor), sat
  //    safely above the webcam's own margin zone so the two never collide.
  //    Fades per `overlay.keystroke.alpha` (driven by `keystrokeBadgeAlpha`,
  //    computed by the caller from the source-time event age).
  if (overlay.keystroke && overlay.keystroke.alpha > 0) {
    drawKeystrokeBadge(ctx, overlay.keystroke.label, overlay.keystroke.alpha, dx, dy, dw, dh);
  }
}

/** Font size (px) for the keystroke badge as a fraction of the content width,
 *  clamped to a sane on-screen range regardless of output resolution. */
const KEYSTROKE_FONT_MIN_PX = 14;
const KEYSTROKE_FONT_MAX_PX = 34;
const KEYSTROKE_FONT_FRAC = 0.022;

/** Vertical gap (px, content-rect space) between the pill's bottom edge and
 *  the content rect's bottom edge — clears the webcam PiP's own margin band
 *  (`WEBCAM_MARGIN`) plus its own height would be excessive, so this is sized
 *  independently as a fraction of content height, floor-clamped. */
const KEYSTROKE_BOTTOM_MARGIN_FRAC = 0.06;
const KEYSTROKE_BOTTOM_MARGIN_MIN_PX = 28;

/**
 * Draw the keystroke badge: a dark translucent rounded pill with white text,
 * horizontally centered and anchored near the bottom of the content rect
 * `(dx, dy, dw, dh)`. `alpha` (0..1, from `keystrokeBadgeAlpha`) scales the
 * whole layer's opacity uniformly (background + text) so the fade-out is a
 * clean dissolve rather than the bg and text fading at different rates.
 */
function drawKeystrokeBadge(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  label: string,
  alpha: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
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
  const bottomMargin = Math.max(KEYSTROKE_BOTTOM_MARGIN_MIN_PX, dh * KEYSTROKE_BOTTOM_MARGIN_FRAC);

  const pillX = dx + dw / 2 - pillW / 2;
  const pillY = dy + dh - bottomMargin - pillH;

  ctx.globalAlpha = a;
  roundedRectPath(ctx, pillX, pillY, pillW, pillH, pillH / 2);
  ctx.fillStyle = "rgba(20,20,24,0.72)";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, pillX + pillW / 2, pillY + pillH / 2 + 1);
  ctx.restore();
}
