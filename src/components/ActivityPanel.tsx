import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, Loader, MessageSquare, Pencil, Quote, RotateCcw, Send, Sparkles, Trash2, X } from "lucide-react";
import Markdown from "./Markdown";
import { useFocusTrap } from "./a11y/Dialog";
import {
  completeTask,
  createProject,
  createChatSessionScoped,
  chatWithMemory,
  deleteItem,
  deleteMeeting,
  getItem,
  getMeeting,
  getMeetingPreferences,
  generateMeetingArtifact,
  listGuideRuns,
  listMeetingParticipants,
  listMeetingArtifacts,
  listPeople,
  listRecipes,
  listSummaryTemplates,
  listProjects,
  listTagsForItem,
  listTasks,
  parseCaptureContext,
  regenerateGuideReview,
  renameMeeting,
  regenerateMeetingSummary,
  replaceMeetingSummaryPoint,
  restoreItem,
  restoreTranscriptBackup,
  rewriteMeetingText,
  runRecipe,
  saveRecipe,
  saveSummaryTemplate,
  setTaskDeadline,
  setMeetingSpeakerLabel,
  uncompleteTask,
  updateItem,
  updateMeetingNotes,
  updateMeetingTranscript,
  type GuideRun,
  type Item,
  type ItemKind,
  type MeetingRow,
  type MeetingParticipant,
  type MeetingArtifact,
  type Project,
  type Person,
  type Recipe,
  type Segment,
  type StoredSummary,
  type StoredTranscript,
  type SummaryTemplate,
} from "../lib/api";
import { ask } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { parseGuideReview, parseTimeline, verdictClass } from "../lib/guideReview";
import GuideTrendView from "./GuideTrendView";
import { relativeTime } from "../lib/format";
import { useActivityPanel } from "./ActivityPanelContext";
import { useToasts } from "./ToastProvider";
import ItemDetailPanel from "./ItemDetailPanel";
import { meetingStatusDisplay } from "../lib/meetingStatus";

export default function ActivityPanel() {
  const { selectedItemId, close } = useActivityPanel();
  const open = selectedItemId !== null;
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
        className={`fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-[90vw] flex-col border-l border-line bg-canvas shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-panel-title"
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
        <div id="activity-panel-title" className="min-w-0 text-sm font-medium text-fg">
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
            <span role="status" className="text-[10px] text-faint">
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

      <MeetingIntelligenceControls meeting={meeting} onMeetingChange={onMeetingChange} />

      <MeetingRecap
        item={item}
        summary={summary}
        onItemChange={onItemChange}
        onEvidenceClick={(index) => document.getElementById(`meeting-segment-${index}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
      />

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

      <GuideReviewSection meetingId={meeting.item_id} />

      <MeetingChatSection meetingId={meeting.item_id} />

      <MeetingWorkflowsSection meeting={meeting} summary={summary} onMeetingChange={onMeetingChange} />

      <NotesSection meeting={meeting} onMeetingChange={onMeetingChange} />

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

      {transcript && transcript.segments.length > 0 ? <TranscriptEditor meeting={meeting} transcript={transcript} onMeetingChange={onMeetingChange} /> : null}
    </div>
  );
}

function MeetingIntelligenceControls({
  meeting,
  onMeetingChange,
}: {
  meeting: MeetingRow;
  onMeetingChange: (meeting: MeetingRow) => void;
}) {
  const [templates, setTemplates] = useState<SummaryTemplate[]>([]);
  const [templateId, setTemplateId] = useState("builtin-general");
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [labels, setLabels] = useState({ you: "You", them: "Them" });
  const [regenerating, setRegenerating] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateInstructions, setTemplateInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      listSummaryTemplates(),
      getMeetingPreferences(meeting.item_id),
      listMeetingParticipants(meeting.item_id),
      listPeople(),
    ]).then(([available, preferences, meetingParticipants, knownPeople]) => {
      setTemplates(available);
      setTemplateId(preferences?.summary_template_id ?? "builtin-general");
      setParticipants(meetingParticipants);
      setPeople(knownPeople);
      const next = { you: "You", them: "Them" };
      for (const participant of meetingParticipants) {
        next[participant.speaker_key] = participant.display_name;
      }
      setLabels(next);
    }).catch((e) => setError(String(e)));
  }, [meeting.item_id]);

  const saveLabel = async (speaker: "you" | "them") => {
    if (!labels[speaker].trim()) return;
    try {
      const linkedPersonId = participants.find((participant) => participant.speaker_key === speaker)?.person_id ?? null;
      await setMeetingSpeakerLabel(meeting.item_id, speaker, labels[speaker].trim(), linkedPersonId);
      setParticipants(await listMeetingParticipants(meeting.item_id));
    } catch (e) {
      setError(String(e));
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      await regenerateMeetingSummary(meeting.item_id, templateId);
      const refreshed = await getMeeting(meeting.item_id);
      if (refreshed) onMeetingChange(refreshed);
    } catch (e) {
      setError(String(e));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <Sparkles size={13} className="text-accent" /> Meeting intelligence
      </div>
      <div className="space-y-2.5 text-[12px]">
        <label className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-faint">Summary format</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-fg">
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <button type="button" onClick={() => void regenerate()} disabled={regenerating} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-accent hover:bg-elevated disabled:opacity-50">
            {regenerating ? <Loader size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            Regenerate
          </button>
        </label>
        {creatingTemplate ? (
          <div className="space-y-2 rounded-md border border-line bg-canvas p-2">
            <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Template name" className="w-full rounded border border-line bg-surface px-2 py-1.5 text-fg" />
            <textarea value={templateInstructions} onChange={(e) => setTemplateInstructions(e.target.value)} placeholder="What should this summary emphasize and how should it be organized?" rows={3} className="w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-fg" />
            <div className="flex justify-end gap-1"><button onClick={() => setCreatingTemplate(false)} className="px-2 py-1 text-faint">Cancel</button><button onClick={() => { saveSummaryTemplate({ name: templateName, description: "Custom meeting summary", instructions: templateInstructions, sections: [] }).then((created) => { setTemplates((current) => [...current, created]); setTemplateId(created.id); setCreatingTemplate(false); setTemplateName(""); setTemplateInstructions(""); }).catch((reason) => setError(String(reason))); }} disabled={!templateName.trim() || !templateInstructions.trim()} className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50">Save template</button></div>
          </div>
        ) : <button type="button" onClick={() => setCreatingTemplate(true)} className="text-left text-[10px] text-accent hover:underline">+ New summary template</button>}
        <div className="grid grid-cols-2 gap-2">
          {(["you", "them"] as const).map((speaker) => (
            <label key={speaker} className="flex items-center gap-2">
              <span className="w-9 text-faint">{speaker === "you" ? "Mic" : "Call"}</span>
              <input value={labels[speaker]} onChange={(e) => setLabels((current) => ({ ...current, [speaker]: e.target.value }))} onBlur={() => void saveLabel(speaker)} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-fg" />
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-faint">Link caller</span>
          <select
            value={participants.find((participant) => participant.speaker_key === "them")?.person_id ?? ""}
            onChange={(e) => {
              const person = people.find((candidate) => candidate.id === e.target.value);
              if (!person) return;
              setLabels((current) => ({ ...current, them: person.name }));
              setMeetingSpeakerLabel(meeting.item_id, "them", person.name, person.id)
                .then(() => listMeetingParticipants(meeting.item_id).then(setParticipants))
                .catch((reason) => setError(String(reason)));
            }}
            className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-fg"
          >
            <option value="">Not linked to a person</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
        <p className="text-[10px] leading-relaxed text-faint">
          Speaker names are confirmed labels for the mic and call channels. Automatic multi-speaker diarization is not inferred.
          {participants.length > 0 ? ` ${participants.length} label${participants.length === 1 ? "" : "s"} confirmed.` : ""}
        </p>
        {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

function MeetingChatSection({ meetingId }: { meetingId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<{ source_id: string; content: string }[]>([]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((current) => [...current, { role: "user", content: text }]);
    setLoading(true);
    try {
      let activeSession = sessionId;
      if (!activeSession) {
        const created = await createChatSessionScoped("meeting", meetingId);
        activeSession = created.id;
        setSessionId(created.id);
      }
      const response = await chatWithMemory(activeSession, text);
      setMessages((current) => [...current, { role: "assistant", content: response.reply }]);
      setSources(response.sources.map((source) => ({ source_id: source.source_id, content: source.content })));
    } catch (e) {
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${String(e)}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <details>
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-muted">
        <MessageSquare size={12} /> Ask this meeting
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2.5">
        {messages.length === 0 ? <p className="text-[11px] text-faint">Answers stay scoped to this meeting’s transcript, notes, and summary.</p> : null}
        {messages.map((message, index) => (
          <div key={index} className={`rounded-md px-2 py-1.5 text-[11px] ${message.role === "user" ? "ml-6 bg-accent-soft text-fg" : "mr-6 bg-elevated text-fg"}`}>
            {message.role === "assistant" ? <Markdown>{message.content}</Markdown> : message.content}
          </div>
        ))}
        {sources.length > 0 ? <div className="text-[10px] text-faint">Grounded in {sources.length} meeting source{sources.length === 1 ? "" : "s"}.</div> : null}
        <div className="flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} rows={2} placeholder="Ask about this meeting…" className="min-w-0 flex-1 resize-none rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-fg focus:border-accent focus:outline-none" />
          <button type="button" onClick={() => void send()} disabled={loading || !input.trim()} aria-label="Send" className="self-end rounded-md bg-accent p-2 text-white disabled:opacity-50">
            {loading ? <Loader size={13} className="animate-spin" /> : <Send size={13} />}
          </button>
        </div>
      </div>
    </details>
  );
}

function MeetingWorkflowsSection({
  meeting,
  summary,
  onMeetingChange,
}: {
  meeting: MeetingRow;
  summary: StoredSummary | null;
  onMeetingChange: (meeting: MeetingRow) => void;
}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [artifact, setArtifact] = useState<MeetingArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [rewriteIndex, setRewriteIndex] = useState(0);
  const [rewriteInstruction, setRewriteInstruction] = useState("Make this clearer and more concise");
  const [error, setError] = useState<string | null>(null);
  const [creatingRecipe, setCreatingRecipe] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [recipePrompt, setRecipePrompt] = useState("");

  useEffect(() => {
    listRecipes().then((available) => {
      setRecipes(available);
      setRecipeId((current) => current || available[0]?.id || "");
    }).catch((e) => setError(String(e)));
  }, []);

  const run = async (kind: "recipe" | "follow_up" | "prep_brief") => {
    setLoading(true);
    setError(null);
    try {
      const result = kind === "recipe"
        ? await runRecipe(recipeId, "meeting", meeting.item_id)
        : await generateMeetingArtifact(kind, "meeting", meeting.item_id);
      setArtifact(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const rewrite = async () => {
    const current = summary?.summary[rewriteIndex];
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const revised = await rewriteMeetingText(current, rewriteInstruction);
      await replaceMeetingSummaryPoint(meeting.item_id, rewriteIndex, revised);
      const refreshed = await getMeeting(meeting.item_id);
      if (refreshed) onMeetingChange(refreshed);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <details>
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-muted">
        <Sparkles size={12} /> Recipes and follow-up
      </summary>
      <div className="mt-2 space-y-3 rounded-lg border border-line bg-surface p-2.5">
        <div className="flex gap-2">
          <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-fg">
            {recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
          </select>
          <button type="button" onClick={() => void run("recipe")} disabled={loading || !recipeId} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-accent hover:bg-elevated disabled:opacity-50">Run Recipe</button>
        </div>
        {creatingRecipe ? (
          <div className="space-y-2 rounded-md border border-line bg-canvas p-2">
            <input value={recipeName} onChange={(e) => setRecipeName(e.target.value)} placeholder="Recipe name" className="w-full rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-fg" />
            <textarea value={recipePrompt} onChange={(e) => setRecipePrompt(e.target.value)} placeholder="What should EchoScribe extract or create?" rows={3} className="w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-fg" />
            <div className="flex justify-end gap-1"><button onClick={() => setCreatingRecipe(false)} className="px-2 py-1 text-[10px] text-faint">Cancel</button><button onClick={() => { saveRecipe({ name: recipeName, description: "Custom meeting workflow", prompt: recipePrompt, defaultScope: "meeting" }).then((created) => { setRecipes((current) => [...current, created]); setRecipeId(created.id); setCreatingRecipe(false); setRecipeName(""); setRecipePrompt(""); }).catch((reason) => setError(String(reason))); }} disabled={!recipeName.trim() || !recipePrompt.trim()} className="rounded bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50">Save Recipe</button></div>
          </div>
        ) : <button type="button" onClick={() => setCreatingRecipe(true)} className="text-left text-[10px] text-accent hover:underline">+ New Recipe</button>}
        <div className="flex gap-2">
          <button type="button" onClick={() => void run("follow_up")} disabled={loading} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-muted hover:bg-elevated">Draft follow-up</button>
          <button type="button" onClick={() => void run("prep_brief")} disabled={loading} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-muted hover:bg-elevated">Create Prep brief</button>
        </div>
        {summary && summary.summary.length > 0 ? (
          <div className="space-y-2 border-t border-line pt-2">
            <div className="flex gap-2">
              <select value={rewriteIndex} onChange={(e) => setRewriteIndex(Number(e.target.value))} className="w-28 rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-fg">
                {summary.summary.map((_, index) => <option key={index} value={index}>Point {index + 1}</option>)}
              </select>
              <input value={rewriteInstruction} onChange={(e) => setRewriteInstruction(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-fg" />
              <button type="button" onClick={() => void rewrite()} disabled={loading || !rewriteInstruction.trim()} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-accent hover:bg-elevated">Rewrite</button>
            </div>
            <p className="text-[10px] text-faint">Rewriting removes the old citation from that point because its wording changed.</p>
          </div>
        ) : null}
        {loading ? <div className="flex items-center gap-2 text-[11px] text-muted"><Loader size={12} className="animate-spin" /> Running locally…</div> : null}
        {artifact ? (
          <div className="rounded-md border border-line bg-canvas p-2 text-[11px] text-fg">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium">{artifact.title}</span>
              <button type="button" onClick={() => navigator.clipboard.writeText(artifact.content)} className="rounded p-1 text-faint hover:text-accent" aria-label="Copy"><Copy size={12} /></button>
            </div>
            <Markdown>{artifact.content}</Markdown>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
      </div>
    </details>
  );
}

function TranscriptEditor({
  meeting,
  transcript,
  onMeetingChange,
}: {
  meeting: MeetingRow;
  transcript: StoredTranscript;
  onMeetingChange: (meeting: MeetingRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [segments, setSegments] = useState<Segment[]>(transcript.segments);
  const [saving, setSaving] = useState(false);
  const [backups, setBackups] = useState<MeetingArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSegments(transcript.segments), [meeting.item_id, meeting.transcript_json]);
  useEffect(() => { listMeetingArtifacts("transcript_backup", meeting.item_id).then(setBackups).catch(() => setBackups([])); }, [meeting.item_id, meeting.transcript_json]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateMeetingTranscript(meeting.item_id, segments);
      const refreshed = await getMeeting(meeting.item_id);
      if (refreshed) onMeetingChange(refreshed);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details>
      <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">Transcript ({segments.length} segments)</summary>
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-faint">Edits automatically preserve a recoverable transcript backup.</span>
          {editing ? (
            <div className="flex gap-1">
              <button type="button" onClick={() => { setSegments(transcript.segments); setEditing(false); }} className="rounded px-2 py-1 text-[10px] text-muted hover:bg-elevated">Cancel</button>
              <button type="button" onClick={() => void save()} disabled={saving || segments.length === 0} className="rounded bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50">{saving ? "Saving…" : "Save transcript"}</button>
            </div>
          ) : <div className="flex gap-1">{backups[0] ? <button type="button" onClick={() => { restoreTranscriptBackup(backups[0].id).then(() => getMeeting(meeting.item_id)).then((refreshed) => { if (refreshed) onMeetingChange(refreshed); }).catch((reason) => setError(String(reason))); }} className="rounded px-2 py-1 text-[10px] text-muted hover:bg-elevated">Restore previous</button> : null}<button type="button" onClick={() => setEditing(true)} className="rounded px-2 py-1 text-[10px] text-accent hover:bg-elevated">Edit transcript</button></div>}
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-line bg-surface p-2 text-[11px]">
          {segments.map((segment, index) => (
            <div key={`${segment.start_ms}-${index}`} id={`meeting-segment-${index}`} className="group flex scroll-mt-4 items-start gap-1 rounded px-1 py-0.5">
              <span className={`w-9 shrink-0 pt-1 ${segment.speaker === "you" ? "text-accent" : "text-muted"}`}>{segment.speaker}:</span>
              {editing ? (
                <>
                  <textarea value={segment.text} onChange={(e) => setSegments((current) => current.map((value, i) => i === index ? { ...value, text: e.target.value } : value))} rows={2} className="min-w-0 flex-1 resize-y rounded border border-line bg-canvas px-1.5 py-1 text-fg" />
                  <button type="button" onClick={() => setSegments((current) => current.filter((_, i) => i !== index))} className="rounded p-1 text-faint hover:bg-danger/10 hover:text-danger" aria-label={`Delete segment ${index + 1}`}><Trash2 size={11} /></button>
                </>
              ) : <span className="pt-1 text-fg/90">{segment.text}</span>}
            </div>
          ))}
        </div>
        {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
      </div>
    </details>
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
              {savingTitle ? <span role="status" className="text-[10px] text-faint">Saving…</span> : null}
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
            className="mt-1 shrink-0 rounded p-1 text-faint opacity-0 transition hover:bg-elevated hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
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
  onEvidenceClick,
}: {
  item: Item;
  summary: StoredSummary | null;
  onItemChange: (i: Item) => void;
  onEvidenceClick: (segmentIndex: number) => void;
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
            <span role="status" className="text-[10px] text-faint">
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
              <span className="min-w-0 flex-1">{b}</span>
              {(summary?.evidence ?? []).filter((e) => e.summary_index === i).map((e, evidenceIndex) => (
                <button
                  key={`${e.segment_index}-${evidenceIndex}`}
                  type="button"
                  onClick={() => onEvidenceClick(e.segment_index)}
                  title={e.quote}
                  aria-label={`Show source: ${e.quote}`}
                  className="mt-0.5 shrink-0 rounded p-1 text-faint hover:bg-elevated hover:text-accent"
                >
                  <Quote size={12} />
                </button>
              ))}
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
            <span role="status" className="text-[10px] text-faint">
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

const VERDICT_STYLES: Record<string, string> = {
  met: "bg-emerald-500/15 text-emerald-400",
  partial: "bg-amber-500/15 text-amber-400",
  missed: "bg-red-500/15 text-red-400",
  unknown: "bg-elevated text-muted",
};
const OVERALL_STYLES: Record<string, string> = {
  strong: "bg-emerald-500/15 text-emerald-400",
  mixed: "bg-amber-500/15 text-amber-400",
  weak: "bg-red-500/15 text-red-400",
};

function GuideReviewSection({ meetingId }: { meetingId: string }) {
  const toasts = useToasts();
  const [runs, setRuns] = useState<GuideRun[]>([]);
  const [openCrit, setOpenCrit] = useState<Record<string, boolean>>({});
  const [showTimeline, setShowTimeline] = useState<Record<string, boolean>>({});
  const [trendFor, setTrendFor] = useState<{ id: string; name: string } | null>(null);
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const r = await listGuideRuns(meetingId).catch(() => [] as GuideRun[]);
    setRuns(r);
  }, [meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when a background review finishes for this meeting.
  useEffect(() => {
    const un = listen<{ meetingId: string }>("guide-review-updated", (e) => {
      if (e.payload?.meetingId === meetingId) load();
    });
    return () => {
      un.then((f) => f());
    };
  }, [meetingId, load]);

  if (runs.length === 0) return null;

  return (
    <>
      <div className="space-y-4">
        {runs.map((run) => {
          const review = parseGuideReview(run.review_json);
          const timeline = parseTimeline(run.timeline_json);
          const overallCls = OVERALL_STYLES[(review?.overall || "").toLowerCase()] ?? "bg-elevated text-muted";
          return (
            <div key={run.id} className="rounded-lg border border-line bg-surface-2">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
                <span className="text-[13px] font-semibold text-fg">{run.template_name}</span>
                {run.status === "ready" && review?.overall ? (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${overallCls}`}>
                    {review.overall}
                  </span>
                ) : null}
                {run.status === "pending" ? (
                  <span className="text-[11px] text-muted">Generating review…</span>
                ) : null}
                <button
                  className="ml-auto text-[11px] text-accent hover:underline"
                  onClick={() => setTrendFor({ id: run.template_id, name: run.template_name })}
                >
                  View trend
                </button>
              </div>

              {run.status === "failed" ? (
                <div className="px-3 py-3 text-[12px] text-muted">
                  Guide review couldn't be generated. See Settings → Diagnostics → logs.{" "}
                  <button
                    className="text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!!retrying[run.id]}
                    onClick={async () => {
                      setRetrying((s) => ({ ...s, [run.id]: true }));
                      try {
                        await regenerateGuideReview(run.id);
                      } catch {
                        toasts.push({
                          tone: "error",
                          message: "Couldn't regenerate the guide review. See Settings → Diagnostics → logs.",
                        });
                      } finally {
                        setRetrying((s) => ({ ...s, [run.id]: false }));
                        load();
                      }
                    }}
                  >
                    {retrying[run.id] ? "Retrying…" : "Retry"}
                  </button>
                </div>
              ) : null}

              {run.status === "ready" && review ? (
                <div className="space-y-3 px-3 py-3">
                  {review.synthesis ? (
                    <p className="text-[13px] leading-relaxed text-fg">{review.synthesis}</p>
                  ) : null}

                  {review.scorecard.length > 0 ? (
                    <div className="space-y-1.5">
                      {review.scorecard.map((c, i) => {
                        const key = `${run.id}:${i}`;
                        const vk = verdictClass(c.verdict);
                        const open = !!openCrit[key];
                        return (
                          <div key={key} className="overflow-hidden rounded-md border border-line">
                            <button
                              aria-expanded={open}
                              className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-elevated"
                              onClick={() => setOpenCrit((s) => ({ ...s, [key]: !open }))}
                            >
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${VERDICT_STYLES[vk]}`}>
                                {vk}
                              </span>
                              <span className="flex-1 text-[13px] font-medium text-fg">{c.criterion}</span>
                              <span className="text-[11px] text-faint">{open ? "▾" : "▸"}</span>
                            </button>
                            {open ? (
                              <div className="space-y-1.5 border-t border-line px-2.5 py-2 text-[12px]">
                                {c.evidence ? (
                                  <p className="border-l-2 border-line pl-2 italic text-muted">"{c.evidence}"</p>
                                ) : null}
                                {c.why ? <p className="text-fg">{c.why}</p> : null}
                                {c.tip ? (
                                  <p className="text-muted">
                                    <span className="font-semibold text-amber-400">Try:</span> {c.tip}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {review.emergent.length > 0 ? (
                    <div>
                      <SectionLabel>What also stood out</SectionLabel>
                      <ul className="space-y-1 text-[12px] text-fg">
                        {review.emergent.map((e, i) => (
                          <li key={i} className="leading-relaxed">{e.observation}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {timeline.length > 0 ? (
                    <div className="border-t border-line pt-2">
                      <button
                        aria-expanded={!!showTimeline[run.id]}
                        className="text-[12px] text-muted hover:text-fg"
                        onClick={() => setShowTimeline((s) => ({ ...s, [run.id]: !s[run.id] }))}
                      >
                        {showTimeline[run.id] ? "▾" : "▸"} Live coaching timeline · {timeline.length}
                      </button>
                      {showTimeline[run.id] ? (
                        <div className="mt-1.5 space-y-1">
                          {timeline.map((t, i) => (
                            <div key={i} className="text-[12px] text-muted">
                              {t.suggestions.join(" · ") || "—"}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {trendFor ? (
        <GuideTrendView
          templateId={trendFor.id}
          templateName={trendFor.name}
          onClose={() => setTrendFor(null)}
        />
      ) : null}
    </>
  );
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
