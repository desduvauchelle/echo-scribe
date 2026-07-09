import type { GuideReview, TimelineEntry } from "./api";

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
