import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  CloudUpload,
  Download,
  FileText,
  FolderOpen,
  Loader,
  MoreHorizontal,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  deleteRecording,
  driveConnect,
  exportRecording,
  getDrivePrefs,
  openRecordingEditor,
  revealRecording,
  transcribeRecording,
  uploadRecording,
  type RecordingRow,
  type UploadQuality,
} from "../lib/api";
import { useToasts } from "./ToastProvider";
import { useActivityPanel } from "./ActivityPanelContext";
import Menu from "./a11y/Menu";
import Dialog from "./a11y/Dialog";

export function recordingDisplayName(r: RecordingRow): string {
  return r.title?.trim() || r.source_label || "Recording";
}

function hasRenderedExport(r: RecordingRow): boolean {
  try {
    const v = JSON.parse(r.exports) as Array<{ quality?: string }>;
    return Array.isArray(v) && v.some((e) => e?.quality === "rendered");
  } catch {
    return false;
  }
}

// Blocking modal shown when an upload fails because Google Drive authorization
// is gone (revoked/expired token, or never connected). Explains why and runs
// the OAuth connect flow inline; on success the caller resumes the upload.
export function DriveReconnectModal({
  onReconnected,
  onClose,
}: {
  onReconnected: () => void;
  onClose: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      // Opens the browser consent page and resolves once Google redirects
      // back to the app's loopback listener (or errors after ~3 minutes).
      await driveConnect();
      onReconnected();
    } catch (e) {
      setError(String(e));
      setConnecting(false);
    }
  };

  return (
    <Dialog
      onClose={onClose}
      label="Reconnect Google Drive"
      dismissible={!connecting}
      className="fixed inset-0 z-[80] grid place-items-center bg-black/50"
      panelClassName="w-[400px] rounded-lg border border-line bg-canvas p-5 shadow-xl"
    >
        <h2 className="text-[14px] font-semibold tracking-tight">
          Google Drive is disconnected
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Google no longer accepts this app&apos;s authorization. This happens
          after a password change, after revoking the app in your Google
          account, or when Google expires the grant on its own. Reconnect to
          continue — this upload will resume automatically.
        </p>
        {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={connecting}
            className="rounded-md border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void connect()}
            disabled={connecting}
            className="flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-accent/25 disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Loader size={13} className="animate-spin" /> Waiting for Google…
              </>
            ) : (
              <>
                <CloudUpload size={13} /> Reconnect Google Drive
              </>
            )}
          </button>
        </div>
    </Dialog>
  );
}

type Busy = "upload" | "transcribe" | "export" | "delete" | null;

/** Kebab menu giving feed cards the full set of recording actions (edit,
 *  upload, reveal, transcribe, export, delete) without leaving the dashboard.
 *  Mutations bump the activity panel's refresh tick so every feed reloads. */
export default function RecordingActionsMenu({ rec }: { rec: RecordingRow }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  // Held upload args so the reconnect modal can resume after OAuth succeeds.
  const [reconnect, setReconnect] = useState<{
    quality: UploadQuality;
    makePublic: boolean;
  } | null>(null);
  const toasts = useToasts();
  const { bumpRefresh } = useActivityPanel();

  const fail = (e: unknown) =>
    toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });

  const onUpload = async (quality: UploadQuality, makePublic: boolean) => {
    setBusy("upload");
    try {
      const updated = await uploadRecording(rec.id, quality, makePublic);
      if (updated.drive_link) {
        // Best-effort auto-copy: the clipboard write needs transient user
        // activation, which the long upload await can outlive.
        try {
          await navigator.clipboard.writeText(updated.drive_link);
          toasts.push({ tone: "success", message: "Uploaded to Drive — link copied" });
        } catch {
          toasts.push({ tone: "success", message: "Uploaded to Drive" });
        }
      }
      bumpRefresh();
    } catch (e) {
      // Backend marks no-usable-authorization failures with this sentinel
      // (see upload_recording in commands.rs) — offer a reconnect flow.
      if (String(e).includes("drive_reconnect_required")) {
        setReconnect({ quality, makePublic });
      } else {
        fail(e);
      }
    } finally {
      setBusy(null);
    }
  };

  const startUpload = async () => {
    setOpen(false);
    const quality: UploadQuality = hasRenderedExport(rec) ? "rendered" : "1080";
    let makePublic = true;
    try {
      makePublic = (await getDrivePrefs()).make_public;
    } catch {
      /* fall back to the public default */
    }
    await onUpload(quality, makePublic);
  };

  const onTranscribe = async () => {
    setOpen(false);
    setBusy("transcribe");
    try {
      await transcribeRecording(rec.id);
      toasts.push({ tone: "success", message: "Transcript ready" });
      bumpRefresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const onExport = async () => {
    setOpen(false);
    setBusy("export");
    try {
      await exportRecording(rec.id, "1080");
      toasts.push({ tone: "success", message: "Exported 1080p MP4" });
      bumpRefresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    setOpen(false);
    const confirmed = await ask(
      `Delete “${recordingDisplayName(rec)}”? This cannot be undone.`,
      { title: "Delete recording", kind: "warning" },
    );
    if (!confirmed) return;
    setBusy("delete");
    try {
      await deleteRecording(rec.id);
      bumpRefresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const entry =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-fg hover:bg-surface";

  return (
    <div
      className="relative shrink-0"
      // The card behind this menu opens the editor on click — keep every
      // interaction inside the menu from bubbling up to it.
      onClick={(e) => e.stopPropagation()}
    >
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
      <Menu
        open={open}
        onOpenChange={setOpen}
        renderTrigger={(props) => (
          <button
            {...props}
            type="button"
            aria-label="Recording actions"
            className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
          >
            {busy ? <Loader size={14} className="animate-spin" /> : <MoreHorizontal size={15} />}
          </button>
        )}
      >
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[190px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-lg">
            <button
              type="button"
              className={entry}
              onClick={() => {
                setOpen(false);
                void openRecordingEditor(rec.id, recordingDisplayName(rec)).catch(fail);
              }}
            >
              <Wand2 size={14} /> Edit recording
            </button>
            <button type="button" className={entry} onClick={() => void startUpload()}>
              <CloudUpload size={14} />
              Upload to Drive{hasRenderedExport(rec) ? " (edited)" : ""}
            </button>
            <button
              type="button"
              className={entry}
              onClick={() => {
                setOpen(false);
                void revealRecording(rec.id).catch(fail);
              }}
            >
              <FolderOpen size={14} /> Reveal in Finder
            </button>
            <button type="button" className={entry} onClick={() => void onTranscribe()}>
              <FileText size={14} />
              {rec.transcript?.trim() ? "Regenerate transcript" : "Get transcript"}
            </button>
            <button type="button" className={entry} onClick={() => void onExport()}>
              <Download size={14} /> Export 1080p
            </button>
            <div className="my-1 border-t border-line" />
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-danger hover:bg-danger/10"
              onClick={() => void onDelete()}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
      </Menu>
    </div>
  );
}
