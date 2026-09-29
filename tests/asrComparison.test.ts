import { expect, test } from "bun:test";
import { median, wordErrorRate } from "../src/lib/asrComparison";
test("WER counts substitutions, insertions and deletions and can exceed 100%", () => {
  expect(wordErrorRate("one two three", "one four three")).toBeCloseTo(1 / 3);
  expect(wordErrorRate("one two", "one")).toBe(0.5);
  expect(wordErrorRate("one", "one two three")).toBe(2);
  expect(wordErrorRate("", "one")).toBeNull();
});
test("WER ignores punctuation and case while preserving accented words", () => {
  expect(wordErrorRate("Café, DON'T!", "café don’t")).toBe(0);
  expect(wordErrorRate("été", "ete")).toBe(1);
});
test("warm median resists a slow outlier", () => expect(median([900, 10, 20])).toBe(20));
