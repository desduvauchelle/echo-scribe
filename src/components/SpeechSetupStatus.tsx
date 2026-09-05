import { Check, Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { prepareSpeech, useSpeechSetup } from "../lib/speechSetup";

export default function SpeechSetupStatus({ start = false }: { start?: boolean }) {
  const { t } = useTranslation("onboarding");
  const setup = useSpeechSetup(start);
  if (!start && (setup.phase === "idle" || setup.phase === "ready")) return null;
  const percent = setup.progress && setup.progress.bytes_total > 0
    ? Math.min(100, Math.round(100 * setup.progress.bytes_downloaded / setup.progress.bytes_total)) : null;
  return <div className="rounded-lg border border-line bg-elevated p-3 text-xs" aria-live="polite">
    <div className="flex items-center gap-2">
      {setup.phase === "ready" ? <Check size={15} className="text-success" /> : <Download size={15} className="text-accent" />}
      <span className="flex-1 font-medium">{t(`speechSetup.${setup.phase === "ready" ? "ready" : setup.phase === "error" ? "error" : setup.progress?.retrying ? "retrying" : "preparing"}`)}</span>
      {setup.phase === "preparing" && percent !== null && <span>{percent}%</span>}
      {setup.phase === "error" && <button onClick={() => void prepareSpeech()} className="flex items-center gap-1 rounded border border-line px-2 py-1"><RefreshCw size={12} />{t("speechSetup.retry")}</button>}
    </div>
    {setup.phase !== "ready" && <p className="mt-1.5 leading-relaxed text-muted">{t("speechSetup.description")}</p>}
    {setup.phase === "preparing" && <div role="progressbar" aria-label={t("speechSetup.preparing")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} className="mt-2 h-1 overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${percent ?? 0}%` }} />
    </div>}
  </div>;
}
