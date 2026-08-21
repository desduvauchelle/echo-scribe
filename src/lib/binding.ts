import type { JsBinding, ModKind, ModSide } from "./api";

/**
 * The user-facing names of the named keys, injected by the caller.
 *
 * This module is pure logic — it must not import i18n (see the notes in
 * ./displayText). Rather than returning English and having every caller
 * re-derive it, the copy is a parameter: UI callers pass a translated set
 * built by `keyLabels()` in ./displayText, and `DEFAULT_KEY_LABELS` keeps the
 * original English for non-UI callers.
 */
export interface KeyLabels {
  control: string;
  shift: string;
  option: string;
  /** The Command key; rendered as the ⌘ glyph in every locale. */
  command: string;
  space: string;
  enter: string;
  tab: string;
  escape: string;
  backspace: string;
  del: string;
  capsLock: string;
  home: string;
  end: string;
  pageUp: string;
  pageDown: string;
  /** Numpad digit, e.g. `"0"` -> "Num 0". */
  numpad: (digit: string) => string;
  /** Qualify a key name with the side of the keyboard it sits on.
   *  A function, not a prefix string, because the word order differs by
   *  language ("Left Control" vs "Control links" vs "lewy Control"). */
  side: (side: "Left" | "Right", key: string) => string;
}

export const DEFAULT_KEY_LABELS: KeyLabels = {
  control: "Control",
  shift: "Shift",
  option: "Option",
  command: "⌘",
  space: "Space",
  enter: "Return",
  tab: "Tab",
  escape: "Esc",
  backspace: "Backspace",
  del: "Delete",
  capsLock: "Caps Lock",
  home: "Home",
  end: "End",
  pageUp: "Page Up",
  pageDown: "Page Down",
  numpad: (digit) => `Num ${digit}`,
  side: (side, key) => `${side === "Left" ? "Left" : "Right"} ${key}`,
};

function modifierSymbol(labels: KeyLabels, kind: ModKind): string {
  switch (kind) {
    case "Control":
      return labels.control;
    case "Shift":
      return labels.shift;
    case "Alt":
      return labels.option;
    case "Meta":
      return labels.command;
  }
}

/** Apply the side qualifier, or leave the name bare for `Either`. */
function withSide(labels: KeyLabels, side: ModSide, key: string): string {
  if (side === "Either") return key;
  return labels.side(side, key);
}

/**
 * Map a DOM KeyboardEvent.code to a human-readable name.
 * Falls back to the raw code for anything unmapped.
 */
export function codeToReadable(
  code: string,
  labels: KeyLabels = DEFAULT_KEY_LABELS,
): string {
  // Letters: KeyA -> A
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  // Top-row digits: Digit0 -> 0
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  // Numpad digits: Numpad0 -> Num 0
  if (/^Numpad[0-9]$/.test(code)) return labels.numpad(code.slice(6));
  // Function keys
  if (/^F[0-9]{1,2}$/.test(code)) return code;

  switch (code) {
    case "ControlLeft":
      return labels.side("Left", labels.control);
    case "ControlRight":
      return labels.side("Right", labels.control);
    case "ShiftLeft":
      return labels.side("Left", labels.shift);
    case "ShiftRight":
      return labels.side("Right", labels.shift);
    case "AltLeft":
      return labels.side("Left", labels.option);
    case "AltRight":
      return labels.side("Right", labels.option);
    case "MetaLeft":
      return labels.side("Left", labels.command);
    case "MetaRight":
      return labels.side("Right", labels.command);
    case "Space":
      return labels.space;
    case "Enter":
      return labels.enter;
    case "Tab":
      return labels.tab;
    case "Escape":
      return labels.escape;
    case "Backspace":
      return labels.backspace;
    case "Delete":
      return labels.del;
    case "CapsLock":
      return labels.capsLock;
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Home":
      return labels.home;
    case "End":
      return labels.end;
    case "PageUp":
      return labels.pageUp;
    case "PageDown":
      return labels.pageDown;
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    default:
      return code;
  }
}

const MOD_ORDER: ModKind[] = ["Control", "Alt", "Shift", "Meta"];

function isModifierCode(code: string): boolean {
  return (
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "ShiftLeft" ||
    code === "ShiftRight" ||
    code === "AltLeft" ||
    code === "AltRight" ||
    code === "MetaLeft" ||
    code === "MetaRight"
  );
}

export function modifierKindFromCode(code: string): ModKind | null {
  if (code === "ControlLeft" || code === "ControlRight") return "Control";
  if (code === "ShiftLeft" || code === "ShiftRight") return "Shift";
  if (code === "AltLeft" || code === "AltRight") return "Alt";
  if (code === "MetaLeft" || code === "MetaRight") return "Meta";
  return null;
}

export function modifierSideFromCode(code: string): ModSide {
  if (code.endsWith("Left")) return "Left";
  if (code.endsWith("Right")) return "Right";
  return "Either";
}

export { isModifierCode };

/**
 * Format a JsBinding into a friendly human-readable string.
 *
 * Examples:
 *   { primary: "ControlRight", modifiers: [] } => "Right Control"
 *   { primary: "KeyL", modifiers: [{ kind: "Meta", side: "Right" }] } => "Right ⌘ + L"
 *   { primary: "Period", modifiers: [{ kind: "Shift", side: "Either" }] } => "Shift + ."
 */
export function formatBinding(
  b: JsBinding,
  labels: KeyLabels = DEFAULT_KEY_LABELS,
): string {
  const primaryReadable = codeToReadable(b.primary, labels);
  const primaryKind = modifierKindFromCode(b.primary);

  // Modifier-only binding (e.g. Right Control alone, no other mods)
  if (primaryKind && b.modifiers.length === 0) {
    return primaryReadable;
  }

  // Sort modifiers in a stable conventional order, dedupe by kind taking the
  // most specific side (a non-Either side wins over Either if both somehow appear).
  const byKind = new Map<ModKind, ModSide>();
  for (const m of b.modifiers) {
    const existing = byKind.get(m.kind);
    if (!existing) {
      byKind.set(m.kind, m.side);
    } else if (existing === "Either" && m.side !== "Either") {
      byKind.set(m.kind, m.side);
    }
  }

  const parts: string[] = [];
  for (const kind of MOD_ORDER) {
    const side = byKind.get(kind);
    if (!side) continue;
    parts.push(withSide(labels, side, modifierSymbol(labels, kind)));
  }
  parts.push(primaryReadable);
  return parts.join(" + ");
}
