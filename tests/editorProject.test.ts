import { describe, expect, test } from "bun:test";
import {
  buildSpeedMap,
  clampSpeedRanges,
  clampTrim,
  defaultProject,
  parseProject,
  placeSpeedRange,
  resizeSpeedRange,
  renderedExportPath,
  shiftRangesForTrim,
  clampZoomCenter,
  nextZoomBlockId,
  resizeZoomBlock,
  moveZoomBlock,
  placeZoomBlock,
  ZOOM_MIN_LENGTH_MS,
  type SpeedRange,
} from "../src/lib/editorProject";
import type { ZoomBlock } from "../src/lib/autoZoom";

/** A speed range literal helper. */
function sr(startMs: number, endMs: number, rate: number): SpeedRange {
  return { startMs, endMs, rate };
}

/** A manual zoom block with sane defaults; override any field. */
function zb(startMs: number, endMs: number, over: Partial<ZoomBlock> = {}): ZoomBlock {
  return { startMs, endMs, cx: 0.5, cy: 0.5, scale: 2, mode: "manual", ...over };
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

  test("zoom/speed/keystrokes defaults present", () => {
    const p = defaultProject();
    expect(p.zoom).toEqual({ mode: "auto", blocks: null });
    expect(p.speed).toEqual([]);
    expect(p.keystrokes).toEqual({ enabled: false, allKeys: false });
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
      .toEqual({ enabled: true, scale: 2 });
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
      cursor: { enabled: true, scale: 2 },
      webcam: {
        show: true,
        shape: "rounded" as const,
        corner: "bl" as const,
        sizeFrac: 0.25,
      },
      zoom: {
        mode: "custom" as const,
        blocks: [
          { startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual" as const, id: "z1" },
        ],
      },
      speed: [{ startMs: 0, endMs: 1000, rate: 2 }],
      keystrokes: { enabled: true, allKeys: true },
    };
    const once = parseProject(JSON.stringify(full));
    const twice = parseProject(JSON.stringify(once));
    expect(twice).toEqual(once);
    expect(once).toEqual(full);
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
