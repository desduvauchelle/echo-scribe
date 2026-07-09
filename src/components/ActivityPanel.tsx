import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, Loader, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import Markdown from "./Markdown";
import {
  completeTask,
  createProject,
  deleteItem,
  deleteMeeting,
  getItem,
  getMeeting,
  listProjects,
  listTagsForItem,
  listTasks,
  matchMeetingCalendar,
  parseCalendarMatch,
  parseCaptureContext,
  renameMeeting,
  restoreItem,
  retryMeetingSummary,
  setMeetingCalendarMatch,
  setTaskDeadline,
  uncompleteTask,
  updateItem,
  updateMeetingNotes,
  type CalendarMatch,
  type Item,
  type ItemKind,
  type MeetingRow,
  type Project,
  type StoredSummary,
  type StoredTranscript,
} from "../lib/api";
import { ask } from "@tauri-apps/plugin-dialog";
import { relativeTime } from "../lib/format";
import { useActivityPanel } from "./ActivityPanelContext";
import { useToasts } from "./ToastProvider";
import ItemDetailPanel from "./ItemDetailPanel";
import { meetingStatusDisplay } from "../lib/meetingStatus";

export default function ActivityPanel() {
  const { selectedItemId, close } = useActivityPanel();
  const open = selectedItemId !== null;

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
        className={`fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-[90vw] flex-col border-l border-line bg-canvas shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
      >
        {open && selectedItemId ? (
          <PanelBody itemId={selectedItemId} onClose={close} />
        ) : null}
      </aside>
    </>
  );
}

function PanelBody({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { bumpRefresh } = useActivityPanel();
  const toasts = useToasts();
  const [item, setItem] = useState<Item | null>(null);
  const [meeting, setMeeting] = useState<MeetingRow | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const it = await getItem(itemId);
    if (!it) {
      setError("Item not found.");
      return;
    }
    setItem(it);
    const tlist = await listTagsForItem(itemId).catch(() => [] as string[]);
    setTags(tlist);
    if (it.source === "meeting") {
      const m = await getMeeting(itemId).catch(() => null);
      setMeeting(m);
    } else {
      setMeeting(null);
    }
    if (it.kind === "task") {
      // listTasks is the only API surface that exposes deadline/completed_at.
      const tasks = await listTasks({ include_completed: true }).catch(() => []);
      const row = tasks.find((t) => t.item.id === itemId);
      setDeadline(row?.deadline ?? null);
      setCompletedAt(row?.completed_at ?? null);
    } else {
      setDeadline(null);
      setCompletedAt(null);
    }
  }, [itemId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItem(null);
    setMeeting(null);
    setTags([]);
    setDeadline(null);
    setCompletedAt(null);
    (async () => {
      try {
        const [_, projs] = await Promise.all([
          reload(),
          listProjects(false).catch(() => [] as Project[]),
        ]);
        if (cancelled) return;
        setProjects(projs);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [itemId, reload]);

  const onItemChange = (next: Item) => {
    setItem(next);
    bumpRefresh();
  };

  const onSavedSideEffect = () => bumpRefresh();

  const onDelete = async () => {
    if (!item) return;
    const confirmed = await ask(
      "Delete this item? You can restore it from the trash.",
      { title: "Delete item", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      if (meeting) {
        await deleteMeeting(item.id);
      } else {
        await deleteItem(item.id);
      }
      bumpRefresh();
      onClose();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const onRestore = async () => {
    if (!item) return;
    await restoreItem(item.id);
    await reload();
    bumpRefresh();
  };

  return (
    <>
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="min-w-0 text-sm font-medium text-fg">
          {loading ? "Loading…" : item ? activityTitle(item, meeting) : "Activity"}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-fg">
        {loading ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : error ? (
          <div className="text-xs text-red-400">{error}</div>
        ) : item ? (
          <div className="space-y-5">
            {meeting ? (
              <MeetingView
                item={item}
                meeting={meeting}
                projects={projects}
                tags={tags}
                onProjectsChange={setProjects}
                onItemChange={onItemChange}
                onTagsChange={setTags}
                onSaved={onSavedSideEffect}
                onMeetingChange={(m) => {
                  setMeeting(m);
                  bumpRefresh();
                }}
              />
            ) : (
              <>
                <HeaderSection item={item} meeting={meeting} />
                <ContentSection item={item} onChange={onItemChange} />
                <KindSection item={item} onChange={onItemChange} />
                <ProjectSection
                  item={item}
                  projects={projects}
                  onProjectsChange={setProjects}
                  onChange={onItemChange}
                />
                <TagsSection
                  item={item}
                  tags={tags}
                  onTagsChange={setTags}
                  onSaved={onSavedSideEffect}
                />
                <MetadataSection item={item} />
                {item.kind === "task" ? (
                  <TaskSection
                    itemId={item.id}
                    deadline={deadline}
                    completedAt={completedAt}
                    onChange={(d, c) => {
                      setDeadline(d);
                      setCompletedAt(c);
                      bumpRefresh();
                    }}
                  />
                ) : null}
              </>
            )}
            <ItemDetailPanel itemId={item.id} />
            <ActionsSection
              item={item}
              onDelete={onDelete}
              onRestore={onRestore}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

function activityTitle(item: Item, meeting: MeetingRow | null): string {
  if (meeting) {
    const summary = meeting.summary_json ? safeParseSummary(meeting.summary_json) : null;
    if (summary?.suggested_title) return truncate(summary.suggested_title, 60);
  }
  const firstLine = item.content.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    if (item.kind === "task") return "Task";
    if (meeting) return "Meeting";
    if (item.source === "voice_at_cursor" || item.kind === "transcription")
      return "Transcription";
    return "Note";
  }
  return truncate(firstLine, 60);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeParseSummary(json: string): StoredSummary | null {
  try { return JSON.parse(json) as StoredSummary; } catch { return null; }
}

function safeParseTranscript(json: string): StoredTranscript | null {
  try { return JSON.parse(json) as StoredTranscript; } catch { return null; }
}

// ─── Sections ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
      {children}
    </div>
  );
}

function HeaderSection({ item, meeting }: { item: Item; meeting: MeetingRow | null }) {
  const badges: string[] = [];
  if (meeting) badges.push("Meeting");
  else if (item.source === "voice_at_cursor" || item.kind === "transcription")
    badges.push("Transcription");
  else if (item.source === "log_capture") badges.push("Log capture");
  if (item.kind === "task") badges.push("Task");
  if (item.deleted_at) badges.push("Deleted");

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
      {badges.map((b) => (
        <span
          key={b}
          className="rounded-full bg-elevated px-2 py-0.5 text-fg"
        >
          {b}
        </span>
      ))}
      <span>{relativeTime(item.captured_at)}</span>
    </div>
  );
}

function EditToggle({ editing, onClick }: { editing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-faint hover:bg-elevated hover:text-fg"
    >
      {editing ? (
        <>
          <Eye size={11} strokeWidth={2.25} /> Done
        </>
      ) : (
        <>
          <Pencil size={11} strokeWidth={2.25} /> Edit
        </>
      )}
    </button>
  );
}

function ContentSection({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const [draft, setDraft] = useState(item.content);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(item.content);
  }, [item.id, item.content]);

  // Debounced auto-save on edit.
  useEffect(() => {
    if (draft === item.content) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await updateItem({ id: item.id, content: draft });
        onChange(updated);
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft, item.content, item.id, onChange]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <SectionLabel>Content</SectionLabel>
        <div className="flex items-center gap-2">
          {editing ? (
            <span className="text-[10px] text-faint">
              {saving ? "Saving…" : draft !== item.content ? "Unsaved" : "Saved"}
            </span>
          ) : null}
          <EditToggle editing={editing} onClick={() => setEditing((e) => !e)} />
        </div>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={8}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[12.5px] text-fg transition-colors focus:border-accent focus:outline-none"
        />
      ) : draft.trim() ? (
        <Markdown>{draft}</Markdown>
      ) : (
        <div className="text-[12px] italic text-faint">No content.</div>
      )}
    </div>
  );
}

function KindSection({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const set = async (k: "" | ItemKind) => {
    const updated = await updateItem({ id: item.id, kind: k });
    onChange(updated);
  };
  return (
    <div>
      <SectionLabel>Kind</SectionLabel>
      <div className="flex gap-1">
        {(["transcription", "note", "task", ""] as const).map((k) => (
          <button
            key={k || "unset"}
            type="button"
            onClick={() => void set(k)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              (item.kind ?? "") === k
                ? "border-accent bg-accent text-canvas"
                : "border-line text-muted hover:bg-elevated hover:text-fg"
            }`}
          >
            {k === ""
              ? "Unset"
              : k === "task"
                ? "Task"
                : k === "transcription"
                  ? "Transcription"
                  : "Note"}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectSection({
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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const value = item.project_id ?? "";

  const onSelect = async (next: string) => {
    if (next === "__new__") {
      setCreating(true);
      return;
    }
    const updated = await updateItem({
      id: item.id,
      project_id: next === "" ? null : next,
    });
    onChange(updated);
  };

  const onCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const proj = await createProject(trimmed);
    onProjectsChange([...projects, proj]);
    const updated = await updateItem({ id: item.id, project_id: proj.id });
    onChange(updated);
    setCreating(false);
    setNewName("");
  };

  return (
    <div>
      <SectionLabel>Project</SectionLabel>
      {!creating ? (
        <select
          value={value}
          onChange={(e) => void onSelect(e.target.value)}
          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
        >
          <option value="">— Unassigned —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__new__">+ New project…</option>
        </select>
      ) : (
        <div className="flex gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Project name"
            className="flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void onCreate()}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => setCreating(false)}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-elevated"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function TagsSection({
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
  const [draft, setDraft] = useState("");

  const commit = async (next: string[]) => {
    await updateItem({ id: item.id, tags: next });
    onTagsChange(next);
    onSaved();
  };

  const addTag = async () => {
    const t = draft.trim().replace(/^#/, "");
    if (!t || tags.includes(t)) {
      setDraft("");
      return;
    }
    await commit([...tags, t]);
    setDraft("");
  };

  const removeTag = async (t: string) => {
    await commit(tags.filter((x) => x !== t));
  };

  return (
    <div>
      <SectionLabel>Tags</SectionLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-muted"
          >
            #{t}
            <button
              type="button"
              onClick={() => void removeTag(t)}
              className="text-faint hover:text-danger"
              aria-label={`Remove ${t}`}
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
          placeholder="add tag…"
          className="min-w-[80px] rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-fg focus:border-accent focus:outline-none"
        />
      </div>
    </div>
  );
}

function MetadataSection({ item }: { item: Item }) {
  const ctx = useMemo(
    () => parseCaptureContext(item.capture_context),
    [item.capture_context],
  );
  const rows: { label: string; value: string | null | undefined }[] = [
    { label: "Source", value: humanSource(item.source) },
    { label: "App", value: ctx?.app_name },
    { label: "Window", value: ctx?.window_title },
    { label: "Content", value: ctx?.content_title },
    { label: "Content URL", value: ctx?.content_url },
    { label: "Content source", value: ctx?.content_source },
    { label: "Browser tab", value: ctx?.browser_tab_title },
    { label: "URL", value: ctx?.browser_url },
    { label: "Bundle ID", value: ctx?.bundle_id },
    { label: "Confidence", value: item.confidence != null ? `${Math.round(item.confidence * 100)}%` : null },
    { label: "Classified by", value: item.classified_by },
  ];
  const visible = rows.filter((r) => r.value);
  if (visible.length === 0) {
    return (
      <div>
        <SectionLabel>Metadata</SectionLabel>
        <div className="text-[11px] text-muted">No metadata captured.</div>
      </div>
    );
  }
  return (
    <div>
      <SectionLabel>Metadata</SectionLabel>
      <dl className="space-y-1 text-[11px]">
        {visible.map((r) => (
          <div key={r.label} className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">{r.label}</dt>
            <dd className="min-w-0 flex-1 break-words text-muted">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function humanSource(s: Item["source"]): string {
  switch (s) {
    case "voice_at_cursor": return "Voice (hotkey paste)";
    case "log_capture": return "Log capture";
    case "meeting": return "Meeting";
  }
}

function TaskSection({
  itemId,
  deadline,
  completedAt,
  onChange,
}: {
  itemId: string;
  deadline: string | null;
  completedAt: string | null;
  onChange: (deadline: string | null, completedAt: string | null) => void;
}) {
  // deadline stored as ISO string. Use a date-only <input type="date"> bound to
  // the YYYY-MM-DD prefix so timezones don't shift the displayed day.
  const dateValue = deadline ? deadline.slice(0, 10) : "";

  const onCheck = async () => {
    if (completedAt) {
      await uncompleteTask(itemId);
      onChange(deadline, null);
    } else {
      await completeTask(itemId);
      onChange(deadline, new Date().toISOString());
    }
  };

  const onDateChange = async (v: string) => {
    const iso = v ? `${v}T00:00:00Z` : null;
    await setTaskDeadline(itemId, iso);
    onChange(iso, completedAt);
  };

  return (
    <div>
      <SectionLabel>Task</SectionLabel>
      <div className="space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!completedAt}
            onChange={() => void onCheck()}
          />
          <span className="text-muted">{completedAt ? "Completed" : "Mark complete"}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-20 text-faint">Deadline</span>
          <input
            type="date"
            value={dateValue}
            onChange={(e) => void onDateChange(e.target.value)}
            className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
          />
          {dateValue ? (
            <button
              type="button"
              onClick={() => void onDateChange("")}
              className="text-faint hover:text-danger"
            >
              Clear
            </button>
          ) : null}
        </label>
      </div>
    </div>
  );
}

function MeetingView({
  item,
  meeting,
  projects,
  tags,
  onProjectsChange,
  onItemChange,
  onTagsChange,
  onSaved,
  onMeetingChange,
}: {
  item: Item;
  meeting: MeetingRow;
  projects: Project[];
  tags: string[];
  onProjectsChange: (next: Project[]) => void;
  onItemChange: (i: Item) => void;
  onTagsChange: (next: string[]) => void;
  onSaved: () => void;
  onMeetingChange: (m: MeetingRow) => void;
}) {
  const summary = meeting.summary_json ? safeParseSummary(meeting.summary_json) : null;
  const transcript = meeting.transcript_json ? safeParseTranscript(meeting.transcript_json) : null;
  const durationMin = meeting.duration_ms
    ? Math.round(meeting.duration_ms / 60000)
    : null;
  const projectName = projects.find((p) => p.id === item.project_id)?.name ?? null;

  const statusDisplay = meetingStatusDisplay(meeting.status);

  return (
    <div className="space-y-5">
      <MeetingTitle meeting={meeting} summary={summary} onMeetingChange={onMeetingChange} />

      {meeting.status !== "complete" ? (
        <div
          className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-[12px] ${
            statusDisplay.tone === "danger"
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-accent/30 bg-accent-soft text-accent"
          }`}
          role="status"
        >
          {statusDisplay.spinner ? (
            <Loader size={14} className="mt-0.5 shrink-0 animate-spin" />
          ) : null}
          <div className="min-w-0">
            <div className="font-medium">{statusDisplay.label}</div>
            <div className="text-[11px] opacity-80">{statusDisplay.description}</div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span className="rounded-full bg-elevated px-2 py-0.5 text-fg">Meeting</span>
        {projectName ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
            {projectName}
          </span>
        ) : null}
        {meeting.detected_app_name ? <span>{meeting.detected_app_name}</span> : null}
        <span>{relativeTime(item.captured_at)}</span>
        {durationMin != null ? <span>· {durationMin} min</span> : null}
      </div>

      <ProjectSection
        item={item}
        projects={projects}
        onProjectsChange={onProjectsChange}
        onChange={onItemChange}
      />

      <MeetingRecap item={item} summary={summary} onItemChange={onItemChange} />

      {summary && summary.action_items.length > 0 ? (
        <div>
          <SectionLabel>Action items</SectionLabel>
          <ul className="space-y-1.5 text-[12px] text-fg">
            {summary.action_items.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-muted">
                  {a.owner}
                </span>
                <span className="leading-relaxed">{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <NotesSection meeting={meeting} onMeetingChange={onMeetingChange} />

      <CalendarMatchPanel meeting={meeting} onChange={onMeetingChange} />

      <TagsSection
        item={item}
        tags={tags}
        onTagsChange={onTagsChange}
        onSaved={onSaved}
      />

      <div>
        <SectionLabel>Meeting metadata</SectionLabel>
        <dl className="space-y-1 text-[11px]">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">Status</dt>
            <dd className="text-muted">{statusDisplay.label || "Complete"}</dd>
          </div>
          {meeting.detected_app_name ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-faint">Detected app</dt>
              <dd className="text-muted">{meeting.detected_app_name}</dd>
            </div>
          ) : null}
          {durationMin != null ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-faint">Duration</dt>
              <dd className="text-muted">{durationMin} min</dd>
            </div>
          ) : null}
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-faint">Audio source</dt>
            <dd className="text-muted">{meeting.mic_only ? "Mic only" : "Mic + system"}</dd>
          </div>
          {meeting.failed_chunk_count > 0 ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-faint">Failed chunks</dt>
              <dd className="text-warning">{meeting.failed_chunk_count}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      {transcript && transcript.segments.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">
            Transcript ({transcript.segments.length} segments)
          </summary>
          <div className="mt-2 max-h-60 space-y-1 overflow-y-auto rounded border border-line bg-surface p-2 text-[11px]">
            {transcript.segments.map((s, i) => (
              <div key={i}>
                <span className={s.speaker === "you" ? "text-accent" : "text-muted"}>
                  {s.speaker}:
                </span>{" "}
                <span className="text-fg/90">{s.text}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MeetingTitle({
  meeting,
  summary,
  onMeetingChange,
}: {
  meeting: MeetingRow;
  summary: StoredSummary | null;
  onMeetingChange: (m: MeetingRow) => void;
}) {
  const current = summary?.suggested_title ?? "";
  const [titleDraft, setTitleDraft] = useState(current);
  const [editing, setEditing] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTitleDraft(current);
  }, [meeting.item_id, current]);

  // Debounced title save.
  useEffect(() => {
    if (titleDraft === current) return;
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(async () => {
      setSavingTitle(true);
      try {
        await renameMeeting(meeting.item_id, titleDraft);
        // Pull fresh meeting row so summary_json reflects new title.
        const m = await getMeeting(meeting.item_id);
        if (m) onMeetingChange(m);
      } finally {
        setSavingTitle(false);
      }
    }, 600);
    return () => {
      if (titleTimer.current) clearTimeout(titleTimer.current);
    };
  }, [titleDraft, current, meeting.item_id, onMeetingChange]);

  return (
    <div>
      {editing ? (
        <>
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel>Meeting title</SectionLabel>
            <div className="flex items-center gap-2">
              {savingTitle ? <span className="text-[10px] text-faint">Saving…</span> : null}
              <EditToggle editing onClick={() => setEditing(false)} />
            </div>
          </div>
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Untitled meeting"
            className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-base font-semibold text-fg focus:border-accent focus:outline-none"
          />
        </>
      ) : (
        <div className="group flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold leading-snug text-fg">
            {titleDraft.trim() || "Untitled meeting"}
          </h2>
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit title"
            className="mt-1 shrink-0 rounded p-1 text-faint opacity-0 transition hover:bg-elevated hover:text-fg group-hover:opacity-100"
          >
            <Pencil size={13} strokeWidth={2.25} />
          </button>
        </div>
      )}
    </div>
  );
}

function MeetingRecap({
  item,
  summary,
  onItemChange,
}: {
  item: Item;
  summary: StoredSummary | null;
  onItemChange: (i: Item) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(item.content);
  }, [item.id, item.content]);

  useEffect(() => {
    if (draft === item.content) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await updateItem({ id: item.id, content: draft });
        onItemChange(updated);
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft, item.content, item.id, onItemChange]);

  const bullets = summary?.summary ?? [];

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <SectionLabel>Summary</SectionLabel>
        <div className="flex items-center gap-2">
          {editing ? (
            <span className="text-[10px] text-faint">
              {saving ? "Saving…" : draft !== item.content ? "Unsaved" : "Saved"}
            </span>
          ) : null}
          <EditToggle editing={editing} onClick={() => setEditing((e) => !e)} />
        </div>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[12.5px] text-fg transition-colors focus:border-accent focus:outline-none"
        />
      ) : bullets.length > 0 ? (
        <ul className="space-y-1.5 text-[13px] text-fg">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-2 leading-relaxed">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : item.content.trim() ? (
        <Markdown>{item.content}</Markdown>
      ) : (
        <div className="text-[12px] italic text-faint">No summary yet.</div>
      )}
    </div>
  );
}

function NotesSection({
  meeting,
  onMeetingChange,
}: {
  meeting: MeetingRow;
  onMeetingChange: (m: MeetingRow) => void;
}) {
  const current = meeting.user_notes ?? "";
  const [editing, setEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNotesDraft(current);
  }, [meeting.item_id, current]);

  useEffect(() => {
    if (notesDraft === current) return;
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await updateMeetingNotes(meeting.item_id, notesDraft);
        onMeetingChange({ ...meeting, user_notes: notesDraft });
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => {
      if (notesTimer.current) clearTimeout(notesTimer.current);
    };
  }, [notesDraft, current, meeting, onMeetingChange]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <SectionLabel>Notes</SectionLabel>
        <div className="flex items-center gap-2">
          {editing ? (
            <span className="text-[10px] text-faint">
              {saving ? "Saving…" : notesDraft !== current ? "Unsaved" : "Saved"}
            </span>
          ) : null}
          <EditToggle editing={editing} onClick={() => setEditing((e) => !e)} />
        </div>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          rows={4}
          placeholder="Add personal notes…"
          className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-[12.5px] text-fg focus:border-accent focus:outline-none"
        />
      ) : notesDraft.trim() ? (
        <Markdown>{notesDraft}</Markdown>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[12px] italic text-faint hover:text-muted"
        >
          Add personal notes…
        </button>
      )}
    </div>
  );
}

function CalendarMatchPanel({
  meeting,
  onChange,
}: {
  meeting: MeetingRow;
  onChange: (m: MeetingRow) => void;
}) {
  const match = useMemo(() => parseCalendarMatch(meeting), [meeting]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<CalendarMatch[] | null>(null);

  if (!match) return null;

  const confidenceTone =
    match.match_score >= 0.6 ? "text-fg" : "text-muted italic";

  const refetchCandidates = async () => {
    if (!meeting.ended_at) return;
    setBusy(true);
    try {
      const out = await matchMeetingCalendar(
        meeting.started_at,
        meeting.ended_at,
        null,
      );
      setCandidates(out ? [out.best, ...out.candidates] : []);
    } catch {
      setCandidates([]);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (next: CalendarMatch | null) => {
    setBusy(true);
    try {
      await setMeetingCalendarMatch(meeting.item_id, next);
      // Re-run synthesis so summary picks up the new (or cleared) context.
      await retryMeetingSummary(meeting.item_id).catch(() => {});
      const refreshed = await getMeeting(meeting.item_id);
      if (refreshed) onChange(refreshed);
      setExpanded(false);
      setCandidates(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface p-2">
      <div className="mb-1 flex items-center justify-between">
        <SectionLabel>Calendar match</SectionLabel>
        <button
          type="button"
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            if (next && candidates === null) void refetchCandidates();
          }}
          className="text-[10px] text-faint hover:text-muted"
        >
          {expanded ? "Close" : "Wrong match?"}
        </button>
      </div>
      <div className={`text-[11px] ${confidenceTone}`}>
        {match.title ?? "Untitled event"}
        <span className="ml-2 text-[10px] text-faint">
          ({Math.round(match.match_score * 100)}% · {match.match_reason})
        </span>
      </div>
      {match.organizer ? (
        <div className="mt-1 text-[10px] text-muted">
          Organizer: {renderAttendeeLine(match.organizer)}
        </div>
      ) : null}
      {match.attendees.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {match.attendees.slice(0, 8).map((a, i) => (
            <span
              key={`${a.email ?? a.name ?? "x"}-${i}`}
              className="rounded-full bg-elevated px-2 py-0.5 text-[10px] text-fg"
              title={a.email ?? ""}
            >
              {renderAttendeeLine(a)}
            </span>
          ))}
          {match.attendees.length > 8 ? (
            <span className="text-[10px] text-faint">
              +{match.attendees.length - 8} more
            </span>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-2 space-y-1 border-t border-line pt-2 text-[11px]">
          {busy ? (
            <div className="text-muted">Loading…</div>
          ) : null}
          {candidates && candidates.length === 0 ? (
            <div className="text-muted">No alternative events found.</div>
          ) : null}
          {candidates?.map((c, i) => (
            <button
              key={`${c.starts_at}-${i}`}
              type="button"
              onClick={() => void apply(c)}
              disabled={busy}
              className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-left text-fg hover:bg-elevated disabled:opacity-50"
            >
              {c.title ?? "Untitled event"}{" "}
              <span className="text-[10px] text-faint">
                ({Math.round(c.match_score * 100)}%)
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => void apply(null)}
            disabled={busy}
            className="w-full rounded border border-warning/40 bg-warning/10 px-2 py-1 text-left text-warning hover:bg-warning/20 disabled:opacity-50"
          >
            Clear match (no calendar event)
          </button>
        </div>
      ) : null}
    </div>
  );
}

function renderAttendeeLine(a: import("../lib/api").CalendarAttendee): string {
  const name = a.name && a.name.trim() ? a.name : null;
  const email = a.email && a.email.trim() ? a.email : null;
  const base = name && email ? `${name} <${email}>` : name ?? email ?? "?";
  return a.self ? `${base} (you)` : base;
}

function ActionsSection({
  item,
  onDelete,
  onRestore,
}: {
  item: Item;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.content);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="flex flex-wrap gap-2 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-elevated hover:text-fg"
      >
        <Copy size={12} strokeWidth={2} />
        Copy content
      </button>
      {item.deleted_at ? (
        <button
          type="button"
          onClick={onRestore}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-elevated hover:text-fg"
        >
          <RotateCcw size={12} strokeWidth={2} />
          Restore
        </button>
      ) : (
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={12} strokeWidth={2} />
          Delete
        </button>
      )}
    </div>
  );
}
