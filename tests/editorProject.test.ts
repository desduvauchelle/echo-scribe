import { describe, expect, test } from "bun:test";
import {
  buildSpeedMap,
  clampCaptionSegments,
  clampMasks,
  clampSpeedRanges,
  clampTrim,
  clampWebcamScenes,
  defaultProject,
  parseProject,
  placeSpeedRange,
  resizeMaskRect,
  MASK_MIN_SIZE,
  resizeSpeedRange,
  renderedExportPath,
  shiftRangesForTrim,
  clampZoomCenter,
  nextZoomBlockId,
  resizeZoomBlock,
  moveZoomBlock,
  placeZoomBlock,
  nextRangeId,
  moveRange,
  resizeRange,
  placeRange,
  ZOOM_MIN_LENGTH_MS,
  SCENE_MIN_LENGTH_MS,
  type CaptionSegment,
  type Mask,
  type MaskRect,
  type SpeedRange,
  type WebcamScene,
} from "../src/lib/editorProject";
import type { ZoomBlock } from "../src/lib/autoZoom";

/** A speed range literal helper. */
function sr(startMs: number, endMs: number, rate: number): SpeedRange {
  return { startMs, endMs, rate };
}

/** A caption segment literal helper. */
function cap(startMs: number, endMs: number, text = "hello"): CaptionSegment {
  return { startMs, endMs, text };
}

/** A manual zoom block with sane defaults; override any field. */
function zb(startMs: number, endMs: number, over: Partial<ZoomBlock> = {}): ZoomBlock {
  return { startMs, endMs, cx: 0.5, cy: 0.5, scale: 2, mode: "manual", ...over };
}

/** A webcam scene literal helper. */
function scene(startMs: number, endMs: number, id = "s1"): WebcamScene {
  return { id, startMs, endMs };
}

/** A mask literal helper (rect defaults to a centered unit-quarter square). */
function mask(
  startMs: number,
  endMs: number,
  over: Partial<Mask> = {},
): Mask {
  return {
    id: "m1",
    startMs,
    endMs,
    rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    kind: "pixelate",
    ...over,
  };
}

describe("defaultProject", () => {
  test("has v=1 and sane appearance defaults", () => {
    const p = defaultProject();
    expect(p.v).toBe(1);
    expect(p.trim).toBeNull();
    expect(p.appearance.padding).toBeGreaterThanOrEqual(0);
    expect(p.appearance.padding).toBeLessThanOrEqual(256);
    expect(p.appearance.cornerRadius).toBeGreaterThanOrEqual(0);
    expect(p.appearance.cornerRadius).toBeLessThanOrEqual(64);
    expect(p.appearance.background.type).toBe("gradient");
  });

  test("cursor + webcam defaults present", () => {
    const p = defaultProject();
    expect(p.cursor.enabled).toBe(false);
    expect(p.cursor.scale).toBeGreaterThanOrEqual(1);
    // webcam default null when no webcam file
    expect(p.webcam).toBeNull();
  });

  test("webcam autoShrink/mirror/scenes defaults present (M6)", () => {
    const p = parseProject(
      JSON.stringify({ webcam: { show: true, shape: "circle", corner: "tl", sizeFrac: 0.2 } }),
    );
    expect(p.webcam).not.toBeNull();
    expect(p.webcam!.autoShrink).toBe(false);
    expect(p.webcam!.mirror).toBe(false);
    expect(p.webcam!.scenes).toEqual([]);
  });

  test("zoom/speed/keystrokes defaults present", () => {
    const p = defaultProject();
    expect(p.zoom).toEqual({ mode: "auto", blocks: null });
    expect(p.speed).toEqual([]);
    expect(p.keystrokes).toEqual({ enabled: false, allKeys: false });
  });

  test("captions/audio/motionBlur defaults present (M4)", () => {
    const p = defaultProject();
    expect(p.captions).toEqual({ enabled: false, segments: null });
    expect(p.audio).toEqual({ normalizeLoudness: false });
    expect(p.motionBlur).toBe(false);
  });

  test("masks default to [] (M5)", () => {
    const p = defaultProject();
    expect(p.masks).toEqual([]);
  });

  test("cursor smoothing/hideIdle defaults present (M4) — existing look unchanged", () => {
    const p = defaultProject();
    expect(p.cursor.smoothing).toBe(0);
    expect(p.cursor.hideIdle).toBe(false);
    // pre-M4 fields untouched
    expect(p.cursor.enabled).toBe(false);
    expect(p.cursor.scale).toBe(1.5);
  });

  test("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultProject();
    const b = defaultProject();
    expect(a).not.toBe(b);
    a.appearance.padding = 200;
    expect(b.appearance.padding).not.toBe(200);
  });
});

describe("parseProject — tolerant", () => {
  test("null -> defaults", () => {
    expect(parseProject(null)).toEqual(defaultProject());
  });

  test("empty string -> defaults", () => {
    expect(parseProject("")).toEqual(defaultProject());
  });

  test("garbage / non-JSON -> defaults (never throws)", () => {
    expect(() => parseProject("{not json")).not.toThrow();
    expect(parseProject("{not json")).toEqual(defaultProject());
    expect(parseProject("42")).toEqual(defaultProject());
    expect(parseProject("null")).toEqual(defaultProject());
    expect(parseProject("[]")).toEqual(defaultProject());
    expect(parseProject('"a string"')).toEqual(defaultProject());
  });

  test("partial JSON merges onto defaults", () => {
    const p = parseProject(JSON.stringify({ appearance: { padding: 42 } }));
    expect(p.appearance.padding).toBe(42);
    // untouched fields keep defaults
    expect(p.appearance.cornerRadius).toBe(defaultProject().appearance.cornerRadius);
    expect(p.v).toBe(1);
    expect(p.trim).toBeNull();
  });

  test("clamps out-of-range numbers", () => {
    const hi = parseProject(
      JSON.stringify({ appearance: { padding: 9999, cornerRadius: 500 } }),
    );
    expect(hi.appearance.padding).toBe(256);
    expect(hi.appearance.cornerRadius).toBe(64);
    const lo = parseProject(
      JSON.stringify({ appearance: { padding: -50, cornerRadius: -3 } }),
    );
    expect(lo.appearance.padding).toBe(0);
    expect(lo.appearance.cornerRadius).toBe(0);
  });

  test("accepts a valid solid background", () => {
    const p = parseProject(
      JSON.stringify({ appearance: { background: { type: "solid", color: "#ff0000" } } }),
    );
    expect(p.appearance.background).toEqual({ type: "solid", color: "#ff0000" });
  });

  test("accepts a valid image background", () => {
    const p = parseProject(
      JSON.stringify({ appearance: { background: { type: "image", path: "/tmp/x.png" } } }),
    );
    expect(p.appearance.background).toEqual({ type: "image", path: "/tmp/x.png" });
  });

  test("bad background type falls back to default background", () => {
    const p = parseProject(
      JSON.stringify({ appearance: { background: { type: "nonsense" } } }),
    );
    expect(p.appearance.background).toEqual(defaultProject().appearance.background);
  });

  test("bad solid color (missing) falls back to default background", () => {
    const p = parseProject(
      JSON.stringify({ appearance: { background: { type: "solid" } } }),
    );
    expect(p.appearance.background).toEqual(defaultProject().appearance.background);
  });

  test("valid trim survives; garbage trim -> null", () => {
    const ok = parseProject(JSON.stringify({ trim: { startMs: 100, endMs: 5000 } }));
    expect(ok.trim).toEqual({ startMs: 100, endMs: 5000 });
    const bad = parseProject(JSON.stringify({ trim: { startMs: "x" } }));
    expect(bad.trim).toBeNull();
  });

  test("inverted trim pair comes back ordered", () => {
    const p = parseProject(JSON.stringify({ trim: { startMs: 8000, endMs: 2000 } }));
    expect(p.trim).toEqual({ startMs: 2000, endMs: 8000 });
  });

  test("negative trim start clamps to 0", () => {
    const p = parseProject(JSON.stringify({ trim: { startMs: -500, endMs: 3000 } }));
    expect(p.trim).toEqual({ startMs: 0, endMs: 3000 });
  });

  test("aspect defaults to auto and survives valid values", () => {
    expect(defaultProject().appearance.aspect).toBe("auto");
    for (const a of ["auto", "16:9", "9:16", "1:1", "4:3"] as const) {
      const p = parseProject(JSON.stringify({ appearance: { aspect: a } }));
      expect(p.appearance.aspect).toBe(a);
    }
  });

  test("unknown aspect falls back to auto (tolerant)", () => {
    expect(parseProject(JSON.stringify({ appearance: { aspect: "21:9" } })).appearance.aspect).toBe("auto");
    expect(parseProject(JSON.stringify({ appearance: { aspect: 169 } })).appearance.aspect).toBe("auto");
    expect(parseProject(JSON.stringify({ appearance: { aspect: null } })).appearance.aspect).toBe("auto");
    // missing → default auto
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).appearance.aspect).toBe("auto");
  });

  test("cursor scale clamped to 1..3", () => {
    expect(parseProject(JSON.stringify({ cursor: { scale: 99 } })).cursor.scale).toBe(3);
    expect(parseProject(JSON.stringify({ cursor: { scale: 0 } })).cursor.scale).toBe(1);
    expect(parseProject(JSON.stringify({ cursor: { enabled: true, scale: 2 } })).cursor)
      .toEqual({ enabled: true, scale: 2, smoothing: 0, hideIdle: false });
  });

  test("webcam parsed when present; sizeFrac clamped 0.1..0.35", () => {
    const p = parseProject(
      JSON.stringify({
        webcam: { show: true, shape: "circle", corner: "tl", sizeFrac: 0.9 },
      }),
    );
    expect(p.webcam).not.toBeNull();
    expect(p.webcam!.shape).toBe("circle");
    expect(p.webcam!.corner).toBe("tl");
    expect(p.webcam!.sizeFrac).toBe(0.35);
    // invalid shape/corner fall back to safe values
    const q = parseProject(
      JSON.stringify({ webcam: { shape: "hexagon", corner: "zz", sizeFrac: 0.01 } }),
    );
    expect(q.webcam!.shape).toBe("rounded");
    expect(q.webcam!.corner).toBe("br");
    expect(q.webcam!.sizeFrac).toBe(0.1);
  });
});

describe("parseProject — webcam autoShrink/mirror/scenes (M6)", () => {
  test("valid autoShrink/mirror/scenes survive", () => {
    const scenes = [scene(0, 1000, "s1"), scene(2000, 3000, "s2")];
    const p = parseProject(
      JSON.stringify({
        webcam: {
          show: true,
          shape: "circle",
          corner: "tl",
          sizeFrac: 0.2,
          autoShrink: true,
          mirror: true,
          scenes,
        },
      }),
    );
    expect(p.webcam!.autoShrink).toBe(true);
    expect(p.webcam!.mirror).toBe(true);
    expect(p.webcam!.scenes).toEqual(scenes);
  });

  test("non-boolean autoShrink/mirror fall back to defaults", () => {
    const p = parseProject(
      JSON.stringify({
        webcam: { show: true, autoShrink: "yes", mirror: 1 },
      }),
    );
    expect(p.webcam!.autoShrink).toBe(false);
    expect(p.webcam!.mirror).toBe(false);
  });

  test("non-array scenes -> empty array", () => {
    const p = parseProject(JSON.stringify({ webcam: { show: true, scenes: "nope" } }));
    expect(p.webcam!.scenes).toEqual([]);
    const q = parseProject(JSON.stringify({ webcam: { show: true, scenes: {} } }));
    expect(q.webcam!.scenes).toEqual([]);
  });

  test("shape-invalid scene entries are dropped, valid ones kept", () => {
    const p = parseProject(
      JSON.stringify({
        webcam: {
          show: true,
          scenes: [
            { id: "s1", startMs: 0, endMs: 1000 },
            { id: "s2", startMs: "x", endMs: 1000 },
            { startMs: 0, endMs: 1000 }, // missing id
            { id: "s3", startMs: 0 }, // missing endMs
            "garbage",
            null,
            { id: "s4", startMs: 500, endMs: 1500 },
          ],
        },
      }),
    );
    expect(p.webcam!.scenes).toEqual([
      { id: "s1", startMs: 0, endMs: 1000 },
      { id: "s4", startMs: 500, endMs: 1500 },
    ]);
  });
});

describe("parseProject — zoom", () => {
  test("missing zoom -> default (mode auto, blocks null)", () => {
    const p = parseProject(JSON.stringify({ appearance: { padding: 20 } }));
    expect(p.zoom).toEqual({ mode: "auto", blocks: null });
  });

  test("valid custom mode with blocks survives", () => {
    const blocks = [
      { startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual" as const, id: "z1" },
    ];
    const p = parseProject(JSON.stringify({ zoom: { mode: "custom", blocks } }));
    expect(p.zoom).toEqual({ mode: "custom", blocks });
  });

  test("unknown mode falls back to auto (tolerant)", () => {
    expect(parseProject(JSON.stringify({ zoom: { mode: "bogus" } })).zoom.mode).toBe("auto");
    expect(parseProject(JSON.stringify({ zoom: { mode: 42 } })).zoom.mode).toBe("auto");
    expect(parseProject(JSON.stringify({ zoom: { mode: null } })).zoom.mode).toBe("auto");
  });

  test("mode off is preserved", () => {
    expect(parseProject(JSON.stringify({ zoom: { mode: "off" } })).zoom.mode).toBe("off");
  });

  test("non-array blocks -> null", () => {
    expect(
      parseProject(JSON.stringify({ zoom: { mode: "custom", blocks: "nope" } })).zoom.blocks,
    ).toBeNull();
    expect(
      parseProject(JSON.stringify({ zoom: { mode: "custom", blocks: {} } })).zoom.blocks,
    ).toBeNull();
  });

  test("blocks forced to null when mode is not custom, even if array is present", () => {
    const blocks = [
      { startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "auto" as const },
    ];
    expect(
      parseProject(JSON.stringify({ zoom: { mode: "auto", blocks } })).zoom.blocks,
    ).toBeNull();
    expect(
      parseProject(JSON.stringify({ zoom: { mode: "off", blocks } })).zoom.blocks,
    ).toBeNull();
  });
});

describe("parseProject — speed", () => {
  test("missing speed -> default empty array", () => {
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).speed).toEqual([]);
  });

  test("non-array speed -> default empty array", () => {
    expect(parseProject(JSON.stringify({ speed: "nope" })).speed).toEqual([]);
    expect(parseProject(JSON.stringify({ speed: {} })).speed).toEqual([]);
  });

  test("valid ranges survive", () => {
    const ranges = [
      { startMs: 0, endMs: 1000, rate: 2 },
      { startMs: 2000, endMs: 3000, rate: 0.5 },
    ];
    expect(parseProject(JSON.stringify({ speed: ranges })).speed).toEqual(ranges);
  });

  test("shape-invalid entries are dropped, valid ones kept", () => {
    const p = parseProject(
      JSON.stringify({
        speed: [
          { startMs: 0, endMs: 1000, rate: 2 },
          { startMs: "x", endMs: 1000, rate: 2 },
          { startMs: 0, rate: 2 },
          { startMs: 0, endMs: 1000 },
          "garbage",
          null,
          { startMs: 500, endMs: 1500, rate: 1.5 },
        ],
      }),
    );
    expect(p.speed).toEqual([
      { startMs: 0, endMs: 1000, rate: 2 },
      { startMs: 500, endMs: 1500, rate: 1.5 },
    ]);
  });
});

describe("parseProject — keystrokes", () => {
  test("missing keystrokes -> default", () => {
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).keystrokes).toEqual({
      enabled: false,
      allKeys: false,
    });
  });

  test("valid keystrokes survive", () => {
    expect(
      parseProject(JSON.stringify({ keystrokes: { enabled: true, allKeys: true } })).keystrokes,
    ).toEqual({ enabled: true, allKeys: true });
  });

  test("non-boolean fields fall back to defaults", () => {
    expect(
      parseProject(JSON.stringify({ keystrokes: { enabled: "yes", allKeys: 1 } })).keystrokes,
    ).toEqual({ enabled: false, allKeys: false });
  });
});

describe("parseProject — captions", () => {
  test("missing captions -> default (disabled, segments null)", () => {
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).captions).toEqual({
      enabled: false,
      segments: null,
    });
  });

  test("valid captions with segments survive", () => {
    const segments = [cap(0, 1000, "hi"), cap(1000, 2000, "there")];
    const p = parseProject(JSON.stringify({ captions: { enabled: true, segments } }));
    expect(p.captions).toEqual({ enabled: true, segments });
  });

  test("enabled true with segments null survives (generation not run yet)", () => {
    const p = parseProject(JSON.stringify({ captions: { enabled: true, segments: null } }));
    expect(p.captions).toEqual({ enabled: true, segments: null });
  });

  test("non-boolean enabled falls back to default", () => {
    expect(
      parseProject(JSON.stringify({ captions: { enabled: "yes", segments: null } })).captions
        .enabled,
    ).toBe(false);
  });

  test("non-array, non-null segments -> null", () => {
    expect(
      parseProject(JSON.stringify({ captions: { enabled: true, segments: "nope" } })).captions
        .segments,
    ).toBeNull();
    expect(
      parseProject(JSON.stringify({ captions: { enabled: true, segments: {} } })).captions
        .segments,
    ).toBeNull();
  });

  test("shape-invalid segment entries are dropped, valid ones kept", () => {
    const p = parseProject(
      JSON.stringify({
        captions: {
          enabled: true,
          segments: [
            { startMs: 0, endMs: 1000, text: "ok" },
            { startMs: "x", endMs: 1000, text: "bad" },
            { startMs: 0, endMs: 1000 }, // missing text
            { startMs: 0, text: "bad" }, // missing endMs
            "garbage",
            null,
            { startMs: 500, endMs: 1500, text: "also ok" },
          ],
        },
      }),
    );
    expect(p.captions.segments).toEqual([
      { startMs: 0, endMs: 1000, text: "ok" },
      { startMs: 500, endMs: 1500, text: "also ok" },
    ]);
  });

  test("non-object captions -> default", () => {
    expect(parseProject(JSON.stringify({ captions: "nope" })).captions).toEqual({
      enabled: false,
      segments: null,
    });
  });
});

describe("parseProject — audio", () => {
  test("missing audio -> default (normalizeLoudness false)", () => {
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).audio).toEqual({
      normalizeLoudness: false,
    });
  });

  test("valid audio survives", () => {
    expect(
      parseProject(JSON.stringify({ audio: { normalizeLoudness: true } })).audio,
    ).toEqual({ normalizeLoudness: true });
  });

  test("non-boolean normalizeLoudness falls back to default", () => {
    expect(
      parseProject(JSON.stringify({ audio: { normalizeLoudness: "yes" } })).audio,
    ).toEqual({ normalizeLoudness: false });
  });

  test("non-object audio -> default", () => {
    expect(parseProject(JSON.stringify({ audio: "nope" })).audio).toEqual({
      normalizeLoudness: false,
    });
  });
});

describe("parseProject — motionBlur", () => {
  test("missing motionBlur -> default false", () => {
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).motionBlur).toBe(false);
  });

  test("valid motionBlur survives", () => {
    expect(parseProject(JSON.stringify({ motionBlur: true })).motionBlur).toBe(true);
  });

  test("non-boolean motionBlur falls back to default", () => {
    expect(parseProject(JSON.stringify({ motionBlur: "yes" })).motionBlur).toBe(false);
    expect(parseProject(JSON.stringify({ motionBlur: 1 })).motionBlur).toBe(false);
  });
});

describe("parseProject — masks (M5)", () => {
  test("missing masks -> empty array", () => {
    expect(parseProject(JSON.stringify({ appearance: { padding: 20 } })).masks).toEqual([]);
  });

  test("non-array masks -> empty array", () => {
    expect(parseProject(JSON.stringify({ masks: "nope" })).masks).toEqual([]);
    expect(parseProject(JSON.stringify({ masks: {} })).masks).toEqual([]);
  });

  test("valid masks survive (both kinds)", () => {
    const masks = [
      { id: "m1", startMs: 0, endMs: 1000, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, kind: "pixelate" },
      { id: "m2", startMs: 500, endMs: 1500, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: "highlight" },
    ];
    expect(parseProject(JSON.stringify({ masks })).masks).toEqual(masks);
  });

  test("shape-invalid mask entries are dropped, valid ones kept in order", () => {
    const p = parseProject(
      JSON.stringify({
        masks: [
          { id: "m1", startMs: 0, endMs: 1000, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, kind: "pixelate" },
          { id: "m2", startMs: "x", endMs: 1000, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: "highlight" }, // bad startMs
          { startMs: 0, endMs: 1000, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: "pixelate" }, // missing id
          { id: "m3", startMs: 0, endMs: 1000, kind: "pixelate" }, // missing rect
          { id: "m4", startMs: 0, endMs: 1000, rect: { x: 0, y: 0, w: 1 }, kind: "pixelate" }, // rect missing h
          { id: "m5", startMs: 0, endMs: 1000, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: "blur" }, // bad kind
          "garbage",
          null,
          { id: "m6", startMs: 500, endMs: 1500, rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, kind: "highlight" },
        ],
      }),
    );
    expect(p.masks).toEqual([
      { id: "m1", startMs: 0, endMs: 1000, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, kind: "pixelate" },
      { id: "m6", startMs: 500, endMs: 1500, rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, kind: "highlight" },
    ]);
  });
});

describe("parseProject — cursor smoothing/hideIdle (M4)", () => {
  test("missing smoothing/hideIdle -> defaults (existing look unchanged)", () => {
    const p = parseProject(JSON.stringify({ cursor: { enabled: true, scale: 2 } }));
    expect(p.cursor).toEqual({ enabled: true, scale: 2, smoothing: 0, hideIdle: false });
  });

  test("valid smoothing/hideIdle survive", () => {
    const p = parseProject(
      JSON.stringify({ cursor: { smoothing: 0.6, hideIdle: true } }),
    );
    expect(p.cursor.smoothing).toBe(0.6);
    expect(p.cursor.hideIdle).toBe(true);
  });

  test("smoothing clamped to [0, 1]", () => {
    expect(parseProject(JSON.stringify({ cursor: { smoothing: 5 } })).cursor.smoothing).toBe(1);
    expect(parseProject(JSON.stringify({ cursor: { smoothing: -2 } })).cursor.smoothing).toBe(0);
  });

  test("malformed smoothing falls back to default (never throws)", () => {
    expect(() => parseProject(JSON.stringify({ cursor: { smoothing: "fast" } }))).not.toThrow();
    expect(parseProject(JSON.stringify({ cursor: { smoothing: "fast" } })).cursor.smoothing).toBe(
      0,
    );
    expect(parseProject(JSON.stringify({ cursor: { smoothing: null } })).cursor.smoothing).toBe(
      0,
    );
    expect(parseProject(JSON.stringify({ cursor: { smoothing: NaN } })).cursor.smoothing).toBe(0);
  });

  test("non-boolean hideIdle falls back to default", () => {
    expect(parseProject(JSON.stringify({ cursor: { hideIdle: "yes" } })).cursor.hideIdle).toBe(
      false,
    );
  });
});

describe("clampSpeedRanges", () => {
  test("empty input -> empty output", () => {
    expect(clampSpeedRanges([], 10000)).toEqual([]);
  });

  test("single valid range passes through unchanged", () => {
    expect(clampSpeedRanges([{ startMs: 1000, endMs: 2000, rate: 2 }], 10000)).toEqual([
      { startMs: 1000, endMs: 2000, rate: 2 },
    ]);
  });

  test("sorts ranges by startMs", () => {
    const out = clampSpeedRanges(
      [
        { startMs: 5000, endMs: 6000, rate: 2 },
        { startMs: 0, endMs: 1000, rate: 2 },
      ],
      10000,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 1000, rate: 2 },
      { startMs: 5000, endMs: 6000, rate: 2 },
    ]);
  });

  test("clamps start/end into [0, durationMs]", () => {
    expect(clampSpeedRanges([{ startMs: -500, endMs: 2000, rate: 2 }], 10000)).toEqual([
      { startMs: 0, endMs: 2000, rate: 2 },
    ]);
    expect(clampSpeedRanges([{ startMs: 8000, endMs: 20000, rate: 2 }], 10000)).toEqual([
      { startMs: 8000, endMs: 10000, rate: 2 },
    ]);
  });

  test("drops ranges with endMs<=startMs after clamping", () => {
    // fully out of bounds — clamps to a zero-length range, dropped.
    expect(clampSpeedRanges([{ startMs: 20000, endMs: 30000, rate: 2 }], 10000)).toEqual([]);
    // inverted before clamp — after clamp still endMs<=startMs is NOT auto-fixed
    // (this function drops, unlike parseTrim which reorders).
    expect(clampSpeedRanges([{ startMs: 5000, endMs: 5000, rate: 2 }], 10000)).toEqual([]);
  });

  test("drops overlapping ranges, keeping the earlier one", () => {
    const out = clampSpeedRanges(
      [
        { startMs: 0, endMs: 2000, rate: 2 },
        { startMs: 1000, endMs: 3000, rate: 3 },
      ],
      10000,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 2000, rate: 2 }]);
  });

  test("touching (non-overlapping) ranges are both kept", () => {
    const out = clampSpeedRanges(
      [
        { startMs: 0, endMs: 2000, rate: 2 },
        { startMs: 2000, endMs: 3000, rate: 3 },
      ],
      10000,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 2000, rate: 2 },
      { startMs: 2000, endMs: 3000, rate: 3 },
    ]);
  });

  test("clamps rate to [0.5, 4]", () => {
    expect(clampSpeedRanges([{ startMs: 0, endMs: 1000, rate: 99 }], 10000)).toEqual([
      { startMs: 0, endMs: 1000, rate: 4 },
    ]);
    expect(clampSpeedRanges([{ startMs: 0, endMs: 1000, rate: 0.01 }], 10000)).toEqual([
      { startMs: 0, endMs: 1000, rate: 0.5 },
    ]);
  });

  test("rounds start/end to integers", () => {
    expect(clampSpeedRanges([{ startMs: 100.6, endMs: 999.4, rate: 2 }], 10000)).toEqual([
      { startMs: 101, endMs: 999, rate: 2 },
    ]);
  });

  test("multiple overlaps resolved left-to-right (earliest wins each time)", () => {
    const out = clampSpeedRanges(
      [
        { startMs: 0, endMs: 5000, rate: 2 },
        { startMs: 1000, endMs: 2000, rate: 3 },
        { startMs: 6000, endMs: 7000, rate: 4 },
      ],
      10000,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 5000, rate: 2 },
      { startMs: 6000, endMs: 7000, rate: 4 },
    ]);
  });
});

describe("clampCaptionSegments", () => {
  test("empty input -> empty output", () => {
    expect(clampCaptionSegments([], 10000)).toEqual([]);
  });

  test("single valid segment passes through unchanged", () => {
    expect(clampCaptionSegments([cap(1000, 2000, "hi")], 10000)).toEqual([
      { startMs: 1000, endMs: 2000, text: "hi" },
    ]);
  });

  test("sorts segments by startMs", () => {
    const out = clampCaptionSegments(
      [cap(5000, 6000, "b"), cap(0, 1000, "a")],
      10000,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 1000, text: "a" },
      { startMs: 5000, endMs: 6000, text: "b" },
    ]);
  });

  test("clamps start/end into [0, durationMs]", () => {
    expect(clampCaptionSegments([cap(-500, 2000, "a")], 10000)).toEqual([
      { startMs: 0, endMs: 2000, text: "a" },
    ]);
    expect(clampCaptionSegments([cap(8000, 20000, "a")], 10000)).toEqual([
      { startMs: 8000, endMs: 10000, text: "a" },
    ]);
  });

  test("drops segments with endMs<=startMs after clamping", () => {
    // fully out of bounds — clamps to a zero-length segment, dropped.
    expect(clampCaptionSegments([cap(20000, 30000, "a")], 10000)).toEqual([]);
    // inverted/zero-length before clamp — dropped, not reordered.
    expect(clampCaptionSegments([cap(5000, 5000, "a")], 10000)).toEqual([]);
  });

  test("drops segments with empty text", () => {
    expect(clampCaptionSegments([cap(0, 1000, "")], 10000)).toEqual([]);
  });

  test("drops overlapping segments, keeping the earlier one", () => {
    const out = clampCaptionSegments(
      [cap(0, 2000, "a"), cap(1000, 3000, "b")],
      10000,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 2000, text: "a" }]);
  });

  test("touching (non-overlapping) segments are both kept", () => {
    const out = clampCaptionSegments(
      [cap(0, 2000, "a"), cap(2000, 3000, "b")],
      10000,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 2000, text: "a" },
      { startMs: 2000, endMs: 3000, text: "b" },
    ]);
  });

  test("rounds start/end to integers", () => {
    expect(clampCaptionSegments([cap(100.6, 999.4, "a")], 10000)).toEqual([
      { startMs: 101, endMs: 999, text: "a" },
    ]);
  });

  test("multiple overlaps resolved left-to-right (earliest wins each time)", () => {
    const out = clampCaptionSegments(
      [cap(0, 5000, "a"), cap(1000, 2000, "b"), cap(6000, 7000, "c")],
      10000,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 5000, text: "a" },
      { startMs: 6000, endMs: 7000, text: "c" },
    ]);
  });
});

describe("clampWebcamScenes", () => {
  test("empty input -> empty output", () => {
    expect(clampWebcamScenes([], 10000)).toEqual([]);
  });

  test("single valid scene passes through unchanged", () => {
    expect(clampWebcamScenes([scene(1000, 2000, "s1")], 10000)).toEqual([
      { id: "s1", startMs: 1000, endMs: 2000 },
    ]);
  });

  test("sorts scenes by startMs", () => {
    const out = clampWebcamScenes(
      [scene(5000, 6000, "b"), scene(0, 1000, "a")],
      10000,
    );
    expect(out).toEqual([
      { id: "a", startMs: 0, endMs: 1000 },
      { id: "b", startMs: 5000, endMs: 6000 },
    ]);
  });

  test("clamps start/end into [0, durationMs]", () => {
    expect(clampWebcamScenes([scene(-500, 2000, "a")], 10000)).toEqual([
      { id: "a", startMs: 0, endMs: 2000 },
    ]);
    expect(clampWebcamScenes([scene(8000, 20000, "a")], 10000)).toEqual([
      { id: "a", startMs: 8000, endMs: 10000 },
    ]);
  });

  test("drops scenes with endMs<=startMs after clamping", () => {
    // fully out of bounds — clamps to a zero-length scene, dropped.
    expect(clampWebcamScenes([scene(20000, 30000, "a")], 10000)).toEqual([]);
    // inverted/zero-length before clamp — dropped, not reordered.
    expect(clampWebcamScenes([scene(5000, 5000, "a")], 10000)).toEqual([]);
  });

  test("drops overlapping scenes, keeping the earlier one", () => {
    const out = clampWebcamScenes(
      [scene(0, 2000, "a"), scene(1000, 3000, "b")],
      10000,
    );
    expect(out).toEqual([{ id: "a", startMs: 0, endMs: 2000 }]);
  });

  test("touching (non-overlapping) scenes are both kept", () => {
    const out = clampWebcamScenes(
      [scene(0, 2000, "a"), scene(2000, 3000, "b")],
      10000,
    );
    expect(out).toEqual([
      { id: "a", startMs: 0, endMs: 2000 },
      { id: "b", startMs: 2000, endMs: 3000 },
    ]);
  });

  test("rounds start/end to integers", () => {
    expect(clampWebcamScenes([scene(100.6, 999.4, "a")], 10000)).toEqual([
      { id: "a", startMs: 101, endMs: 999 },
    ]);
  });

  test("multiple overlaps resolved left-to-right (earliest wins each time)", () => {
    const out = clampWebcamScenes(
      [scene(0, 5000, "a"), scene(1000, 2000, "b"), scene(6000, 7000, "c")],
      10000,
    );
    expect(out).toEqual([
      { id: "a", startMs: 0, endMs: 5000 },
      { id: "c", startMs: 6000, endMs: 7000 },
    ]);
  });
});

describe("clampMasks", () => {
  test("empty input -> empty output", () => {
    expect(clampMasks([], 10000)).toEqual([]);
  });

  test("single valid mask passes through unchanged", () => {
    expect(clampMasks([mask(1000, 2000)], 10000)).toEqual([
      { id: "m1", startMs: 1000, endMs: 2000, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, kind: "pixelate" },
    ]);
  });

  test("preserves input order (does NOT sort by startMs) — masks are order-stable", () => {
    const out = clampMasks(
      [mask(5000, 6000, { id: "b" }), mask(0, 1000, { id: "a" })],
      10000,
    );
    expect(out.map((m) => m.id)).toEqual(["b", "a"]);
  });

  test("clamps start/end into [0, durationMs]", () => {
    expect(clampMasks([mask(-500, 2000)], 10000)[0]).toMatchObject({
      startMs: 0,
      endMs: 2000,
    });
    expect(clampMasks([mask(8000, 20000)], 10000)[0]).toMatchObject({
      startMs: 8000,
      endMs: 10000,
    });
  });

  test("drops masks with endMs<=startMs after clamping", () => {
    // fully out of bounds — clamps to a zero-length window, dropped.
    expect(clampMasks([mask(20000, 30000)], 10000)).toEqual([]);
    // inverted/zero-length before clamp — dropped, not reordered.
    expect(clampMasks([mask(5000, 5000)], 10000)).toEqual([]);
  });

  test("KEEPS time-overlapping masks (unlike scenes/speed/captions)", () => {
    const out = clampMasks(
      [mask(0, 2000, { id: "a" }), mask(1000, 3000, { id: "b" })],
      10000,
    );
    // Both survive — overlap in time is legal for masks.
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("clamps rect x/y into [0,1] and w/h so the rect stays inside the unit square", () => {
    const out = clampMasks(
      [mask(0, 1000, { rect: { x: -0.2, y: 0.5, w: 2, h: 0.9 } })],
      10000,
    );
    // x -> 0; w capped at 1 - x = 1. y stays 0.5; h capped at 1 - y = 0.5.
    expect(out[0].rect).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  test("drops masks whose clamped rect is zero-area", () => {
    // zero width
    expect(clampMasks([mask(0, 1000, { rect: { x: 0.1, y: 0.1, w: 0, h: 0.5 } })], 10000)).toEqual([]);
    // negative height clamps to 0 -> dropped
    expect(clampMasks([mask(0, 1000, { rect: { x: 0.1, y: 0.1, w: 0.5, h: -0.3 } })], 10000)).toEqual([]);
    // x at the far edge leaves no width -> w clamps to 0 -> dropped
    expect(clampMasks([mask(0, 1000, { rect: { x: 1, y: 0.1, w: 0.5, h: 0.5 } })], 10000)).toEqual([]);
  });

  test("rounds start/end to integers (rect stays fractional)", () => {
    const out = clampMasks(
      [mask(100.6, 999.4, { rect: { x: 0.111, y: 0.222, w: 0.3, h: 0.4 } })],
      10000,
    );
    expect(out[0].startMs).toBe(101);
    expect(out[0].endMs).toBe(999);
    // rect not rounded — it's normalized capture coords, not pixels.
    expect(out[0].rect).toEqual({ x: 0.111, y: 0.222, w: 0.3, h: 0.4 });
  });

  test("preserves the kind field", () => {
    const out = clampMasks(
      [mask(0, 1000, { kind: "highlight" }), mask(2000, 3000, { kind: "pixelate" })],
      10000,
    );
    expect(out.map((m) => m.kind)).toEqual(["highlight", "pixelate"]);
  });

  test("does not mutate its argument", () => {
    const input = [mask(-100, 2000, { rect: { x: -1, y: 0.5, w: 3, h: 0.5 } })];
    const snapshot = JSON.parse(JSON.stringify(input));
    clampMasks(input, 10000);
    expect(input).toEqual(snapshot);
  });
});

describe("resizeMaskRect", () => {
  // Reviewer-traced regression: zoom 2x centered (0.5,0.5), mask rect
  // {0,0,0.3,0.3} partially outside the visible zoom window. The nw handle's
  // on-screen (zoom-clipped) position corresponds to capture point
  // (0.25,0.25), NOT the true rect corner (0,0). A caller that grabs at that
  // clipped point records grabDx/grabDy = (0.25-0, 0.25-0) = (0.25, 0.25) —
  // exactly like a body-move grab offset. A zero-movement pointermove (same
  // client point as pointerdown) must reproduce the identical rect: no snap.
  test("zero-movement drag leaves the rect unchanged (nw handle grabbed off the true corner under zoom)", () => {
    const rect: MaskRect = { x: 0, y: 0, w: 0.3, h: 0.3 };
    // Pointer grabbed at capture point (0.25, 0.25) — the clipped nw handle's
    // display position — while the true nw corner is (0, 0). Anchor (se) is
    // (0.3, 0.3), captured once by the caller at pointer-down.
    const grabDx = 0.25 - rect.x;
    const grabDy = 0.25 - rect.y;
    const out = resizeMaskRect(rect.x + rect.w, rect.y + rect.h, 0.25, 0.25, grabDx, grabDy);
    expect(out).toEqual(rect);
  });

  test("zero-movement drag is a no-op for every corner", () => {
    const rect: MaskRect = { x: 0.2, y: 0.3, w: 0.4, h: 0.25 };
    const corners: Array<["nw" | "ne" | "sw" | "se", number, number, number, number]> = [
      ["nw", rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
      ["ne", rect.x + rect.w, rect.y, rect.x, rect.y + rect.h],
      ["sw", rect.x, rect.y + rect.h, rect.x + rect.w, rect.y],
      ["se", rect.x + rect.w, rect.y + rect.h, rect.x, rect.y],
    ];
    for (const [, cornerX, cornerY, fixedX, fixedY] of corners) {
      // Simulate a grab at some arbitrary display point (as if drawn on a
      // clipped box), then a pointermove at that SAME point.
      const grabPointX = cornerX + 0.05;
      const grabPointY = cornerY - 0.05;
      const grabDx = grabPointX - cornerX;
      const grabDy = grabPointY - cornerY;
      const out = resizeMaskRect(fixedX, fixedY, grabPointX, grabPointY, grabDx, grabDy);
      expect(out.x).toBeCloseTo(rect.x, 10);
      expect(out.y).toBeCloseTo(rect.y, 10);
      expect(out.w).toBeCloseTo(rect.w, 10);
      expect(out.h).toBeCloseTo(rect.h, 10);
    }
  });

  test("moves the dragged corner by the pointer's delta since grab", () => {
    const rect: MaskRect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    // Grab exactly at the se corner (0.6, 0.6) — zero grab offset. Anchor
    // (nw) is (0.2, 0.2).
    const out = resizeMaskRect(0.2, 0.2, 0.7, 0.65, 0, 0);
    // se corner moves to (0.7, 0.65); nw anchor (0.2, 0.2) stays fixed.
    expect(out.x).toBeCloseTo(0.2, 10);
    expect(out.y).toBeCloseTo(0.2, 10);
    expect(out.w).toBeCloseTo(0.5, 10);
    expect(out.h).toBeCloseTo(0.45, 10);
  });

  test("dragging the corner past the anchor flips w/h positive (normalizes)", () => {
    // Drag the se corner (anchor stays nw = (0.4, 0.4)) up-left past the anchor.
    const out = resizeMaskRect(0.4, 0.4, 0.1, 0.1, 0, 0);
    expect(out.w).toBeGreaterThan(0);
    expect(out.h).toBeGreaterThan(0);
    expect(out.x).toBeCloseTo(0.1, 10);
    expect(out.y).toBeCloseTo(0.1, 10);
    expect(out.w).toBeCloseTo(0.3, 10);
    expect(out.h).toBeCloseTo(0.3, 10);
  });

  test("clamps the dragged corner to [0,1] at the edges", () => {
    // Drag se corner way past the unit square. Anchor (nw) is (0.5, 0.5).
    const out = resizeMaskRect(0.5, 0.5, 5, 5, 0, 0);
    expect(out).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  test("clamps the dragged corner to [0,1] on the negative side", () => {
    // Drag nw corner (anchor se = (0.5, 0.5)) far off the negative edge.
    const out = resizeMaskRect(0.5, 0.5, -5, -5, 0, 0);
    expect(out).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
  });

  test("does not mutate its arguments", () => {
    const before = { fixedX: 0.5, fixedY: 0.5, pointerNx: 0.9, pointerNy: 0.9, grabDx: 0.1, grabDy: 0.1 };
    const snapshot = { ...before };
    resizeMaskRect(before.fixedX, before.fixedY, before.pointerNx, before.pointerNy, before.grabDx, before.grabDy);
    expect(before).toEqual(snapshot);
  });

  // Reviewer-traced regression: a prior revision re-derived the anchor each
  // move from the MUTATED rect using the STALE corner label — once the
  // dragged corner crosses the anchor, normalization swaps which side is
  // "min"/"max" and the label picks the wrong physical corner on every
  // subsequent move, so the anchor visibly drifts with the cursor instead of
  // staying put (traced case: dragging se of {0.4,0.4,0.2,0.2} leftward past
  // x=0.4 left w frozen as a cursor-riding sliver instead of growing from the
  // anchor). With the anchor captured ONCE at pointer-down and passed through
  // unchanged, feeding each move's output back in as the next move's context
  // must keep growing the rect from the ORIGINAL anchor (0.4, 0.4) even after
  // crossover — never re-anchor to wherever the cursor currently sits.
  test("multi-move crossover: dragging se leftward past the anchor keeps growing from the fixed nw anchor", () => {
    const start: MaskRect = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    // se corner starts at (0.6, 0.6); nw anchor (0.4, 0.4) is captured once
    // at pointer-down and never changes for the whole gesture.
    const fixedX = start.x;
    const fixedY = start.y;
    const grabDx = 0; // grabbed exactly at the se corner
    const grabDy = 0;

    // Move 1: drag left/up a bit, still on the se side of the anchor.
    const m1 = resizeMaskRect(fixedX, fixedY, 0.55, 0.55, grabDx, grabDy);
    expect(m1.x).toBeCloseTo(0.4, 10);
    expect(m1.y).toBeCloseTo(0.4, 10);
    expect(m1.w).toBeCloseTo(0.15, 10);
    expect(m1.h).toBeCloseTo(0.15, 10);

    // Move 2: cross the anchor leftward/upward — pointer now at (0.2, 0.2),
    // left of and above the anchor (0.4, 0.4). The rect must grow from the
    // anchor toward the new pointer position, not freeze at move 1's edge.
    const m2 = resizeMaskRect(fixedX, fixedY, 0.2, 0.2, grabDx, grabDy);
    expect(m2.x).toBeCloseTo(0.2, 10);
    expect(m2.y).toBeCloseTo(0.2, 10);
    expect(m2.w).toBeCloseTo(0.2, 10);
    expect(m2.h).toBeCloseTo(0.2, 10);

    // Move 3: keep dragging further past the anchor — the rect must keep
    // growing from the SAME (0.4, 0.4) anchor, not from move 2's edge.
    const m3 = resizeMaskRect(fixedX, fixedY, 0.05, 0.1, grabDx, grabDy);
    expect(m3.x).toBeCloseTo(0.05, 10);
    expect(m3.y).toBeCloseTo(0.1, 10);
    expect(m3.w).toBeCloseTo(0.35, 10);
    expect(m3.h).toBeCloseTo(0.3, 10);

    // Move 4: drag back right past the anchor again — should shrink back
    // down cleanly, still anchored at (0.4, 0.4), confirming the anchor
    // never moved across the whole back-and-forth gesture.
    const m4 = resizeMaskRect(fixedX, fixedY, 0.5, 0.45, grabDx, grabDy);
    expect(m4.x).toBeCloseTo(0.4, 10);
    expect(m4.y).toBeCloseTo(0.4, 10);
    expect(m4.w).toBeCloseTo(0.1, 10);
    expect(m4.h).toBeCloseTo(0.05, 10);
  });

  // Zero-movement invariant still holds across a crossover-capable gesture:
  // re-grabbing (fresh fixedX/fixedY + grabDx/grabDy) at the CURRENT dragged
  // corner and issuing a zero-movement move must reproduce that exact rect.
  test("zero-movement invariant holds after a crossover move", () => {
    const fixedX = 0.4;
    const fixedY = 0.4;
    const afterCrossover = resizeMaskRect(fixedX, fixedY, 0.2, 0.2, 0, 0);
    expect(afterCrossover).toEqual({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
    // Re-grab at the new dragged corner (nw of the flipped rect, since se
    // crossed to become the min corner) with zero offset and zero movement.
    const noop = resizeMaskRect(fixedX, fixedY, 0.2, 0.2, 0, 0);
    expect(noop).toEqual(afterCrossover);
  });

  // Finding 3: dragging a corner exactly onto (or past) the anchor must not
  // collapse w/h to 0 — clampMasks would silently drop a zero-area mask,
  // clearing the selection mid-drag. MASK_MIN_SIZE floors the span, anchored
  // on the fixed side.
  describe("MASK_MIN_SIZE floor (Finding 3 — exact collapse doesn't zero out the rect)", () => {
    test("dragging the corner exactly onto the anchor floors both axes to MASK_MIN_SIZE", () => {
      // Anchor (nw) at (0.4, 0.4); drag se corner exactly onto the anchor.
      const out = resizeMaskRect(0.4, 0.4, 0.4, 0.4, 0, 0);
      expect(out.w).toBeGreaterThanOrEqual(MASK_MIN_SIZE);
      expect(out.h).toBeGreaterThanOrEqual(MASK_MIN_SIZE);
      expect(out.w).toBeCloseTo(MASK_MIN_SIZE, 10);
      expect(out.h).toBeCloseTo(MASK_MIN_SIZE, 10);
    });

    test("collapse at an edge-flush anchor still floors to MASK_MIN_SIZE by growing into the interior", () => {
      // Rect flush against the right/bottom edge: anchor (nw, since we're
      // dragging se) sits at x+w=1 — pushing the dragged point "out" past 1
      // on the naive side would clamp back to 1 and still collapse. The
      // floor must fall back to growing the rect leftward/upward instead.
      const fixedX = 1; // anchor pinned at the right edge
      const fixedY = 1; // anchor pinned at the bottom edge
      // Drag se corner past the right/bottom edge (clamped to 1,1 — same as
      // the anchor) so naive flooring on the "preferred" side has no room.
      const out = resizeMaskRect(fixedX, fixedY, 5, 5, 0, 0);
      expect(out.w).toBeCloseTo(MASK_MIN_SIZE, 10);
      expect(out.h).toBeCloseTo(MASK_MIN_SIZE, 10);
      // The anchor (fixed corner) must not have moved: x+w and y+h stay at 1.
      expect(out.x + out.w).toBeCloseTo(1, 10);
      expect(out.y + out.h).toBeCloseTo(1, 10);
    });

    test("a drag that already exceeds MASK_MIN_SIZE is unaffected by the floor", () => {
      const out = resizeMaskRect(0.2, 0.2, 0.6, 0.6, 0, 0);
      expect(out.x).toBeCloseTo(0.2, 10);
      expect(out.y).toBeCloseTo(0.2, 10);
      expect(out.w).toBeCloseTo(0.4, 10);
      expect(out.h).toBeCloseTo(0.4, 10);
    });
  });
});

describe("clampTrim", () => {
  test("null passthrough", () => {
    expect(clampTrim(null, 10000)).toBeNull();
  });

  test("clamps both ends into [0, durationMs]", () => {
    expect(clampTrim({ startMs: -500, endMs: 5000 }, 10000)).toEqual({
      startMs: 0,
      endMs: 5000,
    });
    expect(clampTrim({ startMs: 1000, endMs: 99999 }, 10000)).toEqual({
      startMs: 1000,
      endMs: 10000,
    });
    expect(clampTrim({ startMs: -500, endMs: 99999 }, 10000)).toEqual({
      startMs: 0,
      endMs: 10000,
    });
  });

  test("enforces start < end with min length 500ms", () => {
    // start and end collapse to the same point -> push end out by 500ms
    expect(clampTrim({ startMs: 4000, endMs: 4000 }, 10000)).toEqual({
      startMs: 4000,
      endMs: 4500,
    });
    // gap smaller than 500ms gets widened
    expect(clampTrim({ startMs: 4000, endMs: 4100 }, 10000)).toEqual({
      startMs: 4000,
      endMs: 4500,
    });
  });

  test("widening for min length clamps back within duration when near the end", () => {
    // start near duration end; widening end would overflow, so pull start back instead
    expect(clampTrim({ startMs: 9900, endMs: 9950 }, 10000)).toEqual({
      startMs: 9500,
      endMs: 10000,
    });
  });

  test("returns null when durationMs < 500 (impossible to satisfy min length)", () => {
    expect(clampTrim({ startMs: 0, endMs: 100 }, 400)).toBeNull();
    expect(clampTrim(null, 400)).toBeNull();
  });

  test("ordering fixed if inverted", () => {
    expect(clampTrim({ startMs: 8000, endMs: 2000 }, 10000)).toEqual({
      startMs: 2000,
      endMs: 8000,
    });
  });

  test("values rounded to integers", () => {
    expect(clampTrim({ startMs: 100.4, endMs: 5000.6 }, 10000)).toEqual({
      startMs: 100,
      endMs: 5001,
    });
  });
});

describe("round-trip stability", () => {
  test("default -> stringify -> parse == default", () => {
    const d = defaultProject();
    expect(parseProject(JSON.stringify(d))).toEqual(d);
  });

  test("a fully-populated project round-trips unchanged", () => {
    const full = {
      v: 1 as const,
      trim: { startMs: 250, endMs: 12000 },
      appearance: {
        padding: 120,
        cornerRadius: 24,
        aspect: "16:9" as const,
        background: { type: "image" as const, path: "/abs/bg.jpg" },
      },
      cursor: { enabled: true, scale: 2, smoothing: 0.4, hideIdle: true },
      webcam: {
        show: true,
        shape: "rounded" as const,
        corner: "bl" as const,
        sizeFrac: 0.25,
        autoShrink: true,
        mirror: true,
        scenes: [{ id: "s1", startMs: 500, endMs: 2500 }],
      },
      zoom: {
        mode: "custom" as const,
        blocks: [
          { startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual" as const, id: "z1" },
        ],
      },
      speed: [{ startMs: 0, endMs: 1000, rate: 2 }],
      keystrokes: { enabled: true, allKeys: true },
      captions: {
        enabled: true,
        segments: [{ startMs: 0, endMs: 1000, text: "hello there" }],
      },
      audio: { normalizeLoudness: true },
      motionBlur: true,
      masks: [
        { id: "m1", startMs: 0, endMs: 1000, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, kind: "pixelate" as const },
        { id: "m2", startMs: 500, endMs: 1500, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: "highlight" as const },
      ],
    };
    const once = parseProject(JSON.stringify(full));
    const twice = parseProject(JSON.stringify(once));
    expect(twice).toEqual(once);
    expect(once).toEqual(full);
  });

  test("pre-M6 project JSON (webcam without autoShrink/mirror/scenes) parses to identical render behavior", () => {
    // Fixture shape captured from a pre-M6 serialized project — webcam has
    // only the M1 fields (show/shape/corner/sizeFrac), no autoShrink/mirror/
    // scenes yet.
    const preM6Json = JSON.stringify({
      v: 1,
      trim: { startMs: 250, endMs: 12000 },
      appearance: {
        padding: 120,
        cornerRadius: 24,
        aspect: "16:9",
        background: { type: "image", path: "/abs/bg.jpg" },
      },
      cursor: { enabled: true, scale: 2, smoothing: 0.4, hideIdle: true },
      webcam: { show: true, shape: "rounded", corner: "bl", sizeFrac: 0.25 },
      zoom: {
        mode: "custom",
        blocks: [
          { startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual", id: "z1" },
        ],
      },
      speed: [{ startMs: 0, endMs: 1000, rate: 2 }],
      keystrokes: { enabled: true, allKeys: true },
      captions: {
        enabled: true,
        segments: [{ startMs: 0, endMs: 1000, text: "hello there" }],
      },
      audio: { normalizeLoudness: true },
      motionBlur: true,
    });
    const p = parseProject(preM6Json);

    // Pre-existing webcam fields are byte-for-byte unchanged.
    expect(p.webcam!.show).toBe(true);
    expect(p.webcam!.shape).toBe("rounded");
    expect(p.webcam!.corner).toBe("bl");
    expect(p.webcam!.sizeFrac).toBe(0.25);

    // New M6 fields default OFF/neutral so render behavior is unchanged.
    expect(p.webcam!.autoShrink).toBe(false);
    expect(p.webcam!.mirror).toBe(false);
    expect(p.webcam!.scenes).toEqual([]);

    // Everything else is untouched.
    expect(p.trim).toEqual({ startMs: 250, endMs: 12000 });
    expect(p.zoom).toEqual({
      mode: "custom",
      blocks: [{ startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual", id: "z1" }],
    });

    // The M5 masks field is absent in the fixture → defaults to [] (no masks).
    expect(p.masks).toEqual([]);
  });

  test("pre-M4 project JSON (no captions/audio/motionBlur/smoothing/hideIdle) parses to identical render behavior", () => {
    // Fixture shape captured from a pre-M4 serialized project (mirrors the
    // M3 "keystrokes" fixture shape, before this task's fields existed).
    const preM4Json = JSON.stringify({
      v: 1,
      trim: { startMs: 250, endMs: 12000 },
      appearance: {
        padding: 120,
        cornerRadius: 24,
        aspect: "16:9",
        background: { type: "image", path: "/abs/bg.jpg" },
      },
      cursor: { enabled: true, scale: 2 },
      webcam: { show: true, shape: "rounded", corner: "bl", sizeFrac: 0.25 },
      zoom: {
        mode: "custom",
        blocks: [
          { startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual", id: "z1" },
        ],
      },
      speed: [{ startMs: 0, endMs: 1000, rate: 2 }],
      keystrokes: { enabled: true, allKeys: true },
    });
    const p = parseProject(preM4Json);

    // Pre-existing fields are byte-for-byte unchanged.
    expect(p.trim).toEqual({ startMs: 250, endMs: 12000 });
    expect(p.appearance).toEqual({
      padding: 120,
      cornerRadius: 24,
      aspect: "16:9",
      background: { type: "image", path: "/abs/bg.jpg" },
    });
    expect(p.cursor.enabled).toBe(true);
    expect(p.cursor.scale).toBe(2);
    expect(p.webcam).toEqual({
      show: true,
      shape: "rounded",
      corner: "bl",
      sizeFrac: 0.25,
      // New M6 fields default OFF/neutral (see the dedicated pre-M6 fixture
      // test below for the full-project version of this pin).
      autoShrink: false,
      mirror: false,
      scenes: [],
    });
    expect(p.zoom).toEqual({
      mode: "custom",
      blocks: [{ startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual", id: "z1" }],
    });
    expect(p.speed).toEqual([{ startMs: 0, endMs: 1000, rate: 2 }]);
    expect(p.keystrokes).toEqual({ enabled: true, allKeys: true });

    // New M4 fields default OFF/neutral so render behavior is unchanged.
    expect(p.captions).toEqual({ enabled: false, segments: null });
    expect(p.audio).toEqual({ normalizeLoudness: false });
    expect(p.motionBlur).toBe(false);
    expect(p.cursor.smoothing).toBe(0);
    expect(p.cursor.hideIdle).toBe(false);

    // New M5 masks field defaults to [] so render behavior is unchanged.
    expect(p.masks).toEqual([]);
  });
});

describe("clampZoomCenter", () => {
  test("scale 1 pins both axes to 0.5 (whole-frame)", () => {
    expect(clampZoomCenter(0.1, 0.9, 1)).toEqual({ cx: 0.5, cy: 0.5 });
  });

  test("scale 2 clamps into [0.25, 0.75]", () => {
    expect(clampZoomCenter(0.0, 1.0, 2)).toEqual({ cx: 0.25, cy: 0.75 });
    expect(clampZoomCenter(0.5, 0.5, 2)).toEqual({ cx: 0.5, cy: 0.5 });
  });

  test("scale 3 clamps into [1/6, 5/6]", () => {
    const c = clampZoomCenter(0, 1, 3);
    expect(c.cx).toBeCloseTo(1 / 6);
    expect(c.cy).toBeCloseTo(5 / 6);
  });

  test("non-finite center falls back to 0.5", () => {
    expect(clampZoomCenter(NaN, Infinity, 2)).toEqual({ cx: 0.5, cy: 0.5 });
  });

  test("non-positive scale treated as 1", () => {
    expect(clampZoomCenter(0.2, 0.8, 0)).toEqual({ cx: 0.5, cy: 0.5 });
  });
});

describe("nextZoomBlockId", () => {
  test("empty -> z1", () => {
    expect(nextZoomBlockId([])).toBe("z1");
  });

  test("one past the max numeric suffix (z-ids)", () => {
    expect(nextZoomBlockId([zb(0, 1000, { id: "z1" }), zb(2000, 3000, { id: "z3" })])).toBe("z4");
  });

  test("counts trailing integers regardless of prefix", () => {
    expect(nextZoomBlockId([zb(0, 1000, { id: "z2" }), zb(2000, 3000, { id: "m7" })])).toBe("z8");
  });

  test("id-less blocks ignored (fresh auto blocks) -> z1", () => {
    expect(nextZoomBlockId([zb(0, 1000), zb(2000, 3000)])).toBe("z1");
  });

  test("deterministic (not time-based): same input -> same id", () => {
    const blocks = [zb(0, 1000, { id: "z5" })];
    expect(nextZoomBlockId(blocks)).toBe(nextZoomBlockId(blocks));
  });
});

describe("resizeZoomBlock", () => {
  const three = [zb(0, 2000, { id: "z1" }), zb(3000, 5000, { id: "z2" }), zb(6000, 8000, { id: "z3" })];

  test("resize end within bounds", () => {
    const out = resizeZoomBlock(three, 1, "end", 5500, 10000);
    expect(out[1].endMs).toBe(5500);
    expect(out[0]).toBe(three[0]); // untouched blocks are the same reference
    expect(out[2]).toBe(three[2]);
  });

  test("resize start stops at previous neighbour's end (no overlap)", () => {
    // z2 start dragged left past z1.end (2000) -> clamps to 2000, butting up.
    const out = resizeZoomBlock(three, 1, "start", 500, 10000);
    expect(out[1].startMs).toBe(2000);
    expect(out[1].endMs).toBe(5000);
  });

  test("resize end stops at next neighbour's start (no overlap)", () => {
    // z2 end dragged right past z3.start (6000) -> clamps to 6000.
    const out = resizeZoomBlock(three, 1, "end", 9000, 10000);
    expect(out[1].endMs).toBe(6000);
  });

  test("resize enforces the 500ms minimum length", () => {
    // Drag z2's end down toward its start (3000); floor is 3000+500=3500.
    const out = resizeZoomBlock(three, 1, "end", 3100, 10000);
    expect(out[1].endMs).toBe(3000 + ZOOM_MIN_LENGTH_MS);
    // Drag z2's start up toward its end (5000); ceiling is 5000-500=4500.
    const out2 = resizeZoomBlock(three, 1, "start", 4900, 10000);
    expect(out2[1].startMs).toBe(5000 - ZOOM_MIN_LENGTH_MS);
  });

  test("start edge clamps to 0; end edge clamps to duration", () => {
    expect(resizeZoomBlock(three, 0, "start", -1000, 10000)[0].startMs).toBe(0);
    expect(resizeZoomBlock(three, 2, "end", 99999, 10000)[2].endMs).toBe(10000);
  });

  test("no-op edit returns the same array reference", () => {
    expect(resizeZoomBlock(three, 1, "end", 5000, 10000)).toBe(three);
  });

  test("out-of-range index returns input unchanged", () => {
    expect(resizeZoomBlock(three, 9, "end", 5000, 10000)).toBe(three);
  });

  test("never drops blocks", () => {
    const out = resizeZoomBlock(three, 1, "start", -5000, 10000);
    expect(out.length).toBe(3);
  });
});

describe("moveZoomBlock", () => {
  const three = [zb(0, 2000, { id: "z1" }), zb(3000, 5000, { id: "z2" }), zb(7000, 9000, { id: "z3" })];

  test("moves body preserving length", () => {
    const out = moveZoomBlock(three, 1, 4000, 10000);
    expect(out[1]).toMatchObject({ startMs: 4000, endMs: 6000 });
  });

  test("stops when trailing edge would cross previous neighbour", () => {
    // z2 (len 2000) dragged left; can't start before z1.end (2000).
    const out = moveZoomBlock(three, 1, 0, 10000);
    expect(out[1]).toMatchObject({ startMs: 2000, endMs: 4000 });
  });

  test("stops when leading edge would cross next neighbour", () => {
    // z2 (len 2000) dragged right; leading edge can't pass z3.start (7000),
    // so start caps at 7000-2000=5000.
    const out = moveZoomBlock(three, 1, 9000, 10000);
    expect(out[1]).toMatchObject({ startMs: 5000, endMs: 7000 });
  });

  test("first/last block clamp to timeline bounds", () => {
    expect(moveZoomBlock(three, 0, -1000, 10000)[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    // z3 len 2000; can't exceed duration 10000, so start caps at 8000.
    expect(moveZoomBlock(three, 2, 99999, 10000)[2]).toMatchObject({ startMs: 8000, endMs: 10000 });
  });

  test("no-op move returns the same array reference", () => {
    expect(moveZoomBlock(three, 1, 3000, 10000)).toBe(three);
  });

  test("never drops or reorders blocks", () => {
    const out = moveZoomBlock(three, 1, 4000, 10000);
    expect(out.map((b) => b.id)).toEqual(["z1", "z2", "z3"]);
  });
});

describe("placeZoomBlock", () => {
  test("empty timeline: places 2s block at the (clamped) playhead", () => {
    expect(placeZoomBlock([], 3000, 2000, 10000)).toEqual({ startMs: 3000, endMs: 5000 });
  });

  test("clamps a late playhead so the block fits before the end", () => {
    expect(placeZoomBlock([], 9500, 2000, 10000)).toEqual({ startMs: 8000, endMs: 10000 });
  });

  test("pushes past an overlapping block into the next gap", () => {
    // A block at [2000,4000]; playhead 2500 lands inside it → push to 4000.
    const blocks = [zb(2000, 4000, { id: "z1" })];
    expect(placeZoomBlock(blocks, 2500, 2000, 10000)).toEqual({ startMs: 4000, endMs: 6000 });
  });

  test("shrinks the block into a gap that is narrower than the default length", () => {
    // Gap [2000,3000] (1000ms) sits between [0,2000] and [3000,5000]; the
    // playhead is in it. The 2000ms request pushes past nothing (2000 doesn't
    // overlap [0,2000]) but the window [2000,4000] overlaps [3000,5000], so it
    // pushes to 5000 → lands in the open tail after the last block.
    const blocks = [zb(0, 2000, { id: "z1" }), zb(3000, 5000, { id: "z2" })];
    expect(placeZoomBlock(blocks, 2000, 2000, 10000)).toEqual({ startMs: 5000, endMs: 7000 });
  });

  test("caps end at the next block when start is clear but the window overruns", () => {
    // Only one block at [4000,6000]; playhead 1000, length 2000 → [1000,3000]
    // is fully clear (ends before 4000), no push, no cap needed.
    expect(placeZoomBlock([zb(4000, 6000, { id: "z1" })], 1000, 2000, 10000)).toEqual({
      startMs: 1000,
      endMs: 3000,
    });
    // Now length 4000 → [1000,5000] overlaps [4000,6000] → push to 6000.
    expect(placeZoomBlock([zb(4000, 6000, { id: "z1" })], 1000, 4000, 12000)).toEqual({
      startMs: 6000,
      endMs: 10000,
    });
  });

  test("returns null when no gap ≥ min length remains", () => {
    // Two blocks leave only a 200ms gap at [2000,2200].
    const blocks = [zb(0, 2000, { id: "z1" }), zb(2200, 5000, { id: "z2" })];
    expect(placeZoomBlock(blocks, 2000, 2000, 5000)).toBeNull();
  });

  test("returns null when the timeline is shorter than the minimum", () => {
    expect(placeZoomBlock([], 0, 2000, ZOOM_MIN_LENGTH_MS - 1)).toBeNull();
  });
});

// ---- Generic range helpers (M6 extraction) -------------------------------
//
// nextRangeId/moveRange/resizeRange/placeRange are the generic core the zoom
// helpers above (and the webcam scene helpers below) are thin wrappers over.
// These tests exercise the SAME edge cases as the zoom describe blocks above,
// just against the bare `{id,startMs,endMs}` shape with a configurable
// min-length + id prefix, proving the core is behavior-identical to what the
// zoom wrappers already guarantee.

/** A bare range literal helper for the generic core. */
function rg(id: string, startMs: number, endMs: number): { id: string; startMs: number; endMs: number } {
  return { id, startMs, endMs };
}

const RG_MIN = 500;

describe("nextRangeId", () => {
  test("empty -> prefix+1", () => {
    expect(nextRangeId([], "s")).toBe("s1");
  });

  test("one past the max numeric suffix", () => {
    expect(nextRangeId([rg("s1", 0, 1000), rg("s3", 2000, 3000)], "s")).toBe("s4");
  });

  test("counts trailing integers regardless of prefix", () => {
    expect(nextRangeId([rg("s2", 0, 1000), rg("m7", 2000, 3000)], "s")).toBe("s8");
  });

  test("id-less ranges ignored -> prefix+1", () => {
    expect(nextRangeId([{ startMs: 0, endMs: 1000 } as any, { startMs: 2000, endMs: 3000 } as any], "s")).toBe(
      "s1",
    );
  });

  test("deterministic (not time-based): same input -> same id", () => {
    const ranges = [rg("s5", 0, 1000)];
    expect(nextRangeId(ranges, "s")).toBe(nextRangeId(ranges, "s"));
  });
});

describe("resizeRange", () => {
  const three = [rg("s1", 0, 2000), rg("s2", 3000, 5000), rg("s3", 6000, 8000)];

  test("resize end within bounds", () => {
    const out = resizeRange(three, 1, "end", 5500, 10000, RG_MIN);
    expect(out[1].endMs).toBe(5500);
    expect(out[0]).toBe(three[0]);
    expect(out[2]).toBe(three[2]);
  });

  test("resize start stops at previous neighbour's end (no overlap)", () => {
    const out = resizeRange(three, 1, "start", 500, 10000, RG_MIN);
    expect(out[1].startMs).toBe(2000);
    expect(out[1].endMs).toBe(5000);
  });

  test("resize end stops at next neighbour's start (no overlap)", () => {
    const out = resizeRange(three, 1, "end", 9000, 10000, RG_MIN);
    expect(out[1].endMs).toBe(6000);
  });

  test("resize enforces the minimum length", () => {
    const out = resizeRange(three, 1, "end", 3100, 10000, RG_MIN);
    expect(out[1].endMs).toBe(3000 + RG_MIN);
    const out2 = resizeRange(three, 1, "start", 4900, 10000, RG_MIN);
    expect(out2[1].startMs).toBe(5000 - RG_MIN);
  });

  test("start edge clamps to 0; end edge clamps to duration", () => {
    expect(resizeRange(three, 0, "start", -1000, 10000, RG_MIN)[0].startMs).toBe(0);
    expect(resizeRange(three, 2, "end", 99999, 10000, RG_MIN)[2].endMs).toBe(10000);
  });

  test("no-op edit returns the same array reference", () => {
    expect(resizeRange(three, 1, "end", 5000, 10000, RG_MIN)).toBe(three);
  });

  test("out-of-range index returns input unchanged", () => {
    expect(resizeRange(three, 9, "end", 5000, 10000, RG_MIN)).toBe(three);
  });

  test("never drops ranges", () => {
    const out = resizeRange(three, 1, "start", -5000, 10000, RG_MIN);
    expect(out.length).toBe(3);
  });
});

describe("moveRange", () => {
  const three = [rg("s1", 0, 2000), rg("s2", 3000, 5000), rg("s3", 7000, 9000)];

  test("moves body preserving length", () => {
    const out = moveRange(three, 1, 4000, 10000);
    expect(out[1]).toMatchObject({ startMs: 4000, endMs: 6000 });
  });

  test("stops when trailing edge would cross previous neighbour", () => {
    const out = moveRange(three, 1, 0, 10000);
    expect(out[1]).toMatchObject({ startMs: 2000, endMs: 4000 });
  });

  test("stops when leading edge would cross next neighbour", () => {
    const out = moveRange(three, 1, 9000, 10000);
    expect(out[1]).toMatchObject({ startMs: 5000, endMs: 7000 });
  });

  test("first/last range clamp to timeline bounds", () => {
    expect(moveRange(three, 0, -1000, 10000)[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(moveRange(three, 2, 99999, 10000)[2]).toMatchObject({ startMs: 8000, endMs: 10000 });
  });

  test("no-op move returns the same array reference", () => {
    expect(moveRange(three, 1, 3000, 10000)).toBe(three);
  });

  test("never drops or reorders ranges", () => {
    const out = moveRange(three, 1, 4000, 10000);
    expect(out.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("placeRange", () => {
  test("empty timeline: places a 2s range at the (clamped) playhead", () => {
    expect(placeRange([], 3000, 2000, 10000, RG_MIN)).toEqual({ startMs: 3000, endMs: 5000 });
  });

  test("clamps a late playhead so the range fits before the end", () => {
    expect(placeRange([], 9500, 2000, 10000, RG_MIN)).toEqual({ startMs: 8000, endMs: 10000 });
  });

  test("pushes past an overlapping range into the next gap", () => {
    const ranges = [rg("s1", 2000, 4000)];
    expect(placeRange(ranges, 2500, 2000, 10000, RG_MIN)).toEqual({ startMs: 4000, endMs: 6000 });
  });

  test("shrinks the range into a gap that is narrower than the default length", () => {
    const ranges = [rg("s1", 0, 2000), rg("s2", 3000, 5000)];
    expect(placeRange(ranges, 2000, 2000, 10000, RG_MIN)).toEqual({ startMs: 5000, endMs: 7000 });
  });

  test("caps end at the next range when start is clear but the window overruns", () => {
    expect(placeRange([rg("s1", 4000, 6000)], 1000, 2000, 10000, RG_MIN)).toEqual({
      startMs: 1000,
      endMs: 3000,
    });
    expect(placeRange([rg("s1", 4000, 6000)], 1000, 4000, 12000, RG_MIN)).toEqual({
      startMs: 6000,
      endMs: 10000,
    });
  });

  test("returns null when no gap >= min length remains", () => {
    const ranges = [rg("s1", 0, 2000), rg("s2", 2200, 5000)];
    expect(placeRange(ranges, 2000, 2000, 5000, RG_MIN)).toBeNull();
  });

  test("returns null when the timeline is shorter than the minimum", () => {
    expect(placeRange([], 0, 2000, RG_MIN - 1, RG_MIN)).toBeNull();
  });
});

// ---- Webcam scene helpers (M6) — thin wrappers over the generic core -----
//
// Same edge cases as the zoom describe blocks above, proving scenes share
// zoom's exact editing semantics via the extracted core (SCENE_MIN_LENGTH_MS,
// id prefix "s").

describe("nextRangeId for scenes (empty/non-empty determinism)", () => {
  test("empty scenes -> s1", () => {
    expect(nextRangeId([], "s")).toBe("s1");
  });

  test("non-empty scenes -> one past the max suffix", () => {
    expect(nextRangeId([scene(0, 1000, "s1"), scene(2000, 3000, "s4")], "s")).toBe("s5");
  });
});

describe("placeRange for scenes — place-past-overlap + min length", () => {
  test("pushes past an overlapping scene into the next gap", () => {
    const scenes = [scene(2000, 4000, "s1")];
    expect(placeRange(scenes, 2500, 2000, 10000, SCENE_MIN_LENGTH_MS)).toEqual({
      startMs: 4000,
      endMs: 6000,
    });
  });

  test("returns null when no gap >= SCENE_MIN_LENGTH_MS remains", () => {
    const scenes = [scene(0, 2000, "s1"), scene(2200, 5000, "s2")];
    expect(placeRange(scenes, 2000, 2000, 5000, SCENE_MIN_LENGTH_MS)).toBeNull();
  });

  test("returns null when the timeline is shorter than SCENE_MIN_LENGTH_MS", () => {
    expect(placeRange([], 0, 2000, SCENE_MIN_LENGTH_MS - 1, SCENE_MIN_LENGTH_MS)).toBeNull();
  });
});

describe("resizeRange for scenes — clamp at edges + min length + stop-at-neighbor", () => {
  const three = [scene(0, 2000, "s1"), scene(3000, 5000, "s2"), scene(6000, 8000, "s3")];

  test("start edge clamps to 0; end edge clamps to duration", () => {
    expect(resizeRange(three, 0, "start", -1000, 10000, SCENE_MIN_LENGTH_MS)[0].startMs).toBe(0);
    expect(resizeRange(three, 2, "end", 99999, 10000, SCENE_MIN_LENGTH_MS)[2].endMs).toBe(10000);
  });

  test("resize enforces SCENE_MIN_LENGTH_MS", () => {
    const out = resizeRange(three, 1, "end", 3100, 10000, SCENE_MIN_LENGTH_MS);
    expect(out[1].endMs).toBe(3000 + SCENE_MIN_LENGTH_MS);
  });

  test("resize stops at neighbour (no overlap)", () => {
    const out = resizeRange(three, 1, "end", 9000, 10000, SCENE_MIN_LENGTH_MS);
    expect(out[1].endMs).toBe(6000);
    const out2 = resizeRange(three, 1, "start", 500, 10000, SCENE_MIN_LENGTH_MS);
    expect(out2[1].startMs).toBe(2000);
  });
});

describe("buildSpeedMap", () => {
  test("identity when there are no ranges", () => {
    const m = buildSpeedMap([], 10_000);
    expect(m.outDurationMs).toBe(10_000);
    expect(m.srcToOut(0)).toBe(0);
    expect(m.srcToOut(5_000)).toBe(5_000);
    expect(m.srcToOut(10_000)).toBe(10_000);
  });

  test("a single 2x range contributes half its source duration to output", () => {
    // Range [2000,6000) @2x: 4000ms of source → 2000ms of output.
    const m = buildSpeedMap([sr(2_000, 6_000, 2)], 10_000);
    // Total output = 2000 (before) + 2000 (sped span) + 4000 (after) = 8000.
    expect(m.outDurationMs).toBe(8_000);
    // srcToOut(duration) === outDurationMs.
    expect(m.srcToOut(10_000)).toBe(8_000);
  });

  test("2x range: boundaries exact and midpoint piecewise-linear", () => {
    const m = buildSpeedMap([sr(2_000, 6_000, 2)], 10_000);
    // Before the range: identity.
    expect(m.srcToOut(0)).toBe(0);
    expect(m.srcToOut(1_000)).toBe(1_000);
    // Exactly at the range start (boundary): identity value carried through.
    expect(m.srcToOut(2_000)).toBe(2_000);
    // Midpoint of the range (srcT=4000): 2000ms into the range @2x → +1000ms.
    expect(m.srcToOut(4_000)).toBe(3_000);
    // Exactly at the range end (boundary): 2000 + 4000/2 = 4000.
    expect(m.srcToOut(6_000)).toBe(4_000);
    // After the range: identity slope resumes (+1ms per +1ms source).
    expect(m.srcToOut(7_000)).toBe(5_000);
    expect(m.srcToOut(10_000)).toBe(8_000);
  });

  test("monotonic non-decreasing across the whole domain", () => {
    const m = buildSpeedMap([sr(2_000, 6_000, 2), sr(7_000, 9_000, 0.5)], 12_000);
    let prev = -1;
    for (let t = 0; t <= 12_000; t += 100) {
      const v = m.srcToOut(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("multiple ranges accumulate independently", () => {
    // [1000,3000)@2x (2000ms→1000ms) and [5000,7000)@4x (2000ms→500ms).
    const m = buildSpeedMap([sr(1_000, 3_000, 2), sr(5_000, 7_000, 4)], 10_000);
    // out(1000)=1000 (identity before first range).
    expect(m.srcToOut(1_000)).toBe(1_000);
    // out(3000)=1000 + 2000/2 = 2000.
    expect(m.srcToOut(3_000)).toBe(2_000);
    // out(5000)=2000 + 2000 (identity gap) = 4000.
    expect(m.srcToOut(5_000)).toBe(4_000);
    // out(7000)=4000 + 2000/4 = 4500.
    expect(m.srcToOut(7_000)).toBe(4_500);
    // out(10000)=4500 + 3000 (identity tail) = 7500.
    expect(m.srcToOut(10_000)).toBe(7_500);
    expect(m.outDurationMs).toBe(7_500);
  });

  test("rate < 1 (slowdown) lengthens output", () => {
    // [2000,4000)@0.5x: 2000ms of source → 4000ms of output.
    const m = buildSpeedMap([sr(2_000, 4_000, 0.5)], 6_000);
    // out(4000)=2000 + 2000/0.5 = 6000.
    expect(m.srcToOut(4_000)).toBe(6_000);
    // out(6000)=6000 + 2000 identity tail = 8000 > 6000 source duration.
    expect(m.srcToOut(6_000)).toBe(8_000);
    expect(m.outDurationMs).toBe(8_000);
  });

  test("srcToOut(duration) always equals outDurationMs", () => {
    const cases: SpeedRange[][] = [
      [],
      [sr(0, 10_000, 2)],
      [sr(0, 5_000, 4), sr(5_000, 10_000, 0.5)],
      [sr(1_000, 2_000, 3)],
    ];
    for (const ranges of cases) {
      const m = buildSpeedMap(ranges, 10_000);
      expect(m.srcToOut(10_000)).toBeCloseTo(m.outDurationMs, 6);
    }
  });

  test("a range touching the start (srcT=0) still maps 0→0", () => {
    const m = buildSpeedMap([sr(0, 4_000, 2)], 10_000);
    expect(m.srcToOut(0)).toBe(0);
    expect(m.srcToOut(4_000)).toBe(2_000);
    expect(m.outDurationMs).toBe(8_000);
  });

  test("clamps srcMs into [0, durationMs] before mapping", () => {
    const m = buildSpeedMap([sr(2_000, 6_000, 2)], 10_000);
    expect(m.srcToOut(-100)).toBe(0);
    expect(m.srcToOut(99_999)).toBe(m.outDurationMs);
  });

  test("tolerates unsorted / out-of-range input (clamps first)", () => {
    // Same math as the sorted single-2x case even though passed unsorted-ish.
    const m = buildSpeedMap([sr(6_000, 2_000, 2)], 10_000);
    // Inverted range is dropped by the clamp step → identity map.
    expect(m.outDurationMs).toBe(10_000);
    expect(m.srcToOut(5_000)).toBe(5_000);
  });
});

describe("shiftRangesForTrim", () => {
  test("no trim → ranges pass through unchanged", () => {
    const ranges = [sr(2_000, 6_000, 2)];
    expect(shiftRangesForTrim(ranges, null)).toEqual(ranges);
  });

  test("shifts ranges into post-trim time base (subtracts trim start)", () => {
    // Trim [1000, 8000): a range at source [2000,6000) becomes [1000,5000).
    const out = shiftRangesForTrim([sr(2_000, 6_000, 2)], { startMs: 1_000, endMs: 8_000 });
    expect(out).toEqual([sr(1_000, 5_000, 2)]);
  });

  test("clips ranges to the trim window", () => {
    // Trim [2000, 7000). Range [1000,4000) clips to source [2000,4000) →
    // post-trim [0,2000). Range [6000,9000) clips to [6000,7000) → [4000,5000).
    const out = shiftRangesForTrim(
      [sr(1_000, 4_000, 2), sr(6_000, 9_000, 3)],
      { startMs: 2_000, endMs: 7_000 },
    );
    expect(out).toEqual([sr(0, 2_000, 2), sr(4_000, 5_000, 3)]);
  });

  test("drops ranges entirely outside the trim window", () => {
    // Trim [3000, 6000). Range [0,2000) is fully before → dropped; range
    // [7000,9000) is fully after → dropped.
    const out = shiftRangesForTrim(
      [sr(0, 2_000, 2), sr(4_000, 5_000, 3), sr(7_000, 9_000, 4)],
      { startMs: 3_000, endMs: 6_000 },
    );
    expect(out).toEqual([sr(1_000, 2_000, 3)]);
  });

  test("drops a range that clips to a degenerate span", () => {
    // Range [5000,5000) is already empty; and a range that only touches the
    // trim start edge [2000,3000) with trim [3000,...) clips to nothing.
    const out = shiftRangesForTrim(
      [sr(2_000, 3_000, 2)],
      { startMs: 3_000, endMs: 8_000 },
    );
    expect(out).toEqual([]);
  });
});

describe("placeSpeedRange", () => {
  test("empty timeline: places a 5s block at the (clamped) playhead", () => {
    expect(placeSpeedRange([], 3_000, 5_000, 30_000)).toEqual({ startMs: 3_000, endMs: 8_000 });
  });

  test("clamps a late playhead so the block fits before the end", () => {
    expect(placeSpeedRange([], 29_000, 5_000, 30_000)).toEqual({ startMs: 25_000, endMs: 30_000 });
  });

  test("returns null when the playhead is inside an existing range", () => {
    const ranges = [sr(2_000, 6_000, 2)];
    // Playhead 4000 sits inside [2000,6000) → no-op.
    expect(placeSpeedRange(ranges, 4_000, 5_000, 30_000)).toBeNull();
    // The start edge counts as inside.
    expect(placeSpeedRange(ranges, 2_000, 5_000, 30_000)).toBeNull();
  });

  test("shrinks the block to the gap when the default length would overrun a neighbour", () => {
    // Free gap [1000,4000) between nothing-before and a range at [4000,...).
    const ranges = [sr(4_000, 8_000, 2)];
    // Playhead 1000, default 5000 would reach 6000 but must stop at 4000.
    expect(placeSpeedRange(ranges, 1_000, 5_000, 30_000)).toEqual({ startMs: 1_000, endMs: 4_000 });
  });

  test("returns null when the resulting gap is below the minimum length", () => {
    // Playhead just before a neighbour: only ~200ms of room.
    const ranges = [sr(1_200, 8_000, 2)];
    expect(placeSpeedRange(ranges, 1_000, 5_000, 30_000)).toBeNull();
  });
});

describe("resizeSpeedRange", () => {
  const three = [sr(0, 2_000, 2), sr(4_000, 6_000, 2), sr(8_000, 10_000, 2)];

  test("moving an edge stops at the neighbour (no overlap)", () => {
    // Grow range 1's start leftward past range 0's end (2000) → stops at 2000.
    const out = resizeSpeedRange(three, 1, "start", 1_000, 12_000);
    expect(out[1].startMs).toBe(2_000);
  });

  test("keeps a minimum length (cannot invert the block)", () => {
    // Drag range 1's end back past its start → capped at start + min length.
    const out = resizeSpeedRange(three, 1, "end", 4_000, 12_000);
    expect(out[1].endMs).toBeGreaterThan(out[1].startMs);
  });

  test("clamps within [0, durationMs]", () => {
    const out = resizeSpeedRange(three, 2, "end", 99_999, 12_000);
    expect(out[2].endMs).toBeLessThanOrEqual(12_000);
  });

  test("no-op resize returns the same array reference", () => {
    expect(resizeSpeedRange(three, 1, "start", 4_000, 12_000)).toBe(three);
  });
});

describe("renderedExportPath", () => {
  test("returns the rendered entry's path", () => {
    const json = JSON.stringify([
      { quality: "720", path: "/r/rec1-720.mp4", size: 1 },
      { quality: "rendered", path: "/r/rec1.rendered.mp4", size: 2 },
    ]);
    expect(renderedExportPath(json)).toBe("/r/rec1.rendered.mp4");
  });

  test("returns null when no rendered entry exists", () => {
    const json = JSON.stringify([{ quality: "720", path: "/r/rec1-720.mp4", size: 1 }]);
    expect(renderedExportPath(json)).toBeNull();
    expect(renderedExportPath("[]")).toBeNull();
  });

  test("tolerates malformed or non-array JSON", () => {
    expect(renderedExportPath("")).toBeNull();
    expect(renderedExportPath("not json")).toBeNull();
    expect(renderedExportPath("{}")).toBeNull();
    // rendered entry with a missing/empty path is treated as absent
    expect(renderedExportPath(JSON.stringify([{ quality: "rendered", size: 2 }]))).toBeNull();
    expect(renderedExportPath(JSON.stringify([{ quality: "rendered", path: "", size: 2 }]))).toBeNull();
  });
});
