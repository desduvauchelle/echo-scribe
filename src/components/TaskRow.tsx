import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, User } from "lucide-react";
import {
  completeTask,
  setTaskDeadline,
  uncompleteTask,
  type Item,
  type Project,
  type TaskWithItem,
} from "../lib/api";
import {
  dateInputToIso,
  isSameLocalDay,
  isoToDateInput,
  parseIso,
  shortDate,
} from "../lib/format";
import ItemCard from "./ItemCard";
import { useToasts } from "./ToastProvider";

type TaskRowProps = {
  task: TaskWithItem;
  projects: Map<string, Project>;
  completed: boolean;
  onToggle: () => void;
  onChangeDeadline: (value: string) => void;
  /** "card" = the Tasks view's bordered card; "ledger" = flat activity-feed row. */
  variant?: "card" | "ledger";
  /** Suppress the project pill for this project (its own project page). */
  hideProjectId?: string | null;
};

/** One task: checkbox to complete, title (opens the item detail), deadline
 *  pill and meta line. Shared by the Tasks view and the activity feed. */
export default function TaskRow({
  task,
  projects,
  completed,
  onToggle,
  onChangeDeadline,
  variant = "card",
  hideProjectId,
}: TaskRowProps) {
  return (
    <ItemCard
      item={task.item}
      projects={projects}
      compact
      variant={variant}
      hideProjectId={hideProjectId}
      leadingSlot={<TaskCheckbox completed={completed} onToggle={onToggle} />}
      rightSlot={
        <span className="flex items-center gap-1.5">
          {task.assignee_name ? <AssigneeChip name={task.assignee_name} /> : null}
          <DeadlineBadge
            deadlineIso={task.deadline}
            completedAtIso={task.completed_at}
            onChange={onChangeDeadline}
          />
        </span>
      }
    />
  );
}

/** Task row for the activity feed. The feed only carries the bare item, so
 *  deadline/completion come from `task` (the feed's task index) when known;
 *  a task missing from the index renders as open with no deadline. Toggles
 *  and deadline edits update the row optimistically, then `onChanged` lets
 *  the feed refresh its index. */
export function FeedTaskRow({
  item,
  task,
  projects,
  hideProjectId,
  onChanged,
}: {
  item: Item;
  task?: TaskWithItem;
  projects: Map<string, Project>;
  hideProjectId?: string | null;
  onChanged?: () => void;
}) {
  const { t } = useTranslation("main");
  const toasts = useToasts();
  const [deadline, setDeadline] = useState<string | null>(task?.deadline ?? null);
  const [completedAt, setCompletedAt] = useState<string | null>(task?.completed_at ?? null);

  useEffect(() => {
    setDeadline(task?.deadline ?? null);
    setCompletedAt(task?.completed_at ?? null);
  }, [task?.deadline, task?.completed_at]);

  const completed = completedAt !== null;

  const onToggle = async () => {
    const prev = completedAt;
    const next = completed ? null : new Date().toISOString();
    setCompletedAt(next);
    try {
      if (completed) await uncompleteTask(item.id);
      else await completeTask(item.id);
      onChanged?.();
    } catch (e) {
      setCompletedAt(prev);
      console.error("feed task toggle failed", item.id, e);
      toasts.push({
        tone: "error",
        message: t(completed ? "tasks.toast.uncompleteFailed" : "tasks.toast.completeFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const onChangeDeadline = async (value: string) => {
    const iso = dateInputToIso(value);
    const prev = deadline;
    setDeadline(iso);
    try {
      await setTaskDeadline(item.id, iso);
      onChanged?.();
    } catch (e) {
      setDeadline(prev);
      console.error("feed task deadline update failed", item.id, e);
      toasts.push({
        tone: "error",
        message: t("tasks.toast.updateDeadlineFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  return (
    <TaskRow
      task={{
        item,
        deadline,
        completed_at: completedAt,
        assignee_person_id: task?.assignee_person_id ?? null,
        assignee_name: task?.assignee_name ?? null,
      }}
      projects={projects}
      completed={completed}
      onToggle={() => void onToggle()}
      onChangeDeadline={(v) => void onChangeDeadline(v)}
      variant="ledger"
      hideProjectId={hideProjectId}
    />
  );
}

function AssigneeChip({ name }: { name: string }) {
  const { t } = useTranslation("main");
  return (
    <span
      title={t("tasks.assignedTo", { name })}
      className="inline-flex max-w-[120px] items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted"
    >
      <User size={10} aria-hidden="true" />
      <span className="sr-only">{t("tasks.assignedTo", { name })}</span>
      <span className="truncate" aria-hidden="true">{name}</span>
    </span>
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
