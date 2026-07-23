import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  deleteLlmModel,
  downloadLlmModel,
  listLlmModels,
  setActiveLlmModel,
  type DownloadProgress,
  type LlmModelStatus,
} from "../lib/api";
import { formatBytes } from "../lib/format";
import { TrashIcon } from "./icons";

type DownloadState = { bytes_downloaded: number; bytes_total: number };

type CardProps = {
  model: LlmModelStatus;
  downloading: DownloadState | null;
  downloadError: string | null;
  busy: boolean;
  onDownload: () => void;
  onActivate: () => void;
  onDelete: () => void;
};

function ModelCard({
  model,
  downloading,
  downloadError,
  busy,
  onDownload,
  onActivate,
  onDelete,
}: CardProps) {
  const isDownloading = downloading !== null && !model.downloaded;
  const disabled = !model.supported;
  return (
    <div
      title={disabled ? "Not yet supported" : undefined}
      className={`flex items-center justify-between gap-4 rounded-lg border border-line bg-surface p-4 ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <span className="font-semibold">{model.size_label}</span>
          <span className="text-muted"> — {model.display_name}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {model.family} · {formatBytes(model.size_bytes)} · {model.context_length} ctx
        </div>
        {model.incomplete && !isDownloading ? (
          <div className="mt-1 text-[11px] text-warning">
            Incomplete download · {formatBytes(model.disk_bytes)} on disk
          </div>
        ) : null}
        {isDownloading && downloading ? (
          <div className="mt-2">
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
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
              }
              className="h-1.5 w-full overflow-hidden rounded-full bg-elevated"
            >
              <div
                className="h-full bg-fg transition-all"
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
            <div className="mt-1 text-[11px] text-muted">
              {formatBytes(downloading.bytes_downloaded)} /{" "}
              {formatBytes(downloading.bytes_total)}
            </div>
          </div>
        ) : null}
        {downloadError && !isDownloading ? (
          <p className="mt-2 text-xs text-danger">
            Download failed: {downloadError}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!model.supported ? (
          <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
            Unavailable
          </span>
        ) : isDownloading ? (
          <span className="text-xs text-muted">Downloading…</span>
        ) : model.downloaded && model.active ? (
          <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
            Active
          </span>
        ) : model.downloaded ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon />
              Delete
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onActivate}
              className="rounded border border-line px-3 py-1 text-xs hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
            >
              Use this model
            </button>
          </>
        ) : model.incomplete ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon />
              Remove
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDownload}
              className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onDownload}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download
          </button>
        )}
      </div>
    </div>
  );
}

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

  const handleDelete = async (model: LlmModelStatus) => {
    setBusyId(model.id);
    try {
      await deleteLlmModel(model.id);
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
      <p className="text-xs text-warning">
        Couldn't load LLM models: {loadError}
      </p>
    );
  }

  const downloaded = models.filter((m) => m.downloaded);
  const available = models.filter((m) => !m.downloaded);
  const totalBytes = downloaded.reduce((sum, m) => sum + (m.disk_bytes || 0), 0);

  return (
    <div className="flex flex-col gap-5">
      {downloaded.length > 0 ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
              Downloaded models
            </h4>
            {totalBytes > 0 ? (
              <span className="text-[11px] text-muted">
                {formatBytes(totalBytes)} on disk
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
            {downloaded.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                downloading={downloads[model.id] ?? null}
                downloadError={errors[model.id] ?? null}
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
          <h4 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
            Available to download
          </h4>
          <div className="flex flex-col gap-3">
            {available.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                downloading={downloads[model.id] ?? null}
                downloadError={errors[model.id] ?? null}
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
