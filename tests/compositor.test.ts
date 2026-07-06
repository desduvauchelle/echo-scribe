import { describe, expect, test } from "bun:test";
import { zoomStateAt, webcamRect } from "../src/lib/render/compositor";
import type { ZoomBlock } from "../src/lib/autoZoom";

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
