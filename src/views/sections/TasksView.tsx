import { useCallback, useEffect, useState } from "react";
import {
  completeTask,
  deleteItem,
  listTasks,
  restoreItem,
  setTaskDeadline,
  uncompleteTask,
  type Project,
  type TaskWithItem,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { useToasts } from "../../components/ToastProvider";
import {
  dateInputToIso,
  isSameLocalDay,
  isoToDateInput,
  parseIso,
  shortDate,
} from "../../lib/format";
import { EmptyState, SkeletonList } from "./ActivityFeed";

type Props = {
  projects: Map<string, Project>;
};

export default function TasksView({ projects }: Props) {
  const [open, setOpen] = useState<TaskWithItem[]>([]);
  const [done, setDone] = useState<TaskWithItem[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [loadingOpen, setLoadingOpen] = useState(true);
  const [loadingDone, setLoadingDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

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
      const t = await listTasks({ include_completed: true, project_id: null });
      setDone(t);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't load done tasks: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setLoadingDone(false);
    }
  }, [toasts]);

  useEffect(() => {
    void fetchOpen();
  }, [fetchOpen]);

  useEffect(() => {
    if (showDone) void fetchDone();
  }, [showDone, fetchDone]);

  const onComplete = async (t: TaskWithItem) => {
    setOpen((prev) => prev.filter((x) => x.item.id !== t.item.id));
    try {
      await completeTask(t.item.id);
      if (showDone) void fetchDone();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Complete failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      void fetchOpen();
    }
  };

  const onUncomplete = async (t: TaskWithItem) => {
    setDone((prev) => prev.filter((x) => x.item.id !== t.item.id));
    try {
      await uncompleteTask(t.item.id);
      void fetchOpen();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Uncomplete failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      void fetchDone();
    }
  };

  const onChangeDeadline = async (t: TaskWithItem, value: string) => {
    const iso = dateInputToIso(value);
    try {
      await setTaskDeadline(t.item.id, iso);
      void fetchOpen();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Update deadline failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const onDelete = async (t: TaskWithItem) => {
    setOpen((prev) => prev.filter((x) => x.item.id !== t.item.id));
    setDone((prev) => prev.filter((x) => x.item.id !== t.item.id));
    try {
      await deleteItem(t.item.id);
      toasts.push({
        tone: "info",
        message: "Task deleted",
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await restoreItem(t.item.id);
                void fetchOpen();
                if (showDone) void fetchDone();
              } catch (e) {
                toasts.push({
                  tone: "error",
                  message: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            })();
          },
        },
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      void fetchOpen();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
        <p className="text-xs text-neutral-400">
          {open.length} open · {done.length || (showDone ? 0 : "—")} done
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <div className="mb-3 rounded-md border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}{" "}
            <button type="button" onClick={() => void fetchOpen()} className="ml-2 underline">
              Retry
            </button>
          </div>
        ) : null}

        <section>
          <h2 className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
            Open
          </h2>
          {loadingOpen ? (
            <SkeletonList />
          ) : open.length === 0 ? (
            <EmptyState
              title="No open tasks."
              subtitle="When you capture a task with the log hotkey, it shows up here."
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
                  onDelete={() => void onDelete(t)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500">
              Done
            </h2>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
            >
              {showDone ? "Hide" : "Show"}
            </button>
          </div>
          {showDone ? (
            loadingDone ? (
              <SkeletonList />
            ) : done.length === 0 ? (
              <EmptyState
                title="No completed tasks."
                subtitle="Tasks you check off will appear here."
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
                    onDelete={() => void onDelete(t)}
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
  onDelete,
}: {
  task: TaskWithItem;
  projects: Map<string, Project>;
  completed: boolean;
  onToggle: () => void;
  onChangeDeadline: (value: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={completed}
        onChange={onToggle}
        className="mt-3 h-4 w-4 cursor-pointer accent-neutral-200"
        aria-label={completed ? "Mark task as not done" : "Complete task"}
      />
      <div className="flex-1">
        <ItemCard
          item={task.item}
          projects={projects}
          compact
          onDelete={onDelete}
          rightSlot={
            <DeadlineBadge
              deadlineIso={task.deadline}
              completedAtIso={task.completed_at}
              onChange={onChangeDeadline}
            />
          }
        />
      </div>
    </div>
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
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(isoToDateInput(deadlineIso));

  useEffect(() => {
    setValue(isoToDateInput(deadlineIso));
  }, [deadlineIso]);

  if (completedAtIso) {
    return (
      <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-200">
        Done {shortDate(completedAtIso)}
      </span>
    );
  }

  const tMs = parseIso(deadlineIso);
  const now = Date.now();
  let tone = "border-neutral-700 text-neutral-300";
  let label = "No deadline";
  if (tMs !== null) {
    if (tMs < now) {
      tone = "border-red-700 text-red-300";
      label = `Overdue · ${shortDate(deadlineIso!)}`;
    } else if (isSameLocalDay(tMs, now)) {
      tone = "border-amber-700 text-amber-300";
      label = `Today · ${shortDate(deadlineIso!)}`;
    } else {
      tone = "border-neutral-700 text-neutral-300";
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
          className="rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[10px]"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            onChange(value);
            setEditing(false);
          }}
          className="rounded border border-neutral-700 px-1 py-0.5 text-[10px] hover:bg-neutral-800"
        >
          OK
        </button>
        <button
          type="button"
          onClick={() => {
            onChange("");
            setEditing(false);
          }}
          className="rounded border border-neutral-700 px-1 py-0.5 text-[10px] hover:bg-neutral-800"
        >
          Clear
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`rounded-full border px-2 py-0.5 text-[10px] ${tone} hover:bg-neutral-900`}
    >
      {label}
    </button>
  );
}
