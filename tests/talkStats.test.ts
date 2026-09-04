import { describe, expect, test } from "bun:test";
import {
  floorTimeline,
  longestTurnMs,
  questionCount,
  talkShare,
  toTurns,
  wordCount,
  wordsPerMinute,
} from "../src/lib/talkStats";
import type { TranscriptSegment } from "../src/lib/api";

function seg(
  speaker: "you" | "them",
  start_ms: number,
  end_ms: number,
  text = "hello there",
): TranscriptSegment {
  return { speaker, start_ms, end_ms, text };
}

describe("talkShare", () => {
  test("is empty before anyone speaks", () => {
    expect(talkShare([])).toEqual({ you: 0, them: 0, spokenMs: 0 });
  });

  test("splits on spoken time, ignoring the silence between segments", () => {
    const share = talkShare([seg("you", 0, 3000), seg("them", 60000, 61000)]);
    expect(share.you).toBeCloseTo(0.75);
    expect(share.them).toBeCloseTo(0.25);
    expect(share.spokenMs).toBe(4000);
  });

  test("distinguishes an even split from silence", () => {
    const even = talkShare([seg("you", 0, 1000), seg("them", 1000, 2000)]);
    expect(even.you).toBeCloseTo(0.5);
    expect(even.spokenMs).toBeGreaterThan(0);
  });
});

describe("toTurns", () => {
  test("merges consecutive segments from the same speaker", () => {
    const turns = toTurns([
      seg("you", 0, 1000, "one"),
      seg("you", 1200, 2000, "two"),
      seg("them", 2500, 3000, "three"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ speaker: "you", startMs: 0, endMs: 2000, text: "one two" });
    expect(turns[1]).toMatchObject({ speaker: "them", startMs: 2500, endMs: 3000 });
  });
});

describe("longestTurnMs", () => {
  test("measures the merged turn, not the longest single segment", () => {
    const segments = [
      seg("you", 0, 20000),
      seg("you", 20000, 40000),
      seg("you", 40000, 95000),
      seg("them", 96000, 99000),
    ];
    expect(longestTurnMs(segments)).toBe(95000);
  });

  test("is zero with no segments", () => {
    expect(longestTurnMs([])).toBe(0);
  });
});

describe("floorTimeline", () => {
  test("reports the dominant speaker per slice", () => {
    const segments = [seg("you", 0, 5000), seg("them", 5000, 10000)];
    expect(floorTimeline(segments, 2)).toEqual(["you", "them"]);
  });

  test("marks silent slices null rather than crediting the last speaker", () => {
    const segments = [seg("you", 0, 1000), seg("them", 9000, 10000)];
    expect(floorTimeline(segments, 5)).toEqual(["you", null, null, null, "them"]);
  });

  test("returns nothing to draw before any speech", () => {
    expect(floorTimeline([], 8)).toEqual([]);
  });

  test("a monologue fills every slice it spans", () => {
    const bars = floorTimeline([seg("you", 0, 60000), seg("them", 60000, 70000)], 7);
    expect(bars.filter((b) => b === "you").length).toBeGreaterThan(4);
  });
});

describe("wordCount", () => {
  test("counts hyphenated and apostrophised words once", () => {
    expect(wordCount("it's a well-known thing")).toBe(4);
  });

  test("ignores punctuation-only text", () => {
    expect(wordCount("… ?!")).toBe(0);
  });
});

describe("wordsPerMinute", () => {
  test("rates a speaker over their own speaking time", () => {
    const segments = [seg("you", 0, 60000, new Array(140).fill("word").join(" "))];
    expect(wordsPerMinute(segments, "you")).toBe(140);
  });

  test("stays silent until there is enough speech to be meaningful", () => {
    expect(wordsPerMinute([seg("you", 0, 800, "quick two")], "you")).toBe(0);
  });

  test("does not count the other speaker's words", () => {
    const segments = [seg("them", 0, 60000, new Array(200).fill("word").join(" "))];
    expect(wordsPerMinute(segments, "you")).toBe(0);
  });
});

describe("questionCount", () => {
  test("counts a question mark", () => {
    expect(questionCount([seg("you", 0, 1000, "does that match how you see it?")], "you")).toBe(1);
  });

  test("counts an unpunctuated interrogative opener", () => {
    expect(questionCount([seg("you", 0, 1000, "how does that land for you")], "you")).toBe(1);
  });

  test("ignores statements and the other speaker", () => {
    const segments = [
      seg("you", 0, 1000, "the deadline moved to Friday"),
      seg("them", 1000, 2000, "why did it move?"),
    ];
    expect(questionCount(segments, "you")).toBe(0);
    expect(questionCount(segments, "them")).toBe(1);
  });
});
