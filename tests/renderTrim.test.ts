import { describe, expect, test } from "bun:test";
import {
  frameInTrimWindow,
  speedGridIndex,
  type TrimWindow,
} from "../src/lib/render/renderPipeline";
import { buildSpeedMap } from "../src/lib/editorProject";

describe("frameInTrimWindow", () => {
  const full: TrimWindow = { startMs: 0, endMs: 10_000 };

  test("keeps every frame for a full-length window", () => {
    expect(frameInTrimWindow(0, full)).toBe(true);
    expect(frameInTrimWindow(5_000_000, full)).toBe(true); // 5000 ms
    // The frame exactly at endMs is excluded (half-open).
    expect(frameInTrimWindow(10_000_000, full)).toBe(false);
    // Just before the end is kept.
    expect(frameInTrimWindow(9_999_000, full)).toBe(true);
  });

  test("drops frames before the trim start and includes the start", () => {
    const trim: TrimWindow = { startMs: 2000, endMs: 8000 };
    expect(frameInTrimWindow(1_000_000, trim)).toBe(false); // 1000 ms < start
    expect(frameInTrimWindow(1_999_000, trim)).toBe(false); // just before start
    expect(frameInTrimWindow(2_000_000, trim)).toBe(true); // exactly at start
    expect(frameInTrimWindow(2_000_001, trim)).toBe(true);
  });

  test("drops frames at/after the trim end (half-open)", () => {
    const trim: TrimWindow = { startMs: 2000, endMs: 8000 };
    expect(frameInTrimWindow(7_999_000, trim)).toBe(true); // just before end
    expect(frameInTrimWindow(8_000_000, trim)).toBe(false); // exactly at end
    expect(frameInTrimWindow(9_000_000, trim)).toBe(false); // after end
  });

  test("leading-edge epsilon keeps a frame a hair before start", () => {
    const trim: TrimWindow = { startMs: 2000, endMs: 8000 };
    // 1 µs before start is within the epsilon tolerance → kept.
    expect(frameInTrimWindow(2_000_000 - 1, trim)).toBe(true);
    // 2 µs before start is outside tolerance → dropped.
    expect(frameInTrimWindow(2_000_000 - 2, trim)).toBe(false);
  });
});

describe("speedGridIndex", () => {
  test("maps output ms to the nearest 1/fps grid slot", () => {
    // At 30fps a grid slot is 33.33ms. 0ms → 0; 33ms → 1; 66ms → 2.
    expect(speedGridIndex(0, 30)).toBe(0);
    expect(speedGridIndex(1000 / 30, 30)).toBe(1);
    expect(speedGridIndex(2000 / 30, 30)).toBe(2);
    // Rounds to nearest.
    expect(speedGridIndex(1000 / 30 - 1, 30)).toBe(1);
    expect(speedGridIndex(15, 30)).toBe(0); // 15ms rounds to slot 0 (16.67 is midpoint)
    expect(speedGridIndex(20, 30)).toBe(1); // 20ms rounds up to slot 1
  });

  test("advances one grid slot per source frame at identity speed", () => {
    // With an identity speed map, consecutive 30fps source frames land on
    // consecutive grid slots — none are dropped by the keep-if-advances rule.
    const map = buildSpeedMap([], 10_000);
    let last = -1;
    let kept = 0;
    for (let i = 0; i < 30; i++) {
      const srcMs = (i * 1000) / 30;
      const gi = speedGridIndex(map.srcToOut(srcMs), 30);
      if (gi > last) {
        kept++;
        last = gi;
      }
    }
    expect(kept).toBe(30); // every frame advances a slot
  });

  test("a 2x region collapses ~half its source frames onto shared grid slots", () => {
    // A 2× region halves output time, so two source frames map to ~one output
    // grid slot → roughly half are dropped by the keep-if-advances rule.
    const map = buildSpeedMap([{ startMs: 0, endMs: 2_000, rate: 2 }], 2_000);
    let last = -1;
    let kept = 0;
    const total = 60; // 2s of 30fps source
    for (let i = 0; i < total; i++) {
      const srcMs = (i * 1000) / 30;
      const gi = speedGridIndex(map.srcToOut(srcMs), 30);
      if (gi > last) {
        kept++;
        last = gi;
      }
    }
    // 2s @2× → 1s of output → ~30 frames kept, not 60.
    expect(kept).toBeGreaterThanOrEqual(29);
    expect(kept).toBeLessThanOrEqual(31);
  });

  test("a 0.5x region leaves gaps but keeps every source frame", () => {
    // A 0.5× region doubles output time, so every source frame advances the
    // grid index by ~2 → all are kept, with empty slots between them.
    const map = buildSpeedMap([{ startMs: 0, endMs: 2_000, rate: 0.5 }], 2_000);
    let last = -1;
    let kept = 0;
    const total = 60;
    for (let i = 0; i < total; i++) {
      const srcMs = (i * 1000) / 30;
      const gi = speedGridIndex(map.srcToOut(srcMs), 30);
      if (gi > last) {
        kept++;
        last = gi;
      }
    }
    expect(kept).toBe(60); // none dropped
  });
});
