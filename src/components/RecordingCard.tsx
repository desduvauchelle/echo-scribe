import { convertFileSrc } from "@tauri-apps/api/core";
import { Film, Globe, Loader } from "lucide-react";
import type { Project, RecordingRow } from "../lib/api";
import { openRecordingEditor } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useToasts } from "./ToastProvider";
import RecordingActionsMenu, {
  recordingDisplayName,
} from "./RecordingActionsMenu";

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

type Props = {
  rec: RecordingRow;
  /** Optional map of project_id → project for rendering the pill. */
  projects?: Map<string, Project>;
  /** Override the default action (open the editor window). */
  onOpen?: (rec: RecordingRow) => void;
};

/** Recording row for the unified activity feed. Clicking opens the editor
 *  window; the kebab menu holds the rest of the management actions
 *  (upload, reveal, transcribe, export, delete). */
export default function RecordingCard({ rec, projects, onOpen }: Props) {
  const project = rec.project_id ? projects?.get(rec.project_id) : null;
  const toasts = useToasts();
  const handleClick = () => {
    if (onOpen) onOpen(rec);
    else
      void openRecordingEditor(rec.id, recordingDisplayName(rec)).catch((e) =>
        toasts.push({
          tone: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-elevated"
    >
      <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded bg-elevated">
        {rec.thumb_path ? (
          <img
            src={convertFileSrc(rec.thumb_path)}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted">
            <Film size={16} strokeWidth={1.75} />
          </div>
        )}
        {rec.duration_ms ? (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] font-medium tabular-nums text-white">
            {fmtDuration(rec.duration_ms)}
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Film size={12} strokeWidth={2} />
          </span>
          <span className="truncate text-[13px] font-medium text-fg">
            {recordingDisplayName(rec)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span>{relativeTime(new Date(rec.created_at).toISOString())}</span>
          <span>·</span>
          <span>{fmtSize(rec.size_bytes)}</span>
          {project ? (
            <span className="rounded-full bg-elevated px-2 py-0.5 text-fg">
              {project.name}
            </span>
          ) : null}
          {rec.upload_status === "uploading" ? (
            <span className="inline-flex items-center gap-1 text-muted">
              <Loader size={11} className="animate-spin" /> Uploading
            </span>
          ) : null}
          {rec.upload_status === "done" && rec.drive_link ? (
            <span className="inline-flex items-center gap-1 text-success">
              <Globe size={11} /> On Drive
            </span>
          ) : null}
          {rec.upload_status === "error" ? (
            <span className="text-danger">Upload failed</span>
          ) : null}
        </div>
      </div>

      <RecordingActionsMenu rec={rec} />
    </div>
  );
}
