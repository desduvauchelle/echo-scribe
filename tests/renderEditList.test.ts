import { describe, expect, test } from "bun:test";
import { buildEditSegments, mediaToMovieUs } from "../src/lib/render/renderPipeline";

// Regression seam for the trim A/V desync bug (2026-07-23): the demuxer fed
// raw MEDIA-timeline sample timestamps (s.cts) into the render pipeline while
// the trim window (chosen on an HTMLVideoElement) and the Rust audio trim both
// work in MOVIE time — the timeline with the track's edit list applied. Screen
// captures carry a warm-up edit (elst media_time > 0), so every exported frame
// sat ~80ms late vs the trimmed audio: audio led the lips by the edit offset.
//
// `videoEditOffsetUs` is the pure mapping the demuxer now subtracts from every
// sample cts. Fixture values below are the REAL box values from the recording
// that reproduced the bug (rec-1784757681470.cleaned.mp4, probed via mp4box):
//   video trak: elst media_time=49, mdhd timescale=600, movie timescale=600
//   audio trak: elst media_time=2112 (AAC priming), mdhd timescale=48000

/** mp4box-shaped trak literal. */
function trak(entries: { segment_duration: number; media_time: number }[] | null, mediaTimescale?: number) {
  return {
    ...(entries ? { edts: { elst: { entries } } } : {}),
    ...(mediaTimescale ? { mdia: { mdhd: { timescale: mediaTimescale } } } : {}),
  };
}

// Real box values from the recording that reproduced the bugs:
//   main video trak: elst media_time=49 @600 (81.7ms warm-up), movie ts 600
//   webcam trak (TWO segments — a mid-capture session interruption):
//     entry 1: segment_duration=3989,    media_time=5970   (@30000)
//     entry 2: segment_duration=9634430, media_time=12962  (@30000)
const MAIN = trak([{ segment_duration: 197239, media_time: 49 }], 600);
const WEBCAM = trak(
  [
    { segment_duration: 3989, media_time: 5970 },
    { segment_duration: 9634430, media_time: 12962 },
  ],
  30000,
);
const SEG1_START_US = (5970 * 1_000_000) / 30000; // 199000
const SEG1_LEN_US = (3989 * 1_000_000) / 30000; // 132966.67
const SEG2_START_US = (12962 * 1_000_000) / 30000; // 432066.67

describe("buildEditSegments", () => {
  test("no edit list / empty entries / invalid timescale -> [] (identity)", () => {
    expect(buildEditSegments(trak(null, 600), 600)).toEqual([]);
    expect(buildEditSegments(trak([], 600), 600)).toEqual([]);
    expect(buildEditSegments(trak([{ segment_duration: 1, media_time: 49 }]), 600)).toEqual([]);
    expect(buildEditSegments(trak([{ segment_duration: 1, media_time: 49 }], 0), 600)).toEqual([]);
  });

  test("single warm-up edit -> one segment starting at movie 0", () => {
    const segs = buildEditSegments(MAIN, 600);
    expect(segs.length).toBe(1);
    expect(segs[0].movieStartUs).toBe(0);
    expect(segs[0].mediaStartUs).toBeCloseTo((49 * 1_000_000) / 600, 3);
  });

  test("two-segment list -> contiguous movie timeline with a media gap", () => {
    const segs = buildEditSegments(WEBCAM, 30000);
    expect(segs.length).toBe(2);
    expect(segs[0].movieStartUs).toBe(0);
    expect(segs[0].mediaStartUs).toBeCloseTo(SEG1_START_US, 3);
    // Segment 2 starts on the movie timeline exactly where segment 1 ended —
    // the 100ms media gap between them is collapsed.
    expect(segs[1].movieStartUs).toBeCloseTo(SEG1_LEN_US, 3);
    expect(segs[1].mediaStartUs).toBeCloseTo(SEG2_START_US, 3);
  });

  test("leading empty edit (media_time -1) delays the movie start", () => {
    const segs = buildEditSegments(
      trak(
        [
          { segment_duration: 300, media_time: -1 },
          { segment_duration: 197239, media_time: 0 },
        ],
        600,
      ),
      600,
    );
    expect(segs.length).toBe(1);
    expect(segs[0].movieStartUs).toBeCloseTo(500_000, 3); // 300 @600 movie units
    expect(segs[0].mediaStartUs).toBe(0);
  });
});

describe("mediaToMovieUs", () => {
  test("no segments -> identity", () => {
    expect(mediaToMovieUs([], 123456)).toBe(123456);
  });

  test("single segment: uniform shift (media - 81666.67µs), matching the main-video fix", () => {
    const segs = buildEditSegments(MAIN, 600);
    const offset = (49 * 1_000_000) / 600;
    // First real frame (cts 49 @600) lands at movie 0.
    expect(mediaToMovieUs(segs, offset)).toBeCloseTo(0, 3);
    // A frame 10s in keeps the same uniform shift.
    expect(mediaToMovieUs(segs, 10_000_000)).toBeCloseTo(10_000_000 - offset, 3);
    // Warm-up frames before the edit extrapolate to negative movie time
    // (dropped post-decode by frameInTrimWindow).
    expect(mediaToMovieUs(segs, 0)).toBeCloseTo(-offset, 3);
  });

  test("two segments: piecewise mapping matches AVFoundation playback", () => {
    const segs = buildEditSegments(WEBCAM, 30000);
    // First presented frame (media 199ms) -> movie 0.
    expect(mediaToMovieUs(segs, SEG1_START_US)).toBeCloseTo(0, 3);
    // Mid-segment-1 frame keeps segment 1's shift.
    expect(mediaToMovieUs(segs, SEG1_START_US + 50_000)).toBeCloseTo(50_000, 3);
    // First frame of segment 2 (media 432.07ms) -> movie 132.97ms — NOT
    // media − 199ms (the single-offset model was ~100ms late here).
    expect(mediaToMovieUs(segs, SEG2_START_US)).toBeCloseTo(SEG1_LEN_US, 3);
    // Deep into segment 2 the mapping stays anchored to segment 2.
    expect(mediaToMovieUs(segs, SEG2_START_US + 100_000_000)).toBeCloseTo(
      SEG1_LEN_US + 100_000_000,
      3,
    );
  });

  test("frames inside the media gap collapse to the segment boundary", () => {
    const segs = buildEditSegments(WEBCAM, 30000);
    // A glitch frame captured during the interruption (media 400ms — between
    // segment 1's end at ~332ms and segment 2's start at ~432ms) maps to the
    // single movie instant where the gap collapses; the next real frame at the
    // same instant supersedes it under zero-order hold.
    expect(mediaToMovieUs(segs, 400_000)).toBeCloseTo(SEG1_LEN_US, 3);
  });

  test("mapping is monotonic non-decreasing across the whole media range", () => {
    const segs = buildEditSegments(WEBCAM, 30000);
    let prev = -Infinity;
    for (let mediaUs = 0; mediaUs <= 1_000_000; mediaUs += 10_000) {
      const movie = mediaToMovieUs(segs, mediaUs);
      expect(movie).toBeGreaterThanOrEqual(prev);
      prev = movie;
    }
  });
});
