import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createPortal } from "react-dom";
import Dialog from "./a11y/Dialog";
import { useTranslation } from "react-i18next";
import {
  deleteSpeechModel,
  downloadSpeechModel,
  listSpeechModels,
  setActiveSpeechModel,
  type DownloadProgress,
  type SpeechModelStatus,
} from "../lib/api";
import { asrModelBenchmarks, benchmarkGrade } from "../lib/asrModelBenchmarks";
import { formatBytes } from "../lib/format";
import { DownloadIcon, TrashIcon } from "./icons";

type Props = {
  onChange?: () => void;
};

type DownloadState = {
  bytes_downloaded: number;
  bytes_total: number;
  retrying?: boolean;
};

const ACCENT_FILL = "bg-accent";
const ACCENT_TRACK = "bg-elevated";

function SegmentBar({ value, max = 5 }: { value: number; max?: number }) {
  const { t } = useTranslation();
  const v = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <div
      role="img"
      aria-label={t("speechModelPicker.segmentBar.ariaLabel", { value: v, max })}
      className="flex items-center gap-1"
    >
      {Array.from({ length: max }).map((_, i) => (
        <span
          key={i}
          className={[
            "h-1.5 w-4 rounded-full",
            i < v ? ACCENT_FILL : ACCENT_TRACK,
          ].join(" ")}
        />
      ))}
    </div>
  );
}

type CardProps = {
  model: SpeechModelStatus;
  active: boolean;
  downloading: DownloadState | null;
  downloadError: string | null;
  busy: boolean;
  onDownload: () => void;
  onActivate: () => void;
  onDelete: () => void;
};

export function SpeechModelRow({ model, active, downloading, downloadError, busy, onDownload, onActivate, onDelete }: CardProps) {
  const { t } = useTranslation();
  const benchmark = (import.meta.env.DEV || import.meta.env.VITE_LOCAL_ASR === "1") ? asrModelBenchmarks[model.id] : undefined;
  const inProgress = downloading !== null && !model.downloaded;
  const buttonClass = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-xs hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <tr className={active ? "bg-accent/5" : ""}>
      <th scope="row" className="px-4 py-3 text-left font-normal">
        <div className="text-sm font-semibold">{model.display_name} <span className="text-muted">{model.version_label}</span></div>
        <div className="mt-1 text-[11px] text-muted">{formatBytes(model.size_bytes)} download</div>
        <div className="text-[11px] text-muted">{model.language_label}</div>
        {downloadError ? <p role="alert" className="mt-1 max-w-56 text-xs text-danger">{downloadError}</p> : null}
        {model.incomplete && !inProgress ? <p className="mt-1 text-xs text-warning">{t("speechModelPicker.modelCard.incompleteDownload", { size: formatBytes(model.disk_bytes) })}</p> : null}
      </th>
      <td className="px-3 py-3">
        <SegmentBar value={benchmark ? benchmarkGrade("errors", benchmark.errors) : model.accuracy_bars} />
        <div className="mt-1 text-[11px] text-muted whitespace-nowrap">{benchmark ? `${(benchmark.errors / 53 * 100).toFixed(1)}% word errors` : "Not measured"}</div>
      </td>
      <td className="px-3 py-3">
        <SegmentBar value={benchmark ? benchmarkGrade("warmSeconds", benchmark.warmSeconds) : model.speed_bars} />
        <div className="mt-1 text-[11px] text-muted whitespace-nowrap">{benchmark ? `${benchmark.warmSeconds.toFixed(2)} s transcription` : "Not measured"}</div>
        {benchmark ? <div className="text-[11px] text-muted">{benchmark.loadSeconds.toFixed(2)} s load</div> : null}
      </td>
      <td className="px-3 py-3">
        {benchmark ? <><SegmentBar value={benchmarkGrade("memoryGiB", benchmark.memoryGiB)} /><div className="mt-1 text-[11px] text-muted whitespace-nowrap">{benchmark.memoryGiB.toFixed(2)} GiB peak</div></> : <span className="text-xs text-muted">Not measured</span>}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {inProgress && downloading ? (
            <div className="w-32 text-xs text-muted" aria-live="polite">
              <progress aria-label="Model download" className="h-1.5 w-full accent-accent" max={Math.max(1, downloading.bytes_total)} value={downloading.bytes_downloaded} />
              {downloading.retrying ? "Retrying…" : `${Math.min(100, Math.round(downloading.bytes_downloaded / Math.max(1, downloading.bytes_total) * 100))}% downloaded`}
            </div>
          ) : model.downloaded ? (
            <>
              {active ? <span className="text-xs font-medium text-accent">{t("speechModelPicker.modelCard.active")}</span> : <button type="button" disabled={busy || !model.supported} onClick={onActivate} className={buttonClass}>{t("speechModelPicker.modelCard.useThisModel")}</button>}
              <button type="button" disabled={busy} onClick={onDelete} className={buttonClass} aria-label={`Remove ${model.display_name} ${model.version_label}`}><TrashIcon /></button>
            </>
          ) : (
            <>
              {model.incomplete ? <button type="button" disabled={busy} onClick={onDelete} className={buttonClass} aria-label={`Remove incomplete ${model.display_name} ${model.version_label}`}><TrashIcon /></button> : null}
              <button type="button" disabled={busy || !model.supported} onClick={onDownload} className={buttonClass}><DownloadIcon />{model.supported ? t("speechModelPicker.modelCard.download") : t("speechModelPicker.modelCard.unavailable")}</button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function SpeechModelPicker({ onChange }: Props) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const [models, setModels] = useState<SpeechModelStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>(
    {},
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const pendingProgressRef = useRef<Record<string, DownloadState>>({});
  const flushTimerRef = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const m = await listSpeechModels();
      setModels(m);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      try {
        const fn = await listen<DownloadProgress>(
          "speech_model:progress",
          (event) => {
            const p = event.payload;
            pendingProgressRef.current[p.id] = {
              bytes_downloaded: p.bytes_downloaded,
              bytes_total: p.bytes_total,
              retrying: p.retrying ?? false,
            };
            if (flushTimerRef.current === null) {
              flushTimerRef.current = window.setTimeout(() => {
                flushTimerRef.current = null;
                const pending = pendingProgressRef.current;
                pendingProgressRef.current = {};
                setDownloads((prev) => ({ ...prev, ...pending }));
              }, 200);
            }
          },
        );
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  const handleDownload = async (model: SpeechModelStatus) => {
    setBusyId(model.id);
    setDownloadErrors((prev) => {
      const next = { ...prev };
      delete next[model.id];
      return next;
    });
    setDownloads((prev) => ({
      ...prev,
      [model.id]: { bytes_downloaded: 0, bytes_total: model.size_bytes },
    }));
    const noActiveBefore = !models.some((m) => m.active && m.downloaded);

    const poll = window.setInterval(() => {
      void refresh();
    }, 2000);

    try {
      await downloadSpeechModel(model.id);
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
      if (noActiveBefore) {
        try {
          await setActiveSpeechModel(model.id);
        } catch {
          /* ignore — best-effort auto-activate */
        }
      }
      await refresh();
      onChange?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDownloadErrors((prev) => ({ ...prev, [model.id]: msg }));
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
    } finally {
      window.clearInterval(poll);
      setBusyId((cur) => (cur === model.id ? null : cur));
      void refresh();
    }
  };

  const handleActivate = async (model: SpeechModelStatus) => {
    setBusyId(model.id);
    try {
      await setActiveSpeechModel(model.id);
      await refresh();
      onChange?.();
    } catch (e) {
      setDownloadErrors((prev) => ({
        ...prev,
        [model.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusyId((cur) => (cur === model.id ? null : cur));
    }
  };

  const handleDelete = async (model: SpeechModelStatus) => {
    setBusyId(model.id);
    try {
      await deleteSpeechModel(model.id);
      await refresh();
      onChange?.();
    } catch (e) {
      setDownloadErrors((prev) => ({
        ...prev,
        [model.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusyId((cur) => (cur === model.id ? null : cur));
    }
  };

  if (loadError && models.length === 0) {
    return (
      <p className="text-xs text-warning">
        {t("speechModelPicker.loadError", { error: loadError })}
      </p>
    );
  }

  const active = models.find(model => model.active && model.downloaded);
  const downloading = Object.entries(downloads).some(([id]) => !models.find(model => model.id === id)?.downloaded);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
        <div>
          <h3 className="text-sm font-semibold">{t("speechModelPicker.title")}</h3>
          <p className="mt-1 text-sm text-muted">{active ? `${active.display_name} ${active.version_label}` : "Choose a speech model"}</p>
          {downloading ? <p className="mt-1 text-xs text-muted" role="status">Model download in progress…</p> : null}
        </div>
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-elevated">Compare models</button>
      </div>
      {open ? createPortal(
        <Dialog label="Speech models" onClose={() => setOpen(false)} panelClassName="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-xl border border-line bg-canvas shadow-xl">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div><h2 className="text-base font-semibold">Speech models</h2><p className="mt-1 text-xs text-muted">Compare, download, and choose your dictation model.</p></div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-elevated">Done</button>
          </div>
          <div className="min-h-0 overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <caption className="sr-only">Speech model accuracy, speed, memory, and download controls</caption>
              <thead className="sticky top-0 bg-surface text-xs text-muted"><tr>
                <th scope="col" className="px-4 py-2">Model</th><th scope="col" className="px-3 py-2">Accuracy</th><th scope="col" className="px-3 py-2">Speed</th><th scope="col" className="px-3 py-2">RAM efficiency</th><th scope="col" className="px-4 py-2 text-right">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-line">{models.map(model => <SpeechModelRow key={model.id} model={model} active={model.active && model.downloaded} downloading={downloads[model.id] ?? null} downloadError={downloadErrors[model.id] ?? null} busy={busyId === model.id} onDownload={() => void handleDownload(model)} onActivate={() => void handleActivate(model)} onDelete={() => void handleDelete(model)} />)}</tbody>
            </table>
          </div>
          <div className="border-t border-line px-4 py-3 text-[11px] text-muted">
            <p>More bars is better; RAM efficiency means lower memory use. Downloads continue when you close this popup.</p>
            <details className="mt-1"><summary className="cursor-pointer">About these ratings</summary><p className="mt-1">Measured on your 29-second recording with a 53-word reference, without vocabulary hints, on an Apple M5 Pro with 64 GB RAM. Best result gets 5 bars; one bar is deducted per model with a better result. Ties share a rating. Speed is the median of nine warm runs. RAM is peak macOS physical footprint, including GPU allocations. Load time excludes Python imports and uses existing disk caches. One sample does not establish overall quality.</p></details>
          </div>
        </Dialog>, document.body,
      ) : null}
    </>
  );
}
