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

/** The summary body as markdown. New meetings store markdown directly; legacy
 *  meetings get their bullets + action items assembled into equivalent
 *  markdown so one rendering path serves both eras. Null when there is no
 *  summary content at all.
 *
 *  `actionItemsHeading` is the only user-facing string this module emits (the
 *  legacy-assembly path only). It is a parameter rather than a `t()` call so
 *  this module stays i18n-free for `tests/`; UI callers pass the translated
 *  heading, and the English default keeps the pure-logic tests meaningful. */
export function summaryMarkdown(
  summary: StoredSummary | null,
  actionItemsHeading = "Action items",
): string | null {
  if (!summary) return null;
  const md = summary.markdown?.trim();
  if (md) return md;
  const parts: string[] = [];
  const bullets = summary.summary ?? [];
  if (bullets.length > 0) {
    parts.push(bullets.map((b) => `- ${b}`).join("\n"));
  }
  const actions = summary.action_items ?? [];
  if (actions.length > 0) {
    parts.push(
      `## ${actionItemsHeading}\n` +
        actions
          .map((a) => {
            const owner = a.owner && a.owner !== "unspecified" ? ` *(${a.owner})*` : "";
            return `- ${a.text}${owner}`;
          })
          .join("\n"),
    );
  }
  if (parts.length === 0) {
    const raw = summary.raw?.trim();
    return raw ? raw : null;
  }
  return parts.join("\n\n");
}

/** One-line preview for list cards: the first non-heading, non-empty line of
 *  the summary body, stripped of bullet markers and emphasis. */
export function summaryPreview(summary: StoredSummary | null): string {
  const md = summaryMarkdown(summary);
  if (!md) return "";
  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    return line
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\*\*/g, "")
      .trim();
  }
  return "";
}
