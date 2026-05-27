import { convertFileSrc } from "@tauri-apps/api/core";
import { Film, Globe, Loader } from "lucide-react";
import type { RecordingRow } from "../lib/api";
import { revealRecording } from "../lib/api";
import { relativeTime } from "../lib/format";

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

type Props = {
  rec: RecordingRow;
  /** Override the default action (reveal in Finder), e.g. open Recordings view. */
  onOpen?: (rec: RecordingRow) => void;
};

/** Compact recording row for the unified activity feed. Full management
 *  (transcribe, denoise, upload, export) lives in the Recordings view. */
export default function RecordingCard({ rec, onOpen }: Props) {
  const handleClick = () => {
    if (onOpen) onOpen(rec);
    else void revealRecording(rec.id);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
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
            {displayName(rec)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span>{relativeTime(new Date(rec.created_at).toISOString())}</span>
          <span>·</span>
          <span>{fmtSize(rec.size_bytes)}</span>
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
    </button>
  );
}
