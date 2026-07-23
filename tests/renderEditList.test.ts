import { describe, expect, test } from "bun:test";
import { videoEditOffsetUs } from "../src/lib/render/renderPipeline";

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

describe("videoEditOffsetUs", () => {
  test("real capture warm-up edit: media_time 49 @600 -> 81666.67µs", () => {
    const t = trak([{ segment_duration: 197239, media_time: 49 }], 600);
    expect(videoEditOffsetUs(t, 600)).toBeCloseTo((49 * 1_000_000) / 600, 3);
  });

  test("real AAC priming edit: media_time 2112 @48000 -> 44000µs", () => {
    const t = trak([{ segment_duration: 197164, media_time: 2112 }], 48000);
    expect(videoEditOffsetUs(t, 600)).toBeCloseTo(44_000, 3);
  });

  test("no edit list -> 0 (timeline unchanged)", () => {
    expect(videoEditOffsetUs(trak(null, 600), 600)).toBe(0);
  });

  test("empty entries -> 0", () => {
    expect(videoEditOffsetUs(trak([], 600), 600)).toBe(0);
  });

  test("missing/invalid media timescale -> 0 (never NaN/Infinity)", () => {
    expect(videoEditOffsetUs(trak([{ segment_duration: 1, media_time: 49 }]), 600)).toBe(0);
    expect(videoEditOffsetUs(trak([{ segment_duration: 1, media_time: 49 }], 0), 600)).toBe(0);
  });

  test("leading empty edit (media_time -1) delays the track -> negative offset", () => {
    // 300 movie units @600 = 500ms of delay before content starts, then
    // content from media 0: movie time = media time + 500ms, so the offset to
    // SUBTRACT is -500000µs.
    const t = trak(
      [
        { segment_duration: 300, media_time: -1 },
        { segment_duration: 197239, media_time: 0 },
      ],
      600,
    );
    expect(videoEditOffsetUs(t, 600)).toBeCloseTo(-500_000, 3);
  });

  test("empty edit plus warm-up trim combine", () => {
    // 500ms delay, then content from media_time 49 @600 (81.67ms):
    // offset = 81666.67 - 500000.
    const t = trak(
      [
        { segment_duration: 300, media_time: -1 },
        { segment_duration: 197239, media_time: 49 },
      ],
      600,
    );
    expect(videoEditOffsetUs(t, 600)).toBeCloseTo((49 * 1_000_000) / 600 - 500_000, 3);
  });

  test("mapping: first real frame (cts 49 @600) lands at movie time 0", () => {
    const t = trak([{ segment_duration: 197239, media_time: 49 }], 600);
    const offsetUs = videoEditOffsetUs(t, 600);
    const cts = 49;
    const timescale = 600;
    expect((cts * 1_000_000) / timescale - offsetUs).toBeCloseTo(0, 3);
  });
});
