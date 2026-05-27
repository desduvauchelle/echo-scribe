// Unified activity feed: interleaves text items and screen recordings by time.
// Items and recordings live in separate tables/types, so we normalise both into
// a single sortable entry for the "All" view.

import type { Item, RecordingRow } from "./api";

export type FeedEntry =
  | { type: "item"; ts: number; key: string; item: Item }
  | { type: "recording"; ts: number; key: string; rec: RecordingRow };

/** Epoch ms for an item, preferring captured_at then created_at. */
export function itemTs(i: Item): number {
  const t = Date.parse(i.captured_at);
  if (!Number.isNaN(t)) return t;
  const c = Date.parse(i.created_at);
  return Number.isNaN(c) ? 0 : c;
}

/** Merge items + recordings into a single newest-first feed. */
export function mergeFeed(items: Item[], recs: RecordingRow[]): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...items.map((item) => ({
      type: "item" as const,
      ts: itemTs(item),
      key: `i:${item.id}`,
      item,
    })),
    ...recs.map((rec) => ({
      type: "recording" as const,
      ts: rec.created_at, // already epoch ms
      key: `r:${rec.id}`,
      rec,
    })),
  ];
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
}

/** Case-insensitive match of a query against a recording's text fields. */
export function recordingMatches(r: RecordingRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [r.title, r.source_label, r.transcript]
    .filter(Boolean)
    .some((s) => (s as string).toLowerCase().includes(q));
}
