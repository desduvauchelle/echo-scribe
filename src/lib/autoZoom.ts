// Pure TS module: converts recorded input events (JSONL from the Swift sidecar)
// into Screen Studio-style auto-zoom timeline blocks. No dependencies.

export type RecEvent =
  | { t: number; k: "move"; x: number; y: number }
  | { t: number; k: "down" | "up"; b: "l" | "r" | "o"; x: number; y: number }
  | { t: number; k: "scroll"; x: number; y: number; dx: number; dy: number }
  | { t: number; k: "key"; code: number; mods: string[] };

export type EventsHeader = {
  k: "header"; v: number;
  capture: { kind: "display" | "window"; rect: [number, number, number, number]; px_scale: number };
  screen_h: number;
};

export type ZoomBlock = {
  startMs: number; endMs: number;
  // zoom center in normalized capture coords (0..1 relative to capture.rect)
  cx: number; cy: number;
  scale: number;           // e.g. 2.0
  mode: "auto";
};

export type AutoZoomOptions = {
  scale: number;          // default 2.0
  leadInMs: number;       // default 800  (zoom starts this long before first click)
  holdMs: number;         // default 1600 (zoom holds this long after last click)
  clusterGapMs: number;   // default 3000 (clicks closer than this join a block)
  clusterDistFrac: number;// default 0.25 (…and within this fraction of capture diagonal)
  minBlockMs: number;     // default 2000
};

const DEFAULT_OPTIONS: AutoZoomOptions = {
  scale: 2.0,
  leadInMs: 800,
  holdMs: 1600,
  clusterGapMs: 3000,
  clusterDistFrac: 0.25,
  minBlockMs: 2000,
};

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validates that a parsed JSON object has the required shape for its `k`
 * (event kind) before it's trusted as a RecEvent. This exists because a
 * structurally-valid-JSON line with the wrong/missing fields (e.g. a `down`
 * missing x/y) would otherwise be pushed through unchecked: the missing
 * fields become `undefined`/NaN, which silently survive the bounds check in
 * generateAutoZoom (NaN comparisons are always false) and corrupt centroid
 * math downstream. Kept minimal and kind-specific per the event union.
 */
function isValidRecEvent(obj: Record<string, unknown>): obj is RecEvent {
  if (!isFiniteNum(obj.t)) return false;
  switch (obj.k) {
    case "move":
      return isFiniteNum(obj.x) && isFiniteNum(obj.y);
    case "down":
    case "up":
      return (
        (obj.b === "l" || obj.b === "r" || obj.b === "o") &&
        isFiniteNum(obj.x) &&
        isFiniteNum(obj.y)
      );
    case "scroll":
      return (
        isFiniteNum(obj.x) && isFiniteNum(obj.y) && isFiniteNum(obj.dx) && isFiniteNum(obj.dy)
      );
    case "key":
      return isFiniteNum(obj.code) && Array.isArray(obj.mods);
    default:
      return false;
  }
}

/**
 * Parses recorded-events JSONL (header line + one event per line) into a
 * typed header + event array. Blank lines, unparsable lines, and
 * shape-invalid events (right kind, missing/non-numeric required fields) are
 * skipped.
 */
export function parseEventsJsonl(text: string): { header: EventsHeader | null; events: RecEvent[] } {
  let header: EventsHeader | null = null;
  const events: RecEvent[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;

    if (obj.k === "header") {
      header = parsed as EventsHeader;
    } else if (isValidRecEvent(obj)) {
      events.push(obj);
    }
  }

  return { header, events };
}

type NormalizedClick = { t: number; nx: number; ny: number };

type Cluster = {
  clicks: NormalizedClick[];
  // running centroid of the cluster, used for the join-distance check
  centroidX: number;
  centroidY: number;
};

/**
 * Generates auto-zoom timeline blocks from recorded events, mimicking Screen
 * Studio's click-driven zoom behavior: no clicks means no zoom.
 */
export function generateAutoZoom(
  header: EventsHeader,
  events: RecEvent[],
  durationMs: number,
  opts?: Partial<AutoZoomOptions>,
): ZoomBlock[] {
  const options: AutoZoomOptions = { ...DEFAULT_OPTIONS, ...opts };

  // Step 1: take `down` events only (any button). No clicks -> no zoom.
  // Manual loop (not .filter + Extract<>) is deliberate: Extract<RecEvent,
  // { k: "down" }> fails to narrow the "down" | "up" literal union under this
  // repo's tsc config (produces `never`), which broke `bun run build` even
  // though bun's test runner doesn't type-check and so didn't catch it.
  const downEvents: Array<{ t: number; k: "down" | "up"; b: "l" | "r" | "o"; x: number; y: number }> = [];
  for (const e of events) {
    if (e.k === "down") downEvents.push(e);
  }
  if (downEvents.length === 0) return [];

  // Step 2: normalize click coords into capture space; drop clicks outside [0,1].
  const [rx, ry, rw, rh] = header.capture.rect;
  const normalized: NormalizedClick[] = [];
  for (const e of downEvents) {
    const nx = (e.x - rx) / rw;
    const ny = (e.y - ry) / rh;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
    normalized.push({ t: e.t, nx, ny });
  }
  if (normalized.length === 0) return [];

  // Step 3: greedy clustering in event order.
  const clusters: Cluster[] = [];
  for (const click of normalized) {
    const current = clusters[clusters.length - 1];
    if (current) {
      const lastT = current.clicks[current.clicks.length - 1].t;
      const dist = Math.hypot(click.nx - current.centroidX, click.ny - current.centroidY);
      if (click.t - lastT <= options.clusterGapMs && dist <= options.clusterDistFrac) {
        current.clicks.push(click);
        const n = current.clicks.length;
        current.centroidX = current.centroidX + (click.nx - current.centroidX) / n;
        current.centroidY = current.centroidY + (click.ny - current.centroidY) / n;
        continue;
      }
    }
    clusters.push({ clicks: [click], centroidX: click.nx, centroidY: click.ny });
  }

  // Step 4: per cluster -> block.
  const clamp01 = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const centerLo = 0.5 / options.scale;
  const centerHi = 1 - 0.5 / options.scale;

  // Internal-only accumulator: carries RAW (unclamped) weighted-coordinate
  // sums and click counts through construction and merging. The viewport
  // clamp is applied exactly once, when a final ZoomBlock is emitted, so a
  // merge always re-centers on the true click distribution rather than on
  // already-clamped per-block centers (see Finding 1 in the M1 review).
  type BlockAccum = {
    startMs: number;
    endMs: number;
    sumX: number; // sum of raw normalized click x, across all clicks in the (merged) block
    sumY: number;
    clickCount: number;
  };

  const toZoomBlock = (b: BlockAccum): ZoomBlock => ({
    startMs: b.startMs,
    endMs: b.endMs,
    cx: clamp01(b.sumX / b.clickCount, centerLo, centerHi),
    cy: clamp01(b.sumY / b.clickCount, centerLo, centerHi),
    scale: options.scale,
    mode: "auto",
  });

  const blocks: BlockAccum[] = clusters.map((cluster) => {
    const firstT = cluster.clicks[0].t;
    const lastT = cluster.clicks[cluster.clicks.length - 1].t;

    let startMs = Math.max(0, firstT - options.leadInMs);
    let endMs = Math.min(durationMs, lastT + options.holdMs);

    // Extend to minBlockMs via centered growth, clamped to [0, durationMs].
    // If growth on one side would overflow the timeline bound, shift the
    // shortfall to the other side so the block still reaches minBlockMs
    // whenever the full timeline is long enough to hold it.
    const length = endMs - startMs;
    if (length < options.minBlockMs) {
      const deficit = options.minBlockMs - length;
      let growStart = deficit / 2;
      let growEnd = deficit / 2;

      const availableBefore = startMs; // room to grow left before hitting 0
      if (growStart > availableBefore) {
        growEnd += growStart - availableBefore;
        growStart = availableBefore;
      }
      const availableAfter = durationMs - endMs; // room to grow right before hitting duration
      if (growEnd > availableAfter) {
        growStart += growEnd - availableAfter;
        growEnd = availableAfter;
      }

      startMs = Math.max(0, startMs - growStart);
      endMs = Math.min(durationMs, endMs + growEnd);
    }

    let sumX = 0;
    let sumY = 0;
    for (const c of cluster.clicks) {
      sumX += c.nx;
      sumY += c.ny;
    }

    return {
      startMs,
      endMs,
      sumX,
      sumY,
      clickCount: cluster.clicks.length,
    };
  });

  // Step 5: merge blocks that overlap or touch after expansion. Merged
  // center is the weighted-by-click-count centroid of RAW click coordinates
  // (raw sums simply add across merges), clamped once at emission below —
  // NOT a re-average of each block's already-clamped center.
  const merged: BlockAccum[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && block.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, block.endMs);
      prev.sumX += block.sumX;
      prev.sumY += block.sumY;
      prev.clickCount += block.clickCount;
    } else {
      merged.push({ ...block });
    }
  }

  return merged.map(toZoomBlock);
}
