import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  deleteSpeechModel,
  downloadSpeechModel,
  listSpeechModels,
  setActiveSpeechModel,
  type DownloadProgress,
  type SpeechModelStatus,
} from "../lib/api";

type Props = {
  onChange?: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const fixed = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[i]}`;
}

type DownloadState = {
  bytes_downloaded: number;
  bytes_total: number;
};

const ACCENT_FILL = "bg-rose-400";
const ACCENT_TRACK = "bg-neutral-800";

function SegmentBar({ value, max = 5 }: { value: number; max?: number }) {
  const v = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <div className="flex items-center gap-1">
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

function GlobeIcon({ english_only }: { english_only: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      {english_only ? null : null}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
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

function ModelCard({
  model,
  active,
  downloading,
  downloadError,
  busy,
  onDownload,
  onActivate,
  onDelete,
}: CardProps) {
  const disabled = !model.supported;
  const isDownloading = downloading !== null && !model.downloaded;

  return (
    <div
      title={disabled ? "Not yet supported" : undefined}
      className={[
        "rounded-xl border p-4 transition-colors",
        active
          ? "border-rose-700/70 bg-neutral-900"
          : "border-neutral-800 bg-neutral-900/70",
        disabled ? "cursor-not-allowed opacity-50" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-neutral-100">
              {model.display_name}
              {model.version_label ? (
                <span className="ml-1.5 text-neutral-400">
                  {model.version_label}
                </span>
              ) : null}
            </span>
            {active ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-900/60 px-2 py-0.5 text-[11px] font-medium text-rose-200">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="5 12 10 17 19 8" />
                </svg>
                Active
              </span>
            ) : null}
          </div>
          {model.description ? (
            <p className="mt-1 text-sm text-neutral-400">{model.description}</p>
          ) : null}
        </div>

        {(model.accuracy_bars > 0 || model.speed_bars > 0) && !isDownloading ? (
          <div className="shrink-0 space-y-1">
            {model.accuracy_bars > 0 ? (
              <div className="flex items-center justify-end gap-2 text-[11px] text-neutral-400">
                <span>accuracy</span>
                <SegmentBar value={model.accuracy_bars} />
              </div>
            ) : null}
            {model.speed_bars > 0 ? (
              <div className="flex items-center justify-end gap-2 text-[11px] text-neutral-400">
                <span>speed</span>
                <SegmentBar value={model.speed_bars} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {isDownloading && downloading ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-rose-400 transition-all"
              style={{
                width: `${
                  downloading.bytes_total > 0
                    ? Math.min(
                        100,
                        Math.round(
                          (downloading.bytes_downloaded /
                            downloading.bytes_total) *
                            100,
                        ),
                      )
                    : 0
                }%`,
              }}
            />
          </div>
          <div className="mt-1 text-[11px] text-neutral-400">
            {formatBytes(downloading.bytes_downloaded)} /{" "}
            {formatBytes(downloading.bytes_total)} (
            {downloading.bytes_total > 0
              ? Math.round(
                  (downloading.bytes_downloaded / downloading.bytes_total) *
                    100,
                )
              : 0}
            %)
          </div>
        </div>
      ) : null}

      {downloadError && !isDownloading ? (
        <p className="mt-2 text-xs text-rose-400">
          Download failed: {downloadError}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between border-t border-neutral-800/80 pt-3">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-neutral-400">
          <GlobeIcon english_only={model.english_only} />
          <span>{model.language_label || (model.english_only ? "English Only" : "Multi-language")}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!model.supported ? (
            <span className="inline-flex items-center rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
              Unavailable
            </span>
          ) : isDownloading ? (
            <span className="text-xs text-neutral-400">Downloading…</span>
          ) : model.downloaded && active ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs text-neutral-400 transition-colors hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon />
              Delete
            </button>
          ) : model.downloaded ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs text-neutral-400 transition-colors hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <TrashIcon />
                Delete
              </button>
              <button
                type="button"
                onClick={onActivate}
                disabled={busy}
                className="rounded-md border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Use this model
              </button>
            </>
          ) : (
            <>
              {model.size_bytes > 0 ? (
                <span className="text-[11px] text-neutral-500">
                  {formatBytes(model.size_bytes)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={onDownload}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <DownloadIcon />
                Download
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SpeechModelPicker({ onChange }: Props) {
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
      <p className="text-xs text-amber-300">
        Couldn’t load speech models: {loadError}
      </p>
    );
  }

  const downloaded = models.filter((m) => m.downloaded);
  const available = models.filter((m) => !m.downloaded);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-base font-semibold text-neutral-100">
          Transcription Models
        </h3>
        <p className="mt-1 text-sm text-neutral-400">
          Choose a model to transcribe what you say. Run on-device, no network.
        </p>
      </div>

      {downloaded.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Downloaded models
          </h4>
          <div className="flex flex-col gap-3">
            {downloaded.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                active={model.active}
                downloading={downloads[model.id] ?? null}
                downloadError={downloadErrors[model.id] ?? null}
                busy={busyId === model.id}
                onDownload={() => void handleDownload(model)}
                onActivate={() => void handleActivate(model)}
                onDelete={() => void handleDelete(model)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {available.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Available to download
          </h4>
          <div className="flex flex-col gap-3">
            {available.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                active={model.active}
                downloading={downloads[model.id] ?? null}
                downloadError={downloadErrors[model.id] ?? null}
                busy={busyId === model.id}
                onDownload={() => void handleDownload(model)}
                onActivate={() => void handleActivate(model)}
                onDelete={() => void handleDelete(model)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
