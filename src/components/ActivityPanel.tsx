import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlignLeft, Copy, Download, Eye, Info, Loader, MessageSquare, Pencil, Quote, RotateCcw, Send, Sparkles, Tag, Trash2, Users, X } from "lucide-react";
import Markdown from "./Markdown";
import Dialog, { useFocusTrap } from "./a11y/Dialog";
import {
  completeTask,
  createProject,
  createChatSessionScoped,
  chatWithMemory,
  deleteItem,
  deleteMeeting,
  exportMeetingMarkdown,
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
  restoreItem,
  restoreTranscriptBackup,
  runRecipe,
  saveRecipe,
  saveSummaryTemplate,
  setTaskDeadline,
  setMeetingSpeakerLabel,
  uncompleteTask,
  updateItem,
  updateMeetingNotes,
  updateMeetingSummaryMarkdown,
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
import { summaryMarkdown } from "../lib/meetingDisplay";
import { useActivityPanel } from "./ActivityPanelContext";
import { useToasts } from "./ToastProvider";
import ItemDetailPanel from "./ItemDetailPanel";
import { meetingStatusDisplay } from "../lib/meetingStatus";

export default function ActivityPanel() {
  const { selectedItemId, evidenceTarget, close } = useActivityPanel();
  const open = selectedItemId !== null;
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(panelRef, open && !nestedDialogOpen);

  useEffect(() => {
    if (!open) {
      setNestedDialogOpen(false);
      return;
    }
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
        aria-hidden={nestedDialogOpen || undefined}
        aria-labelledby="activity-panel-title"
      >
        {open && selectedItemId ? (
          <PanelBody
            itemId={selectedItemId}
            evidenceTarget={evidenceTarget}
            onClose={close}
            onNestedDialogChange={setNestedDialogOpen}
          />
        ) : null}
      </aside>
    </>
  );
}

function PanelBody({
  itemId,
  evidenceTarget,
  onClose,
  onNestedDialogChange,
}: {
  itemId: string;
  evidenceTarget: { segmentIndex: number; nonce: number } | null;
  onClose: () => void;
  onNestedDialogChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
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
  const [meetingExportOpen, setMeetingExportOpen] = useState(false);

  const setExportDialogOpen = (open: boolean) => {
    setMeetingExportOpen(open);
    onNestedDialogChange(open);
  };

  const reload = useCallback(async () => {
    const it = await getItem(itemId);
    if (!it) {
      setError(t("activityPanel.panelBody.itemNotFound"));
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
  }, [itemId, t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItem(null);
    setMeeting(null);
    setExportDialogOpen(false);
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
      t("activityPanel.panelBody.deleteConfirmMessage"),
      { title: t("activityPanel.panelBody.deleteConfirmTitle"), kind: "warning" },
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
        message: t("activityPanel.panelBody.deleteFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
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
          {loading ? t("activityPanel.panelBody.loading") : item ? activityTitle(item, meeting, t) : t("activityPanel.panelBody.titleFallback")}
        </div>
        <div className="flex items-center gap-1.5">
          {meeting && ["complete", "recovered"].includes(meeting.status) ? (
            <button
              type="button"
              onClick={() => setExportDialogOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              <Download size={13} strokeWidth={2} aria-hidden="true" />
              {t("activityPanel.panelBody.export")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("activityPanel.panelBody.closePanel")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={16} strokeWidth={2.25} />
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-fg">
        {loading ? (
          <div className="text-xs text-muted">{t("activityPanel.panelBody.loading")}</div>
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
                evidenceTarget={evidenceTarget}
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
      {meetingExportOpen && meeting ? (
        <MeetingExportDialog
          meeting={meeting}
          onClose={() => setExportDialogOpen(false)}
        />
      ) : null}
    </>
  );
}

function MeetingExportDialog({
  meeting,
  onClose,
}: {
  meeting: MeetingRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [includeSummary, setIncludeSummary] = useState(true);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSelection = includeSummary || includeTranscript;

  const runExport = async () => {
    if (!hasSelection) return;
    setExporting(true);
    setError(null);
    try {
      const result = await exportMeetingMarkdown(
        meeting.item_id,
        includeSummary,
        includeTranscript,
      );
      // Cancelling the native save dialog returns to this modal so the user
      // can adjust the selection or try again.
      if (!result) return;
      onClose();
      toasts.push({
        tone: "success",
        message: t("activityPanel.exportDialog.exportedToast", { path: result.path }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  };

  return createPortal(
    <Dialog
      onClose={onClose}
      dismissible={!exporting}
      labelledBy="meeting-export-title"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4"
      panelClassName="w-full max-w-md rounded-xl border border-line bg-canvas p-5 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="meeting-export-title" className="text-base font-semibold text-fg">
            {t("activityPanel.exportDialog.title")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {t("activityPanel.exportDialog.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={exporting}
          aria-label={t("activityPanel.exportDialog.closeAriaLabel")}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </div>

      <div className="mt-5 space-y-2.5">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface px-3 py-3 hover:border-line-strong">
          <input
            type="checkbox"
            checked={includeSummary}
            onChange={(event) => setIncludeSummary(event.target.checked)}
            disabled={exporting}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium text-fg">{t("activityPanel.exportDialog.summaryLabel")}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
              {t("activityPanel.exportDialog.summaryDescription")}
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface px-3 py-3 hover:border-line-strong">
          <input
            type="checkbox"
            checked={includeTranscript}
            onChange={(event) => setIncludeTranscript(event.target.checked)}
            disabled={exporting}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium text-fg">{t("activityPanel.exportDialog.transcriptLabel")}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
              {t("activityPanel.exportDialog.transcriptDescription")}
            </span>
          </span>
        </label>
      </div>

      {!hasSelection ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {t("activityPanel.exportDialog.noSelection")}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {t("activityPanel.exportDialog.exportFailed", { error })}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={exporting}
          className="rounded-md px-3 py-2 text-xs font-medium text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
        >
          {t("activityPanel.exportDialog.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void runExport()}
          disabled={!hasSelection || exporting}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? <Loader size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          {exporting ? t("activityPanel.exportDialog.exporting") : t("activityPanel.exportDialog.chooseLocation")}
        </button>
      </div>
    </Dialog>,
    document.body,
  );
}

function activityTitle(item: Item, meeting: MeetingRow | null, t: TFunction): string {
  if (meeting) {
    const summary = meeting.summary_json ? safeParseSummary(meeting.summary_json) : null;
    if (summary?.suggested_title) return truncate(summary.suggested_title, 60);
  }
  const firstLine = item.content.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    if (item.kind === "task") return t("activityPanel.title.task");
    if (meeting) return t("activityPanel.title.meeting");
    if (item.source === "voice_at_cursor" || item.kind === "transcription")
      return t("activityPanel.title.transcription");
    return t("activityPanel.title.note");
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
  const { t } = useTranslation();
  const badges: string[] = [];
  if (meeting) badges.push(t("activityPanel.header.meetingBadge"));
  else if (item.source === "voice_at_cursor" || item.kind === "transcription")
    badges.push(t("activityPanel.header.transcriptionBadge"));
  else if (item.source === "log_capture") badges.push(t("activityPanel.header.logCaptureBadge"));
  if (item.kind === "task") badges.push(t("activityPanel.header.taskBadge"));
  if (item.deleted_at) badges.push(t("activityPanel.header.deletedBadge"));

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
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-faint hover:bg-elevated hover:text-fg"
    >
      {editing ? (
        <>
          <Eye size={11} strokeWidth={2.25} /> {t("activityPanel.editToggle.done")}
        </>
      ) : (
        <>
          <Pencil size={11} strokeWidth={2.25} /> {t("activityPanel.editToggle.edit")}
        </>
      )}
    </button>
  );
}

function ContentSection({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const { t } = useTranslation();
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
        <SectionLabel>{t("activityPanel.content.label")}</SectionLabel>
        <div className="flex items-center gap-2">
          {editing ? (
            <span role="status" className="text-[10px] text-faint">
              {saving ? t("activityPanel.content.saving") : draft !== item.content ? t("activityPanel.content.unsaved") : t("activityPanel.content.saved")}
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
        <div className="text-[12px] italic text-faint">{t("activityPanel.content.empty")}</div>
      )}
    </div>
  );
}

function KindSection({ item, onChange }: { item: Item; onChange: (i: Item) => void }) {
  const { t } = useTranslation();
  const set = async (k: "" | ItemKind) => {
    const updated = await updateItem({ id: item.id, kind: k });
    onChange(updated);
  };
  return (
    <div>
      <SectionLabel>{t("activityPanel.kind.label")}</SectionLabel>
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
              ? t("activityPanel.kind.unset")
              : k === "task"
                ? t("activityPanel.kind.task")
                : k === "transcription"
                  ? t("activityPanel.kind.transcription")
                  : t("activityPanel.kind.note")}
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
  const { t } = useTranslation();
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
      <SectionLabel>{t("activityPanel.project.label")}</SectionLabel>
      {!creating ? (
        <select
          value={value}
          onChange={(e) => void onSelect(e.target.value)}
          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
        >
          <option value="">{t("activityPanel.project.unassigned")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__new__">{t("activityPanel.project.newProject")}</option>
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
            placeholder={t("activityPanel.project.namePlaceholder")}
            className="flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
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
            className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-elevated"
          >
            {t("activityPanel.project.cancel")}
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
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const commit = async (next: string[]) => {
    await updateItem({ id: item.id, tags: next });
    onTagsChange(next);
    onSaved();
  };

  const addTag = async () => {
    const trimmedTag = draft.trim().replace(/^#/, "");
    if (!trimmedTag || tags.includes(trimmedTag)) {
      setDraft("");
      return;
    }
    await commit([...tags, trimmedTag]);
    setDraft("");
  };

  const removeTag = async (tag: string) => {
    await commit(tags.filter((x) => x !== tag));
  };

  return (
    <div>
      <SectionLabel>{t("activityPanel.tags.label")}</SectionLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] text-muted"
          >
            #{tag}
            <button
              type="button"
              onClick={() => void removeTag(tag)}
              className="text-faint hover:text-danger"
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
          placeholder={t("activityPanel.tags.addPlaceholder")}
          className="min-w-[80px] rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-fg focus:border-accent focus:outline-none"
        />
      </div>
    </div>
  );
}

function MetadataSection({ item }: { item: Item }) {
  const { t } = useTranslation();
  const ctx = useMemo(
    () => parseCaptureContext(item.capture_context),
    [item.capture_context],
  );
  const rows: { label: string; value: string | null | undefined }[] = [
    { label: t("activityPanel.metadata.source"), value: humanSource(item.source, t) },
    { label: t("activityPanel.metadata.app"), value: ctx?.app_name },
    { label: t("activityPanel.metadata.window"), value: ctx?.window_title },
    { label: t("activityPanel.metadata.content"), value: ctx?.content_title },
    { label: t("activityPanel.metadata.contentUrl"), value: ctx?.content_url },
    { label: t("activityPanel.metadata.contentSource"), value: ctx?.content_source },
    { label: t("activityPanel.metadata.browserTab"), value: ctx?.browser_tab_title },
    { label: t("activityPanel.metadata.url"), value: ctx?.browser_url },
    { label: t("activityPanel.metadata.bundleId"), value: ctx?.bundle_id },
    { label: t("activityPanel.metadata.confidence"), value: item.confidence != null ? `${Math.round(item.confidence * 100)}%` : null },
    { label: t("activityPanel.metadata.classifiedBy"), value: item.classified_by },
  ];
  const visible = rows.filter((r) => r.value);
  if (visible.length === 0) {
    return (
      <div>
        <SectionLabel>{t("activityPanel.metadata.label")}</SectionLabel>
        <div className="text-[11px] text-muted">{t("activityPanel.metadata.empty")}</div>
      </div>
    );
  }
  return (
    <div>
      <SectionLabel>{t("activityPanel.metadata.label")}</SectionLabel>
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

function humanSource(s: Item["source"], t: TFunction): string {
  switch (s) {
    case "voice_at_cursor": return t("activityPanel.source.voiceAtCursor");
    case "log_capture": return t("activityPanel.source.logCapture");
    case "meeting": return t("activityPanel.source.meeting");
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
  const { t } = useTranslation();
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
      <SectionLabel>{t("activityPanel.task.label")}</SectionLabel>
      <div className="space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!completedAt}
            onChange={() => void onCheck()}
          />
          <span className="text-muted">{completedAt ? t("activityPanel.task.completed") : t("activityPanel.task.markComplete")}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-20 text-faint">{t("activityPanel.task.deadline")}</span>
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
              {t("activityPanel.task.clear")}
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
  evidenceTarget,
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
  evidenceTarget: { segmentIndex: number; nonce: number } | null;
  onProjectsChange: (next: Project[]) => void;
  onItemChange: (i: Item) => void;
  onTagsChange: (next: string[]) => void;
  onSaved: () => void;
  onMeetingChange: (m: MeetingRow) => void;
}) {
  const { t } = useTranslation();
  const summary = meeting.summary_json ? safeParseSummary(meeting.summary_json) : null;
  const transcript = meeting.transcript_json ? safeParseTranscript(meeting.transcript_json) : null;
  const durationMin = meeting.duration_ms
    ? Math.round(meeting.duration_ms / 60000)
    : null;
  const projectName = projects.find((p) => p.id === item.project_id)?.name ?? null;
  const [panel, setPanel] = useState<MeetingPanel>(null);
  const [localEvidenceTarget, setLocalEvidenceTarget] = useState<{
    segmentIndex: number;
    nonce: number;
  } | null>(null);
  const selectedEvidence = evidenceTarget ?? localEvidenceTarget;
  const hasTranscript = !!transcript && transcript.segments.length > 0;

  // An evidence citation (guide review) always jumps to the transcript panel.
  useEffect(() => {
    if (selectedEvidence && hasTranscript) setPanel("transcript");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvidence?.nonce]);

  const statusDisplay = meetingStatusDisplay(meeting.status);
  const onEvidenceClick = (segmentIndex: number) =>
    setLocalEvidenceTarget({ segmentIndex, nonce: Date.now() });

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
        <span>
          {new Date(meeting.started_at).toLocaleDateString()}{" "}
          {new Date(meeting.started_at).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
        {durationMin != null ? <span>{t("activityPanel.meetingView.durationSuffix", { count: durationMin })}</span> : null}
        {meeting.detected_app_name ? <span>{t("activityPanel.meetingView.detectedAppSuffix", { app: meeting.detected_app_name })}</span> : null}
        {projectName ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
            {projectName}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("activityPanel.meetingView.detailsGroupAriaLabel")}>
        <PanelToggle
          icon={<Users size={12} strokeWidth={2.25} aria-hidden="true" />}
          label={t("activityPanel.meetingView.peopleToggle")}
          active={panel === "people"}
          onClick={() => setPanel((p) => (p === "people" ? null : "people"))}
        />
        <PanelToggle
          icon={<Tag size={12} strokeWidth={2.25} aria-hidden="true" />}
          label={t("activityPanel.meetingView.tagsToggle")}
          active={panel === "tags"}
          onClick={() => setPanel((p) => (p === "tags" ? null : "tags"))}
        />
        <PanelToggle
          icon={<Info size={12} strokeWidth={2.25} aria-hidden="true" />}
          label={t("activityPanel.meetingView.detailsToggle")}
          active={panel === "details"}
          onClick={() => setPanel((p) => (p === "details" ? null : "details"))}
        />
        {hasTranscript ? (
          <PanelToggle
            icon={<AlignLeft size={12} strokeWidth={2.25} aria-hidden="true" />}
            label={t("activityPanel.meetingView.transcriptToggle")}
            active={panel === "transcript"}
            onClick={() => setPanel((p) => (p === "transcript" ? null : "transcript"))}
          />
        ) : null}
      </div>

      {panel === "people" ? (
        <MeetingPeoplePanel meeting={meeting} />
      ) : null}
      {panel === "tags" ? (
        <TagsSection
          item={item}
          tags={tags}
          onTagsChange={onTagsChange}
          onSaved={onSaved}
        />
      ) : null}
      {panel === "details" ? (
        <div className="space-y-4">
          <ProjectSection
            item={item}
            projects={projects}
            onProjectsChange={onProjectsChange}
            onChange={onItemChange}
          />
          <div>
            <SectionLabel>{t("activityPanel.meetingView.meetingMetadataLabel")}</SectionLabel>
            <dl className="space-y-1 text-[11px]">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.statusLabel")}</dt>
                <dd className="text-muted">{statusDisplay.label || t("activityPanel.meetingView.statusFallback")}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.startedLabel")}</dt>
                <dd className="text-muted">{new Date(meeting.started_at).toLocaleString()}</dd>
              </div>
              {meeting.ended_at ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.endedLabel")}</dt>
                  <dd className="text-muted">{new Date(meeting.ended_at).toLocaleString()}</dd>
                </div>
              ) : null}
              {meeting.detected_app_name ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.detectedAppLabel")}</dt>
                  <dd className="text-muted">{meeting.detected_app_name}</dd>
                </div>
              ) : null}
              {durationMin != null ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.durationLabel")}</dt>
                  <dd className="text-muted">{t("activityPanel.meetingView.durationValue", { count: durationMin })}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.audioSourceLabel")}</dt>
                <dd className="text-muted">{meeting.mic_only ? t("activityPanel.meetingView.micOnly") : t("activityPanel.meetingView.micAndSystem")}</dd>
              </div>
              {meeting.failed_chunk_count > 0 ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-faint">{t("activityPanel.meetingView.failedChunksLabel")}</dt>
                  <dd className="text-warning">{meeting.failed_chunk_count}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      ) : null}
      {panel === "transcript" && transcript ? (
        <TranscriptEditor
          meeting={meeting}
          transcript={transcript}
          onMeetingChange={onMeetingChange}
          evidenceTarget={selectedEvidence}
        />
      ) : null}

      <MeetingSummarySection meeting={meeting} summary={summary} onMeetingChange={onMeetingChange} />

      <NotesSection meeting={meeting} onMeetingChange={onMeetingChange} />

      <GuideReviewSection
        meetingId={meeting.item_id}
        onEvidenceClick={onEvidenceClick}
      />

      <MeetingChatSection meetingId={meeting.item_id} />

      <MeetingWorkflowsSection meeting={meeting} />
    </div>
  );
}

type MeetingPanel = "people" | "tags" | "details" | "transcript" | null;

function PanelToggle({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-line text-muted hover:bg-elevated hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** "People" panel: confirmed speaker labels for the mic/call channels and the
 *  optional link from the call channel to a known person. */
function MeetingPeoplePanel({ meeting }: { meeting: MeetingRow }) {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [labels, setLabels] = useState({ you: t("activityPanel.peoplePanel.you"), them: t("activityPanel.peoplePanel.them") });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listMeetingParticipants(meeting.item_id), listPeople()])
      .then(([meetingParticipants, knownPeople]) => {
        setParticipants(meetingParticipants);
        setPeople(knownPeople);
        const next = { you: t("activityPanel.peoplePanel.you"), them: t("activityPanel.peoplePanel.them") };
        for (const participant of meetingParticipants) {
          next[participant.speaker_key] = participant.display_name;
        }
        setLabels(next);
      })
      .catch((e) => setError(String(e)));
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

  return (
    <div>
      <SectionLabel>{t("activityPanel.peoplePanel.label")}</SectionLabel>
      <div className="space-y-2.5 text-[12px]">
        <div className="grid grid-cols-2 gap-2">
          {(["you", "them"] as const).map((speaker) => (
            <label key={speaker} className="flex items-center gap-2">
              <span className="w-9 text-faint">{speaker === "you" ? t("activityPanel.peoplePanel.mic") : t("activityPanel.peoplePanel.call")}</span>
              <input value={labels[speaker]} onChange={(e) => setLabels((current) => ({ ...current, [speaker]: e.target.value }))} onBlur={() => void saveLabel(speaker)} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-fg" />
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-faint">{t("activityPanel.peoplePanel.linkCaller")}</span>
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
            <option value="">{t("activityPanel.peoplePanel.notLinked")}</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
        <p className="text-[10px] leading-relaxed text-faint">
          {t("activityPanel.peoplePanel.description")}
          {participants.length > 0 ? t("activityPanel.peoplePanel.confirmedCount", { count: participants.length }) : ""}
        </p>
        {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/** The default meeting content: the summary rendered as markdown. The header
 *  carries the template picker + regenerate control and an edit toggle that
 *  edits the markdown directly, so any template's output stays displayable
 *  and editable without structure-specific UI. */
function MeetingSummarySection({
  meeting,
  summary,
  onMeetingChange,
}: {
  meeting: MeetingRow;
  summary: StoredSummary | null;
  onMeetingChange: (m: MeetingRow) => void;
}) {
  const { t } = useTranslation();
  const markdown = summaryMarkdown(summary) ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<SummaryTemplate[]>([]);
  const [templateId, setTemplateId] = useState("builtin-general");
  const [regenerating, setRegenerating] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateInstructions, setTemplateInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(markdown);
  }, [meeting.item_id, markdown]);

  useEffect(() => {
    Promise.all([
      listSummaryTemplates(),
      getMeetingPreferences(meeting.item_id),
    ])
      .then(([available, preferences]) => {
        setTemplates(available);
        setTemplateId(preferences?.summary_template_id ?? "builtin-general");
      })
      .catch((e) => setError(String(e)));
  }, [meeting.item_id]);

  // Debounced auto-save of markdown edits.
  useEffect(() => {
    if (draft === markdown) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!draft.trim()) return;
      setSaving(true);
      try {
        await updateMeetingSummaryMarkdown(meeting.item_id, draft);
        const refreshed = await getMeeting(meeting.item_id);
        if (refreshed) onMeetingChange(refreshed);
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft, markdown, meeting.item_id, onMeetingChange]);

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

  const onTemplateSelect = (next: string) => {
    if (next === "__new__") {
      setCreatingTemplate(true);
      return;
    }
    setTemplateId(next);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <SectionLabel>{t("activityPanel.summary.label")}</SectionLabel>
        <div className="flex items-center gap-1.5">
          {editing ? (
            <span role="status" className="text-[10px] text-faint">
              {saving ? t("activityPanel.summary.saving") : draft !== markdown ? t("activityPanel.summary.unsaved") : t("activityPanel.summary.saved")}
            </span>
          ) : (
            <>
              <select
                value={templateId}
                onChange={(e) => onTemplateSelect(e.target.value)}
                aria-label={t("activityPanel.summary.templateAriaLabel")}
                className="max-w-[130px] rounded-md border border-line bg-canvas px-1.5 py-1 text-[11px] text-muted focus:border-accent focus:outline-none"
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
                <option value="__new__">{t("activityPanel.summary.newTemplate")}</option>
              </select>
              <button
                type="button"
                onClick={() => void regenerate()}
                disabled={regenerating}
                title={t("activityPanel.summary.regenerateTitle")}
                className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-accent hover:bg-elevated disabled:opacity-50"
              >
                {regenerating ? <Loader size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {t("activityPanel.summary.regenerate")}
              </button>
            </>
          )}
          <EditToggle editing={editing} onClick={() => setEditing((e) => !e)} />
        </div>
      </div>
      {creatingTemplate ? (
        <div className="mb-2 space-y-2 rounded-md border border-line bg-canvas p-2 text-[12px]">
          <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder={t("activityPanel.summary.templateNamePlaceholder")} className="w-full rounded border border-line bg-surface px-2 py-1.5 text-fg" />
          <textarea value={templateInstructions} onChange={(e) => setTemplateInstructions(e.target.value)} placeholder={t("activityPanel.summary.templateInstructionsPlaceholder")} rows={3} className="w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-fg" />
          <div className="flex justify-end gap-1">
            <button onClick={() => setCreatingTemplate(false)} className="px-2 py-1 text-faint">{t("activityPanel.summary.cancel")}</button>
            <button
              onClick={() => {
                saveSummaryTemplate({ name: templateName, description: "Custom meeting summary", instructions: templateInstructions, sections: [] })
                  .then((created) => {
                    setTemplates((current) => [...current, created]);
                    setTemplateId(created.id);
                    setCreatingTemplate(false);
                    setTemplateName("");
                    setTemplateInstructions("");
                  })
                  .catch((reason) => setError(String(reason)));
              }}
              disabled={!templateName.trim() || !templateInstructions.trim()}
              className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50"
            >
              {t("activityPanel.summary.saveTemplate")}
            </button>
          </div>
        </div>
      ) : null}
      {regenerating ? (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
          <Loader size={12} className="animate-spin" /> {t("activityPanel.summary.rewriting")}
        </div>
      ) : null}
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          placeholder={t("activityPanel.summary.editPlaceholder")}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[12.5px] text-fg transition-colors focus:border-accent focus:outline-none"
        />
      ) : markdown.trim() ? (
        <Markdown>{markdown}</Markdown>
      ) : (
        <div className="text-[12px] italic text-faint">{t("activityPanel.summary.empty")}</div>
      )}
      {error ? <p role="alert" className="mt-1.5 text-[11px] text-danger">{error}</p> : null}
    </div>
  );
}

function MeetingChatSection({ meetingId }: { meetingId: string }) {
  const { t } = useTranslation();
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
      setMessages((current) => [...current, { role: "assistant", content: t("activityPanel.chat.errorPrefix", { error: String(e) }) }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <details>
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-muted">
        <MessageSquare size={12} /> {t("activityPanel.chat.toggle")}
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-line bg-surface p-2.5">
        {messages.length === 0 ? <p className="text-[11px] text-faint">{t("activityPanel.chat.empty")}</p> : null}
        {messages.map((message, index) => (
          <div key={index} className={`rounded-md px-2 py-1.5 text-[11px] ${message.role === "user" ? "ml-6 bg-accent-soft text-fg" : "mr-6 bg-elevated text-fg"}`}>
            {message.role === "assistant" ? <Markdown>{message.content}</Markdown> : message.content}
          </div>
        ))}
        {sources.length > 0 ? <div className="text-[10px] text-faint">{t("activityPanel.chat.groundedIn", { count: sources.length })}</div> : null}
        <div className="flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} rows={2} placeholder={t("activityPanel.chat.inputPlaceholder")} className="min-w-0 flex-1 resize-none rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-fg focus:border-accent focus:outline-none" />
          <button type="button" onClick={() => void send()} disabled={loading || !input.trim()} aria-label={t("activityPanel.chat.sendAriaLabel")} className="self-end rounded-md bg-accent p-2 text-white disabled:opacity-50">
            {loading ? <Loader size={13} className="animate-spin" /> : <Send size={13} />}
          </button>
        </div>
      </div>
    </details>
  );
}

function MeetingWorkflowsSection({
  meeting,
}: {
  meeting: MeetingRow;
}) {
  const { t } = useTranslation();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [artifact, setArtifact] = useState<MeetingArtifact | null>(null);
  const [loading, setLoading] = useState(false);
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

  return (
    <details>
      <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-muted">
        <Sparkles size={12} /> {t("activityPanel.workflows.toggle")}
      </summary>
      <div className="mt-2 space-y-3 rounded-lg border border-line bg-surface p-2.5">
        <div className="flex gap-2">
          <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-fg">
            {recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
          </select>
          <button type="button" onClick={() => void run("recipe")} disabled={loading || !recipeId} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-accent hover:bg-elevated disabled:opacity-50">{t("activityPanel.workflows.runRecipe")}</button>
        </div>
        {creatingRecipe ? (
          <div className="space-y-2 rounded-md border border-line bg-canvas p-2">
            <input value={recipeName} onChange={(e) => setRecipeName(e.target.value)} placeholder={t("activityPanel.workflows.recipeNamePlaceholder")} className="w-full rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-fg" />
            <textarea value={recipePrompt} onChange={(e) => setRecipePrompt(e.target.value)} placeholder={t("activityPanel.workflows.recipePromptPlaceholder")} rows={3} className="w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-fg" />
            <div className="flex justify-end gap-1"><button onClick={() => setCreatingRecipe(false)} className="px-2 py-1 text-[10px] text-faint">{t("activityPanel.workflows.cancel")}</button><button onClick={() => { saveRecipe({ name: recipeName, description: "Custom meeting workflow", prompt: recipePrompt, defaultScope: "meeting" }).then((created) => { setRecipes((current) => [...current, created]); setRecipeId(created.id); setCreatingRecipe(false); setRecipeName(""); setRecipePrompt(""); }).catch((reason) => setError(String(reason))); }} disabled={!recipeName.trim() || !recipePrompt.trim()} className="rounded bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50">{t("activityPanel.workflows.saveRecipe")}</button></div>
          </div>
        ) : <button type="button" onClick={() => setCreatingRecipe(true)} className="text-left text-[10px] text-accent hover:underline">{t("activityPanel.workflows.newRecipe")}</button>}
        <div className="flex gap-2">
          <button type="button" onClick={() => void run("follow_up")} disabled={loading} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-muted hover:bg-elevated">{t("activityPanel.workflows.draftFollowUp")}</button>
          <button type="button" onClick={() => void run("prep_brief")} disabled={loading} className="rounded-md border border-line px-2 py-1.5 text-[11px] text-muted hover:bg-elevated">{t("activityPanel.workflows.createPrepBrief")}</button>
        </div>
        {loading ? <div className="flex items-center gap-2 text-[11px] text-muted"><Loader size={12} className="animate-spin" /> {t("activityPanel.workflows.runningLocally")}</div> : null}
        {artifact ? (
          <div className="rounded-md border border-line bg-canvas p-2 text-[11px] text-fg">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium">{artifact.title}</span>
              <button type="button" onClick={() => navigator.clipboard.writeText(artifact.content)} className="rounded p-1 text-faint hover:text-accent" aria-label={t("activityPanel.workflows.copyAriaLabel")}><Copy size={12} /></button>
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
  evidenceTarget,
}: {
  meeting: MeetingRow;
  transcript: StoredTranscript;
  onMeetingChange: (meeting: MeetingRow) => void;
  evidenceTarget: { segmentIndex: number; nonce: number } | null;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [segments, setSegments] = useState<Segment[]>(transcript.segments);
  const [saving, setSaving] = useState(false);
  const [backups, setBackups] = useState<MeetingArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSegments(transcript.segments), [meeting.item_id, meeting.transcript_json]);
  useEffect(() => { listMeetingArtifacts("transcript_backup", meeting.item_id).then(setBackups).catch(() => setBackups([])); }, [meeting.item_id, meeting.transcript_json]);
  useEffect(() => {
    if (!evidenceTarget) return;
    if (evidenceTarget.segmentIndex < 0 || evidenceTarget.segmentIndex >= segments.length) return;
    requestAnimationFrame(() => {
      document
        .getElementById(`meeting-segment-${evidenceTarget.segmentIndex}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [evidenceTarget?.nonce, evidenceTarget?.segmentIndex, segments.length]);

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
    <div>
      <SectionLabel>{t("activityPanel.transcriptEditor.header", { count: segments.length })}</SectionLabel>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-faint">{t("activityPanel.transcriptEditor.backupNote")}</span>
          {editing ? (
            <div className="flex gap-1">
              <button type="button" onClick={() => { setSegments(transcript.segments); setEditing(false); }} className="rounded px-2 py-1 text-[10px] text-muted hover:bg-elevated">{t("activityPanel.transcriptEditor.cancel")}</button>
              <button type="button" onClick={() => void save()} disabled={saving || segments.length === 0} className="rounded bg-accent px-2 py-1 text-[10px] text-white disabled:opacity-50">{saving ? t("activityPanel.transcriptEditor.saving") : t("activityPanel.transcriptEditor.saveTranscript")}</button>
            </div>
          ) : <div className="flex gap-1">{backups[0] ? <button type="button" onClick={() => { restoreTranscriptBackup(backups[0].id).then(() => getMeeting(meeting.item_id)).then((refreshed) => { if (refreshed) onMeetingChange(refreshed); }).catch((reason) => setError(String(reason))); }} className="rounded px-2 py-1 text-[10px] text-muted hover:bg-elevated">{t("activityPanel.transcriptEditor.restorePrevious")}</button> : null}<button type="button" onClick={() => setEditing(true)} className="rounded px-2 py-1 text-[10px] text-accent hover:bg-elevated">{t("activityPanel.transcriptEditor.editTranscript")}</button></div>}
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-line bg-surface p-2 text-[11px]">
          {segments.map((segment, index) => (
            <div
              key={`${segment.start_ms}-${index}`}
              id={`meeting-segment-${index}`}
              className={`group flex scroll-mt-4 items-start gap-1 rounded px-1 py-0.5 transition-colors ${
                evidenceTarget?.segmentIndex === index ? "bg-accent-soft ring-1 ring-accent/40" : ""
              }`}
            >
              <span className={`w-9 shrink-0 pt-1 ${segment.speaker === "you" ? "text-accent" : "text-muted"}`}>{segment.speaker}:</span>
              {editing ? (
                <>
                  <textarea value={segment.text} onChange={(e) => setSegments((current) => current.map((value, i) => i === index ? { ...value, text: e.target.value } : value))} rows={2} className="min-w-0 flex-1 resize-y rounded border border-line bg-canvas px-1.5 py-1 text-fg" />
                  <button type="button" onClick={() => setSegments((current) => current.filter((_, i) => i !== index))} className="rounded p-1 text-faint hover:bg-danger/10 hover:text-danger" aria-label={t("activityPanel.transcriptEditor.deleteSegmentAriaLabel", { count: index + 1 })}><Trash2 size={11} /></button>
                </>
              ) : <span className="pt-1 text-fg/90">{segment.text}</span>}
            </div>
          ))}
        </div>
        {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
      </div>
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
  const { t } = useTranslation();
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
            <SectionLabel>{t("activityPanel.meetingTitle.label")}</SectionLabel>
            <div className="flex items-center gap-2">
              {savingTitle ? <span role="status" className="text-[10px] text-faint">{t("activityPanel.meetingTitle.saving")}</span> : null}
              <EditToggle editing onClick={() => setEditing(false)} />
            </div>
          </div>
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder={t("activityPanel.meetingTitle.placeholder")}
            className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-base font-semibold text-fg focus:border-accent focus:outline-none"
          />
        </>
      ) : (
        <div className="group flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold leading-snug text-fg">
            {titleDraft.trim() || t("activityPanel.meetingTitle.placeholder")}
          </h2>
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={t("activityPanel.meetingTitle.editAriaLabel")}
            className="mt-1 shrink-0 rounded p-1 text-faint opacity-0 transition hover:bg-elevated hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Pencil size={13} strokeWidth={2.25} />
          </button>
        </div>
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
  const { t } = useTranslation();
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
        <SectionLabel>{t("activityPanel.notes.label")}</SectionLabel>
        <div className="flex items-center gap-2">
          {editing ? (
            <span role="status" className="text-[10px] text-faint">
              {saving ? t("activityPanel.notes.saving") : notesDraft !== current ? t("activityPanel.notes.unsaved") : t("activityPanel.notes.saved")}
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
          placeholder={t("activityPanel.notes.emptyPrompt")}
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
          {t("activityPanel.notes.emptyPrompt")}
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
  not_observed: "bg-elevated text-muted",
  light: "bg-sky-500/15 text-sky-400",
  clear: "bg-amber-500/15 text-amber-400",
  strong: "bg-red-500/15 text-red-400",
};
const OVERALL_STYLES: Record<string, string> = {
  strong: "bg-emerald-500/15 text-emerald-400",
  mixed: "bg-amber-500/15 text-amber-400",
  weak: "bg-red-500/15 text-red-400",
};

function GuideReviewSection({
  meetingId,
  onEvidenceClick,
}: {
  meetingId: string;
  onEvidenceClick: (segmentIndex: number) => void;
}) {
  const { t } = useTranslation();
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
                  <span className="text-[11px] text-muted">{t("activityPanel.guideReview.generating")}</span>
                ) : null}
                {run.insight_kind !== "signals" ? (
                  <button
                    className="ml-auto text-[11px] text-accent hover:underline"
                    onClick={() => setTrendFor({ id: run.template_id, name: run.template_name })}
                  >
                    {t("activityPanel.guideReview.viewTrend")}
                  </button>
                ) : null}
              </div>

              {run.status === "failed" || run.status === "stale" ? (
                <div className="px-3 py-3 text-[12px] text-muted">
                  {run.status === "stale"
                    ? t("activityPanel.guideReview.staleMessage")
                    : t("activityPanel.guideReview.failedMessage")}
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
                          message: t("activityPanel.guideReview.regenerateFailedToast"),
                        });
                      } finally {
                        setRetrying((s) => ({ ...s, [run.id]: false }));
                        load();
                      }
                    }}
                  >
                    {retrying[run.id] ? t("activityPanel.guideReview.analyzing") : run.status === "stale" ? t("activityPanel.guideReview.reanalyze") : t("activityPanel.guideReview.retry")}
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
                        const vk =
                          run.insight_kind === "signals"
                            ? (["not_observed", "light", "clear", "strong"].includes(
                                c.verdict.toLowerCase(),
                              )
                                ? c.verdict.toLowerCase()
                                : "not_observed")
                            : verdictClass(c.verdict);
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
                                {(c.evidence_refs ?? []).length > 0 ? (
                                  <div className="space-y-1">
                                    {(c.evidence_refs ?? []).map((evidence, evidenceIndex) => (
                                      <button
                                        key={`${evidence.segment_index}:${evidenceIndex}`}
                                        type="button"
                                        className="flex w-full gap-1.5 border-l-2 border-line pl-2 text-left italic text-muted hover:border-accent hover:text-fg"
                                        onClick={() => onEvidenceClick(evidence.segment_index)}
                                      >
                                        <Quote size={11} className="mt-0.5 shrink-0" />
                                        <span>“{evidence.quote}”</span>
                                      </button>
                                    ))}
                                  </div>
                                ) : c.evidence ? (
                                  <p className="border-l-2 border-line pl-2 italic text-muted">“{c.evidence}”</p>
                                ) : null}
                                {c.why ? <p className="text-fg">{c.why}</p> : null}
                                {c.tip ? (
                                  <p className="text-muted">
                                    <span className="font-semibold text-amber-400">{t("activityPanel.guideReview.tryLabel")}</span> {c.tip}
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
                      <SectionLabel>{t("activityPanel.guideReview.whatStoodOut")}</SectionLabel>
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
                        {showTimeline[run.id] ? "▾" : "▸"} {t("activityPanel.guideReview.timelineHeader", { count: timeline.length })}
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
  const { t } = useTranslation();
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
        {t("activityPanel.actions.copyContent")}
      </button>
      {item.deleted_at ? (
        <button
          type="button"
          onClick={onRestore}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-elevated hover:text-fg"
        >
          <RotateCcw size={12} strokeWidth={2} />
          {t("activityPanel.actions.restore")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={12} strokeWidth={2} />
          {t("activityPanel.actions.delete")}
        </button>
      )}
    </div>
  );
}
