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

/** Output canvas aspect-ratio preset. `auto` = the canvas is exactly the frame
 *  plus padding (the legacy look); the fixed presets wrap that in a canvas of
 *  the named aspect with the recording centered and the short axis letterboxed.
 *  Mirrors `AspectPreset` in `render/compositor.ts` (kept in sync). */
export type AspectPreset = "auto" | "16:9" | "9:16" | "1:1" | "4:3";

const ASPECT_VALUES: readonly AspectPreset[] = ["auto", "16:9", "9:16", "1:1", "4:3"];

export type EditorProject = {
  v: 1;
  trim: { startMs: number; endMs: number } | null; // null = full length
  appearance: {
    padding: number; // 0..256 px output-space
    cornerRadius: number; // 0..64 px
    aspect: AspectPreset; // output aspect; "auto" = frame + padding
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
      aspect: "auto",
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

/** A known aspect preset, else "auto" (tolerant: unknown strings, non-strings,
 *  and missing all resolve to auto). */
function parseAspect(v: unknown): AspectPreset {
  return typeof v === "string" && (ASPECT_VALUES as readonly string[]).includes(v)
    ? (v as AspectPreset)
    : "auto";
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

/** Parse a `trim` field from persisted JSON. Normalizes the pair so callers
 *  always get *ordering*- and *sign*-invariant data (start <= end, both >= 0,
 *  both integers) straight out of parsing — even if the stored JSON has an
 *  inverted or out-of-range pair (e.g. hand-edited, from an older buggy
 *  write, or a stale project). This does NOT enforce the 500ms minimum
 *  length or clamp against a clip's duration — that's inherently unknown at
 *  parse time. Callers that need a fully valid trim for a known duration
 *  must still call `clampTrim(trim, durationMs)` at time of use (e.g. on
 *  metadata load, or before export). */
function parseTrim(v: unknown): EditorProject["trim"] {
  if (!isObject(v)) return null;
  const { startMs, endMs } = v;
  if (
    typeof startMs === "number" &&
    Number.isFinite(startMs) &&
    typeof endMs === "number" &&
    Number.isFinite(endMs)
  ) {
    const a = Math.max(0, startMs);
    const b = Math.max(0, endMs);
    return {
      startMs: Math.round(Math.min(a, b)),
      endMs: Math.round(Math.max(a, b)),
    };
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

/** Minimum trim length in milliseconds — the timeline handles can't be
 *  dragged closer together than this. */
export const TRIM_MIN_LENGTH_MS = 500;

/** Normalize a trim range against a clip duration: clamps both ends into
 *  [0, durationMs], fixes inverted ordering, widens degenerate/too-short
 *  ranges out to `TRIM_MIN_LENGTH_MS` (preferring to push `endMs` later,
 *  falling back to pulling `startMs` earlier if that would overflow the
 *  duration), and rounds both values to integers. Returns `null` when
 *  `trim` is `null`, or when `durationMs` is too short to fit the minimum
 *  length at all. Pure — never mutates its argument. */
export function clampTrim(
  trim: { startMs: number; endMs: number } | null,
  durationMs: number,
): { startMs: number; endMs: number } | null {
  if (trim === null) return null;
  if (durationMs < TRIM_MIN_LENGTH_MS) return null;

  let start = Math.min(trim.startMs, trim.endMs);
  let end = Math.max(trim.startMs, trim.endMs);

  start = clamp(start, 0, durationMs);
  end = clamp(end, 0, durationMs);

  if (end - start < TRIM_MIN_LENGTH_MS) {
    end = start + TRIM_MIN_LENGTH_MS;
    if (end > durationMs) {
      end = durationMs;
      start = end - TRIM_MIN_LENGTH_MS;
    }
  }

  return { startMs: Math.round(start), endMs: Math.round(end) };
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
      aspect: parseAspect(appearance.aspect),
      background: parseBackground(appearance.background, base.appearance.background),
    },
    cursor: {
      enabled: typeof cursor.enabled === "boolean" ? cursor.enabled : base.cursor.enabled,
      scale: clamp(num(cursor.scale, base.cursor.scale), CURSOR_SCALE_MIN, CURSOR_SCALE_MAX),
    },
    webcam: parseWebcam(raw.webcam, base.webcam),
  };
}
