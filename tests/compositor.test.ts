import { describe, expect, test } from "bun:test";
import {
  zoomStateAt,
  webcamRect,
  cursorStateAt,
  cursorDrawScale,
  coverCrop,
  imgWidth,
  imgHeight,
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

describe("coverCrop", () => {
  test("wide source into a square dst crops the sides, keeps full height", () => {
    // 1280×720 (16:9) into a 1:1 mask → sample a centered 720×720 square.
    const c = coverCrop(1280, 720, 200, 200);
    expect(c.sh).toBeCloseTo(720); // full height sampled
    expect(c.sw).toBeCloseTo(720); // square crop
    expect(c.sx).toBeCloseTo((1280 - 720) / 2); // centered horizontally
    expect(c.sy).toBeCloseTo(0);
  });

  test("wide source into a 4:3 dst crops the sides", () => {
    // 1280×720 (16:9) into 4:3 → sample full height, width = 720 * 4/3 = 960.
    const c = coverCrop(1280, 720, 400, 300);
    expect(c.sh).toBeCloseTo(720);
    expect(c.sw).toBeCloseTo(960);
    expect(c.sx).toBeCloseTo((1280 - 960) / 2); // 160
    expect(c.sy).toBeCloseTo(0);
  });

  test("tall source into a square dst crops top/bottom, keeps full width", () => {
    // 480×640 (3:4 portrait) into 1:1 → sample a centered 480×480 square.
    const c = coverCrop(480, 640, 200, 200);
    expect(c.sw).toBeCloseTo(480); // full width sampled
    expect(c.sh).toBeCloseTo(480); // square crop
    expect(c.sx).toBeCloseTo(0);
    expect(c.sy).toBeCloseTo((640 - 480) / 2); // centered vertically
  });

  test("matching aspect samples the whole source (no crop)", () => {
    const c = coverCrop(640, 480, 400, 300); // both 4:3
    expect(c.sx).toBeCloseTo(0);
    expect(c.sy).toBeCloseTo(0);
    expect(c.sw).toBeCloseTo(640);
    expect(c.sh).toBeCloseTo(480);
  });

  test("the crop rect stays within the source bounds", () => {
    for (const [sw, sh] of [[1920, 1080], [720, 1280], [1000, 1000]] as const) {
      for (const [dw, dh] of [[200, 200], [400, 300], [100, 400]] as const) {
        const c = coverCrop(sw, sh, dw, dh);
        expect(c.sx).toBeGreaterThanOrEqual(-1e-6);
        expect(c.sy).toBeGreaterThanOrEqual(-1e-6);
        expect(c.sx + c.sw).toBeLessThanOrEqual(sw + 1e-6);
        expect(c.sy + c.sh).toBeLessThanOrEqual(sh + 1e-6);
        // Cropped rect must carry the destination's aspect ratio.
        expect(c.sw / c.sh).toBeCloseTo(dw / dh);
      }
    }
  });

  test("degenerate dimensions fall back to the full source rect", () => {
    expect(coverCrop(0, 100, 10, 10)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 100 });
    expect(coverCrop(100, 100, 0, 10)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 });
  });
});

describe("imgWidth / imgHeight", () => {
  // Regression for M2 Task 8 finding 1: WebCodecs `VideoFrame` (what the
  // export path's WebcamSource feeds into the webcam-draw code) exposes
  // `displayWidth`/`displayHeight` (and `codedWidth`/`codedHeight`), NOT
  // `videoWidth`/`width` like an HTMLVideoElement or HTMLImageElement. If
  // imgWidth/imgHeight don't check those fields, they return 0 for a
  // VideoFrame, and the webcam PiP silently falls back to a stretched draw
  // instead of the intended cover-crop.

  test("HTMLVideoElement shape (videoWidth/videoHeight) is read", () => {
    const shim = { videoWidth: 1280, videoHeight: 720 } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(1280);
    expect(imgHeight(shim)).toBe(720);
  });

  test("VideoFrame shape (displayWidth/displayHeight only) is read — the export path", () => {
    // A minimal shim mirroring exactly what a decoded WebCodecs VideoFrame
    // exposes for sizing: no videoWidth/width, only display*/coded*.
    const shim = {
      displayWidth: 1920,
      displayHeight: 1080,
      codedWidth: 1920,
      codedHeight: 1080,
    } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(1920);
    expect(imgHeight(shim)).toBe(1080);
  });

  test("VideoFrame shape falls back to codedWidth/codedHeight when display* is absent", () => {
    const shim = { codedWidth: 640, codedHeight: 480 } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(640);
    expect(imgHeight(shim)).toBe(480);
  });

  test("HTMLImageElement/ImageBitmap shape (width/height) is read", () => {
    const shim = { width: 300, height: 150 } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(300);
    expect(imgHeight(shim)).toBe(150);
  });

  test("unknown shape returns 0 for both", () => {
    const shim = {} as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(0);
    expect(imgHeight(shim)).toBe(0);
  });

  test("behavioral: a VideoFrame-shaped webcam source drives coverCrop (aspect-fill), not a stretch fallback", () => {
    // This mirrors the real decision in drawCompositeV2: `iw > 0 && ih > 0`
    // picks coverCrop; otherwise it falls back to a plain stretch. Before the
    // fix, a VideoFrame-shaped source (display*/coded* only, no
    // videoWidth/width) measured 0×0 here and would have taken the stretch
    // branch — this asserts it now takes the crop branch, with correct math.
    const webcamFrame = {
      displayWidth: 1280,
      displayHeight: 720,
      codedWidth: 1280,
      codedHeight: 720,
    } as unknown as CanvasImageSource;

    const iw = imgWidth(webcamFrame);
    const ih = imgHeight(webcamFrame);
    expect(iw).toBeGreaterThan(0);
    expect(ih).toBeGreaterThan(0);

    // Destination is a circular PiP rect (square, e.g. 200x200) — same as the
    // "circle" shape branch in drawCompositeV2.
    const dstW = 200;
    const dstH = 200;
    const usesCoverCrop = iw > 0 && ih > 0;
    expect(usesCoverCrop).toBe(true);

    const c = coverCrop(iw, ih, dstW, dstH);
    // 16:9 source into a 1:1 dest crops the sides, keeping full height, and
    // the sampled rect must carry the destination's aspect ratio (i.e. NOT a
    // stretch of the full untouched 1280x720 source into 200x200).
    expect(c.sh).toBeCloseTo(720);
    expect(c.sw).toBeCloseTo(720);
    expect(c.sw / c.sh).toBeCloseTo(dstW / dstH);
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
