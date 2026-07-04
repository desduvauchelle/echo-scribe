import { describe, expect, test } from "bun:test";
import { generateAutoZoom, parseEventsJsonl, type EventsHeader, type RecEvent } from "../src/lib/autoZoom";

const header: EventsHeader = {
  k: "header", v: 1,
  capture: { kind: "display", rect: [0, 0, 1000, 1000], px_scale: 2 },
  screen_h: 1000,
};
const click = (t: number, x: number, y: number): RecEvent => ({ t, k: "down", b: "l", x, y });

describe("parseEventsJsonl", () => {
  test("parses header and events, skips blank/garbage lines", () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify(click(100, 10, 10)),
      "",
      "not json",
      JSON.stringify({ t: 200, k: "move", x: 1, y: 2 }),
    ].join("\n");
    const { header: h, events } = parseEventsJsonl(text);
    expect(h?.capture.rect).toEqual([0, 0, 1000, 1000]);
    expect(events.length).toBe(2);
  });

  test("drops a `down` event missing x/y (shape-invalid, would otherwise NaN-corrupt centroids)", () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify({ t: 100, k: "down", b: "l" }), // missing x, y
      JSON.stringify(click(200, 10, 10)),
    ].join("\n");
    const { events } = parseEventsJsonl(text);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual(click(200, 10, 10));
  });

  test("drops a `down` event with a string x (wrong type, not finite-number)", () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify({ t: 100, k: "down", b: "l", x: "10", y: 10 }),
      JSON.stringify(click(200, 10, 10)),
    ].join("\n");
    const { events } = parseEventsJsonl(text);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual(click(200, 10, 10));
  });

  test("still parses all valid event kinds (move/down/up/scroll/key)", () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify({ t: 1, k: "move", x: 1, y: 2 }),
      JSON.stringify(click(2, 3, 4)),
      JSON.stringify({ t: 3, k: "up", b: "r", x: 5, y: 6 }),
      JSON.stringify({ t: 4, k: "scroll", x: 7, y: 8, dx: 1, dy: -1 }),
      JSON.stringify({ t: 5, k: "key", code: 36, mods: ["cmd"] }),
    ].join("\n");
    const { events } = parseEventsJsonl(text);
    expect(events.length).toBe(5);
  });
});

describe("generateAutoZoom", () => {
  test("no clicks -> no zoom blocks", () => {
    expect(generateAutoZoom(header, [{ t: 5, k: "move", x: 1, y: 1 }], 10000)).toEqual([]);
  });

  test("single click makes one min-length block with lead-in", () => {
    const blocks = generateAutoZoom(header, [click(5000, 500, 500)], 20000);
    expect(blocks.length).toBe(1);
    const b = blocks[0];
    expect(b.startMs).toBe(4200);            // 5000 - 800 lead-in
    expect(b.endMs).toBe(6600);              // 5000 + 1600 hold
    expect(b.cx).toBeCloseTo(0.5);
    expect(b.cy).toBeCloseTo(0.5);
    expect(b.scale).toBe(2.0);
  });

  test("nearby clicks cluster into one block", () => {
    const blocks = generateAutoZoom(header, [click(1000, 400, 400), click(2500, 450, 420)], 30000);
    expect(blocks.length).toBe(1);
    expect(blocks[0].startMs).toBe(200);     // 1000 - 800
    expect(blocks[0].endMs).toBe(4100);      // 2500 + 1600
  });

  test("distant-in-time clicks make separate blocks", () => {
    const blocks = generateAutoZoom(header, [click(1000, 500, 500), click(10000, 500, 500)], 30000);
    expect(blocks.length).toBe(2);
  });

  test("distant-in-space clicks split even when close in time", () => {
    // t=1000 and t=3500 are 2500ms apart (<= clusterGapMs=3000, so time alone
    // would cluster them); only the spatial distance (0.1,0.1)->(0.9,0.9)
    // forces separate clusters. Their expanded lead-in/hold windows
    // ([200,2600] and [2700,5100]) don't overlap, so they stay 2 blocks.
    const blocks = generateAutoZoom(header, [click(1000, 100, 100), click(3500, 900, 900)], 30000);
    expect(blocks.length).toBe(2);
  });

  test("center clamps so viewport stays in frame", () => {
    const blocks = generateAutoZoom(header, [click(5000, 10, 10)], 20000);
    expect(blocks[0].cx).toBeCloseTo(0.25);  // 0.5/scale with scale=2
    expect(blocks[0].cy).toBeCloseTo(0.25);
  });

  test("block end clamps to duration; short block grows to minBlockMs", () => {
    const blocks = generateAutoZoom(header, [click(19900, 500, 500)], 20000);
    expect(blocks[0].endMs).toBe(20000);
    expect(blocks[0].endMs - blocks[0].startMs).toBeGreaterThanOrEqual(2000);
  });

  test("merge centroid weights RAW click coordinates, clamping only once at the end", () => {
    // Reviewer-reported scenario: a 1-click cluster whose raw centroid would
    // clamp on its own, merging (in time) with a 3-click cluster that doesn't
    // need clamping. The merged center must be the single-clamped raw
    // weighted centroid, NOT a re-average of each block's already-clamped
    // center (that bug produced a reachable 5%-of-frame divergence).
    //
    // Arithmetic (scale=2 -> centerLo=0.25, centerHi=0.75):
    //   Cluster A: 1 click at nx=0.05 (ny=0.5), t=1000.
    //     Block A window: startMs = max(0, 1000-800) = 200
    //                      endMs   = 1000+1600        = 2600   (length 2400 >= minBlockMs, no growth)
    //   Cluster B: 3 clicks at nx=0.5 (ny=0.5), t=1050/1060/1070.
    //     dist(nx=0.5, clusterA centroid nx=0.05) = 0.45 > clusterDistFrac(0.25)
    //     -> B does NOT join A's cluster in step 3; it starts its own cluster.
    //     Block B window: startMs = max(0, 1050-800) = 250
    //                      endMs   = 1070+1600        = 2670   (length 2420 >= minBlockMs, no growth)
    //   Blocks overlap after expansion: B.startMs(250) <= A.endMs(2600) -> step 5 merges them.
    //
    //   Raw weighted centroid (click-count weighted, NOT block-count):
    //     cx = (0.05*1 + 0.5*3) / (1+3) = (0.05 + 1.5) / 4 = 1.55 / 4 = 0.3875
    //     0.3875 is already within [0.25, 0.75] -> single clamp is a no-op, cx stays 0.3875.
    //
    //   Old (buggy) behavior clamped each block's center FIRST, then re-averaged:
    //     A's raw 0.05 clamps to 0.25 (out of viewport range); B's 0.5 needs no clamp.
    //     wrong cx = (0.25*1 + 0.5*3) / 4 = (0.25 + 1.5) / 4 = 1.75 / 4 = 0.4375
    //   0.3875 vs 0.4375 is the reviewer's demonstrated 5%-of-frame divergence.
    const blocks = generateAutoZoom(
      header,
      [
        click(1000, 50, 500), // cluster A: nx = 50/1000 = 0.05
        click(1050, 500, 500), // cluster B click 1: nx = 0.5
        click(1060, 500, 500), // cluster B click 2
        click(1070, 500, 500), // cluster B click 3
      ],
      30000,
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0].cx).toBeCloseTo(0.3875, 10);
    expect(blocks[0].cy).toBeCloseTo(0.5, 10);
  });

  test("overlapping blocks merge", () => {
    const blocks = generateAutoZoom(
      header,
      [click(1000, 200, 200), click(4200, 800, 800), click(4300, 810, 810)],
      30000,
    );
    // block1 ends 2600, block2 starts 3400 -> no merge; tighten:
    const merged = generateAutoZoom(
      header,
      [click(1000, 200, 200), click(2000, 800, 800), click(2100, 810, 810)],
      30000,
    );
    expect(merged.length).toBe(1);
    expect(blocks.length).toBe(2);
  });
});
