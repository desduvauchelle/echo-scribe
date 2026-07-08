// Pure macOS virtual-keycode → display-glyph mapping for the keystroke
// overlay (M3 Task 4). No deps, no I/O — a plain lookup table plus two pure
// functions. US ANSI layout only (per the data contract); non-ANSI layouts
// may render the wrong letter for a physical key, which is an accepted
// limitation (the keycode is layout-INDEPENDENT position, not the typed
// character).
//
// Keycode source: Apple's `Carbon/HIToolbox/Events.h` (`kVK_*` constants),
// cross-checked against this repo's own Rust table at
// `src-tauri/src/input/hotkeys.rs::cg_keycode_to_rdev_key` for the subset it
// covers (letters, digits, F-keys, whitespace/control) — kept numerically
// identical to that table so the two never disagree on the same recording.

/** kVK_* macOS virtual keycode -> display glyph. Deliberately narrow: only
 *  the keys the brief scopes in (letters, digits, F1-F12, arrows, space,
 *  return, esc, tab, delete). Anything else is absent and falls through to
 *  `keyLabel`'s `null` return. */
const KEYCODE_LABELS: Readonly<Record<number, string>> = {
  // Letters (kVK_ANSI_*), US layout.
  0x00: "A",
  0x0b: "B",
  0x08: "C",
  0x02: "D",
  0x0e: "E",
  0x03: "F",
  0x05: "G",
  0x04: "H",
  0x22: "I",
  0x26: "J",
  0x28: "K",
  0x25: "L",
  0x2e: "M",
  0x2d: "N",
  0x1f: "O",
  0x23: "P",
  0x0c: "Q",
  0x0f: "R",
  0x01: "S",
  0x11: "T",
  0x20: "U",
  0x09: "V",
  0x0d: "W",
  0x07: "X",
  0x10: "Y",
  0x06: "Z",

  // Top-row digits.
  0x1d: "0",
  0x12: "1",
  0x13: "2",
  0x14: "3",
  0x15: "4",
  0x17: "5",
  0x16: "6",
  0x1a: "7",
  0x1c: "8",
  0x19: "9",

  // Function row.
  0x7a: "F1",
  0x78: "F2",
  0x63: "F3",
  0x76: "F4",
  0x60: "F5",
  0x61: "F6",
  0x62: "F7",
  0x64: "F8",
  0x65: "F9",
  0x6d: "F10",
  0x67: "F11",
  0x6f: "F12",

  // Arrows (kVK_Left/Right/Down/Up).
  0x7b: "←",
  0x7c: "→",
  0x7d: "↓",
  0x7e: "↑",

  // Whitespace / control.
  0x31: "␣", // kVK_Space
  0x24: "⏎", // kVK_Return
  0x35: "⎋", // kVK_Escape
  0x30: "⇥", // kVK_Tab
  0x33: "⌫", // kVK_Delete (backspace)
};

/** Display glyph for a macOS virtual keycode, or `null` when the code isn't
 *  in the covered set (badge is skipped entirely for that event — see
 *  `keystrokeBadgeAt` in compositor.ts). Pure lookup; rejects non-integer /
 *  non-finite input defensively (NaN, floats) since a keycode is always a
 *  small non-negative integer. */
export function keyLabel(code: number): string | null {
  if (!Number.isInteger(code)) return null;
  return KEYCODE_LABELS[code] ?? null;
}

/** Recognized modifier tokens, in the canonical Apple display order
 *  ⌃⌥⇧⌘ (Control, Option, Shift, Command). `fn` is not part of this fixed
 *  order — it's prefixed separately, before the rest, per the data contract. */
const MOD_GLYPHS: readonly [string, string][] = [
  ["ctrl", "⌃"],
  ["alt", "⌥"],
  ["shift", "⇧"],
  ["cmd", "⌘"],
];

/** Render a recorded event's `mods` array (subset of cmd|shift|alt|ctrl|fn,
 *  any order, possibly with duplicates/unknown tokens) as the canonical
 *  Apple-order glyph string: `fn` prefix (if present) followed by
 *  ⌃⌥⇧⌘ in that fixed order, omitting any modifier not present. Unknown
 *  tokens are ignored. Pure; empty input -> empty string. */
export function modsLabel(mods: string[]): string {
  const present = new Set(mods);
  let out = "";
  if (present.has("fn")) out += "fn";
  for (const [token, glyph] of MOD_GLYPHS) {
    if (present.has(token)) out += glyph;
  }
  return out;
}
