import { describe, expect, test } from "bun:test";
import {
  gifFrameDelayCs,
  gifOutputSize,
  speedGridIndex,
  TARGET_GIF_FPS,
} from "../src/lib/render/renderPipeline";
import { buildSpeedMap } from "../src/lib/editorProject";

describe("TARGET_GIF_FPS", () => {
  test("is 15 (mirrors speed's CFR quantization at a lower fps)", () => {
    expect(TARGET_GIF_FPS).toBe(15);
  });
});

describe("gifOutputSize (width cap 960 + even rounding)", () => {
  test("passes through a size already at/under the cap, rounding to even", () => {
    // 640x360 is under the cap; both dims already even → unchanged.
    expect(gifOutputSize(640, 360)).toEqual({ w: 640, h: 360 });
  });

  test("rounds odd source dims to even without scaling when under the cap", () => {
    // 641x361 under the cap → no scale, but each dim rounded to nearest even:
    // round(641/2)*2 = round(320.5)*2 = 642; round(361/2)*2 = round(180.5)*2 = 362.
    expect(gifOutputSize(641, 361)).toEqual({ w: 642, h: 362 });
    // 639x359 rounds the other way: round(319.5)*2=640, round(179.5)*2=360.
    expect(gifOutputSize(639, 359)).toEqual({ w: 640, h: 360 });
  });

  test("caps width at 960 and scales height proportionally (even)", () => {
    // 1920x1080 → scale 0.5 → 960x540, both even.
    expect(gifOutputSize(1920, 1080)).toEqual({ w: 960, h: 540 });
  });

  test("keeps aspect while forcing even height after the proportional scale", () => {
    // 1000x563 → scale 960/1000=0.96 → 960 x 540.48 → round 540 (even).
    expect(gifOutputSize(1000, 563)).toEqual({ w: 960, h: 540 });
  });

  test("a scaled height that rounds to an odd number is nudged to even", () => {
    // 1930x1090: scale = 960/1930 → h = 1090*960/1930 = 542.17 → round 542 (even).
    const { w, h } = gifOutputSize(1930, 1090);
    expect(w).toBe(960);
    expect(h % 2).toBe(0);
    expect(h).toBe(542);
  });

  test("never returns a zero dimension for tiny inputs", () => {
    // 1x1 → stays 2 minimum (even, non-zero) so the encoder has a valid frame.
    const { w, h } = gifOutputSize(1, 1);
    expect(w).toBeGreaterThanOrEqual(2);
    expect(h).toBeGreaterThanOrEqual(2);
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
  });

  test("respects a custom cap argument", () => {
    expect(gifOutputSize(1920, 1080, 480)).toEqual({ w: 480, h: 270 });
  });
});

describe("gifFrameDelayCs (centisecond delay per grid slot)", () => {
  test("cycles 7,7,6 centiseconds so 3 frames span exactly 20cs", () => {
    expect(gifFrameDelayCs(0)).toBe(7);
    expect(gifFrameDelayCs(1)).toBe(7);
    expect(gifFrameDelayCs(2)).toBe(6);
    expect(gifFrameDelayCs(3)).toBe(7);
    expect(gifFrameDelayCs(4)).toBe(7);
    expect(gifFrameDelayCs(5)).toBe(6);
  });

  test("the 7,7,6 cycle averages exactly 15 fps over whole cycles", () => {
    let totalCs = 0;
    const frames = 45; // 15 whole cycles
    for (let i = 0; i < frames; i++) totalCs += gifFrameDelayCs(i);
    // 45 frames at exactly 15fps span 3.0 seconds = 300 centiseconds.
    expect(totalCs).toBe(300);
    // Effective fps = frames / seconds = 45 / (300/100) = 15.0 exactly.
    expect(frames / (totalCs / 100)).toBeCloseTo(15, 10);
  });

  test("only ever emits integer centiseconds (GIF granularity)", () => {
    for (let i = 0; i < 30; i++) {
      const cs = gifFrameDelayCs(i);
      expect(Number.isInteger(cs)).toBe(true);
      expect(cs === 6 || cs === 7).toBe(true);
    }
  });
});

describe("speedGridIndex at 15fps (GIF frame-drop from a 30fps source)", () => {
  test("drops ~half the frames of a 30fps source onto the 15fps grid", () => {
    // A 30fps source (identity speed) mapped onto the 15fps grid keeps every
    // other frame: two consecutive source frames (33.3ms apart) land on the
    // same 66.7ms grid slot → the second is dropped by the keep-if-advances rule.
    const map = buildSpeedMap([], 2_000);
    let last = -1;
    let kept = 0;
    const total = 60; // 2s of 30fps source
    for (let i = 0; i < total; i++) {
      const srcMs = (i * 1000) / 30;
      const gi = speedGridIndex(map.srcToOut(srcMs), TARGET_GIF_FPS);
      if (gi > last) {
        kept++;
        last = gi;
      }
    }
    // 2s at 15fps → ~30 frames kept, not 60.
    expect(kept).toBeGreaterThanOrEqual(29);
    expect(kept).toBeLessThanOrEqual(31);
  });

  test("keeps every frame of a 15fps-cadence source (nothing to drop)", () => {
    // A source already at 15fps advances one grid slot per frame → all kept.
    const map = buildSpeedMap([], 2_000);
    let last = -1;
    let kept = 0;
    const total = 30; // 2s of 15fps source
    for (let i = 0; i < total; i++) {
      const srcMs = (i * 1000) / 15;
      const gi = speedGridIndex(map.srcToOut(srcMs), TARGET_GIF_FPS);
      if (gi > last) {
        kept++;
        last = gi;
      }
    }
    expect(kept).toBe(30);
  });

  test("a 2x region on the 15fps grid drops to ~15 frames over 2s", () => {
    // Speed quantization mirrors the MP4 path — it just uses a 15fps grid.
    const map = buildSpeedMap([{ startMs: 0, endMs: 2_000, rate: 2 }], 2_000);
    let last = -1;
    let kept = 0;
    const total = 60; // 2s of 30fps source
    for (let i = 0; i < total; i++) {
      const srcMs = (i * 1000) / 30;
      const gi = speedGridIndex(map.srcToOut(srcMs), TARGET_GIF_FPS);
      if (gi > last) {
        kept++;
        last = gi;
      }
    }
    // 2s @2× → 1s of output → ~15 frames on the 15fps grid.
    expect(kept).toBeGreaterThanOrEqual(14);
    expect(kept).toBeLessThanOrEqual(16);
  });
});
