/**
 * Pure helpers for the pre-record countdown overlay's tick sequence. Kept
 * separate from the React page so the sequence logic is testable without a
 * DOM/timer runtime.
 */

/**
 * The sequence of numbers the countdown displays, countable down from
 * `seconds` to `1` inclusive (e.g. `secondsSequence(3)` -> `[3, 2, 1]`).
 * `seconds <= 0` yields an empty sequence (nothing to show; the caller
 * should start recording immediately).
 */
export function secondsSequence(seconds: number): number[] {
  const n = Math.floor(seconds);
  if (n <= 0) return [];
  const out: number[] = [];
  for (let i = n; i >= 1; i--) out.push(i);
  return out;
}

/**
 * Given the sequence and the number of ticks elapsed so far (0 = just
 * started, showing `sequence[0]`), returns the number to display, or `null`
 * once the countdown has run past its last tick (caller should proceed to
 * start recording).
 */
export function currentTick(sequence: number[], ticksElapsed: number): number | null {
  if (ticksElapsed < 0 || ticksElapsed >= sequence.length) return null;
  return sequence[ticksElapsed];
}
