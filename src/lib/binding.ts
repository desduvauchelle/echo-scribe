import type { JsBinding, ModKind, ModSide } from "./api";

const MODIFIER_SYMBOL: Record<ModKind, string> = {
  Control: "Control",
  Shift: "Shift",
  Alt: "Option",
  Meta: "⌘",
};

function sidePrefix(side: ModSide): string {
  if (side === "Either") return "";
  return side === "Left" ? "Left " : "Right ";
}

/**
 * Map a DOM KeyboardEvent.code to a human-readable name.
 * Falls back to the raw code for anything unmapped.
 */
export function codeToReadable(code: string): string {
  // Letters: KeyA -> A
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  // Top-row digits: Digit0 -> 0
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  // Numpad digits: Numpad0 -> Num 0
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  // Function keys
  if (/^F[0-9]{1,2}$/.test(code)) return code;

  switch (code) {
    case "ControlLeft":
      return "Left Control";
    case "ControlRight":
      return "Right Control";
    case "ShiftLeft":
      return "Left Shift";
    case "ShiftRight":
      return "Right Shift";
    case "AltLeft":
      return "Left Option";
    case "AltRight":
      return "Right Option";
    case "MetaLeft":
      return "Left ⌘";
    case "MetaRight":
      return "Right ⌘";
    case "Space":
      return "Space";
    case "Enter":
      return "Return";
    case "Tab":
      return "Tab";
    case "Escape":
      return "Esc";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "CapsLock":
      return "Caps Lock";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "Page Up";
    case "PageDown":
      return "Page Down";
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
export function formatBinding(b: JsBinding): string {
  const primaryReadable = codeToReadable(b.primary);
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
    parts.push(`${sidePrefix(side)}${MODIFIER_SYMBOL[kind]}`.trim());
  }
  parts.push(primaryReadable);
  return parts.join(" + ");
}
