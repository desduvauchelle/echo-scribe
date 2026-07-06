import { describe, expect, test } from "bun:test";
import {
  zoomStateAt,
  webcamRect,
  cursorStateAt,
  cursorDrawScale,
  type CursorSample,
} from "../src/lib/render/compositor";
import type { ZoomBlock, EventsHeader } from "../src/lib/autoZoom";

const block: ZoomBlock = { startMs: 2000, endMs: 6000, cx: 0.3, cy: 0.7, scale: 2, mode: "auto" };

describe("zoomStateAt", () => {
  test("identity outside blocks", () => {
    expect(zoomStateAt(0, [block])).toEqual({ cx: 0.5, cy: 0.5, scale: 1 });
    expect(zoomStateAt(10000, [block])).toEqual({ cx: 0.5, cy: 0.5, scale: 1 });
  });
  test("full zoom mid-block", () => {
    expect(zoomStateAt(4000, [block])).toEqual({ cx: 0.3, cy: 0.7, scale: 2 });
  });
  test("halfway through transition is between states", () => {
    const s = zoomStateAt(2250, [block], 500);
    expect(s.scale).toBeGreaterThan(1);
    expect(s.scale).toBeLessThan(2);
  });
  test("transition is monotonic entering the block", () => {
    let prev = 1;
    for (let t = 2000; t <= 2500; t += 50) {
      const s = zoomStateAt(t, [block], 500);
      expect(s.scale).toBeGreaterThanOrEqual(prev);
      prev = s.scale;
    }
    expect(prev).toBeCloseTo(2);
  });
});

describe("webcamRect", () => {
  const OUT_W = 1920;
  const OUT_H = 1080;
  const MARGIN = 24;

  test("size math: width = sizeFrac * outW; circle is square", () => {
    const r = webcamRect(OUT_W, OUT_H, "br", 0.2, "circle");
    expect(r.w).toBeCloseTo(0.2 * OUT_W); // 384
    expect(r.h).toBeCloseTo(r.w); // square for circle
  });

  test("rounded uses 4:3 aspect (h = w * 3/4)", () => {
    const r = webcamRect(OUT_W, OUT_H, "br", 0.2, "rounded");
    expect(r.w).toBeCloseTo(0.2 * OUT_W); // 384
    expect(r.h).toBeCloseTo(r.w * 0.75); // 288
  });

  test("bottom-right corner honors 24px margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "br", 0.2, "circle");
    expect(r.x + r.w).toBeCloseTo(OUT_W - MARGIN);
    expect(r.y + r.h).toBeCloseTo(OUT_H - MARGIN);
  });

  test("bottom-left corner honors margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "bl", 0.2, "circle");
    expect(r.x).toBeCloseTo(MARGIN);
    expect(r.y + r.h).toBeCloseTo(OUT_H - MARGIN);
  });

  test("top-right corner honors margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "tr", 0.2, "circle");
    expect(r.x + r.w).toBeCloseTo(OUT_W - MARGIN);
    expect(r.y).toBeCloseTo(MARGIN);
  });

  test("top-left corner honors margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "tl", 0.2, "circle");
    expect(r.x).toBeCloseTo(MARGIN);
    expect(r.y).toBeCloseTo(MARGIN);
  });

  test("larger sizeFrac yields a larger rect", () => {
    const small = webcamRect(OUT_W, OUT_H, "br", 0.15, "circle");
    const big = webcamRect(OUT_W, OUT_H, "br", 0.35, "circle");
    expect(big.w).toBeGreaterThan(small.w);
    // both remain margin-anchored at the corner
    expect(big.x + big.w).toBeCloseTo(OUT_W - MARGIN);
    expect(small.x + small.w).toBeCloseTo(OUT_W - MARGIN);
  });
});

describe("cursorStateAt", () => {
  // A capture rect at global origin (100, 200), 800×600 points. Normalization
  // is (px - 100)/800, (py - 200)/600. So point (500, 500) → (0.5, 0.5).
  const header: EventsHeader = {
    k: "header",
    v: 1,
    capture: { kind: "display", rect: [100, 200, 800, 600], px_scale: 2 },
    screen_h: 900,
  };
  // Two move samples 1s apart: at t=1000 the cursor is at the rect center;
  // at t=2000 it's at the bottom-right quadrant point (700, 500) → (0.75, 0.5).
  const moves: CursorSample[] = [
    { t: 1000, x: 500, y: 500 }, // → (0.5, 0.5)
    { t: 2000, x: 700, y: 500 }, // → (0.75, 0.5)
  ];

  test("exact sample hit returns that sample normalized", () => {
    const s = cursorStateAt(1000, moves, [], header);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.5);
    expect(s!.y).toBeCloseTo(0.5);
    expect(s!.clickAge).toBeNull();
  });

  test("midpoint lerps between the two surrounding samples", () => {
    // Halfway (t=1500) between (0.5,0.5) and (0.75,0.5) → (0.625, 0.5).
    const s = cursorStateAt(1500, moves, [], header);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.625);
    expect(s!.y).toBeCloseTo(0.5);
  });

  test("before first sample holds the first when within 2000ms", () => {
    const s = cursorStateAt(500, moves, [], header); // 500ms before first
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.5);
    expect(s!.y).toBeCloseTo(0.5);
  });

  test("after last sample holds the last when within 2000ms", () => {
    const s = cursorStateAt(3500, moves, [], header); // 1500ms after last
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.75);
    expect(s!.y).toBeCloseTo(0.5);
  });

  test("before first beyond 2000ms → null (cursor hidden)", () => {
    // First sample is at t=1000; query well before it with no sample within 2s.
    expect(cursorStateAt(-1500, moves, [], header)).toBeNull();
  });

  test("after last beyond 2000ms → null", () => {
    expect(cursorStateAt(4500, moves, [], header)).toBeNull(); // 2500ms after last
  });

  test("gap between surrounding samples > 2000ms → null", () => {
    // Two samples 3s apart: any query landing between them straddles a
    // >2000ms gap, so the cursor is hidden regardless of nearness to a side.
    const sparse: CursorSample[] = [
      { t: 0, x: 500, y: 500 },
      { t: 3000, x: 700, y: 500 },
    ];
    expect(cursorStateAt(1000, sparse, [], header)).toBeNull(); // in a 3s gap
    expect(cursorStateAt(1500, sparse, [], header)).toBeNull();
    // Exact hits on the bracketing samples still resolve (no interpolation gap).
    expect(cursorStateAt(0, sparse, [], header)).not.toBeNull();
    expect(cursorStateAt(3000, sparse, [], header)).not.toBeNull();
  });

  test("interpolation across a gap ≤ 2000ms resolves", () => {
    // A 2000ms gap is exactly at the limit (not > 2000ms), so it interpolates.
    const ok: CursorSample[] = [
      { t: 0, x: 500, y: 500 },
      { t: 2000, x: 700, y: 500 },
    ];
    const s = cursorStateAt(1000, ok, [], header);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.625); // midpoint of 0.5..0.75
  });

  test("empty moves → null", () => {
    expect(cursorStateAt(1000, [], [], header)).toBeNull();
  });

  test("clickAge is set when a down is within the ripple window", () => {
    const downs: CursorSample[] = [{ t: 1200, x: 500, y: 500 }];
    const s = cursorStateAt(1500, moves, downs, header); // 300ms after the down
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeCloseTo(300);
  });

  test("clickAge is null when the most recent down is older than 400ms", () => {
    const downs: CursorSample[] = [{ t: 1000, x: 500, y: 500 }];
    const s = cursorStateAt(1500, moves, downs, header); // 500ms after → outside window
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeNull();
  });

  test("clickAge ignores downs that occur after tMs", () => {
    const downs: CursorSample[] = [{ t: 1800, x: 700, y: 500 }]; // after t=1500
    const s = cursorStateAt(1500, moves, downs, header);
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeNull();
  });

  test("clickAge uses the most recent down at or before tMs", () => {
    const downs: CursorSample[] = [
      { t: 900, x: 500, y: 500 },
      { t: 1450, x: 600, y: 500 }, // most recent ≤ 1500
      { t: 1900, x: 700, y: 500 }, // after tMs, ignored
    ];
    const s = cursorStateAt(1500, moves, downs, header); // 50ms after t=1450
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeCloseTo(50);
  });

  test("clickAge exactly at the down (age 0) is inside the window", () => {
    const downs: CursorSample[] = [{ t: 1500, x: 500, y: 500 }];
    const s = cursorStateAt(1500, moves, downs, header);
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeCloseTo(0);
  });
});

describe("cursorDrawScale", () => {
  test("scales linearly with user scale and px_scale", () => {
    const base = cursorDrawScale(1, 1);
    expect(cursorDrawScale(2, 1)).toBeCloseTo(base * 2);
    expect(cursorDrawScale(1, 2)).toBeCloseTo(base * 2); // Retina capture
    expect(cursorDrawScale(3, 2)).toBeCloseTo(base * 6);
  });

  test("invalid inputs fall back to 1", () => {
    const base = cursorDrawScale(1, 1);
    expect(cursorDrawScale(0, 1)).toBeCloseTo(base);
    expect(cursorDrawScale(NaN, 1)).toBeCloseTo(base);
    expect(cursorDrawScale(1, 0)).toBeCloseTo(base);
    expect(cursorDrawScale(1, NaN)).toBeCloseTo(base);
  });
});
