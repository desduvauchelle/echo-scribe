import { describe, expect, test } from "bun:test";
import { currentTick, secondsSequence } from "../src/lib/countdown";

describe("secondsSequence", () => {
  test("3 seconds -> [3, 2, 1]", () => {
    expect(secondsSequence(3)).toEqual([3, 2, 1]);
  });

  test("1 second -> [1]", () => {
    expect(secondsSequence(1)).toEqual([1]);
  });

  test("0 or negative seconds -> empty (no countdown)", () => {
    expect(secondsSequence(0)).toEqual([]);
    expect(secondsSequence(-5)).toEqual([]);
  });

  test("floors a fractional seconds value", () => {
    expect(secondsSequence(3.9)).toEqual([3, 2, 1]);
  });
});

describe("currentTick", () => {
  const seq = [3, 2, 1];

  test("ticksElapsed 0 shows the first number", () => {
    expect(currentTick(seq, 0)).toBe(3);
  });

  test("ticksElapsed advances through the sequence", () => {
    expect(currentTick(seq, 1)).toBe(2);
    expect(currentTick(seq, 2)).toBe(1);
  });

  test("ticksElapsed past the end returns null (countdown finished)", () => {
    expect(currentTick(seq, 3)).toBeNull();
    expect(currentTick(seq, 99)).toBeNull();
  });

  test("negative ticksElapsed returns null", () => {
    expect(currentTick(seq, -1)).toBeNull();
  });

  test("empty sequence always returns null", () => {
    expect(currentTick([], 0)).toBeNull();
  });
});
