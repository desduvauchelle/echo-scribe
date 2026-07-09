import { describe, expect, test } from "bun:test";
import { parseGuideReview, parseTimeline, verdictClass } from "../src/lib/guideReview";

describe("guideReview helpers", () => {
  test("parseGuideReview returns null for null/blank/bad json", () => {
    expect(parseGuideReview(null)).toBeNull();
    expect(parseGuideReview("")).toBeNull();
    expect(parseGuideReview("not json")).toBeNull();
  });

  test("parseGuideReview fills missing arrays with empty defaults", () => {
    const r = parseGuideReview('{"overall":"mixed","synthesis":"s"}');
    expect(r).not.toBeNull();
    expect(r!.overall).toBe("mixed");
    expect(r!.scorecard).toEqual([]);
    expect(r!.emergent).toEqual([]);
  });

  test("parseTimeline returns [] for null and parses arrays", () => {
    expect(parseTimeline(null)).toEqual([]);
    const t = parseTimeline('[{"at":"x","key_points":[],"suggestions":["a"]}]');
    expect(t.length).toBe(1);
    expect(t[0].suggestions).toEqual(["a"]);
  });

  test("verdictClass maps verdicts to a stable token", () => {
    expect(verdictClass("met")).toBe("met");
    expect(verdictClass("Partial")).toBe("partial");
    expect(verdictClass("MISSED")).toBe("missed");
    expect(verdictClass("weird")).toBe("unknown");
  });
});

import { aggregateTrend } from "../src/lib/guideReview";
import type { GuideRun } from "../src/lib/api";

function run(id: string, startedAt: string, overall: string, sc: [string, string][]): GuideRun {
  return {
    id, meeting_id: "m", template_id: "t", template_name: "T", template_json: "{}",
    slot: 0, started_at: startedAt,
    timeline_json: null,
    review_json: JSON.stringify({ overall, synthesis: "", scorecard: sc.map(([criterion, verdict]) => ({ criterion, verdict, evidence: "", why: "", tip: "" })), emergent: [] }),
    status: "ready", error: null, generated_at: startedAt, created_at: startedAt,
  };
}

describe("aggregateTrend", () => {
  test("orders columns oldest→newest, counts hits, finds gap and strength", () => {
    const runs: GuideRun[] = [
      run("r2", "2026-07-08T00:00:00Z", "mixed", [["Speak last", "partial"], ["Owner + date", "missed"]]),
      run("r1", "2026-07-01T00:00:00Z", "weak", [["Speak last", "met"], ["Owner + date", "missed"]]),
    ];
    const t = aggregateTrend(runs);
    expect(t.columns.map((c) => c.runId)).toEqual(["r1", "r2"]); // oldest first
    expect(t.criteria).toEqual(["Speak last", "Owner + date"]);
    expect(t.hits).toEqual([1, 0]); // Speak last met once; Owner+date never
    expect(t.gap).toBe("Owner + date"); // missed in 2/2
    expect(t.strength).toBe("Speak last"); // most mets
  });

  test("returns empty structure for no runs", () => {
    const t = aggregateTrend([]);
    expect(t.criteria).toEqual([]);
    expect(t.columns).toEqual([]);
    expect(t.gap).toBeNull();
  });
});
