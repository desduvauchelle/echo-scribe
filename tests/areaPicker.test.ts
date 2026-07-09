import { describe, expect, test } from "bun:test";
import {
  dragToLocalRect,
  isDragRectSignificant,
  localRectToGlobal,
  MIN_DRAG_SIZE,
} from "../src/lib/areaPicker";

describe("dragToLocalRect", () => {
  test("normalizes a drag going down-right", () => {
    expect(dragToLocalRect({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 200,
    });
  });

  test("normalizes a drag going up-left (reversed order)", () => {
    expect(dragToLocalRect({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 200,
    });
  });

  test("normalizes a drag going up-right", () => {
    expect(dragToLocalRect({ x: 10, y: 220 }, { x: 110, y: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 200,
    });
  });

  test("zero-size drag (click without moving) yields a 0x0 rect at the click point", () => {
    expect(dragToLocalRect({ x: 50, y: 50 }, { x: 50, y: 50 })).toEqual({
      x: 50,
      y: 50,
      w: 0,
      h: 0,
    });
  });
});

describe("isDragRectSignificant", () => {
  test("rejects a rect smaller than MIN_DRAG_SIZE in either dimension", () => {
    expect(isDragRectSignificant({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
    expect(isDragRectSignificant({ x: 0, y: 0, w: MIN_DRAG_SIZE - 1, h: 100 })).toBe(false);
    expect(isDragRectSignificant({ x: 0, y: 0, w: 100, h: MIN_DRAG_SIZE - 1 })).toBe(false);
  });

  test("accepts a rect at or above MIN_DRAG_SIZE in both dimensions", () => {
    expect(isDragRectSignificant({ x: 0, y: 0, w: MIN_DRAG_SIZE, h: MIN_DRAG_SIZE })).toBe(true);
    expect(isDragRectSignificant({ x: 0, y: 0, w: 1200, h: 800 })).toBe(true);
  });
});

describe("localRectToGlobal", () => {
  test("adds the display's global origin to a fully-interior local rect", () => {
    const local = { x: 100, y: 150, w: 1200, h: 800 };
    const origin = { x: 1920, y: 0 }; // e.g. a secondary display to the right of the primary
    const size = { width: 2560, height: 1440 };
    expect(localRectToGlobal(local, origin, size)).toEqual([2020, 150, 1200, 800]);
  });

  test("origin (0,0) is a pure passthrough (primary display)", () => {
    const local = { x: 0, y: 0, w: 500, h: 400 };
    const origin = { x: 0, y: 0 };
    const size = { width: 1920, height: 1080 };
    expect(localRectToGlobal(local, origin, size)).toEqual([0, 0, 500, 400]);
  });

  test("clamps a rect that overhangs the display's right/bottom edge", () => {
    const local = { x: 1800, y: 1000, w: 300, h: 300 };
    const origin = { x: 0, y: 0 };
    const size = { width: 1920, height: 1080 };
    // Right edge clamps from 2100 -> 1920 (w: 120); bottom clamps from 1300 -> 1080 (h: 80).
    expect(localRectToGlobal(local, origin, size)).toEqual([1800, 1000, 120, 80]);
  });

  test("clamps a rect with a negative local origin (drag reported slightly off-window)", () => {
    const local = { x: -20, y: -10, w: 100, h: 100 };
    const origin = { x: 500, y: 0 };
    const size = { width: 1920, height: 1080 };
    // x0 clamps 0 (was -20), so the far edge (80) determines width = 80; same for y (h=90).
    expect(localRectToGlobal(local, origin, size)).toEqual([500, 0, 80, 90]);
  });

  test("a rect entirely outside the display's right edge collapses width to zero", () => {
    const local = { x: 2000, y: 0, w: 100, h: 100 };
    const origin = { x: 0, y: 0 };
    const size = { width: 1920, height: 1080 };
    // x is fully out of bounds (both edges clamp to 1920) -> w=0; y is in
    // bounds (0..100) so h passes through unclamped.
    expect(localRectToGlobal(local, origin, size)).toEqual([1920, 0, 0, 100]);
  });

  test("multi-display: a secondary display above-left of the primary uses negative origin", () => {
    const local = { x: 200, y: 100, w: 400, h: 300 };
    const origin = { x: -1920, y: -200 }; // display placed left of and above the primary
    const size = { width: 1920, height: 1080 };
    expect(localRectToGlobal(local, origin, size)).toEqual([-1720, -100, 400, 300]);
  });
});
