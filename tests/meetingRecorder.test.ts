import { describe, expect, test } from "bun:test";
import { nextRecorderAction } from "../src/lib/meetingRecorder";

describe("nextRecorderAction", () => {
  test("stops when a meeting is active", () => {
    expect(nextRecorderAction(true)).toBe("stop");
  });

  test("starts when nothing is recording", () => {
    expect(nextRecorderAction(false)).toBe("start");
  });
});
