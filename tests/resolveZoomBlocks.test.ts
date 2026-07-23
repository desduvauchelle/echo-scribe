import { describe, expect, test } from "bun:test";
import {
  materializeBlocks,
  resolveZoomBlocks,
  zoomSuppressMarker,
  type EventsHeader,
  type RecEvent,
  type ZoomBlock,
} from "../src/lib/autoZoom";
import { defaultProject, type EditorProject } from "../src/lib/editorProject";

const header: EventsHeader = {
  k: "header",
  v: 1,
  capture: { kind: "display", rect: [0, 0, 1000, 1000], px_scale: 2 },
  screen_h: 1000,
};
const click = (t: number, x: number, y: number): RecEvent => ({ t, k: "down", b: "l", x, y });

/** A project with the given zoom settings, other fields at defaults.
 *  `suppressed` defaults to `[]` so existing callers stay concise. */
function projectWithZoom(
  zoom: Omit<EditorProject["zoom"], "suppressed"> & { suppressed?: number[] },
): EditorProject {
  return { ...defaultProject(), zoom: { suppressed: [], ...zoom } };
}

// Two well-separated clicks -> two auto blocks (see generateAutoZoom tests).
const twoClickEvents: RecEvent[] = [click(1000, 500, 500), click(10000, 500, 500)];

describe("materializeBlocks", () => {
  test("returns generateAutoZoom output with stable z-ids and mode auto", () => {
    const blocks = materializeBlocks(header, twoClickEvents, 30000);
    expect(blocks.length).toBe(2);
    expect(blocks.map((b) => b.id)).toEqual(["z1", "z2"]);
    expect(blocks.every((b) => b.mode === "auto")).toBe(true);
  });

  test("ids are assigned in start order", () => {
    const blocks = materializeBlocks(header, twoClickEvents, 30000);
    // Sorted by start; z1 is the earliest.
    const sorted = [...blocks].sort((a, b) => a.startMs - b.startMs);
    expect(sorted.map((b) => b.id)).toEqual(["z1", "z2"]);
    expect(sorted[0].startMs).toBeLessThan(sorted[1].startMs);
  });

  test("no clicks -> []", () => {
    expect(materializeBlocks(header, [{ t: 5, k: "move", x: 1, y: 1 }], 10000)).toEqual([]);
  });

  test("deterministic: same input yields identical ids/blocks", () => {
    const a = materializeBlocks(header, twoClickEvents, 30000);
    const b = materializeBlocks(header, twoClickEvents, 30000);
    expect(a).toEqual(b);
  });
});

describe("resolveZoomBlocks", () => {
  test('mode "off" -> [] (ignores events)', () => {
    const project = projectWithZoom({ mode: "off", blocks: null });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual([]);
  });

  test('mode "off" -> [] even with stored blocks (null per contract, but tolerant)', () => {
    const stored: ZoomBlock[] = [
      { id: "z1", startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 2, mode: "manual" },
    ];
    const project = projectWithZoom({ mode: "off", blocks: stored });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual([]);
  });

  test('mode "custom" -> stored blocks verbatim', () => {
    const stored: ZoomBlock[] = [
      { id: "z1", startMs: 200, endMs: 2600, cx: 0.4, cy: 0.6, scale: 2, mode: "manual" },
    ];
    const project = projectWithZoom({ mode: "custom", blocks: stored });
    // Events are ignored for custom; the stored blocks win.
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual(stored);
  });

  test('mode "custom" with null blocks -> []', () => {
    const project = projectWithZoom({ mode: "custom", blocks: null });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual([]);
  });

  test('mode "auto" -> materialized auto blocks (with ids)', () => {
    const project = projectWithZoom({ mode: "auto", blocks: null });
    const resolved = resolveZoomBlocks(project, header, twoClickEvents, 30000);
    expect(resolved).toEqual(materializeBlocks(header, twoClickEvents, 30000));
    expect(resolved.map((b) => b.id)).toEqual(["z1", "z2"]);
  });

  test('mode "auto" with no events -> []', () => {
    const project = projectWithZoom({ mode: "auto", blocks: null });
    expect(resolveZoomBlocks(project, header, [], 30000)).toEqual([]);
  });

  test('mode "auto" with null header -> [] (no capture geometry)', () => {
    const project = projectWithZoom({ mode: "auto", blocks: null });
    expect(resolveZoomBlocks(project, null, twoClickEvents, 30000)).toEqual([]);
  });

  test('mode "auto" ids are stable/deterministic across calls', () => {
    const project = projectWithZoom({ mode: "auto", blocks: null });
    const a = resolveZoomBlocks(project, header, twoClickEvents, 30000);
    const b = resolveZoomBlocks(project, header, twoClickEvents, 30000);
    expect(a).toEqual(b);
  });
});

describe("resolveZoomBlocks — auto suppression", () => {
  test("empty suppressed is a no-op", () => {
    const project = projectWithZoom({ mode: "auto", blocks: null, suppressed: [] });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual(
      materializeBlocks(header, twoClickEvents, 30000),
    );
  });

  test("suppressing one block's marker drops exactly that block, keeps the rest auto", () => {
    const all = materializeBlocks(header, twoClickEvents, 30000);
    expect(all.length).toBe(2);
    const marker = zoomSuppressMarker(all[0]);
    const project = projectWithZoom({ mode: "auto", blocks: null, suppressed: [marker] });
    const resolved = resolveZoomBlocks(project, header, twoClickEvents, 30000);
    // The first block is gone; the second is untouched (still auto-generated).
    expect(resolved).toEqual([all[1]]);
  });

  test("a marker inside the second block drops only the second", () => {
    const all = materializeBlocks(header, twoClickEvents, 30000);
    const project = projectWithZoom({
      mode: "auto",
      blocks: null,
      suppressed: [zoomSuppressMarker(all[1])],
    });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual([all[0]]);
  });

  test("suppressing every block yields []", () => {
    const all = materializeBlocks(header, twoClickEvents, 30000);
    const project = projectWithZoom({
      mode: "auto",
      blocks: null,
      suppressed: all.map(zoomSuppressMarker),
    });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual([]);
  });

  test("a marker matching no block leaves all blocks intact", () => {
    const all = materializeBlocks(header, twoClickEvents, 30000);
    const project = projectWithZoom({ mode: "auto", blocks: null, suppressed: [999999] });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual(all);
  });

  test("suppressed is ignored in custom mode (blocks win verbatim)", () => {
    const stored: ZoomBlock[] = [
      { id: "z1", startMs: 200, endMs: 2600, cx: 0.4, cy: 0.6, scale: 2, mode: "manual" },
    ];
    const project = projectWithZoom({
      mode: "custom",
      blocks: stored,
      suppressed: [zoomSuppressMarker(stored[0])],
    });
    expect(resolveZoomBlocks(project, header, twoClickEvents, 30000)).toEqual(stored);
  });

  test("zoomSuppressMarker returns an interior timestamp", () => {
    const marker = zoomSuppressMarker({ startMs: 1000, endMs: 3000 });
    expect(marker).toBe(2000);
    expect(marker).toBeGreaterThanOrEqual(1000);
    expect(marker).toBeLessThan(3000);
  });
});
