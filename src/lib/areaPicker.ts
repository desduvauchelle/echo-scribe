/**
 * Pure geometry helpers for the area-picker overlay (drag-to-select a screen
 * region). Kept separate from the React page so the coordinate math is
 * testable without a DOM/Tauri runtime.
 *
 * Coordinate-space contract (must match the Rust side —
 * `src-tauri/src/overlay.rs`'s "Area picker" section and
 * `src-tauri/src/screenrec::display_bounds`):
 *
 *  - The picker webview is sized/positioned by Rust to exactly cover the
 *    target display's frame, in GLOBAL POINTS (CGDisplayBounds space:
 *    top-left origin at the PRIMARY display's top-left corner, +y down).
 *  - Because macOS bakes the display scale factor into the physical/logical
 *    pixel split, CSS px inside that webview are 1:1 with those same global
 *    points — so a mouse position captured via `clientX`/`clientY` is
 *    ALREADY in the display's local point space (i.e. relative to the
 *    display's own top-left corner, not the primary's).
 *  - `localRectToGlobal` adds the display's global origin (`origin_x`,
 *    `origin_y` from the `area-picker-start` event payload) to convert that
 *    local rect into the GLOBAL points rect the sidecar's `--rect` /
 *    `start_screen_recording`'s `rect` param expects.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest allowed drag size (CSS px / points) before a rect is treated as a
 *  no-op click-without-drag rather than a real selection. */
export const MIN_DRAG_SIZE = 4;

/**
 * Normalize two arbitrary drag points (start, current — either order, any
 * quadrant) into a non-negative local rect `{x, y, w, h}` relative to the
 * picker's own top-left corner (0,0).
 */
export function dragToLocalRect(start: Point, current: Point): Rect {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  const w = Math.abs(current.x - start.x);
  const h = Math.abs(current.y - start.y);
  return { x, y, w, h };
}

/** True when a local drag rect is large enough to count as a real selection
 *  (guards against an accidental click/tiny jitter producing a 0×0 or
 *  near-0×0 recording rect). */
export function isDragRectSignificant(rect: Rect): boolean {
  return rect.w >= MIN_DRAG_SIZE && rect.h >= MIN_DRAG_SIZE;
}

/**
 * Convert a local (picker-relative) rect into the GLOBAL points rect the
 * sidecar expects, by adding the display's global origin. Also clamps the
 * local rect to the display's own bounds (`[0,0,width,height]`) first — the
 * picker window is exactly display-sized, but a fast drag can still report
 * transient coordinates a few px outside the webview during a mouseup that
 * lands after the cursor crossed the edge.
 */
export function localRectToGlobal(
  local: Rect,
  origin: Point,
  displaySize: { width: number; height: number },
): [number, number, number, number] {
  const x0 = clamp(local.x, 0, displaySize.width);
  const y0 = clamp(local.y, 0, displaySize.height);
  const x1 = clamp(local.x + local.w, 0, displaySize.width);
  const y1 = clamp(local.y + local.h, 0, displaySize.height);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  return [origin.x + x0, origin.y + y0, w, h];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
