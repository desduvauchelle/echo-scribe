import { useEffect, useState } from "react";
import { Check, CheckSquare, Copy, Mic, StickyNote } from "lucide-react";
import type { Item, Project } from "../lib/api";
import { listTagsForItem } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useActivityPanel } from "./ActivityPanelContext";

type Props = {
  item: Item;
  /** Optional map of project_id → project for rendering the pill. */
  projects?: Map<string, Project>;
  /** Highlight terms (lowercased words) wrapped in <mark>. */
  highlight?: string[];
  compact?: boolean;
  /** Replaces the passive kind icon with an interactive leading control. */
  leadingSlot?: React.ReactNode;
  /** Custom slot rendered to the right of the actions. */
  rightSlot?: React.ReactNode;
};

function KindIcon({ kind, source }: { kind: Item["kind"]; source: Item["source"] }) {
  if (kind === "task") {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-warning/15 text-warning">
        <CheckSquare size={12} strokeWidth={2} aria-hidden="true" />
      </span>
    );
  }
  if (source === "voice_at_cursor") {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent-soft text-accent">
        <Mic size={12} strokeWidth={2} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-elevated text-muted">
      <StickyNote size={12} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function highlightContent(content: string, terms: string[] | undefined): React.ReactNode {
  if (!terms || terms.length === 0) return content;
  const cleaned = terms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (cleaned.length === 0) return content;
  const re = new RegExp(`(${cleaned.join("|")})`, "gi");
  const parts = content.split(re);
  return parts.map((p, i) =>
    re.test(p) ? (
      <mark key={i} className="bg-warning/15 text-warning">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export default function ItemCard({
  item,
  projects,
  highlight,
  compact,
  leadingSlot,
  rightSlot,
}: Props) {
  const { openItem } = useActivityPanel();
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await listTagsForItem(item.id);
        if (!cancelled) setTags(t);
      } catch {
        if (!cancelled) setTags([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  const project = item.project_id ? projects?.get(item.project_id) : null;
  const lineClamp = compact ? "line-clamp-2" : "line-clamp-3";
  const isVoice = item.source === "voice_at_cursor";
  const contentClass = isVoice
    ? "font-mono text-[12.5px] text-fg/95"
    : "text-[13px] text-fg";

  return (
    <div
      className={`group relative flex w-full gap-3 rounded-lg border border-line bg-surface ${
        compact ? "px-3 py-2.5" : "px-3.5 py-3"
      } text-left transition-colors hover:border-line-strong hover:bg-elevated ${
        isVoice ? "border-l-2 border-l-accent/70" : ""
      }`}
    >
      {/* Primary action: full-card overlay button. Secondary controls sit
          above it (relative z-10) so they stay clickable. */}
      <button
        type="button"
        onClick={() => openItem(item.id)}
        className="absolute inset-0 cursor-pointer rounded-lg"
        aria-label={`Open ${item.kind === "task" ? "task" : "note"}: ${item.content.slice(0, 80)}`}
      />
      <div
        className={`mt-0.5 shrink-0 ${leadingSlot ? "relative z-10" : ""}`}
        onClick={leadingSlot ? (e) => e.stopPropagation() : undefined}
      >
        {leadingSlot ?? <KindIcon kind={item.kind} source={item.source} />}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`leading-relaxed ${contentClass} ${lineClamp} whitespace-pre-wrap break-words`}
        >
          {highlightContent(item.content, highlight)}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <span>{relativeTime(item.captured_at)}</span>
          {project ? (
            <span className="rounded-full bg-elevated px-2 py-0.5 text-fg">
              {project.name}
            </span>
          ) : null}
          {tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-line px-2 py-0.5 text-muted"
            >
              #{t}
            </span>
          ))}
        </div>
      </div>
      <div
        className="relative z-10 flex shrink-0 flex-col items-end gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        {isVoice ? <CopyContentButton value={item.content} /> : null}
        {rightSlot}
      </div>
    </div>
  );
}

function CopyContentButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy transcription"}
      title="Copy transcription"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className={`grid h-7 w-7 place-items-center rounded-md border opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:bg-elevated ${
        copied ? "border-green-500/40 text-green-500 opacity-100" : "border-line text-muted"
      }`}
    >
      {copied ? (
        <Check size={13} aria-hidden="true" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
    </button>
  );
}
