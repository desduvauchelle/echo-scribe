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
