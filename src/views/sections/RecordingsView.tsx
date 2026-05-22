import { useCallback, useEffect, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  ChevronDown,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  isScreenRecording,
  openScreenrecSetup,
  stopScreenRecording,
  listRecordings,
  deleteRecording,
  renameRecording,
  revealRecording,
  transcribeRecording,
  denoiseRecording,
  exportRecording,
  uploadRecording,
  type RecordingRow,
} from "../../lib/api";

function displayName(r: RecordingRow): string {
  return r.title?.trim() || r.source_label || "Recording";
}

function fmtDuration(ms: number | null): string {
  if (!ms) return "0:00";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

type ExportVariant = { quality: string; path: string; size: number };

function parseExports(json: string): ExportVariant[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ExportVariant[]) : [];
  } catch {
    return [];
  }
}

/** CSS hover tooltip (native `title` is unreliable in the macOS webview). */
function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tt relative inline-flex shrink-0">
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-[60] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-elevated px-2 py-1 text-[11px] text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover/tt:opacity-100">
        {label}
      </span>
    </span>
  );
}

/** Copy-to-clipboard icon button; flips to a green check for ~1.2s on click. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy"
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border hover:bg-surface ${
        copied ? "border-green-500/40 text-green-500" : "border-line text-fg"
      }`}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={title}>
      <button
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        className={`grid h-8 w-8 place-items-center rounded-md border border-line hover:bg-surface disabled:opacity-50 ${
          danger ? "text-red-500 hover:bg-red-500/10" : "text-fg"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Icon button with a default action plus a caret that opens a resolution menu. */
function SplitButton({
  title,
  icon,
  options,
  defaultValue,
  onSelect,
  busy,
  disabled,
}: {
  title: string;
  icon: ReactNode;
  options: { label: string; value: string }[];
  defaultValue: string;
  onSelect: (value: string) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group/tt relative flex shrink-0">
      <button
        aria-label={title}
        onClick={() => onSelect(defaultValue)}
        disabled={disabled}
        className="grid h-8 w-8 place-items-center rounded-l-md border border-line text-fg hover:bg-surface disabled:opacity-50"
      >
        {busy ? <Loader size={16} className="animate-spin" /> : icon}
      </button>
      <button
        aria-label="Choose resolution"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="grid h-8 w-5 place-items-center rounded-r-md border border-l-0 border-line text-muted hover:bg-surface disabled:opacity-50"
      >
        <ChevronDown size={13} />
      </button>
      {open ? null : (
        <span className="pointer-events-none absolute left-1/2 top-full z-[60] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-elevated px-2 py-1 text-[11px] text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover/tt:opacity-100">
          {title}
        </span>
      )}
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[110px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-lg">
            {options.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  setOpen(false);
                  onSelect(o.value);
                }}
                className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-surface"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function RecordingsView() {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<RecordingRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [denoising, setDenoising] = useState(false);
  const [denoiseProgress, setDenoiseProgress] = useState(0);
  const [showCleaned, setShowCleaned] = useState(true);

  const refresh = useCallback(async () => {
    const next = await listRecordings();
    setRows(next);
    setSelected((cur) => (cur ? next.find((r) => r.id === cur.id) ?? cur : cur));
    setRecording(await isScreenRecording());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for screenrec-changed events (emitted by Rust on start/stop,
  // whether triggered from the setup window or tray) to keep button state
  // and list in sync without polling.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("screenrec-changed", () => {
      void refresh();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("transcribe-progress", (e) => {
      if (selected && e.payload.id === selected.id) setProgress(e.payload.pct);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [selected]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("denoise-progress", (e) => {
      if (selected && e.payload.id === selected.id) {
        setDenoiseProgress(e.payload.pct);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [selected]);

  const onToggle = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      if (recording) {
        await stopScreenRecording();
        await refresh();
      } else {
        // Open the setup window so the user can pick source/audio before
        // recording starts. The actual start is triggered from that window;
        // screenrec-changed will fire and refresh() when recording begins.
        await openScreenrecSetup();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [recording, refresh]);

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await deleteRecording(id);
        if (selected?.id === id) setSelected(null);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, selected],
  );

  const startRename = useCallback(() => {
    if (!selected) return;
    setNameInput(displayName(selected));
    setRenaming(true);
  }, [selected]);

  const saveRename = useCallback(async () => {
    if (!selected) return;
    const next = nameInput.trim();
    if (!next || next === displayName(selected)) {
      setRenaming(false);
      return;
    }
    try {
      await renameRecording(selected.id, next);
      setRenaming(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [selected, nameInput, refresh]);

  const onTranscribe = useCallback(async () => {
    if (!selected) return;
    setTranscribing(true);
    setProgress(0);
    setError(null);
    try {
      await transcribeRecording(selected.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }, [selected, refresh]);

  const onDenoise = useCallback(async () => {
    if (!selected) return;
    setDenoising(true);
    setDenoiseProgress(0);
    setError(null);
    try {
      await denoiseRecording(selected.id);
      await refresh();
      setShowCleaned(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setDenoising(false);
    }
  }, [selected, refresh]);

  const [exporting, setExporting] = useState<string | null>(null);

  const onExport = useCallback(
    async (id: string, quality: "1080" | "720" | "480") => {
      setExporting(quality);
      setError(null);
      try {
        await exportRecording(id, quality);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setExporting(null);
      }
    },
    [refresh],
  );

  const [uploading, setUploading] = useState(false);

  const onUpload = useCallback(
    async (id: string, quality: "original" | "1080" | "720" | "480") => {
      setUploading(true);
      setError(null);
      try {
        const updated = await uploadRecording(id, quality);
        if (updated.drive_link) {
          await navigator.clipboard.writeText(updated.drive_link);
        }
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setUploading(false);
      }
    },
    [refresh],
  );

  return (
    <div className="flex h-full flex-col bg-canvas text-fg">
      <div className="flex items-center justify-between border-b border-line px-6 py-4">
        <h1 className="text-[15px] font-semibold tracking-tight">Recordings</h1>
        <button
          onClick={onToggle}
          disabled={busy}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
            recording ? "bg-red-600 text-white" : "bg-accent text-white"
          } disabled:opacity-50`}
        >
          {recording ? "Stop recording" : "Record screen"}
        </button>
      </div>

      {error ? (
        <div className="border-b border-line bg-red-950/40 px-6 py-2 text-[12px] text-red-300">
          {error}
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        <div className="w-[320px] shrink-0 overflow-y-auto border-r border-line">
          {rows.length === 0 ? (
            <div className="p-6 text-[13px] text-muted">No recordings yet.</div>
          ) : (
            rows.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelected(r);
                  setRenaming(false);
                  setProgress(0);
                  setDenoiseProgress(0);
                  setShowCleaned(true);
                }}
                className={`flex w-full gap-3 border-b border-line p-3 text-left hover:bg-surface ${
                  selected?.id === r.id ? "bg-surface" : ""
                }`}
              >
                {r.thumb_path ? (
                  <img
                    src={convertFileSrc(r.thumb_path)}
                    alt=""
                    className="h-12 w-20 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-12 w-20 shrink-0 rounded bg-elevated" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">
                    {displayName(r)}
                  </div>
                  <div className="text-[11px] text-muted">
                    {new Date(r.created_at).toLocaleString()} ·{" "}
                    {fmtDuration(r.duration_ms)} · {fmtSize(r.size_bytes)}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto p-6">
          {selected ? (
            <>
              {renaming ? (
                <div className="mb-3 flex items-center gap-2">
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename();
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[15px] font-semibold outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => void saveRename()}
                    className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setRenaming(false)}
                    className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                    {displayName(selected)}
                  </h2>
                  <IconButton title="Rename" onClick={startRename}>
                    <Pencil size={16} />
                  </IconButton>
                </div>
              )}
              {selected.denoised_path ? (
                <div className="mb-2 inline-flex overflow-hidden rounded-md border border-line text-[12px]">
                  <button
                    onClick={() => setShowCleaned(false)}
                    className={`px-3 py-1 ${!showCleaned ? "bg-surface font-medium" : ""}`}
                  >
                    Original
                  </button>
                  <button
                    onClick={() => setShowCleaned(true)}
                    className={`px-3 py-1 ${showCleaned ? "bg-surface font-medium" : ""}`}
                  >
                    Cleaned
                  </button>
                </div>
              ) : null}
              <video
                key={`${selected.id}-${
                  showCleaned && selected.denoised_path ? "clean" : "orig"
                }`}
                src={convertFileSrc(
                  showCleaned && selected.denoised_path
                    ? selected.denoised_path
                    : selected.file_path,
                )}
                controls
                className="w-full rounded-lg bg-black"
              />
              <div className="mt-4 flex items-center gap-2">
                <IconButton
                  title="Reveal in Finder"
                  onClick={() => void revealRecording(selected.id)}
                >
                  <FolderOpen size={16} />
                </IconButton>
                <SplitButton
                  title="Export 1080p"
                  icon={<Download size={16} />}
                  busy={exporting !== null}
                  disabled={exporting !== null || uploading}
                  defaultValue="1080"
                  options={[
                    { label: "1080p", value: "1080" },
                    { label: "720p", value: "720" },
                    { label: "480p", value: "480" },
                  ]}
                  onSelect={(v) =>
                    void onExport(selected.id, v as "1080" | "720" | "480")
                  }
                />
                <SplitButton
                  title="Upload to Drive (1080p)"
                  icon={<CloudUpload size={16} />}
                  busy={uploading}
                  disabled={uploading || exporting !== null}
                  defaultValue="1080"
                  options={[
                    { label: "Original", value: "original" },
                    { label: "1080p", value: "1080" },
                    { label: "720p", value: "720" },
                    { label: "480p", value: "480" },
                  ]}
                  onSelect={(v) =>
                    void onUpload(
                      selected.id,
                      v as "original" | "1080" | "720" | "480",
                    )
                  }
                />
                <IconButton
                  title={
                    selected.transcript?.trim()
                      ? "Regenerate transcript"
                      : "Get transcript"
                  }
                  onClick={() => void onTranscribe()}
                  disabled={transcribing}
                >
                  {transcribing ? (
                    <Loader size={16} className="animate-spin" />
                  ) : (
                    <FileText size={16} />
                  )}
                </IconButton>
                <IconButton
                  title={
                    selected.denoised_path
                      ? "Re-clean audio"
                      : "Clean up audio"
                  }
                  onClick={() => void onDenoise()}
                  disabled={denoising}
                >
                  {denoising ? (
                    <Loader size={16} className="animate-spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                </IconButton>
                <div className="flex-1" />
                <IconButton
                  title="Delete"
                  onClick={() => void onDelete(selected.id)}
                  danger
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>

              {parseExports(selected.exports).length > 0 ? (
                <div className="mt-2 text-[12px] text-muted">
                  Exported:{" "}
                  {parseExports(selected.exports)
                    .map((e) => `${e.quality}p (${fmtSize(e.size)})`)
                    .join(" · ")}
                </div>
              ) : null}
              {transcribing ? (
                <div className="mt-2 text-[12px] text-muted">
                  Transcribing… {progress}%
                </div>
              ) : null}
              {denoising ? (
                <div className="mt-2 text-[12px] text-muted">
                  Cleaning audio… {denoiseProgress}%
                </div>
              ) : null}
              {uploading ? (
                <div className="mt-2 text-[12px] text-muted">
                  Uploading to Drive…
                </div>
              ) : null}
              {selected.upload_status === "error" ? (
                <div className="mt-2 text-[12px] text-red-400">
                  Upload failed
                  {selected.upload_error ? `: ${selected.upload_error}` : ""}
                </div>
              ) : null}
              {selected.upload_status === "done" && selected.drive_link ? (
                <div className="mt-3 flex items-center gap-2">
                  <ExternalLink size={14} className="shrink-0 text-muted" />
                  <a
                    href={selected.drive_link}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-[13px] text-accent underline"
                  >
                    {selected.drive_link}
                  </a>
                  <CopyButton value={selected.drive_link} />
                </div>
              ) : null}

              <div className="mt-6 border-t border-line pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold">Transcript</h3>
                  {selected.transcript?.trim() ? (
                    <CopyButton value={selected.transcript} />
                  ) : null}
                </div>
                {selected.transcript !== null ? (
                  selected.transcript.trim() ? (
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                      {selected.transcript}
                    </p>
                  ) : (
                    <span className="text-[13px] text-muted">
                      No speech detected. Use the transcript button above to retry.
                    </span>
                  )
                ) : (
                  <span className="text-[13px] text-muted">
                    No transcript yet — use the transcript button above to generate
                    one.
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-[13px] text-muted">
              Select a recording to play it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
