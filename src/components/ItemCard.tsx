import { useEffect, useState } from "react";
import type { Item, Project } from "../lib/api";
import { listTagsForItem, updateItem } from "../lib/api";
import { relativeTime } from "../lib/format";
import ItemDetailPanel from "./ItemDetailPanel";

type Props = {
  item: Item;
  /** Optional map of project_id → project for rendering the pill. */
  projects?: Map<string, Project>;
  onEdited?: (updated: Item) => void;
  onDelete?: () => void;
  /** Toggle kind between note ↔ task (used by ActivityFeed's "Open as task"). */
  onToggleKind?: (next: "note" | "task") => void;
  /** Highlight terms (lowercased words) wrapped in <mark>. */
  highlight?: string[];
  compact?: boolean;
  /** When true, no edit/delete buttons rendered. */
  readOnly?: boolean;
  /** Custom slot rendered to the right of the actions. */
  rightSlot?: React.ReactNode;
};

function KindIcon({ kind, source }: { kind: Item["kind"]; source: Item["source"] }) {
  // simple textual marker; visual style varies per category.
  if (kind === "task") {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-amber-900/60 text-[11px] text-amber-200">
        ✓
      </span>
    );
  }
  if (source === "voice_at_cursor") {
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-sky-900/60 text-[11px] text-sky-200">
        🎙
      </span>
    );
  }
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-neutral-800 text-[11px] text-neutral-300">
      ·
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
      <mark key={i} className="bg-amber-900/50 text-amber-100">
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
  onEdited,
  onDelete,
  onToggleKind,
  highlight,
  compact,
  readOnly,
  rightSlot,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [expanded, setExpanded] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    setDraft(item.content);
  }, [item.content]);

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

  const onSave = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const updated = await updateItem({ id: item.id, content: draft });
      onEdited?.(updated);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const lineClamp = compact ? "line-clamp-2" : "line-clamp-3";
  const tooLong = item.content.split("\n").length > (compact ? 2 : 3) || item.content.length > 280;

  return (
    <div
      className={`group flex gap-3 rounded-lg border border-neutral-800 bg-neutral-900 ${
        compact ? "px-3 py-2" : "p-4"
      } hover:border-neutral-700`}
    >
      <div className="pt-1">
        <KindIcon kind={item.kind} source={item.source} />
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={compact ? 3 : 5}
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(item.content);
                }}
                disabled={busy}
                className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={busy || !draft.trim() || draft === item.content}
                className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-semibold text-neutral-900 hover:bg-white disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => !readOnly && setEditing(true)}
            disabled={readOnly}
            className={`block w-full text-left text-sm leading-relaxed text-neutral-100 ${
              expanded ? "" : lineClamp
            } whitespace-pre-wrap break-words ${
              readOnly ? "cursor-default" : "cursor-text"
            }`}
            title={readOnly ? undefined : "Click to edit"}
          >
            {highlightContent(item.content, highlight)}
          </button>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
          <span>{relativeTime(item.captured_at)}</span>
          {project ? (
            <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-neutral-200">
              {project.name}
            </span>
          ) : null}
          {tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-300"
            >
              #{t}
            </span>
          ))}
          {tooLong && !editing ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
          >
            {showDetail ? "Hide details" : "Details"}
          </button>
        </div>

        {showDetail ? <ItemDetailPanel itemId={item.id} /> : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {rightSlot}
        {!readOnly && !editing ? (
          <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
            {onToggleKind ? (
              <button
                type="button"
                onClick={() => onToggleKind(item.kind === "task" ? "note" : "task")}
                className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
                title={item.kind === "task" ? "Demote to note" : "Open as task"}
              >
                {item.kind === "task" ? "→ Note" : "→ Task"}
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-red-950 hover:text-red-200"
              >
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
