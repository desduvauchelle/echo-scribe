import type { TranscriptSegment } from "./api";

export type Speaker = "you" | "them";

export type TalkShare = {
  /** Fraction of *spoken* time held by each speaker; both 0 when silent so far. */
  you: number;
  them: number;
  /** Total spoken milliseconds, so callers can tell "50/50" from "nothing yet". */
  spokenMs: number;
};

/** A run of consecutive segments by the same speaker, with the gaps inside it kept. */
export type Turn = {
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
};

const durationOf = (s: TranscriptSegment): number =>
  Math.max(0, s.end_ms - s.start_ms);

export function talkShare(segments: TranscriptSegment[]): TalkShare {
  let you = 0;
  let them = 0;
  for (const s of segments) {
    if (s.speaker === "you") you += durationOf(s);
    else them += durationOf(s);
  }
  const spokenMs = you + them;
  if (spokenMs === 0) return { you: 0, them: 0, spokenMs: 0 };
  return { you: you / spokenMs, them: them / spokenMs, spokenMs };
}

/**
 * Merge consecutive same-speaker segments into turns. Diarizers emit a segment
 * per utterance, so "one long monologue" arrives as a dozen segments — without
 * this, longest-turn would report the longest *sentence*.
 */
export function toTurns(segments: TranscriptSegment[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) {
      last.endMs = Math.max(last.endMs, s.end_ms);
      last.text = `${last.text} ${s.text}`.trim();
    } else {
      turns.push({
        speaker: s.speaker,
        startMs: s.start_ms,
        endMs: s.end_ms,
        text: s.text,
      });
    }
  }
  return turns;
}

export function longestTurnMs(segments: TranscriptSegment[]): number {
  let longest = 0;
  for (const turn of toTurns(segments)) {
    longest = Math.max(longest, turn.endMs - turn.startMs);
  }
  return longest;
}

/**
 * Who held the floor in each of `buckets` equal slices of the elapsed call.
 * `null` means nobody spoke in that slice — silence reads as a gap, not as a
 * win for whoever spoke last.
 */
export function floorTimeline(
  segments: TranscriptSegment[],
  buckets: number,
): (Speaker | null)[] {
  if (buckets <= 0 || segments.length === 0) return [];
  let spanStart = Infinity;
  let spanEnd = 0;
  for (const s of segments) {
    spanStart = Math.min(spanStart, s.start_ms);
    spanEnd = Math.max(spanEnd, s.end_ms);
  }
  const span = spanEnd - spanStart;
  if (span <= 0) return new Array(buckets).fill(null);

  const width = span / buckets;
  const out: (Speaker | null)[] = [];
  for (let i = 0; i < buckets; i++) {
    const from = spanStart + i * width;
    const to = from + width;
    let you = 0;
    let them = 0;
    for (const s of segments) {
      const overlap = Math.min(s.end_ms, to) - Math.max(s.start_ms, from);
      if (overlap <= 0) continue;
      if (s.speaker === "you") you += overlap;
      else them += overlap;
    }
    if (you === 0 && them === 0) out.push(null);
    else out.push(you >= them ? "you" : "them");
  }
  return out;
}

const WORD_RE = /[\p{L}\p{N}'’-]+/gu;

export function wordCount(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

/**
 * Words per minute over that speaker's *own* speaking time — a pace reading,
 * not a share of the call. Returns 0 until they've spoken a few seconds, since
 * a two-word segment yields a meaningless four-digit rate.
 */
export function wordsPerMinute(
  segments: TranscriptSegment[],
  speaker: Speaker,
): number {
  let words = 0;
  let ms = 0;
  for (const s of segments) {
    if (s.speaker !== speaker) continue;
    words += wordCount(s.text);
    ms += durationOf(s);
  }
  if (ms < 3000) return 0;
  return Math.round(words / (ms / 60000));
}

const QUESTION_OPENERS =
  /^(who|what|when|where|why|how|is|are|was|were|do|does|did|can|could|would|will|should|have|has|had|any|anything)\b/i;

/**
 * Questions asked by a speaker. Live transcripts are unreliably punctuated, so
 * a turn counts when it ends in "?" *or* opens with an interrogative — an
 * approximation, deliberately, because waiting for perfect punctuation would
 * mean counting almost nothing.
 */
export function questionCount(
  segments: TranscriptSegment[],
  speaker: Speaker,
): number {
  let count = 0;
  for (const s of segments) {
    if (s.speaker !== speaker) continue;
    const text = s.text.trim();
    if (!text) continue;
    if (text.endsWith("?") || QUESTION_OPENERS.test(text)) count += 1;
  }
  return count;
}
