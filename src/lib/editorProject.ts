// Per-recording editor project settings (persisted opaquely in the
// `recordings.project_json` TEXT column). This TS type is the source of truth;
// Rust never parses the JSON.
//
// `parseProject` is deliberately *tolerant*: a null column, empty string,
// non-JSON garbage, or a partial/stale object all resolve to a valid
// `EditorProject` by merging known-good fields onto `defaultProject()`. It
// never throws — the editor must always have something sane to render.

export type Background =
  | { type: "solid"; color: string }
  | { type: "gradient"; from: string; to: string }
  | { type: "image"; path: string }; // absolute path under the recordings dir

export type WebcamSettings = {
  show: boolean;
  shape: "circle" | "rounded";
  corner: "br" | "bl" | "tr" | "tl";
  sizeFrac: number; // 0.1..0.35 of output width
};

export type EditorProject = {
  v: 1;
  trim: { startMs: number; endMs: number } | null; // null = full length
  appearance: {
    padding: number; // 0..256 px output-space
    cornerRadius: number; // 0..64 px
    background: Background;
  };
  cursor: { enabled: boolean; scale: number }; // scale 1..3
  webcam: WebcamSettings | null; // null when recording has no webcam file
};

// Bounds shared with the UI sliders and the compositor.
export const PADDING_MIN = 0;
export const PADDING_MAX = 256;
export const CORNER_MIN = 0;
export const CORNER_MAX = 64;
export const CURSOR_SCALE_MIN = 1;
export const CURSOR_SCALE_MAX = 3;
export const WEBCAM_SIZE_MIN = 0.1;
export const WEBCAM_SIZE_MAX = 0.35;

/** The default appearance — matches the hard-coded M1 render look so the editor
 *  opens on the same visual an un-edited recording would render with. */
export function defaultProject(): EditorProject {
  return {
    v: 1,
    trim: null,
    appearance: {
      padding: 96,
      cornerRadius: 16,
      background: { type: "gradient", from: "#1e3a5f", to: "#0f1b2d" },
    },
    cursor: { enabled: false, scale: 1.5 },
    webcam: null,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** A finite number, else the fallback. */
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseBackground(v: unknown, fallback: Background): Background {
  if (!isObject(v)) return fallback;
  switch (v.type) {
    case "solid":
      return typeof v.color === "string" ? { type: "solid", color: v.color } : fallback;
    case "gradient":
      return typeof v.from === "string" && typeof v.to === "string"
        ? { type: "gradient", from: v.from, to: v.to }
        : fallback;
    case "image":
      return typeof v.path === "string" && v.path.length > 0
        ? { type: "image", path: v.path }
        : fallback;
    default:
      return fallback;
  }
}

function parseTrim(v: unknown): EditorProject["trim"] {
  if (!isObject(v)) return null;
  const { startMs, endMs } = v;
  if (
    typeof startMs === "number" &&
    Number.isFinite(startMs) &&
    typeof endMs === "number" &&
    Number.isFinite(endMs)
  ) {
    return { startMs, endMs };
  }
  return null;
}

function parseWebcam(v: unknown, fallback: WebcamSettings | null): WebcamSettings | null {
  if (!isObject(v)) return fallback;
  const shape = v.shape === "circle" ? "circle" : "rounded";
  const corner =
    v.corner === "bl" || v.corner === "tr" || v.corner === "tl" ? v.corner : "br";
  return {
    show: typeof v.show === "boolean" ? v.show : true,
    shape,
    corner,
    sizeFrac: clamp(num(v.sizeFrac, 0.2), WEBCAM_SIZE_MIN, WEBCAM_SIZE_MAX),
  };
}

/** Tolerant parse: merges valid fields from `json` onto `defaultProject()`.
 *  Any missing/malformed field keeps its default. Never throws. */
export function parseProject(json: string | null): EditorProject {
  const base = defaultProject();
  if (!json) return base;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return base;
  }
  if (!isObject(raw)) return base;

  const appearance = isObject(raw.appearance) ? raw.appearance : {};
  const cursor = isObject(raw.cursor) ? raw.cursor : {};

  return {
    v: 1,
    trim: parseTrim(raw.trim),
    appearance: {
      padding: clamp(num(appearance.padding, base.appearance.padding), PADDING_MIN, PADDING_MAX),
      cornerRadius: clamp(
        num(appearance.cornerRadius, base.appearance.cornerRadius),
        CORNER_MIN,
        CORNER_MAX,
      ),
      background: parseBackground(appearance.background, base.appearance.background),
    },
    cursor: {
      enabled: typeof cursor.enabled === "boolean" ? cursor.enabled : base.cursor.enabled,
      scale: clamp(num(cursor.scale, base.cursor.scale), CURSOR_SCALE_MIN, CURSOR_SCALE_MAX),
    },
    webcam: parseWebcam(raw.webcam, base.webcam),
  };
}
