// Pure display helpers for meeting cards. Kept out of the component so they
// can be tested without a DOM.

import type { MeetingRow, StoredSummary } from "./api";

/** Parse a meeting's stored summary JSON. Returns null when absent or
 *  malformed — a half-written summary must not break the card. */
export function parseSummary(json: string | null | undefined): StoredSummary | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as StoredSummary;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Meeting title: the LLM's suggested title when we have one, else the app it
 *  was detected in, else "Manual meeting". */
export function meetingTitle(
  mtg: MeetingRow,
  summary: StoredSummary | null,
): string {
  const suggested = summary?.suggested_title?.trim();
  if (suggested) return suggested;
  const app = mtg.detected_app_name?.trim();
  return app ? `${app} meeting` : "Manual meeting";
}

/** Human duration, rounded to the minute. */
export function meetingDuration(ms: number | null | undefined): string {
  const mins = Math.round((ms ?? 0) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}
