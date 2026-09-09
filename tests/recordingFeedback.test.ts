import { describe, expect, test } from "bun:test";
import { coverPrivacyMasks, pointerAt } from "../src/lib/recordingFeedback";
import type { EventsHeader, RecEvent } from "../src/lib/autoZoom";
import type { Mask } from "../src/lib/editorProject";

describe("recording feedback evidence", () => {
  const header: EventsHeader = { k: "header", v: 1, capture: { kind: "window", rect: [-800, 100, 800, 600], px_scale: 2 }, screen_h: 900 };
  const events: RecEvent[] = [
    { k: "move", t: 100, x: -400, y: 400 },
    { k: "down", b: "l", t: 900, x: -200, y: 550 },
    { k: "move", t: 1100, x: -700, y: 200 },
  ];
  test("uses the pointer at the screenshot time in capture coordinates, including other displays", () => {
    expect(pointerAt(header, events, 1000)).toEqual([0.75, 0.75]);
    expect(pointerAt(header, events, 500)).toEqual([0.5, 0.5]);
  });
  test("does not invent markers from future, stale, outside-window, or malformed data", () => {
    expect(pointerAt(header, events, 0)).toBeNull();
    expect(pointerAt(header, events, 6000)).toBeNull();
    expect(pointerAt(null, events, 1000)).toBeNull();
    expect(pointerAt({ ...header, capture: { ...header.capture, rect: [0, 0, 0, 0] } }, events, 1000)).toBeNull();
    expect(pointerAt(header, [{ k: "move", t: 800, x: 2000, y: 500 }], 1000)).toBeNull();
  });
  test("redacts active privacy regions at native resolution without hiding emphasis highlights", () => {
    const calls: number[][] = [];
    const ctx = { fillStyle: "", fillRect: (...args: number[]) => calls.push(args) } as unknown as CanvasRenderingContext2D;
    const mask: Mask = { id: "private", kind: "pixelate", startMs: 1000, endMs: 2000, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
    coverPrivacyMasks(ctx, [mask, { ...mask, id: "emphasis", kind: "highlight" }], 1500, 1920, 1080);
    expect(calls).toEqual([[192, 216, 577, 433]]);
    coverPrivacyMasks(ctx, [mask], 2000, 1920, 1080);
    expect(calls.length).toBe(1);
  });
});
