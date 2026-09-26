// Detail view for a single dictation / note / task in the activity side panel.
// Meetings have their own layout in ActivityPanel.tsx; this file covers the rest.
//
// Layout: header (type menu + time + icon actions) → the text itself as the
// hero → a compact property list → where it was captured → collapsed history.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Copy,
  Crosshair,
  FileText,
  Flag,
  Folder,
  Hash,
  Mic,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import Markdown from "./Markdown";
import ItemDetailPanel from "./ItemDetailPanel";
import { Tooltip } from "./recordingActionButtons";
import {
  completeTask,
  createProject,
  parseCaptureContext,
  setTaskDeadline,
  setTaskFocus,
  uncompleteTask,
  updateItem,
  type Item,
  type ItemImportance,
  type ItemKind,
  type Project,
} from "../lib/api";
import { relativeTimeLabel } from "../lib/displayText";
import { useToasts } from "./ToastProvider";

// ─── Header ────────────────────────────────────────────────────────────────

type KindKey = ItemKind | "";

const KIND_META: Record<KindKey, { icon: typeof Mic; tone: string; labelKey: string }> = {
  transcription: { icon: Mic, tone: "text-sky-600", labelKey: "activityPanel.kind.transcription" },
  note: { icon: FileText, tone: "text-amber-600", labelKey: "activityPanel.kind.note" },
  task: { icon: CircleCheck, tone: "text-accent", labelKey: "activityPanel.kind.task" },
  meeting: { icon: Users, tone: "text-violet-600", labelKey: "activityPanel.title.meeting" },
  "": { icon: CircleDashed, tone: "text-faint", labelKey: "activityPanel.header.unsorted" },
};

const KIND_CHOICES: ItemKind[] = ["transcription", "note", "task"];

function HeaderIconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`grid h-8 w-8 place-items-center rounded-md text-muted transition-colors ${
          danger ? "hover:bg-danger/10 hover:text-danger" : "hover:bg-elevated hover:text-fg"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function ItemHeader({
  item,
  titleId,
  title,
  onKindChange,
  onDelete,
  onRestore,
  onClose,
}: {
  item: Item;
  titleId: string;
  /** Accessible name for the dialog; not shown — the text body is the real title. */
  title: string;
  onKindChange: (i: Item) => void;
  onDelete: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("[activity-panel] clipboard write failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.copyFailed") });
    }
  };

  return (
    <header className="flex items-center gap-2 border-b border-line py-2.5 pl-4 pr-3">
      <span id={titleId} className="sr-only">{title}</span>
      <KindMenu item={item} onChange={onKindChange} />
      <span className="truncate text-xs text-faint">{relativeTimeLabel(t, item.captured_at)}</span>
      {item.deleted_at ? (
        <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
          {t("activityPanel.header.inTrash")}
        </span>
      ) : null}
      <span className="flex-1" />
      <HeaderIconButton
        label={copied ? t("activityPanel.header.copied") : t("activityPanel.header.copy")}
        onClick={() => void copy()}
      >
        {copied ? <Check size={16} strokeWidth={2} className="text-accent" /> : <Copy size={16} strokeWidth={2} />}
      </HeaderIconButton>
      {item.deleted_at ? (
        <HeaderIconButton label={t("activityPanel.header.restore")} onClick={onRestore}>
          <RotateCcw size={16} strokeWidth={2} />
        </HeaderIconButton>
      ) : (
        <HeaderIconButton label={t("activityPanel.header.moveToTrash")} onClick={onDelete} danger>
          <Trash2 size={16} strokeWidth={2} />
        </HeaderIconButton>
      )}
      <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
      <HeaderIconButton label={t("activityPanel.panelBody.closePanel")} onClick={onClose}>
        <X size={16} strokeWidth={2.25} />
      </HeaderIconButton>
    </header>
  );
}

function KindMenu({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current: KindKey = item.kind ?? "";
  const meta = KIND_META[current];
  const Icon = meta.icon;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = async (k: ItemKind) => {
    setOpen(false);
    if (k === item.kind) return;
    try {
      onChange(await updateItem({ id: item.id, kind: k }));
    } catch (e) {
      console.error("[activity-panel] kind change failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onKeyDown={(e) => {
        // Close the menu, not the whole panel.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Tooltip label={t("activityPanel.header.changeType")}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface py-1 pl-2 pr-1.5 text-xs font-semibold text-fg transition-colors hover:border-line-strong"
        >
          <Icon size={14} strokeWidth={2} className={meta.tone} aria-hidden="true" />
          {t(meta.labelKey)}
          <ChevronDown size={12} strokeWidth={2.5} className="text-faint" aria-hidden="true" />
        </button>
      </Tooltip>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-[70] mt-1.5 w-44 rounded-lg border border-line-strong bg-canvas p-1 shadow-xl"
        >
          {KIND_CHOICES.map((k) => {
            const m = KIND_META[k];
            const KIcon = m.icon;
            const active = k === item.kind;
            return (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                autoFocus={active}
                onClick={() => void choose(k)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated ${
                  active ? "bg-accent-soft" : ""
                }`}
              >
                <KIcon size={14} strokeWidth={2} className={m.tone} aria-hidden="true" />
                {t(m.labelKey)}
                {active ? <Check size={13} strokeWidth={2.5} className="ml-auto text-accent" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Body ──────────────────────────────────────────────────────────────────

export function ItemBody({
  item,
  projects,
  tags,
  deadline,
  completedAt,
  focused,
  onItemChange,
  onProjectsChange,
  onTagsChange,
  onTaskChange,
  onFocusChange,
  onSaved,
}: {
  item: Item;
  projects: Project[];
  tags: string[];
  deadline: string | null;
  completedAt: string | null;
  focused: boolean;
  onItemChange: (i: Item) => void;
  onProjectsChange: (next: Project[]) => void;
  onTagsChange: (next: string[]) => void;
  onTaskChange: (deadline: string | null, completedAt: string | null) => void;
  onFocusChange: (focused: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const isTask = item.kind === "task";

  const toggleComplete = async () => {
    try {
      if (completedAt) {
        await uncompleteTask(item.id);
        onTaskChange(deadline, null);
      } else {
        await completeTask(item.id);
        onTaskChange(deadline, new Date().toISOString());
      }
    } catch (e) {
      console.error("[activity-panel] toggle complete failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  const toggleFocus = async () => {
    try {
      await setTaskFocus(item.id, !focused);
      onFocusChange(!focused);
    } catch (e) {
      console.error("[activity-panel] toggle focus failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  return (
    <div>
      <div className="flex items-start gap-3">
        {isTask ? (
          <Tooltip label={completedAt ? t("activityPanel.task.markIncomplete") : t("activityPanel.task.markComplete")}>
            <button
              type="button"
              role="checkbox"
              aria-checked={!!completedAt}
              aria-label={t("activityPanel.task.markComplete")}
              onClick={() => void toggleComplete()}
              className={`mt-[3px] grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border-2 transition-colors ${
                completedAt
                  ? "border-accent bg-accent text-canvas"
                  : "border-line-strong text-transparent hover:border-accent hover:text-accent/60"
              }`}
            >
              <Check size={13} strokeWidth={3} />
            </button>
          </Tooltip>
        ) : null}
        <div className="min-w-0 flex-1">
          <EditableContent item={item} muted={!!completedAt} onChange={onItemChange} />
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-[104px_1fr] items-center gap-y-1 border-t border-line pt-4 text-[13px]">
        {isTask ? (
          <PropRow icon={<Crosshair size={14} />} label={t("main:dashboard.focus.label")}>
            <button
              type="button"
              role="checkbox"
              aria-checked={focused}
              aria-label={t("main:dashboard.focus.label")}
              onClick={() => void toggleFocus()}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${focused ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-fg"}`}
            >
              {t("main:dashboard.focus.label")}
            </button>
          </PropRow>
        ) : null}
        {isTask ? (
          <PropRow icon={<Calendar size={14} />} label={t("activityPanel.props.due")}>
            <DueDate
              itemId={item.id}
              deadline={deadline}
              completed={!!completedAt}
              onChange={(d) => onTaskChange(d, completedAt)}
            />
          </PropRow>
        ) : null}
        <PropRow icon={<Flag size={14} />} label={t("activityPanel.props.importance")}>
          <ImportancePicker item={item} onChange={onItemChange} />
        </PropRow>
        <PropRow icon={<Folder size={14} />} label={t("activityPanel.project.label")}>
          <ProjectPicker item={item} projects={projects} onProjectsChange={onProjectsChange} onChange={onItemChange} />
        </PropRow>
        <PropRow icon={<Hash size={14} />} label={t("activityPanel.tags.label")}>
          <TagEditor item={item} tags={tags} onTagsChange={onTagsChange} onSaved={onSaved} />
        </PropRow>
      </dl>

      <CapturedFrom item={item} />
      <HistoryDisclosure itemId={item.id} projects={projects} />
    </div>
  );
}

function PropRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-[12.5px] text-faint">
        <span aria-hidden="true">{icon}</span>
        {label}
      </dt>
      <dd className="flex min-h-[32px] min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </>
  );
}

// ─── Content ───────────────────────────────────────────────────────────────

function EditableContent({ item, muted, onChange }: { item: Item; muted: boolean; onChange: (i: Item) => void }) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [draft, setDraft] = useState(item.content);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(item.content);
  }, [item.id, item.content]);

  const save = async (text: string) => {
    if (text === item.content) return;
    setSaving(true);
    try {
      onChange(await updateItem({ id: item.id, content: text }));
    } catch (e) {
      console.error("[activity-panel] content save failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    } finally {
      setSaving(false);
    }
  };

  // Debounced auto-save while editing.
  useEffect(() => {
    if (!editing || draft === item.content) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(draft), 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  const finish = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void save(draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              finish();
            }
          }}
          rows={Math.min(14, Math.max(4, draft.split("\n").length + 2))}
          className="-mx-3 -mt-2 w-[calc(100%+1.5rem)] rounded-lg border border-accent bg-surface px-3 py-2 text-[15px] leading-relaxed text-fg focus:outline-none"
        />
        <div className="mt-1.5 flex items-center justify-end gap-3">
          <span role="status" className="text-[11px] text-faint">
            {saving
              ? t("activityPanel.content.saving")
              : draft !== item.content
                ? t("activityPanel.content.unsaved")
                : t("activityPanel.content.saved")}
          </span>
          <button
            type="button"
            onClick={finish}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          >
            {t("activityPanel.editToggle.done")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="group relative -mx-3 -mt-2 cursor-text rounded-lg px-3 py-2 transition-colors hover:bg-surface"
      onClick={(e) => {
        // Let links inside the rendered markdown work normally.
        if ((e.target as HTMLElement).closest("a")) return;
        setEditing(true);
      }}
    >
      <div className={`pr-6 text-[15px] leading-relaxed ${muted ? "text-muted" : "text-fg"}`}>
        {draft.trim() ? (
          <Markdown>{draft}</Markdown>
        ) : (
          <span className="italic text-faint">{t("activityPanel.content.empty")}</span>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        aria-label={t("activityPanel.content.editAriaLabel")}
        className="absolute right-1.5 top-1.5 rounded p-1 text-faint opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
      >
        <Pencil size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

// ─── Properties ────────────────────────────────────────────────────────────

const IMPORTANCE_CHOICES: { key: ItemImportance; tone: string; active: string }[] = [
  { key: "high", tone: "text-danger", active: "border-danger/40 bg-danger/10 text-danger" },
  { key: "medium", tone: "text-amber-600", active: "border-amber-500/40 bg-amber-500/10 text-amber-700" },
  { key: "low", tone: "text-sky-600", active: "border-sky-500/40 bg-sky-500/10 text-sky-700" },
];

function ImportancePicker({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const current = item.importance ?? null;

  const set = async (next: ItemImportance) => {
    try {
      // Clicking the active level clears it.
      onChange(await updateItem({ id: item.id, importance: next === current ? "" : next }));
    } catch (e) {
      console.error("[activity-panel] importance change failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  return (
    <div role="radiogroup" aria-label={t("activityPanel.props.importance")} className="-ml-2 flex gap-1">
      {IMPORTANCE_CHOICES.map((c) => {
        const active = current === c.key;
        return (
          <Tooltip key={c.key} label={t(`activityPanel.importance.${c.key}`)}>
            <button
              type="button"
              role="radio"
              aria-label={t(`activityPanel.importance.${c.key}`)}
              aria-checked={active}
              onClick={() => void set(c.key)}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border text-xs transition-colors ${
                active ? `${c.active} font-medium` : "border-transparent text-faint hover:bg-surface hover:text-fg"
              }`}
            >
              <Flag size={14} strokeWidth={2.25} className={active ? "" : c.tone} fill={active ? "currentColor" : "none"} aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ProjectPicker({
  item,
  projects,
  onProjectsChange,
  onChange,
}: {
  item: Item;
  projects: Project[];
  onProjectsChange: (next: Project[]) => void;
  onChange: (i: Item) => void;
}) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const value = item.project_id ?? "";
  const current = projects.find((p) => p.id === value) ?? null;

  const onSelect = async (next: string) => {
    if (next === "__new__") {
      setCreating(true);
      return;
    }
    try {
      onChange(await updateItem({ id: item.id, project_id: next === "" ? null : next }));
    } catch (e) {
      console.error("[activity-panel] project change failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  const onCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const proj = await createProject(trimmed);
      onProjectsChange([...projects, proj]);
      onChange(await updateItem({ id: item.id, project_id: proj.id }));
      setCreating(false);
      setNewName("");
    } catch (e) {
      console.error("[activity-panel] create project failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  if (creating) {
    return (
      <div className="flex w-full gap-1.5">
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCreate();
            if (e.key === "Escape") {
              e.stopPropagation();
              setCreating(false);
            }
          }}
          placeholder={t("activityPanel.project.namePlaceholder")}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void onCreate()}
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
        >
          {t("activityPanel.project.create")}
        </button>
        <button
          type="button"
          onClick={() => setCreating(false)}
          className="rounded-md px-2 py-1 text-xs text-muted hover:bg-elevated"
        >
          {t("activityPanel.project.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="relative -ml-2 flex w-full items-center rounded-md px-2 transition-colors hover:bg-surface">
      {current ? (
        <span
          className="mr-2 h-2 w-2 shrink-0 rounded-[3px]"
          style={{ background: current.color ?? "var(--color-accent)" }}
          aria-hidden="true"
        />
      ) : null}
      <select
        value={value}
        onChange={(e) => void onSelect(e.target.value)}
        aria-label={t("activityPanel.project.label")}
        className={`min-h-[30px] w-full cursor-pointer appearance-none bg-transparent pr-5 text-[13px] focus:outline-none ${
          current ? "text-fg" : "text-faint"
        }`}
      >
        <option value="">{t("activityPanel.props.noProject")}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji ? `${p.emoji} ${p.name}` : p.name}
          </option>
        ))}
        <option value="__new__">{t("activityPanel.project.newProject")}</option>
      </select>
      <ChevronDown size={12} strokeWidth={2.25} className="pointer-events-none absolute right-2 text-faint" aria-hidden="true" />
    </div>
  );
}

function TagEditor({
  item,
  tags,
  onTagsChange,
  onSaved,
}: {
  item: Item;
  tags: string[];
  onTagsChange: (next: string[]) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [draft, setDraft] = useState("");

  const commit = async (next: string[]) => {
    try {
      await updateItem({ id: item.id, tags: next });
      onTagsChange(next);
      onSaved();
    } catch (e) {
      console.error("[activity-panel] tag save failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  const addTag = async () => {
    const tag = draft.trim().replace(/^#/, "");
    setDraft("");
    if (!tag || tags.includes(tag)) return;
    await commit([...tags, tag]);
  };

  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2 pr-1 text-xs text-muted"
        >
          #{tag}
          <button
            type="button"
            onClick={() => void commit(tags.filter((x) => x !== tag))}
            className="rounded-full p-0.5 text-faint hover:text-danger"
            aria-label={t("activityPanel.tags.removeAriaLabel", { tag })}
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void addTag();
          }
        }}
        onBlur={() => {
          if (draft.trim()) void addTag();
        }}
        placeholder={t("activityPanel.props.addTag")}
        aria-label={t("activityPanel.props.addTag")}
        className="-ml-2 min-h-[30px] min-w-[90px] flex-1 rounded-md bg-transparent px-2 text-[13px] text-fg placeholder:text-faint hover:bg-surface focus:bg-surface focus:outline-none"
      />
    </>
  );
}

/** Days from local today to a YYYY-MM-DD date (negative = past). */
function daysFromToday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function DueDate({
  itemId,
  deadline,
  completed,
  onChange,
}: {
  itemId: string;
  deadline: string | null;
  completed: boolean;
  onChange: (deadline: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const [picking, setPicking] = useState(false);
  // Stored as ISO; bind only the YYYY-MM-DD prefix so timezones never shift the day.
  const ymd = deadline ? deadline.slice(0, 10) : "";

  const save = async (v: string) => {
    setPicking(false);
    const iso = v ? `${v}T00:00:00Z` : null;
    try {
      await setTaskDeadline(itemId, iso);
      onChange(iso);
    } catch (e) {
      console.error("[activity-panel] deadline save failed", e);
      toasts.push({ tone: "error", message: t("activityPanel.header.saveFailed") });
    }
  };

  if (picking) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={ymd}
        onChange={(e) => {
          if (e.target.value) void save(e.target.value);
        }}
        onBlur={() => setPicking(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setPicking(false);
          }
        }}
        className="rounded-md border border-accent bg-surface px-2 py-1 text-xs text-fg focus:outline-none"
      />
    );
  }

  if (!ymd) {
    return (
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="-ml-2 min-h-[30px] rounded-md px-2 text-left text-[13px] text-faint hover:bg-surface hover:text-fg"
      >
        {t("activityPanel.props.setDue")}
      </button>
    );
  }

  const diff = daysFromToday(ymd);
  const [y, m, d] = ymd.split("-").map(Number);
  const dateLabel = new Date(y, m - 1, d).toLocaleDateString(i18n.language, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const relative =
    diff < 0 ? t("activityPanel.props.overdue")
    : diff === 0 ? t("activityPanel.props.today")
    : diff === 1 ? t("activityPanel.props.tomorrow")
    : null;
  const tone = completed ? "text-muted" : diff < 0 ? "text-danger" : diff === 0 ? "text-warning" : "text-fg";

  return (
    <div className="group -ml-2 flex items-center">
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="min-h-[30px] rounded-md px-2 text-left text-[13px] hover:bg-surface"
      >
        {relative ? <span className={`font-medium ${tone}`}>{relative}</span> : null}
        <span className={relative ? "ml-1.5 text-faint" : tone}>
          {relative ? `· ${dateLabel}` : dateLabel}
        </span>
      </button>
      <Tooltip label={t("activityPanel.props.clearDue")}>
        <button
          type="button"
          onClick={() => void save("")}
          aria-label={t("activityPanel.props.clearDue")}
          className="rounded p-1 text-faint opacity-0 transition-opacity hover:text-danger focus:opacity-100 group-hover:opacity-100"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </Tooltip>
    </div>
  );
}

// ─── Capture context ───────────────────────────────────────────────────────

const AVATAR_COLORS = ["#c96442", "#2f6f9f", "#6a4bb3", "#b0417a", "#8a6d1c", "#3b7d4f", "#5b6b7a"];

function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function humanSource(s: Item["source"], t: TFunction): string {
  switch (s) {
    case "voice_at_cursor": return t("activityPanel.source.voiceAtCursor");
    case "log_capture": return t("activityPanel.source.logCapture");
    case "meeting": return t("activityPanel.source.meeting");
  }
}

function CapturedFrom({ item }: { item: Item }) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const ctx = useMemo(() => parseCaptureContext(item.capture_context), [item.capture_context]);
  const byAssistant = item.classified_by === "project_agent";
  const appName = ctx?.app_name?.trim() || null;

  const title = appName ?? (byAssistant ? t("activityPanel.captured.projectAssistant") : humanSource(item.source, t));
  const window = ctx?.window_title && ctx.window_title !== appName ? ctx.window_title : null;
  const contentTitle = ctx?.content_title && ctx.content_title !== ctx?.window_title ? ctx.content_title : null;
  const subtitle = [window, contentTitle, humanSource(item.source, t)].filter(Boolean).join(" · ");
  const avatar = appName ? appName.charAt(0).toUpperCase() : "T";
  const avatarBg = appName ? avatarColor(appName) : "var(--color-accent)";

  const pct = item.confidence != null ? Math.round(item.confidence * 100) : null;
  const sortedNote = byAssistant
    ? t("activityPanel.captured.filedByAssistant")
    : item.classified_by === "ai" && pct != null
      ? t("activityPanel.captured.sortedByAi", { pct })
      : null;

  const details: { label: string; value: string | null | undefined }[] = [
    { label: t("activityPanel.metadata.source"), value: humanSource(item.source, t) },
    { label: t("activityPanel.metadata.app"), value: ctx?.app_name },
    { label: t("activityPanel.metadata.window"), value: ctx?.window_title },
    { label: t("activityPanel.metadata.content"), value: ctx?.content_title },
    { label: t("activityPanel.metadata.contentUrl"), value: ctx?.content_url },
    { label: t("activityPanel.metadata.contentSource"), value: ctx?.content_source },
    { label: t("activityPanel.metadata.browserTab"), value: ctx?.browser_tab_title },
    { label: t("activityPanel.metadata.url"), value: ctx?.browser_url },
    { label: t("activityPanel.metadata.bundleId"), value: ctx?.bundle_id },
    { label: t("activityPanel.metadata.confidence"), value: pct != null ? `${pct}%` : null },
    { label: t("activityPanel.metadata.classifiedBy"), value: item.classified_by },
  ];
  const contextLabels: Record<string, string> = {
    heading: "Heading", selected_item: "Selected item", document: "Document",
    workspace: "Workspace", conversation: "Conversation", project: "External project",
    subject: "Email subject", recipient: "Recipient", sender: "Sender", mail_header: "Email header",
  };
  for (const signal of ctx?.signals ?? []) {
    if (contextLabels[signal.kind] && typeof signal.value === "string") {
      details.push({ label: t(`activityPanel.metadata.context.${signal.kind}`, { defaultValue: contextLabels[signal.kind] }), value: signal.value });
    }
  }
  const visible = details.filter((r) => r.value);

  return (
    <section className="mt-6">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
        {t("activityPanel.captured.label")}
      </h3>
      <div className="rounded-xl border border-line bg-surface">
        <button
          type="button"
          onClick={() => setShowDetails((s) => !s)}
          aria-expanded={showDetails}
          aria-label={`${title}, ${t("activityPanel.captured.details")}`}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold text-white"
            style={{ background: avatarBg }}
            aria-hidden="true"
          >
            {avatar}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-fg">{title}</div>
            <div className="truncate text-xs text-faint">{subtitle}</div>
          </div>
          {visible.length > 0 ? (
            showDetails ? <ChevronDown size={12} strokeWidth={2.5} className="shrink-0 text-faint" aria-hidden="true" /> : <ChevronRight size={12} strokeWidth={2.5} className="shrink-0 text-faint" aria-hidden="true" />
          ) : null}
        </button>
        {showDetails ? (
          <dl className="space-y-1 border-t border-line px-3 py-2.5 text-[11px]">
            {visible.map((r, index) => (
              <div key={`${r.label}-${index}`} className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">{r.label}</dt>
                <dd className="min-w-0 flex-1 break-words text-muted">{r.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      {sortedNote ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-faint">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          {sortedNote}
        </div>
      ) : null}
    </section>
  );
}

function HistoryDisclosure({ itemId, projects }: { itemId: string; projects: Project[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-6 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] text-muted hover:text-fg"
      >
        {open ? <ChevronDown size={13} strokeWidth={2.5} /> : <ChevronRight size={13} strokeWidth={2.5} />}
        {t("activityPanel.history.label")}
      </button>
      {open ? (
        <div className="mt-2">
          <ItemDetailPanel itemId={itemId} framed={false} projects={projects} />
        </div>
      ) : null}
    </section>
  );
}
