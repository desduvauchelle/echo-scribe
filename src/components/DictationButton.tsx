import { useState } from "react";
import { setDictationActive } from "../lib/api";
import { useCapabilities } from "../lib/capabilitiesContext";
import { uiGates } from "../lib/capabilities";

/// In-app dictation trigger. A toggle: first click starts capture, second stops
/// it (transcribe + paste). Complements the global hotkey and needs no global
/// shortcut registration. Only shown where the platform supports dictation.
export default function DictationButton() {
  const caps = useCapabilities();
  const [active, setActive] = useState(false);

  if (!uiGates(caps).showDictation) return null;

  const toggle = async () => {
    const next = !active;
    setActive(next);
    try {
      await setDictationActive(next);
    } catch {
      // Roll back the visual state if the pipeline isn't ready.
      setActive(!next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={
        active
          ? "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
          : "rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
      }
      aria-pressed={active}
    >
      {active ? "Stop dictation" : "Record / Dictate"}
    </button>
  );
}
