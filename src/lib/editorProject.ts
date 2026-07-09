// Per-recording editor project settings (persisted opaquely in the
// `recordings.project_json` TEXT column). This TS type is the source of truth;
// Rust never parses the JSON.
//
// `parseProject` is deliberately *tolerant*: a null column, empty string,
// non-JSON garbage, or a partial/stale object all resolve to a valid
// `EditorProject` by merging known-good fields onto `defaultProject()`. It
// never throws — the editor must always have something sane to render.

import type { ZoomBlock } from "./autoZoom";

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

/** Zoom mode: "auto" derives blocks from recorded clicks at render time
 *  (blocks stays null); "custom" holds hand-edited/materialized blocks;
 *  "off" disables zoom entirely (blocks stays null). */
export type ZoomMode = "auto" | "custom" | "off";

export type ZoomSettings = {
  mode: ZoomMode;
  blocks: ZoomBlock[] | null; // non-null only when mode === "custom"
};

/** A speed-ramp segment over source (pre-speed) time. Non-overlapping;
 *  rate clamped to [0.5, 4] in 0.25 steps by the editor UI (clampSpeedRanges
 *  enforces the bound; step granularity is a UI concern only). */
export type SpeedRange = { startMs: number; endMs: number; rate: number };

export type KeystrokeSettings = { enabled: boolean; allKeys: boolean };

/** A single caption line over source (pre-speed) time. Non-overlapping;
 *  mirrors the `SpeedRange` shape/semantics (see `clampCaptionSegments`). */
export type CaptionSegment = { startMs: number; endMs: number; text: string };

/** `segments === null` means captions have never been generated for this
 *  recording (distinct from `[]`, which means generation ran and found
 *  nothing / the user cleared them). */
export type CaptionSettings = {
  enabled: boolean;
  segments: CaptionSegment[] | null;
};

export type AudioSettings = { normalizeLoudness: boolean };

/** Output canvas aspect-ratio preset. `auto` = the canvas is exactly the frame
 *  plus padding (the legacy look); the fixed presets wrap that in a canvas of
 *  the named aspect with the recording centered and the short axis letterboxed.
 *  Single source of truth — `render/compositor.ts` type-only imports this. */
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
  cursor: {
    enabled: boolean;
    scale: number; // 1..3
    smoothing: number; // 0..1, default 0 (existing look unchanged)
    hideIdle: boolean;
  };
  webcam: WebcamSettings | null; // null when recording has no webcam file
  zoom: ZoomSettings;
  speed: SpeedRange[];
  keystrokes: KeystrokeSettings;
  captions: CaptionSettings;
  audio: AudioSettings;
  motionBlur: boolean;
};

// Bounds shared with the UI sliders and the compositor.
export const PADDING_MIN = 0;
export const PADDING_MAX = 256;
export const CORNER_MIN = 0;
export const CORNER_MAX = 64;
export const CURSOR_SCALE_MIN = 1;
export const CURSOR_SCALE_MAX = 3;
export const CURSOR_SMOOTHING_MIN = 0;
export const CURSOR_SMOOTHING_MAX = 1;
export const WEBCAM_SIZE_MIN = 0.1;
export const WEBCAM_SIZE_MAX = 0.35;
export const SPEED_RATE_MIN = 0.5;
export const SPEED_RATE_MAX = 4;

const ZOOM_MODE_VALUES: readonly ZoomMode[] = ["auto", "custom", "off"];

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
    cursor: { enabled: false, scale: 1.5, smoothing: 0, hideIdle: false },
    webcam: null,
    zoom: { mode: "auto", blocks: null },
    speed: [],
    keystrokes: { enabled: false, allKeys: false },
    captions: { enabled: false, segments: null },
    audio: { normalizeLoudness: false },
    motionBlur: false,
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

/** A known zoom mode, else "auto" (tolerant: unknown strings, non-strings,
 *  and missing all resolve to auto — same pattern as parseAspect). */
function parseZoomMode(v: unknown): ZoomMode {
  return typeof v === "string" && (ZOOM_MODE_VALUES as readonly string[]).includes(v)
    ? (v as ZoomMode)
    : "auto";
}

/** Shape-checks a single persisted zoom block. Doesn't validate id — a
 *  missing id is legal (fresh auto blocks don't have one yet). */
function isValidZoomBlock(v: unknown): v is ZoomBlock {
  if (!isObject(v)) return false;
  return (
    typeof v.startMs === "number" &&
    Number.isFinite(v.startMs) &&
    typeof v.endMs === "number" &&
    Number.isFinite(v.endMs) &&
    typeof v.cx === "number" &&
    Number.isFinite(v.cx) &&
    typeof v.cy === "number" &&
    Number.isFinite(v.cy) &&
    typeof v.scale === "number" &&
    Number.isFinite(v.scale) &&
    (v.mode === "auto" || v.mode === "manual")
  );
}

/** Parses the `zoom` field. Unknown mode -> "auto". `blocks` is tolerant:
 *  a non-array (or absent) value becomes `null`, and shape-invalid entries
 *  are dropped from an array. Per the data contract, blocks are only ever
 *  materialized when `mode === "custom"` — any other mode forces `blocks`
 *  back to `null` on parse, even if the stored JSON has a stale array. */
function parseZoom(v: unknown, fallback: ZoomSettings): ZoomSettings {
  if (!isObject(v)) return fallback;
  const mode = parseZoomMode(v.mode);
  if (mode !== "custom") return { mode, blocks: null };

  if (!Array.isArray(v.blocks)) return { mode, blocks: null };
  const blocks = v.blocks.filter(isValidZoomBlock);
  return { mode, blocks };
}

/** Shape-checks a single persisted speed range (rate bound is enforced by
 *  clampSpeedRanges at time-of-use, not here — parse only validates shape). */
function isValidSpeedRange(v: unknown): v is SpeedRange {
  if (!isObject(v)) return false;
  return (
    typeof v.startMs === "number" &&
    Number.isFinite(v.startMs) &&
    typeof v.endMs === "number" &&
    Number.isFinite(v.endMs) &&
    typeof v.rate === "number" &&
    Number.isFinite(v.rate)
  );
}

/** Parses the `speed` field: non-array (or absent) -> `[]`; shape-invalid
 *  entries are dropped, valid ones kept in their original order. */
function parseSpeed(v: unknown): SpeedRange[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isValidSpeedRange);
}

/** Parses the `keystrokes` field: missing/non-object -> default; individual
 *  non-boolean fields fall back to their default value. */
function parseKeystrokes(v: unknown, fallback: KeystrokeSettings): KeystrokeSettings {
  if (!isObject(v)) return fallback;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : fallback.enabled,
    allKeys: typeof v.allKeys === "boolean" ? v.allKeys : fallback.allKeys,
  };
}

/** Shape-checks a single persisted caption segment (overlap/ordering/empty-text
 *  are enforced by clampCaptionSegments at time-of-use, not here — parse only
 *  validates shape, same pattern as isValidSpeedRange). */
function isValidCaptionSegment(v: unknown): v is CaptionSegment {
  if (!isObject(v)) return false;
  return (
    typeof v.startMs === "number" &&
    Number.isFinite(v.startMs) &&
    typeof v.endMs === "number" &&
    Number.isFinite(v.endMs) &&
    typeof v.text === "string"
  );
}

/** Parses the `captions` field: missing/non-object -> default; `enabled`
 *  falls back to its default when non-boolean; `segments` is tolerant: a
 *  non-array/non-null value becomes `null`, and shape-invalid entries are
 *  dropped from an array (mirrors parseSpeed). `null` is preserved as-is
 *  (means "never generated"), distinct from `[]`. */
function parseCaptions(v: unknown, fallback: CaptionSettings): CaptionSettings {
  if (!isObject(v)) return fallback;
  const enabled = typeof v.enabled === "boolean" ? v.enabled : fallback.enabled;
  if (v.segments === null) return { enabled, segments: null };
  if (!Array.isArray(v.segments)) return { enabled, segments: null };
  return { enabled, segments: v.segments.filter(isValidCaptionSegment) };
}

/** Parses the `audio` field: missing/non-object -> default; non-boolean
 *  `normalizeLoudness` falls back to its default value. */
function parseAudio(v: unknown, fallback: AudioSettings): AudioSettings {
  if (!isObject(v)) return fallback;
  return {
    normalizeLoudness:
      typeof v.normalizeLoudness === "boolean" ? v.normalizeLoudness : fallback.normalizeLoudness,
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
      smoothing: clamp(
        num(cursor.smoothing, base.cursor.smoothing),
        CURSOR_SMOOTHING_MIN,
        CURSOR_SMOOTHING_MAX,
      ),
      hideIdle: typeof cursor.hideIdle === "boolean" ? cursor.hideIdle : base.cursor.hideIdle,
    },
    webcam: parseWebcam(raw.webcam, base.webcam),
    zoom: parseZoom(raw.zoom, base.zoom),
    speed: parseSpeed(raw.speed),
    keystrokes: parseKeystrokes(raw.keystrokes, base.keystrokes),
    captions: parseCaptions(raw.captions, base.captions),
    audio: parseAudio(raw.audio, base.audio),
    motionBlur: typeof raw.motionBlur === "boolean" ? raw.motionBlur : base.motionBlur,
  };
}

/** Sorts, clamps, and de-overlaps a list of speed ranges against a clip
 *  duration. Pure — never mutates its argument. Order of operations:
 *
 *  1. Sort by `startMs` ascending.
 *  2. Clamp both `startMs` and `endMs` into `[0, durationMs]`.
 *  3. Drop any range where `endMs <= startMs` after clamping (degenerate or
 *     fully out-of-bounds) — unlike `parseTrim`, this does NOT reorder an
 *     inverted pair; it drops it.
 *  4. Walk the (now-sorted) survivors left to right, dropping any range
 *     that starts before the previous kept range's `endMs` (overlap) —
 *     the earlier range always wins. Ranges that merely touch
 *     (`startMs === prev.endMs`) are not an overlap and both are kept.
 *  5. Clamp `rate` into `[SPEED_RATE_MIN, SPEED_RATE_MAX]`.
 *  6. Round `startMs`/`endMs` to integers.
 */
export function clampSpeedRanges(ranges: SpeedRange[], durationMs: number): SpeedRange[] {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);

  const clamped: SpeedRange[] = [];
  for (const r of sorted) {
    const start = clamp(r.startMs, 0, durationMs);
    const end = clamp(r.endMs, 0, durationMs);
    if (end <= start) continue;
    clamped.push({
      startMs: start,
      endMs: end,
      rate: clamp(r.rate, SPEED_RATE_MIN, SPEED_RATE_MAX),
    });
  }

  const kept: SpeedRange[] = [];
  for (const r of clamped) {
    const prev = kept[kept.length - 1];
    if (prev && r.startMs < prev.endMs) continue; // overlap: earlier range wins
    kept.push(r);
  }

  return kept.map((r) => ({
    startMs: Math.round(r.startMs),
    endMs: Math.round(r.endMs),
    rate: r.rate,
  }));
}

/** Sorts, clamps, and de-overlaps a list of caption segments against a clip
 *  duration. Pure — never mutates its argument. Mirrors `clampSpeedRanges`
 *  exactly, with an added empty-text drop. Order of operations:
 *
 *  1. Sort by `startMs` ascending.
 *  2. Clamp both `startMs` and `endMs` into `[0, durationMs]`.
 *  3. Drop any segment where `endMs <= startMs` after clamping (degenerate or
 *     fully out-of-bounds) — does NOT reorder an inverted pair; it drops it.
 *  4. Drop any segment with empty `text`.
 *  5. Walk the (now-sorted) survivors left to right, dropping any segment
 *     that starts before the previous kept segment's `endMs` (overlap) —
 *     the earlier segment always wins. Segments that merely touch
 *     (`startMs === prev.endMs`) are not an overlap and both are kept.
 *  6. Round `startMs`/`endMs` to integers.
 */
export function clampCaptionSegments(
  segments: CaptionSegment[],
  durationMs: number,
): CaptionSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);

  const clamped: CaptionSegment[] = [];
  for (const s of sorted) {
    const start = clamp(s.startMs, 0, durationMs);
    const end = clamp(s.endMs, 0, durationMs);
    if (end <= start) continue;
    if (s.text.length === 0) continue;
    clamped.push({ startMs: start, endMs: end, text: s.text });
  }

  const kept: CaptionSegment[] = [];
  for (const s of clamped) {
    const prev = kept[kept.length - 1];
    if (prev && s.startMs < prev.endMs) continue; // overlap: earlier segment wins
    kept.push(s);
  }

  return kept.map((s) => ({
    startMs: Math.round(s.startMs),
    endMs: Math.round(s.endMs),
    text: s.text,
  }));
}

// ---- Speed map + retiming math (Task 5) ---------------------------------
//
// A "speed map" turns SOURCE time (ms) into OUTPUT time (ms) for the retimed
// export. Outside every range playback is 1:1; inside a range with rate `r`,
// each `dt` of source time contributes `dt/r` of output (so 2× halves a span's
// output length; 0.5× doubles it). The map is piecewise-linear, continuous, and
// strictly monotone-non-decreasing (rate > 0). The frontend and the Rust
// audio retimer must produce the SAME output length for a given range list; the
// TS `buildSpeedMap` is the authoritative definition of that math and the video
// pipeline maps every emitted frame timestamp through it.

/** Minimum speed-range length (ms) — a range can't be resized below this,
 *  matching the zoom/trim handle floors. */
export const SPEED_MIN_LENGTH_MS = 500;

/** Default length + rate for a freshly-added speed segment ("Add speed"). */
export const SPEED_ADD_DEFAULT_LENGTH_MS = 5000;
export const SPEED_ADD_DEFAULT_RATE = 2.0;

/** A source→output time map for a set of (source-time) speed ranges.
 *  `srcToOut(srcMs)` is piecewise-linear & monotonic; `outDurationMs` is the
 *  total output length for the whole `[0, durationMs]` source span. */
export type SpeedMap = {
  srcToOut(srcMs: number): number;
  outDurationMs: number;
};

/** Build the source→output time map for `ranges` over a `durationMs` source
 *  clip. Ranges are first normalized through `clampSpeedRanges` (sorted,
 *  clamped, de-overlapped, rate-bounded) so callers may pass raw/unsorted
 *  input. Pure. */
export function buildSpeedMap(ranges: SpeedRange[], durationMs: number): SpeedMap {
  const dur = Math.max(0, durationMs);
  const norm = clampSpeedRanges(ranges, dur);

  // Precompute the cumulative output time at each range boundary so srcToOut is
  // O(log n)/O(n) rather than re-integrating from 0 every call. `outAtSrc[i]`
  // is the output time at `norm[i].startMs`.
  const outAtStart: number[] = [];
  let outCursor = 0;
  let srcCursor = 0;
  for (const r of norm) {
    // Identity gap before this range.
    outCursor += r.startMs - srcCursor;
    outAtStart.push(outCursor);
    // The range itself contributes (len / rate) to output.
    outCursor += (r.endMs - r.startMs) / r.rate;
    srcCursor = r.endMs;
  }
  // Identity tail after the last range.
  const outDurationMs = outCursor + (dur - srcCursor);

  const srcToOut = (srcMsRaw: number): number => {
    const srcMs = Math.min(Math.max(srcMsRaw, 0), dur);
    // Walk to the range covering (or preceding) srcMs. n is small (a handful of
    // ranges) so a linear scan is fine and keeps the code obvious.
    let out = 0;
    let cursor = 0;
    for (let i = 0; i < norm.length; i++) {
      const r = norm[i];
      if (srcMs <= r.startMs) {
        // In the identity gap before this range.
        return out + (srcMs - cursor);
      }
      // Advance across the identity gap up to the range start.
      out = outAtStart[i];
      if (srcMs <= r.endMs) {
        // Inside the range: partial contribution at rate r.
        return out + (srcMs - r.startMs) / r.rate;
      }
      // Past the range end; continue past it.
      out += (r.endMs - r.startMs) / r.rate;
      cursor = r.endMs;
    }
    // In the identity tail after the last range.
    return out + (srcMs - cursor);
  };

  return { srcToOut, outDurationMs };
}

/** Re-express source-time speed ranges into POST-TRIM time so the Rust audio
 *  retimer (which operates on the already-trimmed WAV) and the video pipeline's
 *  post-trim speed map apply them directly. Each range is clipped to the trim
 *  window `[startMs, endMs)` then shifted left by `startMs`; ranges that fall
 *  entirely outside the window (or clip to a degenerate span) are dropped.
 *  `trim === null` → pass the ranges through unchanged (no trim). Pure.
 *
 *  CONTRACT (must match the Rust side): the frontend always sends ranges in
 *  post-trim time; Rust never re-derives the trim shift. */
export function shiftRangesForTrim(
  ranges: SpeedRange[],
  trim: { startMs: number; endMs: number } | null,
): SpeedRange[] {
  if (trim === null) return ranges;
  const { startMs, endMs } = trim;
  const out: SpeedRange[] = [];
  for (const r of ranges) {
    const clippedStart = Math.max(r.startMs, startMs);
    const clippedEnd = Math.min(r.endMs, endMs);
    if (clippedEnd <= clippedStart) continue; // fully outside / degenerate
    out.push({
      startMs: clippedStart - startMs,
      endMs: clippedEnd - startMs,
      rate: r.rate,
    });
  }
  return out;
}

/** Find a placement for a NEW speed range near `preferredStartMs`, of length
 *  `lengthMs`. Unlike `placeZoomBlock` (which pushes past overlaps), a speed
 *  add at the playhead is a no-op when the playhead already sits inside a
 *  range (the caller shows a toast): returns `null` in that case. Otherwise it
 *  clamps the block into `[0, durationMs]` and caps its end at the next range's
 *  start (stop-at-neighbour), returning `null` if the resulting gap is shorter
 *  than `SPEED_MIN_LENGTH_MS`. Pure; `ranges` need not be pre-sorted. */
export function placeSpeedRange(
  ranges: SpeedRange[],
  preferredStartMs: number,
  lengthMs: number,
  durationMs: number,
): { startMs: number; endMs: number } | null {
  const dur = Math.max(0, durationMs);
  if (dur < SPEED_MIN_LENGTH_MS) return null;
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);

  let start = clamp(Math.round(preferredStartMs), 0, Math.max(0, dur - lengthMs));

  // No-op if the (clamped) start lands inside an existing range — the start
  // edge counts as inside so butting ranges don't silently swallow the add.
  for (const r of sorted) {
    if (start >= r.startMs && start < r.endMs) return null;
  }

  let end = Math.min(dur, start + lengthMs);
  // Cap the end at the next range that starts at/after `start`.
  const nextAfter = sorted.find((r) => r.startMs >= start);
  if (nextAfter) end = Math.min(end, nextAfter.startMs);

  if (end - start < SPEED_MIN_LENGTH_MS) return null;
  return { startMs: start, endMs: end };
}

/** Resize one edge of speed range `index`. Mirrors `resizeZoomBlock`'s
 *  stop-at-neighbour semantics: both edges stay in `[0, durationMs]`, the range
 *  keeps at least `SPEED_MIN_LENGTH_MS`, and the moving edge stops at the
 *  neighbour on that side (prev.endMs for "start", next.startMs for "end") so
 *  ranges butt up but never overlap. `ranges` is assumed sorted by `startMs`.
 *  Never drops/reorders. Returns a new array (or the same reference on a
 *  no-op). Pure. */
export function resizeSpeedRange(
  ranges: SpeedRange[],
  index: number,
  edge: "start" | "end",
  valueMs: number,
  durationMs: number,
): SpeedRange[] {
  if (index < 0 || index >= ranges.length) return ranges;
  const range = ranges[index];
  const prev = ranges[index - 1];
  const next = ranges[index + 1];

  let v = clamp(Math.round(valueMs), 0, Math.max(0, durationMs));

  if (edge === "start") {
    const lo = prev ? prev.endMs : 0;
    const hi = range.endMs - SPEED_MIN_LENGTH_MS;
    v = clamp(v, lo, Math.max(lo, hi));
    if (v === range.startMs) return ranges;
    return ranges.map((r, i) => (i === index ? { ...r, startMs: v } : r));
  } else {
    const hi = next ? next.startMs : durationMs;
    const lo = range.startMs + SPEED_MIN_LENGTH_MS;
    v = clamp(v, Math.min(lo, hi), hi);
    if (v === range.endMs) return ranges;
    return ranges.map((r, i) => (i === index ? { ...r, endMs: v } : r));
  }
}

// ---- Zoom block editing (Task 3) ----------------------------------------
//
// These are the pure primitives the timeline zoom lane drives every edit
// through. They all take a `blocks` array assumed to be sorted by `startMs`
// and non-overlapping (the invariant materialization + these helpers
// maintain), an index into it, and return a NEW array — never mutating the
// input. Overlap is prevented by clamping against the immediate neighbours'
// edges: an edit that would cross a neighbour STOPS at that neighbour's edge.
// Blocks are never dropped (unlike clampSpeedRanges) — every intermediate drag
// state stays valid, which is what the live-drag UI needs.

/** Minimum zoom block length (ms). A block can't be resized shorter than this,
 *  matching the trim handle's own floor. */
export const ZOOM_MIN_LENGTH_MS = 500;

/** Zoom scale bounds for hand-edited (manual/custom) blocks. Auto blocks use
 *  their own default (2.0); the inspector slider is 1.5–3.0. */
export const ZOOM_SCALE_MIN = 1.5;
export const ZOOM_SCALE_MAX = 3;

/** Default length + scale for a freshly-added manual block ("Add zoom"). */
export const ZOOM_ADD_DEFAULT_LENGTH_MS = 2000;
export const ZOOM_ADD_DEFAULT_SCALE = 2.0;

/** Clamp a zoom center into the viewport-safe range for its scale, so the
 *  magnified sample window never runs off the source edge — identical bound to
 *  `generateAutoZoom` (cx, cy ∈ [0.5/scale, 1 − 0.5/scale]). At scale 1 this
 *  collapses to exactly 0.5 on both axes. Pure. */
export function clampZoomCenter(
  cx: number,
  cy: number,
  scale: number,
): { cx: number; cy: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const lo = 0.5 / s;
  const hi = 1 - 0.5 / s;
  // For s === 1, lo === hi === 0.5, so both clamps pin to 0.5.
  const safe = (v: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0.5);
  return { cx: safe(cx), cy: safe(cy) };
}

/** Next stable zoom-block id: `z<n>` where n is one past the max numeric suffix
 *  already in use (ids like `z1`, `z2`, `m7`… — any trailing integer counts).
 *  Deterministic (NOT time-based) so replaying the same edits yields the same
 *  ids. Empty / id-less input → `z1`. Pure. */
export function nextZoomBlockId(blocks: ZoomBlock[]): string {
  let max = 0;
  for (const b of blocks) {
    if (typeof b.id !== "string") continue;
    const m = b.id.match(/(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `z${max + 1}`;
}

/** Resize one edge of block `index`. `edge` is which end moves; `valueMs` is the
 *  proposed new position for that edge. The result is clamped so that:
 *    - both edges stay in [0, durationMs];
 *    - the block keeps at least `ZOOM_MIN_LENGTH_MS` (the moving edge can't cross
 *      the fixed edge's minimum-gap line);
 *    - the moving edge does not cross the neighbour on that side — it stops at
 *      the neighbour's touching edge (prev.endMs for "start", next.startMs for
 *      "end"), so blocks butt up but never overlap.
 *  Never drops or reorders blocks. Returns a new array. Pure. */
export function resizeZoomBlock(
  blocks: ZoomBlock[],
  index: number,
  edge: "start" | "end",
  valueMs: number,
  durationMs: number,
): ZoomBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  const block = blocks[index];
  const prev = blocks[index - 1];
  const next = blocks[index + 1];

  let v = clamp(Math.round(valueMs), 0, Math.max(0, durationMs));

  if (edge === "start") {
    // Lower bound: neighbour's end (butt against it, no overlap); 0 otherwise.
    const lo = prev ? prev.endMs : 0;
    // Upper bound: keep >= min length before the fixed end edge.
    const hi = block.endMs - ZOOM_MIN_LENGTH_MS;
    v = clamp(v, lo, Math.max(lo, hi));
    if (v === block.startMs) return blocks;
    return blocks.map((b, i) => (i === index ? { ...b, startMs: v } : b));
  } else {
    // Upper bound: neighbour's start (butt against it); duration otherwise.
    const hi = next ? next.startMs : durationMs;
    // Lower bound: keep >= min length after the fixed start edge.
    const lo = block.startMs + ZOOM_MIN_LENGTH_MS;
    v = clamp(v, Math.min(lo, hi), hi);
    if (v === block.endMs) return blocks;
    return blocks.map((b, i) => (i === index ? { ...b, endMs: v } : b));
  }
}

/** Find a placement for a NEW zoom block near `preferredStartMs`, of length
 *  `lengthMs`, that (a) fits in [0, durationMs] and (b) doesn't overlap any of
 *  `blocks` (assumed sorted, non-overlapping). Strategy: start at the clamped
 *  preferred start, then push right past any block it overlaps, then cap its end
 *  at the next block's start. Returns `{startMs, endMs}` when a slot ≥
 *  `ZOOM_MIN_LENGTH_MS` exists, else `null` (timeline full / too short). Pure. */
export function placeZoomBlock(
  blocks: ZoomBlock[],
  preferredStartMs: number,
  lengthMs: number,
  durationMs: number,
): { startMs: number; endMs: number } | null {
  const dur = Math.max(0, durationMs);
  if (dur < ZOOM_MIN_LENGTH_MS) return null;

  const sorted = [...blocks].sort((a, b) => a.startMs - b.startMs);
  let start = clamp(Math.round(preferredStartMs), 0, Math.max(0, dur - lengthMs));
  let end = Math.min(dur, start + lengthMs);

  // Push past any block the desired window overlaps (left-to-right).
  for (const b of sorted) {
    if (start < b.endMs && end > b.startMs) {
      start = b.endMs;
      end = Math.min(dur, start + lengthMs);
    }
  }
  // Cap the end at the next block that starts at/after `start`.
  const nextAfter = sorted.find((b) => b.startMs >= start);
  if (nextAfter) end = Math.min(end, nextAfter.startMs);

  if (start >= dur || end - start < ZOOM_MIN_LENGTH_MS) return null;
  return { startMs: start, endMs: end };
}

/** Move block `index` bodily so its start lands at (as close as possible to)
 *  `newStartMs`, preserving its length. Clamped so the whole block stays in
 *  [0, durationMs] AND does not overlap either neighbour: the block can slide
 *  until its leading edge touches the next block's start or its trailing edge
 *  touches the previous block's end. Never drops/reorders blocks. Returns a new
 *  array. Pure. */
export function moveZoomBlock(
  blocks: ZoomBlock[],
  index: number,
  newStartMs: number,
  durationMs: number,
): ZoomBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  const block = blocks[index];
  const len = block.endMs - block.startMs;
  const prev = blocks[index - 1];
  const next = blocks[index + 1];

  // Allowed range for the block's start given the neighbours and bounds.
  const lo = prev ? prev.endMs : 0;
  const hi = (next ? next.startMs : Math.max(0, durationMs)) - len;
  // If the block is longer than the gap (shouldn't happen with a valid layout),
  // lo may exceed hi; prefer lo so it butts against the previous neighbour.
  let start = clamp(Math.round(newStartMs), lo, Math.max(lo, hi));
  if (start === block.startMs) return blocks;
  return blocks.map((b, i) =>
    i === index ? { ...b, startMs: start, endMs: start + len } : b,
  );
}

/** Path of the editor's `"rendered"` entry inside a recording row's `exports`
 *  JSON, or `null` when the recording has never been editor-exported (or the
 *  JSON is malformed). Lets the post-export "Reveal in Finder" affordance
 *  target `<id>.rendered.mp4` instead of the original recording. */
export function renderedExportPath(exportsJson: string): string | null {
  try {
    const v: unknown = JSON.parse(exportsJson);
    if (!Array.isArray(v)) return null;
    for (const e of v) {
      if (
        e &&
        typeof e === "object" &&
        (e as { quality?: unknown }).quality === "rendered" &&
        typeof (e as { path?: unknown }).path === "string" &&
        (e as { path: string }).path.length > 0
      ) {
        return (e as { path: string }).path;
      }
    }
    return null;
  } catch {
    return null;
  }
}
