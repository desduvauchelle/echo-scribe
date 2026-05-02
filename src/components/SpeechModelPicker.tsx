import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
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

export default function SpeechModelPicker({ onChange }: Props) {
  const [models, setModels] = useState<SpeechModelStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>(
    {},
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  // Throttle progress updates: queue per-id and flush at ~5hz
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
      setBusyId((cur) => (cur === model.id ? null : cur));
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

  if (loadError && models.length === 0) {
    return (
      <p className="text-xs text-amber-300">
        Couldn’t load speech models: {loadError}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {models.map((model) => {
        const dl = downloads[model.id];
        const isDownloading = dl !== undefined;
        const downloadErr = downloadErrors[model.id];
        const disabled = !model.supported;

        return (
          <div
            key={model.id}
            title={disabled ? "Not yet supported" : undefined}
            className={[
              "flex items-center justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4",
              disabled ? "cursor-not-allowed opacity-50" : "",
            ].join(" ")}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-semibold">{model.size_label}</span>
                <span className="text-neutral-400"> — {model.display_name}</span>
              </div>
              {model.size_bytes > 0 ? (
                <div className="mt-0.5 text-xs text-neutral-400">
                  {formatBytes(model.size_bytes)}
                </div>
              ) : null}
              {isDownloading ? (
                <div className="mt-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className="h-full bg-neutral-100 transition-all"
                      style={{
                        width: `${
                          dl.bytes_total > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (dl.bytes_downloaded / dl.bytes_total) * 100,
                                ),
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-neutral-400">
                    {formatBytes(dl.bytes_downloaded)} /{" "}
                    {formatBytes(dl.bytes_total)} (
                    {dl.bytes_total > 0
                      ? Math.round(
                          (dl.bytes_downloaded / dl.bytes_total) * 100,
                        )
                      : 0}
                    %)
                  </div>
                </div>
              ) : null}
              {downloadErr && !isDownloading ? (
                <p className="mt-2 text-xs text-red-400">
                  Download failed: {downloadErr}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center">
              {!model.supported ? (
                <span className="inline-flex items-center rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  Unavailable
                </span>
              ) : isDownloading ? (
                <span className="text-xs text-neutral-400">Downloading…</span>
              ) : model.downloaded && model.active ? (
                <span className="inline-flex items-center rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-200">
                  Active
                </span>
              ) : model.downloaded ? (
                <button
                  type="button"
                  disabled={busyId === model.id}
                  onClick={() => {
                    void handleActivate(model);
                  }}
                  className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Use this model
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyId === model.id}
                  onClick={() => {
                    void handleDownload(model);
                  }}
                  className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Download
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
