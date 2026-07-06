import { describe, expect, test } from "bun:test";
import { frameInTrimWindow, type TrimWindow } from "../src/lib/render/renderPipeline";

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
