import { describe, expect, test } from "bun:test";
import {
  clampCaptionSegments,
  clampWebcamScenes,
  defaultProject,
  resolveCaptionSegments,
  resolveWebcamScenes,
  type CaptionSegment,
  type EditorProject,
  type WebcamScene,
} from "../src/lib/editorProject";
import { captionAt, webcamSceneAt } from "../src/lib/render/compositor";

// The render-boundary defensive clamp. Both the export (renderPipeline) and the
// editor preview resolve the STORED webcam scenes / caption segments through
// these two functions, so `webcamSceneAt` / `captionAt` — which binary-search
// assuming sorted, non-overlapping input — can never mis-pick on hand-edited or
// foreign project_json that `parseProject` shape-validated but did not clamp.
// This is the scenes/captions analog of how `buildSpeedMap` self-defends via
// `clampSpeedRanges` and zoom flows through `resolveZoomBlocks`.

const DURATION_MS = 10_000;

function projectWithScenes(scenes: WebcamScene[]): EditorProject {
  return {
    ...defaultProject(),
    webcam: {
      show: false,
      shape: "rounded",
      corner: "br",
      sizeFrac: 0.2,
      autoShrink: false,
      mirror: false,
      scenes,
    },
  };
}

function projectWithCaptions(
  segments: CaptionSegment[] | null,
  enabled = true,
): EditorProject {
  return { ...defaultProject(), captions: { enabled, segments } };
}

describe("resolveWebcamScenes (render-boundary defensive clamp)", () => {
  test("an unsorted, overlapping stored scenes array renders as its clamped form", () => {
    // Out-of-order AND overlapping — the editor write path clamps every edit,
    // but hand-edited / foreign project_json bypasses that (parse only checks
    // shape). This is exactly the input `webcamSceneAt`'s binary search assumes
    // it will never see.
    const raw: WebcamScene[] = [
      { id: "late", startMs: 5000, endMs: 8000 },
      { id: "early", startMs: 1000, endMs: 6000 }, // out of order; overlaps "late"
    ];
    const resolved = resolveWebcamScenes(projectWithScenes(raw), DURATION_MS);

    // Renders exactly as `clampWebcamScenes` would: sorted ascending, the later
    // overlapping scene dropped (earlier wins).
    expect(resolved).toEqual(clampWebcamScenes(raw, DURATION_MS));
    expect(resolved).toEqual([{ id: "early", startMs: 1000, endMs: 6000 }]);

    // The concrete mis-pick the clamp fixes: on the RAW (unsorted) array the
    // binary search bails at t=1500 and returns null; on the resolved array it
    // correctly reports the covering scene.
    expect(webcamSceneAt(1500, raw)).toBeNull();
    expect(webcamSceneAt(1500, resolved)).toEqual({ id: "early" });
  });

  test("an already-clamped stored scenes array renders unchanged", () => {
    const clamped: WebcamScene[] = [
      { id: "a", startMs: 1000, endMs: 3000 },
      { id: "b", startMs: 4000, endMs: 6000 },
    ];
    const resolved = resolveWebcamScenes(projectWithScenes(clamped), DURATION_MS);
    expect(resolved).toEqual(clamped);
    // Same picks as the already-valid array — behavior identical.
    expect(webcamSceneAt(2000, resolved)).toEqual({ id: "a" });
    expect(webcamSceneAt(5000, resolved)).toEqual({ id: "b" });
  });

  test("no webcam settings → empty (pre-M6 projects unaffected)", () => {
    expect(resolveWebcamScenes(defaultProject(), DURATION_MS)).toEqual([]);
  });
});

describe("resolveCaptionSegments (render-boundary defensive clamp)", () => {
  test("an unsorted, overlapping stored segments array renders as its clamped form", () => {
    const raw: CaptionSegment[] = [
      { startMs: 5000, endMs: 8000, text: "late" },
      { startMs: 1000, endMs: 6000, text: "early" }, // out of order; overlaps "late"
    ];
    const resolved = resolveCaptionSegments(projectWithCaptions(raw), DURATION_MS);

    expect(resolved).toEqual(clampCaptionSegments(raw, DURATION_MS));
    expect(resolved).toEqual([{ startMs: 1000, endMs: 6000, text: "early" }]);

    // Same concrete mis-pick fix as scenes.
    expect(captionAt(1500, raw)).toBeNull();
    expect(captionAt(1500, resolved)).toBe("early");
  });

  test("an already-clamped stored segments array renders unchanged", () => {
    const clamped: CaptionSegment[] = [
      { startMs: 1000, endMs: 3000, text: "a" },
      { startMs: 4000, endMs: 6000, text: "b" },
    ];
    const resolved = resolveCaptionSegments(projectWithCaptions(clamped), DURATION_MS);
    expect(resolved).toEqual(clamped);
    expect(captionAt(2000, resolved)).toBe("a");
    expect(captionAt(5000, resolved)).toBe("b");
  });

  test("captions disabled → empty regardless of stored segments", () => {
    const segments: CaptionSegment[] = [{ startMs: 0, endMs: 1000, text: "x" }];
    expect(
      resolveCaptionSegments(projectWithCaptions(segments, false), DURATION_MS),
    ).toEqual([]);
  });

  test("segments never generated (null) → empty", () => {
    expect(resolveCaptionSegments(projectWithCaptions(null, true), DURATION_MS)).toEqual([]);
  });
});
