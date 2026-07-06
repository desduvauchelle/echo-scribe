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

import type { ZoomBlock } from "../autoZoom";

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

const CLICK_RIPPLE_MS = 400;

/** Draw a macOS-style arrow cursor glyph with its tip at (px,py), scaled. */
function drawCursorGlyph(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  px: number,
  py: number,
  scale: number,
): void {
  // Arrow outline (tip at 0,0), roughly 16×22 at scale 1.
  const pts: [number, number][] = [
    [0, 0],
    [0, 16],
    [4, 12.5],
    [6.5, 18.5],
    [9, 17.5],
    [6.5, 11.5],
    [11, 11.5],
  ];
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.stroke();
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
 * Overlays are drawn INSIDE the padded frame area, so they track the video.
 * With both overlays null this is pixel-identical to `drawComposite` (aside
 * from image-background support).
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
      // Click ripple: expanding, fading ring for CLICK_RIPPLE_MS after a down.
      const age = overlay.cursor.clickAge;
      if (age !== null && age >= 0 && age < CLICK_RIPPLE_MS) {
        const f = age / CLICK_RIPPLE_MS; // 0..1
        const radius = 8 + f * 28 * cursorScale;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(90,170,255,${(1 - f) * 0.8})`;
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
