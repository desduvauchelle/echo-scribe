import { describe, expect, test } from "bun:test";
import { caughtOfKind, extractCaught } from "../src/lib/caught";
import type { TranscriptSegment } from "../src/lib/api";

function seg(text: string, start_ms = 0, speaker: "you" | "them" = "you"): TranscriptSegment {
  return { speaker, start_ms, end_ms: start_ms + 1000, text };
}

const textsOf = (segments: TranscriptSegment[]) =>
  extractCaught(segments).map((c) => c.text.toLowerCase());

describe("extractCaught", () => {
  test("catches weekdays and clock times", () => {
    const found = textsOf([seg("let's move it to Friday, maybe 8am")]);
    expect(found).toContain("friday");
    expect(found).toContain("8am");
  });

  test("keeps a duration whole instead of splitting off the number", () => {
    const found = textsOf([seg("he had two months to learn the book")]);
    expect(found).toContain("two months");
    expect(found).not.toContain("two");
  });

  test("catches money and percentages", () => {
    const found = textsOf([seg("we spent $1,200 and it grew 20%")]);
    expect(found).toContain("$1,200");
    expect(found).toContain("20%");
  });

  test("splits dates from numbers", () => {
    const items = extractCaught([seg("three years ago we had 40 customers")]);
    expect(caughtOfKind(items, "date").map((c) => c.text)).toContain("three years");
    expect(caughtOfKind(items, "number").map((c) => c.text)).toContain("40 customers");
  });

  test("ignores prose with nothing quantitative in it", () => {
    expect(extractCaught([seg("the professor is there to teach")])).toHaveLength(0);
  });

  test("deduplicates repeats and keeps the first time it was said", () => {
    const items = extractCaught([
      seg("Friday works", 5000),
      seg("so Friday then", 90000),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].atMs).toBe(5000);
  });

  test("orders newest first", () => {
    const items = extractCaught([seg("40 customers", 1000), seg("Friday", 9000)]);
    expect(items[0].text.toLowerCase()).toBe("friday");
  });

  test("records who said it", () => {
    const items = extractCaught([seg("Friday", 0, "them")]);
    expect(items[0].speaker).toBe("them");
  });

  test("does not catch bare single digits", () => {
    expect(textsOf([seg("there were 3 of us")])).not.toContain("3");
  });
});

describe("month names", () => {
  test("catches a real month and day", () => {
    const found = extractCaught([seg("let's ship it March 5")]).map((c) => c.text);
    expect(found).toContain("March 5");
  });

  test("does not treat a word merely starting with a month as a date", () => {
    const items = extractCaught([seg("maybe 20% more coverage")]);
    expect(items.map((c) => c.text.toLowerCase())).not.toContain("maybe 20");
    expect(caughtOfKind(items, "number").map((c) => c.text)).toContain("20%");
  });
});
