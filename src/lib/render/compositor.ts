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
    | { type: "gradient"; from: string; to: string };
};

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
  // 1. Background.
  if (appearance.background.type === "gradient") {
    const grad = ctx.createLinearGradient(0, 0, 0, outH);
    grad.addColorStop(0, appearance.background.from);
    grad.addColorStop(1, appearance.background.to);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = appearance.background.color;
  }
  ctx.fillRect(0, 0, outW, outH);

  // 2. Inner video area (destination).
  const pad = appearance.padding;
  const dx = pad;
  const dy = pad;
  const dw = Math.max(0, outW - 2 * pad);
  const dh = Math.max(0, outH - 2 * pad);
  if (dw <= 0 || dh <= 0) return;

  // 3. Source sub-rectangle (zoom): sample 1/scale of the source, centered on
  //    (cx, cy), clamped inside [0, frameW] × [0, frameH].
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
