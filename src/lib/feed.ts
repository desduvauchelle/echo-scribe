// Unified activity feed: interleaves text items, meetings and screen
// recordings by time. Each lives in its own table/type, so we normalise them
// into a single sortable entry for the "All" view.

import type { Item, MeetingRow, RecordingRow } from "./api";

export type FeedEntry =
  | { type: "item"; ts: number; key: string; item: Item }
  | { type: "meeting"; ts: number; key: string; mtg: MeetingRow }
  | { type: "recording"; ts: number; key: string; rec: RecordingRow };

/** Epoch ms for an item, preferring captured_at then created_at. */
export function itemTs(i: Item): number {
  const t = Date.parse(i.captured_at);
  if (!Number.isNaN(t)) return t;
  const c = Date.parse(i.created_at);
  return Number.isNaN(c) ? 0 : c;
}

/** Epoch ms for a meeting, from its start time. */
export function meetingTs(m: MeetingRow): number {
  const t = Date.parse(m.started_at);
  return Number.isNaN(t) ? 0 : t;
}

/** Epoch ms for a screen recording. */
export function recordingTs(r: RecordingRow): number {
  return r.created_at;
}

/** Merge items + recordings + meetings into a single newest-first feed.
 *  An item of kind "meeting" is dropped when the same meeting is present in
 *  `meetings`, which renders a richer card — keeping both would show it twice.
 *  A meeting item with no matching row still falls through as a plain item, so
 *  a broken row is visible rather than silently missing. */
export function mergeFeed(
  items: Item[],
  recs: RecordingRow[],
  meetings: MeetingRow[] = [],
): FeedEntry[] {
  const meetingIds = new Set(meetings.map((m) => m.item_id));
  const entries: FeedEntry[] = [
    ...items
      .filter((item) => !(item.kind === "meeting" && meetingIds.has(item.id)))
      .map((item) => ({
        type: "item" as const,
        ts: itemTs(item),
        key: `i:${item.id}`,
        item,
      })),
    ...meetings.map((mtg) => ({
      type: "meeting" as const,
      ts: meetingTs(mtg),
      key: `m:${mtg.item_id}`,
      mtg,
    })),
    ...recs.map((rec) => ({
      type: "recording" as const,
      ts: recordingTs(rec),
      key: `r:${rec.id}`,
      rec,
    })),
  ];
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
}

/** Meetings older than the loaded item page are held back until the user pages
 *  further, so they don't pile up under the newest items and above the "Load
 *  more" button.
 *
 *  `oldestLoadedTs` is the timestamp of the oldest item currently loaded; pass
 *  `null` (nothing loaded) or `hasMore = false` (everything loaded) to keep
 *  every meeting. */
export function clampMeetingsToPage(
  meetings: MeetingRow[],
  oldestLoadedTs: number | null,
  hasMore: boolean,
): MeetingRow[] {
  if (!hasMore || oldestLoadedTs === null) return meetings;
  return meetings.filter((m) => meetingTs(m) >= oldestLoadedTs);
}

/** Recordings follow the same loaded-item boundary as meetings so older rows
 *  do not appear ahead of the Dashboard's "Load more" control. */
export function clampRecordingsToPage(
  recs: RecordingRow[],
  oldestLoadedTs: number | null,
  hasMore: boolean,
): RecordingRow[] {
  if (!hasMore || oldestLoadedTs === null) return recs;
  return recs.filter((r) => recordingTs(r) >= oldestLoadedTs);
}

/** Build the paginated mixed-source feed used by the Dashboard's "All" tab. */
export function mergeBrowseFeed(
  items: Item[],
  recs: RecordingRow[],
  meetings: MeetingRow[],
  hasMore: boolean,
): FeedEntry[] {
  const oldestLoadedTs = items.length > 0 ? itemTs(items[items.length - 1]) : null;
  return mergeFeed(
    items,
    clampRecordingsToPage(recs, oldestLoadedTs, hasMore),
    clampMeetingsToPage(meetings, oldestLoadedTs, hasMore),
  );
}

/** Case-insensitive match of a query against a recording's text fields. */
export function recordingMatches(r: RecordingRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [r.title, r.source_label, r.transcript]
    .filter(Boolean)
    .some((s) => (s as string).toLowerCase().includes(q));
}
