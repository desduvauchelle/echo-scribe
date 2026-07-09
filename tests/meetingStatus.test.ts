import { describe, expect, test } from "bun:test";
import {
  isMeetingProcessing,
  meetingStatusDisplay,
} from "../src/lib/meetingStatus";
import type { MeetingStatus } from "../src/lib/api";

describe("meeting status display", () => {
  test("in-progress statuses count as processing", () => {
    expect(isMeetingProcessing("recording")).toBe(true);
    expect(isMeetingProcessing("transcribing")).toBe(true);
    expect(isMeetingProcessing("summarizing")).toBe(true);
  });

  test("terminal statuses are not processing", () => {
    expect(isMeetingProcessing("complete")).toBe(false);
    expect(isMeetingProcessing("failed")).toBe(false);
    expect(isMeetingProcessing("recovered")).toBe(false);
  });

  test("transcribing shows a spinning pill", () => {
    const d = meetingStatusDisplay("transcribing");
    expect(d.label).toBe("Transcribing…");
    expect(d.spinner).toBe(true);
    expect(d.tone).toBe("processing");
    expect(d.pill).toBe(true);
  });

  test("summarizing shows a spinning pill", () => {
    const d = meetingStatusDisplay("summarizing");
    expect(d.label).toBe("Summarizing…");
    expect(d.spinner).toBe(true);
    expect(d.tone).toBe("processing");
    expect(d.pill).toBe(true);
  });

  test("recording shows a spinning pill", () => {
    const d = meetingStatusDisplay("recording");
    expect(d.label).toBe("Recording…");
    expect(d.spinner).toBe(true);
    expect(d.pill).toBe(true);
  });

  test("failed shows a danger pill without a spinner", () => {
    const d = meetingStatusDisplay("failed");
    expect(d.label).toBe("Failed");
    expect(d.spinner).toBe(false);
    expect(d.tone).toBe("danger");
    expect(d.pill).toBe(true);
  });

  test("complete shows no pill so the card renders its normal counts + duration", () => {
    const d = meetingStatusDisplay("complete");
    expect(d.pill).toBe(false);
    expect(d.spinner).toBe(false);
    expect(d.description).toBe("");
  });

  test("recovered is terminal with a note but no pill", () => {
    const d = meetingStatusDisplay("recovered");
    expect(d.pill).toBe(false);
    expect(d.spinner).toBe(false);
    expect(d.label).toBe("Recovered");
  });

  test("every non-complete status has a banner description", () => {
    const nonComplete: MeetingStatus[] = [
      "recording",
      "transcribing",
      "summarizing",
      "failed",
      "recovered",
    ];
    for (const s of nonComplete) {
      expect(meetingStatusDisplay(s).description.length).toBeGreaterThan(0);
    }
  });
});
