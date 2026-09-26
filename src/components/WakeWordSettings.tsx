import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getWakeWordStatus, setWakeWordEnabled, type WakeWordStatus } from "../lib/api";
import { useCapabilities } from "../lib/capabilitiesContext";

export default function WakeWordSettings() {
  const caps = useCapabilities();
  const [status, setStatus] = useState<WakeWordStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const dispose = await listen<WakeWordStatus>("wakeword:status", event => {
          if (active) setStatus(event.payload);
        });
        if (!active) { dispose(); return; }
        unlisten = dispose;
        const current = await getWakeWordStatus();
        if (active) setStatus(current);
      } catch (e) { if (active) setError(String(e)); }
    })();
    return () => { active = false; unlisten?.(); };
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true); setError("");
    try {
      await setWakeWordEnabled(enabled);
      setStatus(await getWakeWordStatus());
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  // The current native wake listener ships with the macOS capture runtime.
  if (!caps.system_audio_capture) return null;
  return <section className="space-y-3 rounded-xl border border-line bg-canvas p-4" aria-labelledby="wake-word-title">
    <label className="flex items-start justify-between gap-4" htmlFor="wake-word-enabled">
      <span className="space-y-1">
        <span id="wake-word-title" className="block text-sm font-semibold">Listen for “Tucky”</span>
        <span id="wake-word-help" className="block text-sm text-muted">Say “Tucky,” then your request. No hotkey needed.</span>
      </span>
      <input id="wake-word-enabled" type="checkbox" aria-describedby="wake-word-help wake-word-privacy"
        className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={status?.enabled ?? false}
        disabled={!status || busy} onChange={event => void toggle(event.target.checked)} />
    </label>
    <p role="status" aria-live="polite" className="text-sm text-muted">{status?.message ?? "Loading wake-word setting…"}</p>
    <p id="wake-word-privacy" className="text-xs leading-relaxed text-muted">Runs locally while Tucky is open and your Mac is awake. Pauses during dictation, transcription, meetings, and screen recordings. Background audio stays in a short memory buffer and is discarded. Your microphone indicator stays on while listening.</p>
    <p className="text-xs text-muted">Try “Tucky, save a task: review the proposal.” Pause at the end to finish, or press Escape to cancel. You can pause wake-word listening from the menu bar.</p>
    {error && <p role="alert" className="text-sm text-danger">Couldn’t change wake-word listening. {error}</p>}
  </section>;
}
