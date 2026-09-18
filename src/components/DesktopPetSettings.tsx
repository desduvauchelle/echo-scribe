import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export default function DesktopPetSettings() {
  const [size, setSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<number>("desktop-pet-size-changed", event => {
          if (!disposed) setSize(event.payload);
        });
        if (disposed) { unlisten(); return; }
        const current = await invoke<number>("desktop_pet_get_size");
        if (!disposed) setSize(current);
      } catch {
        if (!disposed) setError("Could not load pet size. Reopen Settings to try again.");
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const change = async (next: number) => {
    setBusy(true);
    setError("");
    try {
      await invoke("desktop_pet_set_size", { size: next });
      setSize(next);
    } catch {
      setError("Could not save pet size. Please try again.");
    } finally { setBusy(false); }
  };
  return <div>
    <label className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-canvas p-3">
      <span>
        <span className="block text-sm font-semibold text-fg">Pet size</span>
        <span className="block text-xs text-muted">You can also change this by right-clicking the pet.</span>
      </span>
      <select aria-label="Pet size" value={size ?? 0} disabled={size === null || busy}
        onChange={event => void change(Number(event.target.value))}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg">
        <option value={0}>Small</option><option value={1}>Medium</option><option value={2}>Large</option>
      </select>
    </label>
    {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
  </div>;
}
