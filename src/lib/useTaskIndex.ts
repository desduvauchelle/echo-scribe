import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { listFocusTasks, listTasks, type TaskWithItem } from "./api";
import { useActivityPanel } from "../components/ActivityPanelContext";

/** item id → task state (deadline, completion, assignee) for the activity
 *  feed, which only loads bare items. Built from open + completed tasks plus
 *  focus-board tasks (which `list_tasks` excludes). Refreshes on the same
 *  signals as the feed. Failures are non-fatal: a missing entry renders as an
 *  open task with no deadline. */
export function useTaskIndex(projectId: string | null = null) {
  const [tasks, setTasks] = useState<Map<string, TaskWithItem>>(new Map());
  const { refreshTick } = useActivityPanel();

  const reload = useCallback(async () => {
    const [open, done, focus] = await Promise.all([
      listTasks({ include_completed: false, project_id: projectId }).catch((e) => {
        console.warn("task index: list open tasks failed", e);
        return [] as TaskWithItem[];
      }),
      listTasks({ include_completed: true, project_id: projectId }).catch((e) => {
        console.warn("task index: list done tasks failed", e);
        return [] as TaskWithItem[];
      }),
      listFocusTasks().catch((e) => {
        console.warn("task index: list focus tasks failed", e);
        return [];
      }),
    ]);
    const next = new Map<string, TaskWithItem>();
    for (const f of focus) {
      if (projectId && f.item.project_id !== projectId) continue;
      next.set(f.item.id, { item: f.item, deadline: null, completed_at: f.completed_at });
    }
    for (const task of [...open, ...done]) next.set(task.item.id, task);
    setTasks(next);
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const handler = () => {
        if (!cancelled) void reload();
      };
      const subs = await Promise.all([
        listen("item:created", handler),
        listen("app:refresh", handler),
        listen("focus:changed", handler),
      ]);
      if (cancelled) subs.forEach((u) => u());
      else unlisteners.push(...subs);
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [reload]);

  return { tasks, reload };
}
