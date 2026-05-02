import { useEffect, useRef, useState } from "react";
import {
  getVoiceAtCursorBinding,
  updateVoiceAtCursorBinding,
  type JsBinding,
  type ModKind,
  type ModSide,
} from "../lib/api";
import {
  formatBinding,
  isModifierCode,
  modifierKindFromCode,
  modifierSideFromCode,
} from "../lib/binding";

type Props = {
  onBack: () => void;
};

type CaptureState =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "captured"; binding: JsBinding };

function buildBinding(
  primaryCode: string,
  pressedCodes: Set<string>,
): JsBinding {
  // Modifier kind/side aggregator
  const sides: Partial<Record<ModKind, Set<ModSide>>> = {};
  for (const code of pressedCodes) {
    if (code === primaryCode) continue;
    const kind = modifierKindFromCode(code);
    if (!kind) continue;
    const side = modifierSideFromCode(code);
    sides[kind] ??= new Set<ModSide>();
    sides[kind]!.add(side);
  }

  const modifiers: { kind: ModKind; side: ModSide }[] = [];
  (["Control", "Shift", "Alt", "Meta"] as ModKind[]).forEach((kind) => {
    const set = sides[kind];
    if (!set) return;
    const hasLeft = set.has("Left");
    const hasRight = set.has("Right");
    let side: ModSide;
    if (hasLeft && hasRight) side = "Either";
    else if (hasLeft) side = "Left";
    else if (hasRight) side = "Right";
    else side = "Either";
    modifiers.push({ kind, side });
  });

  return { primary: primaryCode, modifiers };
}

export default function Settings({ onBack }: Props) {
  const [current, setCurrent] = useState<JsBinding | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureState>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load current binding
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await getVoiceAtCursorBinding();
        if (!cancelled) setCurrent(b);
      } catch (e) {
        if (!cancelled)
          setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Capture-mode key listeners
  const pressedRef = useRef<Set<string>>(new Set());
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (capture.kind !== "capturing") return;

    pressedRef.current = new Set();
    lastKeyRef.current = null;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === "Escape") {
        setCapture({ kind: "idle" });
        return;
      }
      if (e.repeat) return;
      pressedRef.current.add(e.code);
      // Track last non-modifier key, or any key as fallback
      if (!isModifierCode(e.code)) {
        lastKeyRef.current = e.code;
      } else if (lastKeyRef.current === null) {
        // No non-modifier seen yet — track this modifier as a candidate primary
        lastKeyRef.current = e.code;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === "Escape") {
        setCapture({ kind: "idle" });
        return;
      }
      // Decide primary: prefer the last non-modifier seen; otherwise the
      // most-recently pressed key (which will be a modifier in modifier-only
      // bindings like Right Control alone).
      let primary = lastKeyRef.current;
      if (!primary) {
        // Fall back to whatever key just went up.
        primary = e.code;
      }
      // If primary is a modifier, prefer it being THIS released key when
      // there were no non-modifier presses — keeps Right Control alone working.
      if (
        isModifierCode(primary) &&
        !Array.from(pressedRef.current).some((c) => !isModifierCode(c))
      ) {
        primary = e.code;
      }

      const binding = buildBinding(primary, pressedRef.current);
      setCapture({ kind: "captured", binding });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capture.kind]);

  const handleSave = async () => {
    if (capture.kind !== "captured") return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateVoiceAtCursorBinding(capture.binding);
      setCurrent(capture.binding);
      setCapture({ kind: "idle" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(`Unsupported key — try a different one. (${msg})`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full items-start justify-center bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="relative w-full max-w-[480px] rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          ← Back
        </button>

        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

        <section className="mt-6">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-200">
            Voice-at-cursor hotkey
          </h2>
          <p className="mt-1 text-sm text-neutral-300">
            Hold this key combination anywhere in macOS to dictate at the
            cursor.
          </p>

          <div className="mt-4 rounded-md border border-neutral-800 bg-neutral-950 p-4">
            {capture.kind === "idle" ? (
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm">
                  Current:{" "}
                  <span className="font-semibold">
                    {current
                      ? formatBinding(current)
                      : loadError
                        ? "—"
                        : "Loading…"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSaveError(null);
                    setCapture({ kind: "capturing" });
                  }}
                  className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
                >
                  Record new shortcut…
                </button>
              </div>
            ) : capture.kind === "capturing" ? (
              <div className="text-sm">
                <div className="font-semibold">Listening…</div>
                <p className="mt-1 text-neutral-300">
                  Press a key combination, then release. Press Esc to cancel.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="text-sm">
                  Captured:{" "}
                  <span className="font-semibold">
                    {formatBinding(capture.binding)}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      void handleSave();
                    }}
                    className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCapture({ kind: "idle" });
                      setSaveError(null);
                    }}
                    className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {saveError ? (
            <p className="mt-2 text-xs text-amber-300">{saveError}</p>
          ) : null}
          {loadError && capture.kind === "idle" ? (
            <p className="mt-2 text-xs text-amber-300">
              Couldn’t load current shortcut: {loadError}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
