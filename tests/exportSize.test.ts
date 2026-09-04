import { describe, expect, test } from "bun:test";
import { defaultProject, parseProject } from "../src/lib/editorProject";
import { mp4OutputSize } from "../src/lib/render/exportSize";
import { outputLayout } from "../src/lib/render/compositor";

describe("edited MP4 resolution", () => {
  test("the reported small window exports at Full HD by default", () => {
    expect(mp4OutputSize(1100, 600, 38, "16:9", "1080"))
      .toEqual({ w: 1920, h: 1080 });
  });

  test("4K renders a full UHD canvas", () => {
    expect(mp4OutputSize(1100, 600, 38, "16:9", "2160"))
      .toEqual({ w: 3840, h: 2160 });
  });

  test("preserves portrait, square, and 4:3 compositions", () => {
    expect(mp4OutputSize(1100, 600, 38, "9:16", "1080"))
      .toEqual({ w: 1080, h: 1920 });
    expect(mp4OutputSize(1100, 600, 38, "1:1", "2160"))
      .toEqual({ w: 2160, h: 2160 });
    expect(mp4OutputSize(1100, 600, 38, "4:3", "1080"))
      .toEqual({ w: 1440, h: 1080 });
  });

  test("auto preserves the padded aspect, with even encoder dimensions", () => {
    const size = mp4OutputSize(1100, 600, 38, "auto", "1080");
    expect(size.h).toBe(1080);
    expect(size.w % 2).toBe(0);
    expect(Math.abs(size.w / size.h - 1176 / 676)).toBeLessThan(0.002);
  });

  test("original size retains the existing layout and 3840 pixel cap", () => {
    for (const [w, h] of [[1100, 600], [5120, 2880]]) {
      const layout = outputLayout(w, h, 38, "16:9");
      expect(mp4OutputSize(w, h, 38, "16:9", "native"))
        .toEqual({ w: layout.outW, h: layout.outH });
    }
  });

  test("resolution survives project saving; old or invalid settings use 1080p", () => {
    expect(defaultProject().exportResolution).toBe("1080");
    for (const resolution of ["1080", "2160", "native"] as const) {
      expect(parseProject(JSON.stringify({ ...defaultProject(), exportResolution: resolution })).exportResolution)
        .toBe(resolution);
    }
    expect(parseProject('{"v":1}').exportResolution).toBe("1080");
    expect(parseProject('{"exportResolution":"8K"}').exportResolution).toBe("1080");
  });
});
