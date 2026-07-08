import { describe, expect, test } from "bun:test";
import { clampSpeedRanges, clampTrim, defaultProject, parseProject } from "../src/lib/editorProject";

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
