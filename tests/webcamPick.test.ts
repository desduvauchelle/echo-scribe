import { describe, expect, test } from "bun:test";
import { pickWebcamFrameIndex } from "../src/lib/render/renderPipeline";

// Convention under test (settled by review derivation):
//   webcamTime = mainTime + offset_ms
// pickWebcamFrameIndex takes MAIN source µs, an offset in ms, and a webcam
// timestamp buffer in µs (ascending), and returns the index of the latest
// webcam frame with ts <= mainUs + offsetMs*1000 (zero-order hold), or -1 when
// all buffered webcam frames are still in the future.

describe("pickWebcamFrameIndex", () => {
  // Webcam frames at 0, 100ms, 200ms, 300ms (in µs).
  const buf = [0, 100_000, 200_000, 300_000];

  test("empty buffer → -1", () => {
    expect(pickWebcamFrameIndex(0, 0, [])).toBe(-1);
  });

  test("zero offset: picks the latest webcam frame at or before main time", () => {
    expect(pickWebcamFrameIndex(0, 0, buf)).toBe(0); // exactly at frame 0
    expect(pickWebcamFrameIndex(50_000, 0, buf)).toBe(0); // 50ms → hold frame 0
    expect(pickWebcamFrameIndex(100_000, 0, buf)).toBe(1); // exactly frame 1
    expect(pickWebcamFrameIndex(250_000, 0, buf)).toBe(2); // 250ms → hold frame 2
    expect(pickWebcamFrameIndex(999_000, 0, buf)).toBe(3); // past the end → last frame
  });

  test("positive offset shifts the webcam timeline forward (webcamTime = mainTime + offset)", () => {
    // offset = +100ms: at main t=0 we need webcam time 100ms → frame 1.
    expect(pickWebcamFrameIndex(0, 100, buf)).toBe(1);
    // at main t=100ms we need webcam time 200ms → frame 2.
    expect(pickWebcamFrameIndex(100_000, 100, buf)).toBe(2);
  });

  test("negative-shifting main time (offset makes needed webcam time < 0) → -1", () => {
    // A large negative offset pushes the needed webcam time before frame 0.
    // (offset_ms is normally positive; this guards the defensive path.)
    expect(pickWebcamFrameIndex(0, -50, buf)).toBe(-1); // need = -50ms < 0
  });

  test("main time before the webcam's first frame → -1 (nothing to draw yet)", () => {
    // Webcam starts at 500ms; a main frame at 200ms with zero offset has no
    // co-occurring webcam frame yet.
    const late = [500_000, 600_000];
    expect(pickWebcamFrameIndex(200_000, 0, late)).toBe(-1);
    expect(pickWebcamFrameIndex(500_000, 0, late)).toBe(0);
  });

  test("stream ended early: every later main frame holds the final index", () => {
    // Webcam stops at 300ms; main runs to 10s → keeps returning the last index.
    expect(pickWebcamFrameIndex(5_000_000, 0, buf)).toBe(3);
    expect(pickWebcamFrameIndex(10_000_000, 0, buf)).toBe(3);
  });
});
