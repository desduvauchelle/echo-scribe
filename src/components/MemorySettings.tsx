import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLowMemoryMode, setLowMemoryMode } from "../lib/api";

export default function MemorySettings() {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    getLowMemoryMode().then(value => {
      if (!cancelled) setEnabled(value);
    }).catch(() => { if (!cancelled) setError(t("memory.loadError")); });
    return () => { cancelled = true; };
  }, [t]);

  async function change(next: boolean) {
    setBusy(true);
    setError("");
    try {
      await setLowMemoryMode(next);
      setEnabled(next);
    } catch {
      setError(t("memory.saveError"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="mb-3 rounded-lg border border-line bg-canvas p-3">
    <label className="flex items-center gap-3 text-sm font-semibold text-fg">
      <input type="checkbox" checked={enabled ?? false} disabled={busy || enabled === null}
        aria-describedby="memory-mode-description"
        onChange={event => void change(event.target.checked)} />
      {t("memory.title")}
    </label>
    <p id="memory-mode-description" className="mt-2 text-xs text-muted">{t("memory.description")}</p>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}
