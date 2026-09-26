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
import TaskRow from "../../components/TaskRow";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import { useToasts } from "../../components/ToastProvider";
import { dateInputToIso } from "../../lib/format";
import { CheckCircle2, ListTodo } from "lucide-react";
import { EmptyState, SkeletonList } from "./ActivityFeed";

type Props = {
  projects: Map<string, Project>;
  /** When true, render without outer page chrome (header, h-full, own scroll). */
  embedded?: boolean;
  /** Only show tasks in this project (the project page). */
  projectId?: string | null;
};

export default function TasksView({ projects, embedded = false, projectId = null }: Props) {
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
      const t = await listTasks({ include_completed: false, project_id: projectId });
      setOpen(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOpen(false);
    }
  }, [projectId]);

  const fetchDone = useCallback(async () => {
    setLoadingDone(true);
    try {
      const doneTasks = await listTasks({ include_completed: true, project_id: projectId });
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
  }, [toasts, t, projectId]);

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
