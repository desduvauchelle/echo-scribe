import { describe, expect, test } from "bun:test";
import {
  meetingDuration,
  meetingTitle,
  parseSummary,
} from "../src/lib/meetingDisplay";
import type { MeetingRow } from "../src/lib/api";

function row(over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    item_id: "m1",
    started_at: "2026-07-20T11:00:00Z",
    ended_at: null,
    duration_ms: null,
    detected_app: null,
    detected_app_name: null,
    status: "complete",
    transcript_json: null,
    summary_json: null,
    user_notes: null,
    failed_chunk_count: 0,
    mic_only: false,
    calendar_match_json: null,
    guide_template_json: null,
    project_name: null,
    ...over,
  } as MeetingRow;
}

describe("parseSummary", () => {
  test("returns null for absent or malformed JSON", () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary("")).toBeNull();
    expect(parseSummary("{ half-writ")).toBeNull();
  });

  test("parses a stored summary", () => {
    const s = parseSummary(
      JSON.stringify({ summary: ["a", "b"], action_items: [], suggested_title: "Kickoff" }),
    );
    expect(s?.suggested_title).toBe("Kickoff");
    expect(s?.summary).toHaveLength(2);
  });
});

describe("meetingTitle", () => {
  test("prefers the summary's suggested title", () => {
    const s = parseSummary(
      JSON.stringify({ summary: [], action_items: [], suggested_title: "Roadmap sync" }),
    );
    expect(meetingTitle(row({ detected_app_name: "Zoom" }), s)).toBe("Roadmap sync");
  });

  test("falls back to the detected app when there is no title", () => {
    expect(meetingTitle(row({ detected_app_name: "Zoom" }), null)).toBe("Zoom meeting");
  });

  test("falls back again for a manual meeting", () => {
    expect(meetingTitle(row(), null)).toBe("Manual meeting");
  });

  test("a blank suggested title does not win", () => {
    const s = parseSummary(
      JSON.stringify({ summary: [], action_items: [], suggested_title: "   " }),
    );
    expect(meetingTitle(row({ detected_app_name: "Teams" }), s)).toBe("Teams meeting");
  });
});

describe("meetingDuration", () => {
  test("renders minutes under an hour", () => {
    expect(meetingDuration(600_000)).toBe("10m");
  });

  test("renders hours and minutes past an hour", () => {
    expect(meetingDuration(5_400_000)).toBe("1h 30m");
  });

  test("treats a missing duration as zero", () => {
    expect(meetingDuration(null)).toBe("0m");
    expect(meetingDuration(undefined)).toBe("0m");
  });
});
