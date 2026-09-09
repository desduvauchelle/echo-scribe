import { describe, expect, test } from "bun:test";
import { CATEGORIES, GROUPS, LESSONS, MILESTONES, emptyCounts, groupLessons, groupProgress, initialLearning, learningSteps, markVisited, nextTip, observeCounts } from "../src/lib/learning";

describe("local learning progress", () => {
  test("existing history earns milestones without a historical pop-up backlog", () => {
    const state = observeCounts(initialLearning(), { ...emptyCounts(), transcriptions: 800, meetings: 51 });
    expect(state.pending).toEqual([]);
    expect(state.earned).toHaveLength(8);
    expect(state.hidden).toBe(true);
  });
  test("every capture type celebrates increasing thresholds once, stopping at 200", () => {
    for (const category of CATEGORIES) {
      let state = observeCounts(initialLearning(), emptyCounts());
      for (const count of MILESTONES) {
        state = observeCounts(state, { ...emptyCounts(), [category]: count });
        expect(state.pending.at(-1)).toEqual({ category, count });
      }
      expect(state.pending).toHaveLength(5);
      expect(observeCounts(state, { ...emptyCounts(), [category]: 500 }).pending).toHaveLength(5);
      expect(observeCounts(state, emptyCounts()).counts[category]).toBe(200);
      expect(observeCounts(state, { ...emptyCounts(), [category]: 200 }).pending).toHaveLength(5);
    }
  });
  test("an offline jump offers the latest milestone for each category", () => {
    const state = observeCounts(observeCounts(initialLearning(), emptyCounts()), { ...emptyCounts(), notes: 60 });
    expect(state.pending).toEqual([{ category: "notes", count: 50 }]);
    expect(state.earned).toHaveLength(3);
  });
  test("turning celebrations off still records wins", () => {
    const state = observeCounts({ ...initialLearning(), initialized: true, celebrations: false }, { ...emptyCounts(), tasks: 10 });
    expect(state.pending).toEqual([]);
    expect(state.earned).toEqual(["tasks:10"]);
  });
  test("learning needs real captures and retrieval; opening a lesson earns nothing", () => {
    expect(learningSteps(initialLearning())).toEqual([false, false, false]);
    expect(learningSteps({ ...initialLearning(), practiced: true })).toEqual([true, false, false]);
    expect(learningSteps({ ...initialLearning(), counts: { ...emptyCounts(), notes: 1 }, retrieved: true })).toEqual([false, true, true]);
  });
  test("tips respect activity, dismissal, snooze and a daily limit", () => {
    const now = Date.now();
    const state = { ...initialLearning(), counts: { ...emptyCounts(), meetings: 1 } };
    expect(nextTip(state, now)?.id).toBe("people");
    expect(nextTip({ ...state, dismissed: ["people"] }, now)).toBeUndefined();
    expect(nextTip({ ...state, snoozed: { people: now + 1000 } }, now)).toBeUndefined();
    expect(nextTip({ ...state, lastTipAt: now - 1000 }, now)).toBeUndefined();
    expect(nextTip({ ...state, tips: false }, now)).toBeUndefined();
  });
});

describe("lesson tracking", () => {
  test("every lesson belongs to exactly one listed group", () => {
    expect(GROUPS.flatMap(groupLessons)).toHaveLength(LESSONS.length);
    for (const group of GROUPS) expect(groupLessons(group).length).toBeGreaterThan(0);
  });
  test("a group reads complete only once every one of its lessons has been opened", () => {
    let state = initialLearning();
    const lessons = groupLessons("voice");
    expect(groupProgress(state, "voice")).toEqual({ done: 0, total: lessons.length, complete: false });
    for (const lesson of lessons.slice(0, -1)) state = markVisited(state, lesson.id);
    expect(groupProgress(state, "voice").complete).toBe(false);
    state = markVisited(state, lessons.at(-1)!.id);
    expect(groupProgress(state, "voice")).toEqual({ done: lessons.length, total: lessons.length, complete: true });
  });
  test("opening the same lesson twice does not double-count it", () => {
    const once = markVisited(initialLearning(), "dictate");
    expect(markVisited(once, "dictate")).toBe(once);
    expect(markVisited(once, "dictate").visited).toEqual(["dictate"]);
  });
});
