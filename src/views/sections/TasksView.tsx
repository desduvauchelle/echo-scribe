import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  completeTask,
  listTasks,
  setTaskDeadline,
  uncompleteTask,
  type Project,
  type TaskWithItem,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import { useToasts } from "../../components/ToastProvider";
import {
  dateInputToIso,
  isSameLocalDay,
  isoToDateInput,
  parseIso,
  shortDate,
} from "../../lib/format";
import { Check, CheckCircle2, ListTodo } from "lucide-react";
import { EmptyState, SkeletonList } from "./ActivityFeed";

type Props = {
  projects: Map<string, Project>;
  /** When true, render without outer page chrome (header, h-full, own scroll). */
  embedded?: boolean;
};

export default function TasksView({ projects, embedded = false }: Props) {
  const { t } = useTranslation("main");
  const [open, setOpen] = useState<TaskWithItem[]>([]);
  const [done, setDone] = useState<TaskWithItem[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [loadingOpen, setLoadingOpen] = useState(true);
  const [loadingDone, setLoadingDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const { refreshTick } = useActivityPanel();

  const fetchOpen = useCallback(async () => {
    setLoadingOpen(true);
    setError(null);
    try {
      const t = await listTasks({ include_completed: false, project_id: null });
      setOpen(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOpen(false);
    }
  }, []);

  const fetchDone = useCallback(async () => {
    setLoadingDone(true);
    try {
      const doneTasks = await listTasks({ include_completed: true, project_id: null });
      setDone(doneTasks);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("tasks.toast.loadDoneFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setLoadingDone(false);
    }
  }, [toasts, t]);

  useEffect(() => {
    void fetchOpen();
  }, [fetchOpen]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void fetchOpen();
    if (showDone) void fetchDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    if (showDone) void fetchDone();
  }, [showDone, fetchDone]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const subscribe = async () => {
      const handler = () => {
        if (cancelled) return;
        void fetchOpen();
        if (showDone) void fetchDone();
      };
      const u1 = await listen("item:created", handler);
      const u2 = await listen("app:refresh", handler);
      if (cancelled) {
        u1();
        u2();
      } else {
        unlisteners.push(u1, u2);
      }
    };
    void subscribe();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [fetchOpen, fetchDone, showDone]);

  const onComplete = async (task: TaskWithItem) => {
    setOpen((prev) => prev.filter((x) => x.item.id !== task.item.id));
    try {
      await completeTask(task.item.id);
      if (showDone) void fetchDone();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("tasks.toast.completeFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
      void fetchOpen();
    }
  };

  const onUncomplete = async (task: TaskWithItem) => {
    setDone((prev) => prev.filter((x) => x.item.id !== task.item.id));
    try {
      await uncompleteTask(task.item.id);
      void fetchOpen();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("tasks.toast.uncompleteFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
      void fetchDone();
    }
  };

  const onChangeDeadline = async (task: TaskWithItem, value: string) => {
    const iso = dateInputToIso(value);
    try {
      await setTaskDeadline(task.item.id, iso);
      void fetchOpen();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("tasks.toast.updateDeadlineFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  return (
    <div className={embedded ? "flex flex-col" : "flex h-full flex-col"}>
      {embedded ? null : (
        <div className="border-b border-line bg-canvas/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight text-fg">{t("tasks.header.title")}</h1>
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-medium text-fg">{open.length}</span> {t("tasks.header.openLabel")} ·{" "}
            <span className="font-medium text-fg">
              {done.length || (showDone ? 0 : "—")}
            </span>{" "}
            {t("tasks.header.doneLabel")}
          </p>
        </div>
      )}

      <div className={embedded ? "" : "flex-1 overflow-y-auto px-6 py-4"}>
        {error ? (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/15 px-3 py-2 text-sm text-danger">
            {error}{" "}
            <button type="button" onClick={() => void fetchOpen()} className="ml-2 underline">
              {t("tasks.error.retry")}
            </button>
          </div>
        ) : null}

        <section>
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {t("tasks.sections.open")}
          </h2>
          {loadingOpen ? (
            <SkeletonList />
          ) : open.length === 0 ? (
            <EmptyState
              icon={<ListTodo size={20} strokeWidth={1.75} />}
              title={t("tasks.emptyState.noOpenTasks.title")}
              subtitle={t("tasks.emptyState.noOpenTasks.subtitle")}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {open.map((t) => (
                <TaskRow
                  key={t.item.id}
                  task={t}
                  projects={projects}
                  completed={false}
                  onToggle={() => void onComplete(t)}
                  onChangeDeadline={(v) => void onChangeDeadline(t, v)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              {t("tasks.sections.done")}
            </h2>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
            >
              {showDone ? t("tasks.toggle.hide") : t("tasks.toggle.show")}
            </button>
          </div>
          {showDone ? (
            loadingDone ? (
              <SkeletonList />
            ) : done.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 size={20} strokeWidth={1.75} />}
                title={t("tasks.emptyState.noCompletedTasks.title")}
                subtitle={t("tasks.emptyState.noCompletedTasks.subtitle")}
              />
            ) : (
              <div className="flex flex-col gap-2 opacity-80">
                {done.map((t) => (
                  <TaskRow
                    key={t.item.id}
                    task={t}
                    projects={projects}
                    completed={true}
                    onToggle={() => void onUncomplete(t)}
                    onChangeDeadline={(v) => void onChangeDeadline(t, v)}
                  />
                ))}
              </div>
            )
          ) : null}
        </section>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  projects,
  completed,
  onToggle,
  onChangeDeadline,
}: {
  task: TaskWithItem;
  projects: Map<string, Project>;
  completed: boolean;
  onToggle: () => void;
  onChangeDeadline: (value: string) => void;
}) {
  return (
    <ItemCard
      item={task.item}
      projects={projects}
      compact
      leadingSlot={
        <TaskCheckbox completed={completed} onToggle={onToggle} />
      }
      rightSlot={
        <DeadlineBadge
          deadlineIso={task.deadline}
          completedAtIso={task.completed_at}
          onChange={onChangeDeadline}
        />
      }
    />
  );
}

function TaskCheckbox({
  completed,
  onToggle,
}: {
  completed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("main");
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={completed}
      aria-label={completed ? t("tasks.checkbox.markNotDoneAria") : t("tasks.checkbox.completeAria")}
      title={completed ? t("tasks.checkbox.markOpenTitle") : t("tasks.checkbox.completeAria")}
      onClick={onToggle}
      className={`grid h-5 w-5 place-items-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        completed
          ? "border-success/40 bg-success/15 text-success hover:bg-success/20"
          : "border-warning/45 bg-warning/10 text-warning hover:bg-warning/20"
      }`}
    >
      {completed ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : null}
    </button>
  );
}

function DeadlineBadge({
  deadlineIso,
  completedAtIso,
  onChange,
}: {
  deadlineIso: string | null;
  completedAtIso: string | null;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("main");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(isoToDateInput(deadlineIso));

  useEffect(() => {
    setValue(isoToDateInput(deadlineIso));
  }, [deadlineIso]);

  if (completedAtIso) {
    return (
      <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">
        {t("tasks.deadline.doneLabel", { date: shortDate(completedAtIso) })}
      </span>
    );
  }

  const tMs = parseIso(deadlineIso);
  const now = Date.now();
  let tone = "border-line text-muted";
  let label = t("tasks.deadline.noDeadline");
  if (tMs !== null) {
    if (tMs < now) {
      tone = "border-danger/40 text-danger";
      label = t("tasks.deadline.overdue", { date: shortDate(deadlineIso!) });
    } else if (isSameLocalDay(tMs, now)) {
      tone = "border-warning/40 text-warning";
      label = t("tasks.deadline.today", { date: shortDate(deadlineIso!) });
    } else {
      tone = "border-line text-muted";
      label = shortDate(deadlineIso!);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded border border-line bg-canvas px-1 py-0.5 text-[10px]"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            onChange(value);
            setEditing(false);
          }}
          className="rounded border border-line px-1 py-0.5 text-[10px] hover:bg-elevated"
        >
          {t("tasks.deadline.ok")}
        </button>
        <button
          type="button"
          onClick={() => {
            onChange("");
            setEditing(false);
          }}
          className="rounded border border-line px-1 py-0.5 text-[10px] hover:bg-elevated"
        >
          {t("tasks.deadline.clear")}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`rounded-full border px-2 py-0.5 text-[10px] ${tone} hover:bg-surface`}
    >
      {label}
    </button>
  );
}
