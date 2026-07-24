import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader,
  Pencil,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  deleteRecording,
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
import {
  DriveReconnectModal,
  recordingDisplayName,
} from "./RecordingActionsMenu";
import {
  fmtSize,
  parseExports,
  IconButton,
  SplitButton,
  UploadButton,
} from "./recordingActionButtons";

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
