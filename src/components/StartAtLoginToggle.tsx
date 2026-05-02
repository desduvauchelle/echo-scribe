import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useToasts } from "./ToastProvider";

type Props = {
  /** Compact variant for inline use (e.g. onboarding rows). Defaults to the
   *  bordered card style used in Settings. */
  variant?: "card" | "row";
};

export default function StartAtLoginToggle({ variant = "card" }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await isEnabled();
        if (!cancelled) setEnabled(v);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) await enable();
      else await disable();
      setEnabled(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update start-at-login: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const wrapperClass =
    variant === "card"
      ? "flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950 p-3"
      : "flex items-center justify-between";

  return (
    <label className={wrapperClass}>
      <div>
        <div className="text-sm font-semibold text-neutral-100">
          Start at login
        </div>
        <p className="text-xs text-neutral-400">
          Launch Echo Scribe automatically when you log in to your Mac.
        </p>
      </div>
      <input
        type="checkbox"
        disabled={busy || enabled === null}
        checked={enabled ?? false}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-neutral-100"
      />
    </label>
  );
}
