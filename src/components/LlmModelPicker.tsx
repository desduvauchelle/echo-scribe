import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  downloadLlmModel,
  listLlmModels,
  setActiveLlmModel,
  type DownloadProgress,
  type LlmModelStatus,
} from "../lib/api";

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

type DownloadState = { bytes_downloaded: number; bytes_total: number };

export default function LlmModelPicker() {
  const [models, setModels] = useState<LlmModelStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const pendingRef = useRef<Record<string, DownloadState>>({});
  const flushTimer = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const m = await listLlmModels();
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
          "llm_model:progress",
          (event) => {
            const p = event.payload;
            pendingRef.current[p.id] = {
              bytes_downloaded: p.bytes_downloaded,
              bytes_total: p.bytes_total,
            };
            if (flushTimer.current === null) {
              flushTimer.current = window.setTimeout(() => {
                flushTimer.current = null;
                const pending = pendingRef.current;
                pendingRef.current = {};
                setDownloads((prev) => ({ ...prev, ...pending }));
              }, 200);
            }
          },
        );
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, []);

  const handleDownload = async (model: LlmModelStatus) => {
    setBusyId(model.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[model.id];
      return next;
    });
    setDownloads((prev) => ({
      ...prev,
      [model.id]: { bytes_downloaded: 0, bytes_total: model.size_bytes },
    }));
    const noActiveBefore = !models.some((m) => m.active && m.downloaded);
    const poll = window.setInterval(() => void refresh(), 2000);
    try {
      await downloadLlmModel(model.id);
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
      if (noActiveBefore) {
        try {
          await setActiveLlmModel(model.id);
        } catch {
          /* ignore */
        }
      }
      await refresh();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [model.id]: e instanceof Error ? e.message : String(e),
      }));
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

  const handleActivate = async (model: LlmModelStatus) => {
    setBusyId(model.id);
    try {
      await setActiveLlmModel(model.id);
      await refresh();
    } catch (e) {
      setErrors((prev) => ({
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
        Couldn’t load LLM models: {loadError}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {models.map((model) => {
        const dl = downloads[model.id];
        const isDownloading = dl !== undefined && !model.downloaded;
        const downloadErr = errors[model.id];
        const disabled = !model.supported;
        return (
          <div
            key={model.id}
            title={disabled ? "Not yet supported" : undefined}
            className={`flex items-center justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4 ${
              disabled ? "cursor-not-allowed opacity-50" : ""
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-semibold">{model.size_label}</span>
                <span className="text-neutral-400"> — {model.display_name}</span>
              </div>
              <div className="mt-0.5 text-xs text-neutral-400">
                {model.family} · {formatBytes(model.size_bytes)} · {model.context_length} ctx
              </div>
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
                    {formatBytes(dl.bytes_downloaded)} / {formatBytes(dl.bytes_total)}
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
                  onClick={() => void handleActivate(model)}
                  className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
                >
                  Use this model
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyId === model.id}
                  onClick={() => void handleDownload(model)}
                  className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-white disabled:opacity-50"
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
