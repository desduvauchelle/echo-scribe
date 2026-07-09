import type { GuideReview, TimelineEntry, GuideRun } from "./api";

/** Safe-parse a `review_json` string into a fully-defaulted GuideReview. */
export function parseGuideReview(json: string | null): GuideReview | null {
  if (!json || !json.trim()) return null;
  try {
    const o = JSON.parse(json) as Partial<GuideReview>;
    return {
      overall: typeof o.overall === "string" ? o.overall : "",
      synthesis: typeof o.synthesis === "string" ? o.synthesis : "",
      scorecard: Array.isArray(o.scorecard) ? o.scorecard : [],
      emergent: Array.isArray(o.emergent) ? o.emergent : [],
    };
  } catch {
    return null;
  }
}

/** Safe-parse a `timeline_json` string into an array (never throws). */
export function parseTimeline(json: string | null): TimelineEntry[] {
  if (!json || !json.trim()) return [];
  try {
    const o = JSON.parse(json);
    return Array.isArray(o) ? (o as TimelineEntry[]) : [];
  } catch {
    return [];
  }
}

/** Normalize a loose verdict string to one of met/partial/missed/unknown. */
export function verdictClass(verdict: string): "met" | "partial" | "missed" | "unknown" {
  const v = (verdict || "").toLowerCase();
  if (v === "met") return "met";
  if (v === "partial") return "partial";
  if (v === "missed") return "missed";
  return "unknown";
}

export type TrendColumn = { runId: string; startedAt: string; overall: string; cells: string[] };
export type TrendData = {
  criteria: string[];
  columns: TrendColumn[];
  hits: number[];
  gap: string | null;
  strength: string | null;
};

export function aggregateTrend(runs: GuideRun[]): TrendData {
  // Oldest → newest by started_at.
  const sorted = [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const parsed = sorted.map((r) => ({ run: r, review: parseGuideReview(r.review_json) }));

  // Criteria order from the most recent run that has a scorecard.
  let criteria: string[] = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    const sc = parsed[i].review?.scorecard ?? [];
    if (sc.length > 0) {
      criteria = sc.map((c) => c.criterion);
      break;
    }
  }

  const columns: TrendColumn[] = parsed.map(({ run, review }) => {
    const byName = new Map((review?.scorecard ?? []).map((c) => [c.criterion, verdictClass(c.verdict)]));
    return {
      runId: run.id,
      startedAt: run.started_at,
      overall: review?.overall ?? "",
      cells: criteria.map((c) => byName.get(c) ?? "unknown"),
    };
  });

  const hits = criteria.map((_, i) => columns.filter((col) => col.cells[i] === "met").length);
  const misses = criteria.map((_, i) => columns.filter((col) => col.cells[i] === "missed").length);

  const gap =
    criteria.length > 0 && Math.max(...misses) > 0
      ? criteria[misses.indexOf(Math.max(...misses))]
      : null;
  const strength =
    criteria.length > 0 && Math.max(...hits) > 0
      ? criteria[hits.indexOf(Math.max(...hits))]
      : null;

  return { criteria, columns, hits, gap, strength };
}
