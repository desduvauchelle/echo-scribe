import { describe, expect, test } from "bun:test";
import {
  clampMeetingsToPage,
  mergeBrowseFeed,
  mergeFeed,
} from "../src/lib/feed";
import type { Item, MeetingRow, RecordingRow } from "../src/lib/api";

function item(id: string, capturedAt: string, kind: Item["kind"] = "note"): Item {
  return {
    id,
    content: `content ${id}`,
    source: kind === "meeting" ? "meeting" : "manual",
    kind,
    project_id: null,
    captured_at: capturedAt,
    created_at: capturedAt,
    deleted_at: null,
    confidence: null,
    classified_by: null,
    capture_context: null,
  } as Item;
}

function meeting(itemId: string, startedAt: string): MeetingRow {
  return {
    item_id: itemId,
    started_at: startedAt,
    ended_at: null,
    duration_ms: 600_000,
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
  } as MeetingRow;
}

function recording(id: string, createdAt: number): RecordingRow {
  return { id, created_at: createdAt } as RecordingRow;
}

describe("mergeFeed", () => {
  test("interleaves items, meetings and recordings newest-first", () => {
    const entries = mergeFeed(
      [item("i1", "2026-07-20T10:00:00Z")],
      [recording("r1", Date.parse("2026-07-20T12:00:00Z"))],
      [meeting("m1", "2026-07-20T11:00:00Z")],
    );
    expect(entries.map((e) => e.key)).toEqual(["r:r1", "m:m1", "i:i1"]);
  });

  test("a meeting present in both lists renders once, as a meeting", () => {
    const entries = mergeFeed(
      [item("m1", "2026-07-20T11:00:00Z", "meeting"), item("i1", "2026-07-20T10:00:00Z")],
      [],
      [meeting("m1", "2026-07-20T11:00:00Z")],
    );
    expect(entries.map((e) => e.key)).toEqual(["m:m1", "i:i1"]);
    expect(entries[0].type).toBe("meeting");
  });

  test("a meeting item with no meeting row still shows as an item", () => {
    const entries = mergeFeed([item("orphan", "2026-07-20T11:00:00Z", "meeting")], [], []);
    expect(entries.map((e) => e.key)).toEqual(["i:orphan"]);
  });

  test("meeting-derived tasks are untouched — they are not meetings", () => {
    const task = item("t1", "2026-07-20T11:30:00Z", "task");
    const entries = mergeFeed([task], [], [meeting("m1", "2026-07-20T11:00:00Z")]);
    expect(entries.map((e) => e.key)).toEqual(["i:t1", "m:m1"]);
  });
});

describe("clampMeetingsToPage", () => {
  const meetings = [
    meeting("new", "2026-07-20T12:00:00Z"),
    meeting("old", "2026-01-01T09:00:00Z"),
  ];

  test("holds back meetings older than the loaded page", () => {
    const oldest = Date.parse("2026-07-20T08:00:00Z");
    expect(clampMeetingsToPage(meetings, oldest, true).map((m) => m.item_id)).toEqual([
      "new",
    ]);
  });

  test("keeps everything once all items are loaded", () => {
    const oldest = Date.parse("2026-07-20T08:00:00Z");
    expect(clampMeetingsToPage(meetings, oldest, false)).toHaveLength(2);
  });

  test("keeps everything when no items are loaded", () => {
    expect(clampMeetingsToPage(meetings, null, true)).toHaveLength(2);
  });
});

describe("mergeBrowseFeed", () => {
  test("holds recordings older than the loaded item page behind Load more", () => {
    const entries = mergeBrowseFeed(
      [
        item("new", "2026-07-20T12:00:00Z"),
        item("cutoff", "2026-07-20T10:00:00Z"),
      ],
      [
        recording("inside", Date.parse("2026-07-20T11:00:00Z")),
        recording("old", Date.parse("2026-07-20T09:00:00Z")),
      ],
      [],
      true,
    );

    expect(entries.map((e) => e.key)).toEqual([
      "i:new",
      "r:inside",
      "i:cutoff",
    ]);
  });

  test("shows older recordings and meetings once the item history is complete", () => {
    const entries = mergeBrowseFeed(
      [item("new", "2026-07-20T12:00:00Z")],
      [recording("old-rec", Date.parse("2026-07-20T09:00:00Z"))],
      [meeting("old-meeting", "2026-07-20T08:00:00Z")],
      false,
    );

    expect(entries.map((e) => e.key)).toEqual([
      "i:new",
      "r:old-rec",
      "m:old-meeting",
    ]);
  });
});
