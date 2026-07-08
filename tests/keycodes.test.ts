import { describe, expect, test } from "bun:test";
import { keyLabel, modsLabel } from "../src/lib/keycodes";

describe("keyLabel", () => {
  test("letters: macOS virtual keycodes 0=A, 1=S, 2=D (ANSI layout)", () => {
    expect(keyLabel(0)).toBe("A");
    expect(keyLabel(1)).toBe("S");
    expect(keyLabel(2)).toBe("D");
  });

  test("letters: full A-Z coverage resolves to uppercase single letters", () => {
    // kVK_ANSI_* codes for every letter (from Carbon/HIToolbox/Events.h, cross
    // -checked against src-tauri/src/input/hotkeys.rs::cg_keycode_to_rdev_key).
    const letterCodes: Record<number, string> = {
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
    };
    for (const [code, expected] of Object.entries(letterCodes)) {
      expect(keyLabel(Number(code))).toBe(expected);
    }
  });

  test("top-row digits 0-9", () => {
    const digitCodes: Record<number, string> = {
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
    };
    for (const [code, expected] of Object.entries(digitCodes)) {
      expect(keyLabel(Number(code))).toBe(expected);
    }
  });

  test("function row F1-F12", () => {
    const fCodes: Record<number, string> = {
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
    };
    for (const [code, expected] of Object.entries(fCodes)) {
      expect(keyLabel(Number(code))).toBe(expected);
    }
  });

  test("arrow keys render as glyphs", () => {
    expect(keyLabel(0x7b)).toBe("←");
    expect(keyLabel(0x7e)).toBe("↑");
    expect(keyLabel(0x7d)).toBe("↓");
    expect(keyLabel(0x7c)).toBe("→");
  });

  test("special keys: space, return, esc, tab, delete", () => {
    expect(keyLabel(0x31)).toBe("␣"); // kVK_Space
    expect(keyLabel(0x24)).toBe("⏎"); // kVK_Return
    expect(keyLabel(0x35)).toBe("⎋"); // kVK_Escape
    expect(keyLabel(0x30)).toBe("⇥"); // kVK_Tab
    expect(keyLabel(0x33)).toBe("⌫"); // kVK_Delete (backspace)
  });

  test("unknown keycode returns null", () => {
    expect(keyLabel(9999)).toBeNull();
    expect(keyLabel(-1)).toBeNull();
  });

  test("negative/non-integer/NaN codes return null (defensive)", () => {
    expect(keyLabel(NaN)).toBeNull();
    expect(keyLabel(1.5)).toBeNull();
  });
});

describe("modsLabel", () => {
  test("empty mods -> empty string", () => {
    expect(modsLabel([])).toBe("");
  });

  test("single modifiers map to their glyph", () => {
    expect(modsLabel(["cmd"])).toBe("⌘");
    expect(modsLabel(["ctrl"])).toBe("⌃");
    expect(modsLabel(["alt"])).toBe("⌥");
    expect(modsLabel(["shift"])).toBe("⇧");
  });

  test("canonical order is ctrl, alt, shift, cmd regardless of input order", () => {
    expect(modsLabel(["cmd", "shift", "alt", "ctrl"])).toBe("⌃⌥⇧⌘");
    expect(modsLabel(["shift", "cmd"])).toBe("⇧⌘");
    expect(modsLabel(["ctrl", "cmd"])).toBe("⌃⌘");
  });

  test("fn is prefixed before the canonical order", () => {
    expect(modsLabel(["fn", "cmd"])).toBe("fn⌘");
    expect(modsLabel(["cmd", "fn"])).toBe("fn⌘");
    expect(modsLabel(["fn"])).toBe("fn");
  });

  test("duplicate mods are not repeated in the label", () => {
    expect(modsLabel(["cmd", "cmd"])).toBe("⌘");
  });

  test("unknown mod strings are ignored", () => {
    expect(modsLabel(["bogus", "cmd"])).toBe("⌘");
  });
});
