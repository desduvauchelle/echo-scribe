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
