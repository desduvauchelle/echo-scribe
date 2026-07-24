import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CloudUpload,
  Globe,
  Loader,
  Lock,
} from "lucide-react";
import Menu from "./a11y/Menu";
import type { UploadQuality } from "../lib/api";

// Shared presentational controls for a recording's management actions. These
// leaf components carry NO business logic — the caller wires the handlers — so
// the same buttons render identically in the dashboard detail slide-over
// (RecordingDetailPanel) and in the dedicated editor window's top bar
// (EditorView), and only need styling/behavior fixed in one place.

export type ExportVariant = { quality: string; path: string; size: number };

export function parseExports(json: string): ExportVariant[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ExportVariant[]) : [];
  } catch {
    return [];
  }
}

export function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** CSS hover tooltip (native `title` is unreliable in the macOS webview). */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tt relative inline-flex shrink-0">
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-[60] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-elevated px-2 py-1 text-[11px] text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover/tt:opacity-100">
        {label}
      </span>
    </span>
  );
}

export function IconButton({
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
export function SplitButton({
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
export function UploadButton({
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
