import { describe, expect, test } from "bun:test";
import {
  meetingDuration,
  meetingTitle,
  parseSummary,
  summaryMarkdown,
  summaryPreview,
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

describe("summaryMarkdown", () => {
  test("returns the markdown body verbatim when present", () => {
    const s = parseSummary(
      JSON.stringify({
        markdown: "## Summary\n- Shipped it",
        summary: ["stale bullet"],
        suggested_title: "T",
      }),
    );
    expect(summaryMarkdown(s)).toBe("## Summary\n- Shipped it");
  });

  test("assembles legacy bullets and action items into markdown", () => {
    const s = parseSummary(
      JSON.stringify({
        summary: ["Discussed launch", "Agreed on pricing"],
        action_items: [
          { text: "Send deck", owner: "you" },
          { text: "Review copy", owner: "unspecified" },
        ],
        suggested_title: "T",
      }),
    );
    const md = summaryMarkdown(s)!;
    expect(md).toContain("- Discussed launch");
    expect(md).toContain("## Action items");
    expect(md).toContain("- Send deck *(you)*");
    expect(md.endsWith("- Review copy")).toBe(true);
    expect(md).not.toContain("(unspecified)");
  });

  test("falls back to legacy raw text, and to null when empty", () => {
    expect(
      summaryMarkdown(parseSummary(JSON.stringify({ raw: "plain text notes" }))),
    ).toBe("plain text notes");
    expect(summaryMarkdown(parseSummary(JSON.stringify({ summary: [] })))).toBeNull();
    expect(summaryMarkdown(null)).toBeNull();
  });
});

describe("summaryPreview", () => {
  test("skips headings and strips bullet markers", () => {
    const s = parseSummary(
      JSON.stringify({ markdown: "## Summary\n\n- **Key win**: closed the deal\n- More" }),
    );
    expect(summaryPreview(s)).toBe("Key win: closed the deal");
  });

  test("uses the first legacy bullet", () => {
    const s = parseSummary(
      JSON.stringify({ summary: ["Discussed launch"], action_items: [] }),
    );
    expect(summaryPreview(s)).toBe("Discussed launch");
  });

  test("returns empty string when there is no summary", () => {
    expect(summaryPreview(null)).toBe("");
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
