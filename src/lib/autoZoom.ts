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

/**
 * Parses recorded-events JSONL (header line + one event per line) into a
 * typed header + event array. Blank lines and unparsable lines are skipped.
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
    } else {
      events.push(parsed as RecEvent);
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

  type BlockWithWeight = ZoomBlock & { clickCount: number };

  const blocks: BlockWithWeight[] = clusters.map((cluster) => {
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

    const cx = clamp01(cluster.centroidX, centerLo, centerHi);
    const cy = clamp01(cluster.centroidY, centerLo, centerHi);

    return {
      startMs,
      endMs,
      cx,
      cy,
      scale: options.scale,
      mode: "auto",
      clickCount: cluster.clicks.length,
    };
  });

  // Step 5: merge blocks that overlap or touch after expansion
  // (weighted-by-click-count centroid for the merged center, re-clamped).
  const merged: BlockWithWeight[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && block.startMs <= prev.endMs) {
      const totalClicks = prev.clickCount + block.clickCount;
      const cx = clamp01(
        (prev.cx * prev.clickCount + block.cx * block.clickCount) / totalClicks,
        centerLo,
        centerHi,
      );
      const cy = clamp01(
        (prev.cy * prev.clickCount + block.cy * block.clickCount) / totalClicks,
        centerLo,
        centerHi,
      );
      prev.endMs = Math.max(prev.endMs, block.endMs);
      prev.cx = cx;
      prev.cy = cy;
      prev.clickCount = totalClicks;
    } else {
      merged.push({ ...block });
    }
  }

  return merged.map(({ clickCount: _clickCount, ...block }) => block);
}
