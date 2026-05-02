import { useEffect, useState } from "react";
import { permissionsStatus } from "../lib/api";

type Props = {
  onOpenSettings: () => void;
};

/// Polls permission status every few seconds and renders a top warning banner
/// when something has broken mid-session (e.g. user revoked access from
/// System Settings). Stays out of the way when everything is green.
export default function PermissionWarningBanner({ onOpenSettings }: Props) {
  const [missing, setMissing] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await permissionsStatus();
        if (cancelled) return;
        const m: string[] = [];
        if (!s.microphone) m.push("Microphone");
        if (!s.accessibility) m.push("Accessibility");
        setMissing(m);
      } catch {
        /* ignore — transient */
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (missing.length === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/40 px-4 py-2 text-xs text-amber-100">
      <span>
        <strong>Permission missing:</strong> {missing.join(" + ")}. Echo Scribe
        can't dictate or paste until you re-grant.
      </span>
      <button
        type="button"
        onClick={onOpenSettings}
        className="shrink-0 rounded border border-amber-700 bg-amber-900/50 px-2 py-0.5 font-semibold text-amber-100 hover:bg-amber-900/70"
      >
        Fix in Settings
      </button>
    </div>
  );
}
