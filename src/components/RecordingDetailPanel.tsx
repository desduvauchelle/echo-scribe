import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  AudioLines,
  Check,
  ChevronDown,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  Loader,
  Lock,
  Pencil,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  deleteRecording,
  denoiseRecording,
  exportRecording,
  getDrivePrefs,
  listRecordings,
  openRecordingEditor,
  renameRecording,
  revealRecording,
  transcribeRecording,
  uploadRecording,
  type RecordingRow,
  type UploadQuality,
} from "../lib/api";
import { useToasts } from "./ToastProvider";
import { useActivityPanel } from "./ActivityPanelContext";
import { useFocusTrap } from "./a11y/Dialog";
import Menu from "./a11y/Menu";
import {
  DriveReconnectModal,
  recordingDisplayName,
} from "./RecordingActionsMenu";

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
          danger ? "text-danger hover:bg-danger/10" : "text-fg"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Icon button with a default action plus a caret that opens an options menu. */
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
    <Menu
      open={open}
      onOpenChange={setOpen}
      className="group/tt relative flex shrink-0"
      renderTrigger={(props) => (
        <>
          <button
            aria-label={title}
            onClick={() => onSelect(defaultValue)}
            disabled={disabled}
            className="grid h-8 w-8 place-items-center rounded-l-md border border-line text-fg hover:bg-surface disabled:opacity-50"
          >
            {busy ? <Loader size={16} className="animate-spin" /> : icon}
          </button>
          <button
            {...props}
            aria-label={`${title} options`}
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
        </>
      )}
    >
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
    </Menu>
  );
}

// Upload-to-Drive control: a split button whose dropdown lets the user pick
// the file's sharing visibility (per-video override of the Settings default)
// and the export quality. The primary click uploads the EDITED export when the
// recording has one, else 1080p; the dropdown always offers every choice.
function UploadButton({
  defaultPublic,
  hasEdited,
  busy,
  disabled,
  onUpload,
}: {
  defaultPublic: boolean;
  hasEdited: boolean;
  busy?: boolean;
  disabled?: boolean;
  onUpload: (quality: UploadQuality, makePublic: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPublic, setIsPublic] = useState(defaultPublic);
  // Re-sync when the Settings default loads/changes (defaultPublic starts stale).
  useEffect(() => setIsPublic(defaultPublic), [defaultPublic]);

  const primary: UploadQuality = hasEdited ? "rendered" : "1080";
  const qualities: { label: string; value: UploadQuality }[] = [
    ...(hasEdited ? [{ label: "Edited", value: "rendered" as UploadQuality }] : []),
    { label: "Original", value: "original" },
    { label: "1080p", value: "1080" },
    { label: "720p", value: "720" },
    { label: "480p", value: "480" },
  ];
  const seg = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-1 rounded border px-2 py-1 text-[11px] ${
      active ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-surface"
    }`;

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      className="group/tt relative flex shrink-0"
      renderTrigger={(props) => (
        <>
          <button
            aria-label="Upload to Drive"
            onClick={() => onUpload(primary, isPublic)}
            disabled={disabled}
            className="grid h-8 w-8 place-items-center rounded-l-md border border-line text-fg hover:bg-surface disabled:opacity-50"
          >
            {busy ? <Loader size={16} className="animate-spin" /> : <CloudUpload size={16} />}
          </button>
          <button
            {...props}
            aria-label="Upload options"
            disabled={disabled}
            className="grid h-8 w-5 place-items-center rounded-r-md border border-l-0 border-line text-muted hover:bg-surface disabled:opacity-50"
          >
            <ChevronDown size={13} />
          </button>
          {open ? null : (
            <span className="pointer-events-none absolute left-1/2 top-full z-[60] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-elevated px-2 py-1 text-[11px] text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover/tt:opacity-100">
              Upload to Drive ({hasEdited ? "edited version" : "1080p"})
            </span>
          )}
        </>
      )}
    >
      <div className="absolute right-0 top-full z-50 mt-1 min-w-[170px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-lg">
        <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">
          Sharing
        </div>
        <div className="flex gap-1 px-2 pb-2">
          <button type="button" onClick={() => setIsPublic(true)} className={seg(isPublic)}>
            <Globe size={12} /> Anyone
          </button>
          <button type="button" onClick={() => setIsPublic(false)} className={seg(!isPublic)}>
            <Lock size={12} /> Only me
          </button>
        </div>
        <div className="border-t border-line px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          Quality
        </div>
        {qualities.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              setOpen(false);
              onUpload(o.value, isPublic);
            }}
            className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-surface"
          >
            {o.label}
          </button>
        ))}
      </div>
    </Menu>
  );
}

/** Slide-over from the right showing a recording's full detail — the video
 *  player plus the management actions that used to live on the Recordings
 *  page (rename, reveal, clean audio, export, upload, transcript, delete).
 *  "Edit video" opens the dedicated editor window for the advanced tools. */
export default function RecordingDetailPanel() {
  const { selectedRecordingId, close } = useActivityPanel();
  const open = selectedRecordingId !== null;
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <div
        onClick={close}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={`fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[92vw] flex-col border-l border-line bg-canvas shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-panel-title"
      >
        {open && selectedRecordingId ? (
          <PanelBody id={selectedRecordingId} onClose={close} />
        ) : null}
      </aside>
    </>
  );
}

function PanelBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { bumpRefresh, refreshTick } = useActivityPanel();
  const toasts = useToasts();
  const [rec, setRec] = useState<RecordingRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [denoising, setDenoising] = useState(false);
  const [denoiseProgress, setDenoiseProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [defaultPublic, setDefaultPublic] = useState(true);
  const [reconnect, setReconnect] = useState<{
    quality: UploadQuality;
    makePublic: boolean;
  } | null>(null);

  const fail = useCallback(
    (e: unknown) =>
      toasts.push({
        tone: "error",
        message: e instanceof Error ? e.message : String(e),
      }),
    [toasts],
  );

  const reload = useCallback(async () => {
    try {
      const rows = await listRecordings();
      const found = rows.find((r) => r.id === id) ?? null;
      setRec(found);
      if (!found) setError("Recording not found.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    void getDrivePrefs().then((p) => setDefaultPublic(p.make_public)).catch(() => {});
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("transcribe-progress", (e) => {
      if (e.payload.id === id) setProgress(e.payload.pct);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [id]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("denoise-progress", (e) => {
      if (e.payload.id !== id) return;
      setDenoising(true);
      setDenoiseProgress(e.payload.pct);
      if (e.payload.pct >= 100) {
        setDenoising(false);
        void reload();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [id, reload]);

  const startRename = () => {
    if (!rec) return;
    setNameInput(recordingDisplayName(rec));
    setRenaming(true);
  };

  const saveRename = async () => {
    if (!rec) return;
    const next = nameInput.trim();
    if (!next || next === recordingDisplayName(rec)) {
      setRenaming(false);
      return;
    }
    try {
      await renameRecording(rec.id, next);
      setRenaming(false);
      await reload();
      bumpRefresh();
    } catch (e) {
      fail(e);
    }
  };

  const onTranscribe = async () => {
    if (!rec) return;
    setTranscribing(true);
    setProgress(0);
    try {
      await transcribeRecording(rec.id);
      await reload();
      bumpRefresh();
    } catch (e) {
      fail(e);
    } finally {
      setTranscribing(false);
    }
  };

  const onDenoise = async () => {
    if (!rec) return;
    setDenoising(true);
    setDenoiseProgress(0);
    try {
      await denoiseRecording(rec.id);
      await reload();
      bumpRefresh();
    } catch (e) {
      setDenoising(false);
      fail(e);
    }
  };

  const onExport = async (quality: "1080" | "720" | "480") => {
    if (!rec) return;
    setExporting(true);
    try {
      await exportRecording(rec.id, quality);
      toasts.push({ tone: "success", message: `Exported ${quality}p MP4` });
      await reload();
      bumpRefresh();
    } catch (e) {
      fail(e);
    } finally {
      setExporting(false);
    }
  };

  const onUpload = async (quality: UploadQuality, makePublic: boolean) => {
    if (!rec) return;
    setUploading(true);
    try {
      const updated = await uploadRecording(rec.id, quality, makePublic);
      if (updated.drive_link) {
        // Best-effort auto-copy: the clipboard write needs transient user
        // activation, which the long upload await can outlive.
        try {
          await navigator.clipboard.writeText(updated.drive_link);
        } catch {
          /* link still copyable from the UI */
        }
      }
      await reload();
      bumpRefresh();
    } catch (e) {
      if (String(e).includes("drive_reconnect_required")) {
        setReconnect({ quality, makePublic });
      } else {
        fail(e);
      }
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async () => {
    if (!rec) return;
    const confirmed = await ask(
      `Delete “${recordingDisplayName(rec)}”? This cannot be undone.`,
      { title: "Delete recording", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await deleteRecording(rec.id);
      bumpRefresh();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const exportsList = rec ? parseExports(rec.exports) : [];
  const hasEdited = exportsList.some((e) => e.quality === "rendered");
  const audioCleaned = rec?.denoised_path != null;

  return (
    <>
      {reconnect ? (
        <DriveReconnectModal
          onClose={() => setReconnect(null)}
          onReconnected={() => {
            const args = reconnect;
            setReconnect(null);
            void onUpload(args.quality, args.makePublic);
          }}
        />
      ) : null}
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        {renaming && rec ? (
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveRename();
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
            onBlur={() => void saveRename()}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm font-medium outline-none focus:border-accent"
          />
        ) : (
          <div
            id="recording-panel-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-fg"
          >
            {rec ? recordingDisplayName(rec) : "Recording"}
          </div>
        )}
        {rec && !renaming ? (
          <button
            type="button"
            onClick={startRename}
            aria-label="Rename recording"
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <Pencil size={14} strokeWidth={2.25} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 text-sm text-fg">
        {error ? (
          <div className="text-xs text-danger">{error}</div>
        ) : !rec ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : (
          <>
            <video
              // Key on the resolved path, not the id: denoise swaps the file
              // (original → cleaned) under the same recording id, and an
              // errored <video> only recovers on remount.
              key={rec.denoised_path ?? rec.file_path}
              src={convertFileSrc(rec.denoised_path ?? rec.file_path)}
              controls
              className="w-full rounded-lg bg-black"
            />

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void openRecordingEditor(rec.id, recordingDisplayName(rec)).catch(fail)
                }
                className="flex h-8 items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 text-[12.5px] font-medium text-fg hover:bg-accent/25"
              >
                <Wand2 size={14} /> Edit video
              </button>
              <div className="flex-1" />
              <IconButton
                title="Reveal in Finder"
                onClick={() => void revealRecording(rec.id).catch(fail)}
              >
                <FolderOpen size={16} />
              </IconButton>
              <IconButton
                title={audioCleaned ? "Audio already cleaned" : "Clean up audio"}
                onClick={() => void onDenoise()}
                disabled={audioCleaned || denoising}
              >
                {denoising ? (
                  <Loader size={16} className="animate-spin" />
                ) : (
                  <AudioLines size={16} />
                )}
              </IconButton>
              <SplitButton
                title="Export 1080p"
                icon={<Download size={16} />}
                busy={exporting}
                disabled={exporting || uploading}
                defaultValue="1080"
                options={[
                  { label: "1080p", value: "1080" },
                  { label: "720p", value: "720" },
                  { label: "480p", value: "480" },
                ]}
                onSelect={(v) => void onExport(v as "1080" | "720" | "480")}
              />
              <UploadButton
                defaultPublic={defaultPublic}
                hasEdited={hasEdited}
                busy={uploading}
                disabled={uploading || exporting}
                onUpload={(quality, makePublic) => void onUpload(quality, makePublic)}
              />
              <IconButton
                title={
                  rec.transcript?.trim() ? "Regenerate transcript" : "Get transcript"
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
              <IconButton title="Delete" onClick={() => void onDelete()} danger>
                <Trash2 size={16} />
              </IconButton>
            </div>

            {exportsList.length > 0 ? (
              <div className="mt-2 text-[12px] text-muted">
                Exported:{" "}
                {exportsList
                  .map(
                    (e) =>
                      `${e.quality === "rendered" ? "Rendered" : `${e.quality}p`} (${fmtSize(e.size)})`,
                  )
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
              <div className="mt-2 text-[12px] text-muted">Uploading to Drive…</div>
            ) : null}
            {rec.upload_status === "error" ? (
              <div className="mt-2 text-[12px] text-danger">
                Upload failed
                {rec.upload_error ? `: ${rec.upload_error}` : ""}
              </div>
            ) : null}
            {rec.upload_status === "done" && rec.drive_link ? (
              <div className="mt-3 flex items-center gap-2">
                <ExternalLink size={14} className="shrink-0 text-muted" />
                <a
                  href={rec.drive_link}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-[13px] text-accent underline"
                >
                  {rec.drive_link}
                </a>
                <CopyButton value={rec.drive_link} />
              </div>
            ) : null}

            <div className="mt-6 border-t border-line pt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[13px] font-semibold">Transcript</h3>
                {rec.transcript?.trim() ? <CopyButton value={rec.transcript} /> : null}
              </div>
              {rec.transcript !== null ? (
                rec.transcript.trim() ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                    {rec.transcript}
                  </p>
                ) : (
                  <span className="text-[13px] text-muted">
                    No speech detected. Use the transcript button above to retry.
                  </span>
                )
              ) : (
                <span className="text-[13px] text-muted">
                  No transcript yet — use the transcript button above to generate one.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
