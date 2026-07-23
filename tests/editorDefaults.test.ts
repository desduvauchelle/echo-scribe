import { describe, expect, test } from "bun:test";
import {
  applyEditorDefaults,
  defaultProject,
  extractEditorDefaults,
  mergeEditorDefaults,
  parseEditorDefaults,
  type EditorDefaults,
  type EditorProject,
  type WebcamSettings,
} from "../src/lib/editorProject";

const webcam: WebcamSettings = {
  show: true,
  shape: "rounded",
  corner: "br",
  sizeFrac: 0.2,
  autoShrink: false,
  mirror: false,
  scenes: [],
};

function projectWithWebcam(): EditorProject {
  return { ...defaultProject(), webcam: { ...webcam } };
}

describe("parseEditorDefaults", () => {
  test("null / empty / garbage -> {}", () => {
    expect(parseEditorDefaults(null)).toEqual({});
    expect(parseEditorDefaults("")).toEqual({});
    expect(parseEditorDefaults("not json")).toEqual({});
    expect(parseEditorDefaults("[1,2,3]")).toEqual({});
    expect(parseEditorDefaults("42")).toEqual({});
  });

  test("valid fields survive; unknown/malformed omitted", () => {
    const json = JSON.stringify({
      zoomEnabled: false,
      webcamSizeFrac: 0.3,
      webcamCorner: "tl",
      cursorEnabled: true,
      cursorScale: 2.2,
      aspect: "16:9",
      background: { type: "solid", color: "#abc" },
      padding: 40,
      cornerRadius: 8,
      bogus: "ignored",
    });
    expect(parseEditorDefaults(json)).toEqual({
      zoomEnabled: false,
      webcamSizeFrac: 0.3,
      webcamCorner: "tl",
      cursorEnabled: true,
      cursorScale: 2.2,
      aspect: "16:9",
      background: { type: "solid", color: "#abc" },
      padding: 40,
      cornerRadius: 8,
    });
  });

  test("out-of-range numerics are clamped", () => {
    const d = parseEditorDefaults(
      JSON.stringify({ webcamSizeFrac: 99, cursorScale: 99, padding: 9999, cornerRadius: -5 }),
    );
    expect(d.webcamSizeFrac).toBe(0.35); // WEBCAM_SIZE_MAX
    expect(d.cursorScale).toBe(3); // CURSOR_SCALE_MAX
    expect(d.padding).toBe(256); // PADDING_MAX
    expect(d.cornerRadius).toBe(0); // CORNER_MIN
  });

  test("bad enum values are dropped, not defaulted", () => {
    const d = parseEditorDefaults(
      JSON.stringify({ webcamCorner: "middle", aspect: "21:9", background: { type: "nope" } }),
    );
    expect(d.webcamCorner).toBeUndefined();
    expect(d.aspect).toBeUndefined();
    expect(d.background).toBeUndefined();
  });
});

describe("extractEditorDefaults", () => {
  test("omits webcam fields when the recording has no webcam", () => {
    const d = extractEditorDefaults(defaultProject());
    expect("webcamSizeFrac" in d).toBe(false);
    expect("webcamCorner" in d).toBe(false);
    // Non-webcam fields are present.
    expect(d.zoomEnabled).toBe(true); // default zoom mode is "auto"
    expect(d.cursorScale).toBe(1.5);
    expect(d.aspect).toBe("auto");
  });

  test("includes webcam size/corner when a webcam exists", () => {
    const p = projectWithWebcam();
    p.webcam!.sizeFrac = 0.28;
    p.webcam!.corner = "tr";
    const d = extractEditorDefaults(p);
    expect(d.webcamSizeFrac).toBe(0.28);
    expect(d.webcamCorner).toBe("tr");
  });

  test('zoomEnabled is false only for mode "off"', () => {
    const off = { ...defaultProject(), zoom: { mode: "off" as const, blocks: null, suppressed: [] } };
    expect(extractEditorDefaults(off).zoomEnabled).toBe(false);
    const custom = {
      ...defaultProject(),
      zoom: { mode: "custom" as const, blocks: [], suppressed: [] },
    };
    expect(extractEditorDefaults(custom).zoomEnabled).toBe(true);
  });
});

describe("mergeEditorDefaults", () => {
  test("next's present keys win; absent keys keep prev", () => {
    const prev: EditorDefaults = { webcamSizeFrac: 0.3, webcamCorner: "br", cursorScale: 1.5 };
    const next: EditorDefaults = { cursorScale: 2.5 }; // e.g. a webcam-less snapshot
    expect(mergeEditorDefaults(prev, next)).toEqual({
      webcamSizeFrac: 0.3,
      webcamCorner: "br",
      cursorScale: 2.5,
    });
  });
});

describe("applyEditorDefaults", () => {
  test("seeds appearance/cursor/zoom onto a fresh project", () => {
    const defaults: EditorDefaults = {
      zoomEnabled: false,
      cursorEnabled: true,
      cursorScale: 2.5,
      aspect: "9:16",
      padding: 20,
      cornerRadius: 4,
      background: { type: "solid", color: "#000" },
    };
    const p = applyEditorDefaults(defaultProject(), defaults);
    expect(p.appearance.aspect).toBe("9:16");
    expect(p.appearance.padding).toBe(20);
    expect(p.appearance.cornerRadius).toBe(4);
    expect(p.appearance.background).toEqual({ type: "solid", color: "#000" });
    expect(p.cursor.enabled).toBe(true);
    expect(p.cursor.scale).toBe(2.5);
    expect(p.zoom).toEqual({ mode: "off", blocks: null, suppressed: [] });
  });

  test("zoomEnabled true maps to auto mode", () => {
    const p = applyEditorDefaults(defaultProject(), { zoomEnabled: true });
    expect(p.zoom).toEqual({ mode: "auto", blocks: null, suppressed: [] });
  });

  test("webcam fields apply only when the project has a webcam", () => {
    const noCam = applyEditorDefaults(defaultProject(), {
      webcamSizeFrac: 0.3,
      webcamCorner: "tl",
    });
    expect(noCam.webcam).toBeNull(); // no webcam to apply onto

    const withCam = applyEditorDefaults(projectWithWebcam(), {
      webcamSizeFrac: 0.3,
      webcamCorner: "tl",
    });
    expect(withCam.webcam!.sizeFrac).toBe(0.3);
    expect(withCam.webcam!.corner).toBe("tl");
    // Untouched webcam fields are preserved.
    expect(withCam.webcam!.shape).toBe("rounded");
  });

  test("absent defaults leave the project unchanged", () => {
    const base = defaultProject();
    expect(applyEditorDefaults(base, {})).toEqual(base);
  });

  test("does not mutate its input", () => {
    const base = projectWithWebcam();
    const snapshot = JSON.parse(JSON.stringify(base));
    applyEditorDefaults(base, { padding: 10, webcamSizeFrac: 0.31, cursorScale: 2 });
    expect(base).toEqual(snapshot);
  });

  test("round-trips through extract: apply(extract(p)) reproduces the remembered look", () => {
    const src = projectWithWebcam();
    src.appearance.aspect = "1:1";
    src.appearance.padding = 33;
    src.cursor.enabled = true;
    src.cursor.scale = 2.75;
    src.webcam!.sizeFrac = 0.22;
    src.webcam!.corner = "bl";
    src.zoom = { mode: "off", blocks: null, suppressed: [] };

    const defaults = extractEditorDefaults(src);
    const seeded = applyEditorDefaults(projectWithWebcam(), defaults);

    expect(seeded.appearance.aspect).toBe("1:1");
    expect(seeded.appearance.padding).toBe(33);
    expect(seeded.cursor.enabled).toBe(true);
    expect(seeded.cursor.scale).toBe(2.75);
    expect(seeded.webcam!.sizeFrac).toBe(0.22);
    expect(seeded.webcam!.corner).toBe("bl");
    expect(seeded.zoom.mode).toBe("off");
  });
});
