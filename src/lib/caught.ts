import type { TranscriptSegment } from "./api";

export type CaughtKind = "date" | "number";

export type CaughtItem = {
  /** Text exactly as it was said, so the chip reads like the conversation. */
  text: string;
  kind: CaughtKind;
  /** When it was first said — a repeat doesn't move it. */
  atMs: number;
  speaker: "you" | "them";
};

const NUMBER_WORD =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|a couple|a few|half a";
const UNIT = "second|minute|hour|day|week|weekend|month|quarter|year";
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
/* Full names and abbreviations spelled out, and never followed by a wildcard:
   an open-ended `may[a-z]*` swallows "Maybe" and then eats the number after
   it, turning "maybe 20% more" into the date "Maybe 20". */
const MONTH =
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

/**
 * Ordered longest-intent-first: a phrase matched by an earlier pattern is not
 * re-matched by a later one, so "two months" stays one chip instead of
 * splitting into "two" and a bare number.
 */
const PATTERNS: { kind: CaughtKind; re: RegExp }[] = [
  { kind: "date", re: new RegExp(`\\b(next|last|this|the)\\s+(${WEEKDAY}|${UNIT})\\b`, "gi") },
  { kind: "date", re: new RegExp(`\\b(?:${MONTH})\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b`, "gi") },
  { kind: "date", re: new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+of\\s+(?:${MONTH})\\b`, "gi") },
  { kind: "date", re: /\b\d{1,2}:\d{2}\s?(am|pm)?\b/gi },
  { kind: "date", re: /\b\d{1,2}\s?(am|pm|a\.m\.|p\.m\.)\b/gi },
  { kind: "date", re: new RegExp(`\\b(${WEEKDAY}|today|tomorrow|yesterday|tonight)\\b`, "gi") },
  { kind: "date", re: new RegExp(`\\b(${NUMBER_WORD}|\\d+)\\s+(${UNIT})s?\\b`, "gi") },
  { kind: "number", re: /[$£€]\s?\d[\d,]*(\.\d+)?\s?[km]?\b/gi },
  { kind: "number", re: /\b\d[\d,]*(\.\d+)?\s?%/g },
  { kind: "number", re: /\b\d[\d,]*(\.\d+)?\s?percent\b/gi },
  { kind: "number", re: /\b\d[\d,]*(\.\d+)?\s+(dollars|euros|pounds|people|users|customers|times)\b/gi },
  { kind: "number", re: /\b\d{1,3}(,\d{3})+(\.\d+)?\b/g },
  { kind: "number", re: /\b\d+\.\d+\b/g },
  { kind: "number", re: /\b\d{2,}\b/g },
];

type Span = { start: number; end: number };

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

/**
 * Pull dates, times, durations and figures out of the live transcript.
 * Deliberately regex-only: it runs on every transcript tick, needs no model,
 * and a missed chip costs far less than a stalled HUD.
 */
export function extractCaught(segments: TranscriptSegment[]): CaughtItem[] {
  const byKey = new Map<string, CaughtItem>();

  for (const segment of segments) {
    const taken: Span[] = [];
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(segment.text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (match[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        if (overlaps(taken, start, end)) continue;
        taken.push({ start, end });

        const text = match[0].trim().replace(/\s+/g, " ");
        const key = `${kind}:${text.toLowerCase()}`;
        const existing = byKey.get(key);
        if (!existing || segment.start_ms < existing.atMs) {
          byKey.set(key, {
            text,
            kind,
            atMs: segment.start_ms,
            speaker: segment.speaker,
          });
        }
      }
    }
  }

  return [...byKey.values()].sort((a, b) => b.atMs - a.atMs);
}

export function caughtOfKind(items: CaughtItem[], kind: CaughtKind): CaughtItem[] {
  return items.filter((i) => i.kind === kind);
}
