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

import type { ZoomBlock, EventsHeader } from "../autoZoom";

export type Appearance = {
  padding: number; // px in OUTPUT space (uniform inset around the video)
  cornerRadius: number; // px, applied to the video frame's corners
  background:
    | { type: "solid"; color: string }
    | { type: "gradient"; from: string; to: string }
    | { type: "image"; path: string };
};

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

/** Margin (px, output space) between the webcam PiP and the frame edge. */
const WEBCAM_MARGIN = 24;

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
 *   2. Draw the source `frame` inset by `appearance.padding` on all sides,
 *      clipped to a rounded rect (`appearance.cornerRadius`).
 *   3. Apply the pan/zoom: `scale` magnifies around the normalized center
 *      (`cx`,`cy`); at scale 1 / center 0.5 this is the whole frame.
 *
 * The inner (video) area is `outW - 2*padding` × `outH - 2*padding`. Zoom is
 * done by choosing the source sub-rectangle to sample: a `scale`× zoom samples
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

/** Natural width of a decoded image source (0 if unknown). */
function imgWidth(src: CanvasImageSource): number {
  const s = src as { width?: number; videoWidth?: number };
  return s.videoWidth || s.width || 0;
}
function imgHeight(src: CanvasImageSource): number {
  const s = src as { height?: number; videoHeight?: number };
  return s.videoHeight || s.height || 0;
}

/** Draw the padded + rounded + zoomed source frame into the inner area. */
function drawFrameLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  frameW: number,
  frameH: number,
  outW: number,
  outH: number,
  appearance: Appearance,
  zoom: ZoomState,
): void {
  const pad = appearance.padding;
  const dx = pad;
  const dy = pad;
  const dw = Math.max(0, outW - 2 * pad);
  const dh = Math.max(0, outH - 2 * pad);
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
 * Overlays are drawn INSIDE the padded frame area, so they track the video.
 * With both overlays null this is pixel-identical to `drawComposite` (aside
 * from image-background support).
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

  const pad = appearance.padding;
  const dx = pad;
  const dy = pad;
  const dw = Math.max(0, outW - 2 * pad);
  const dh = Math.max(0, outH - 2 * pad);
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
        ctx.fillStyle = `rgba(96,176,255,${alpha * 0.22})`;
        ctx.fill();
        // Expanding stroked ring.
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.5, 2.2 * cursorScale * (1 - f));
        ctx.strokeStyle = `rgba(96,176,255,${alpha})`;
        ctx.stroke();
      }
      drawCursorGlyph(ctx, cx, cy, cursorScale);
      ctx.restore();
    }
  }

  // 4. Webcam PiP, corner-anchored inside the padded frame area.
  if (overlay.webcam) {
    const shape = overlay.webcam.shape;
    // webcamRect is computed in the inner (padded) coordinate space.
    const r = webcamRect(dw, dh, overlay.webcam.corner, overlay.webcam.sizeFrac, shape);
    const wx = dx + r.x;
    const wy = dy + r.y;
    ctx.save();
    if (shape === "circle") {
      ctx.beginPath();
      ctx.arc(wx + r.w / 2, wy + r.h / 2, Math.min(r.w, r.h) / 2, 0, Math.PI * 2);
      ctx.closePath();
    } else {
      roundedRectPath(ctx, wx, wy, r.w, r.h, 16);
    }
    ctx.clip();
    // Cover-fit the webcam frame into the PiP rect.
    const iw = imgWidth(overlay.webcam.frame);
    const ih = imgHeight(overlay.webcam.frame);
    if (iw > 0 && ih > 0) {
      const s = Math.max(r.w / iw, r.h / ih);
      const fw = iw * s;
      const fh = ih * s;
      ctx.drawImage(overlay.webcam.frame, wx + (r.w - fw) / 2, wy + (r.h - fh) / 2, fw, fh);
    } else {
      ctx.drawImage(overlay.webcam.frame, wx, wy, r.w, r.h);
    }
    ctx.restore();
  }
}
