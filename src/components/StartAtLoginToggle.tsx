import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useTranslation } from "react-i18next";
import { useToasts } from "./ToastProvider";

type Props = {
  /** Compact variant for inline use (e.g. onboarding rows). Defaults to the
   *  bordered card style used in Settings. */
  variant?: "card" | "row";
};

export default function StartAtLoginToggle({ variant = "card" }: Props) {
  const { t } = useTranslation();
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
        message: t("startAtLoginToggle.updateError", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  const wrapperClass =
    variant === "card"
      ? "flex items-center justify-between rounded-lg border border-line bg-canvas p-3"
      : "flex items-center justify-between";

  return (
    <label className={wrapperClass}>
      <div>
        <div className="text-sm font-semibold text-fg">
          {t("startAtLoginToggle.title")}
        </div>
        <p className="text-xs text-muted">
          {t("startAtLoginToggle.subtitle")}
        </p>
      </div>
      <input
        type="checkbox"
        disabled={busy || enabled === null}
        checked={enabled ?? false}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-accent"
      />
    </label>
  );
}
