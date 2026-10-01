import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Check, Crosshair, Eye, GripVertical, Plus, X } from "lucide-react";
import {
  addFocusTask,
  completeTask,
  deleteItem,
  listFocusTasks,
  reorderFocusTasks,
  uncompleteTask,
  updateItem,
  type Project,
} from "../lib/api";
import Menu from "./a11y/Menu";
import { useToasts } from "./ToastProvider";
import { capitalizeFirst } from "../lib/text";
import { useActivityPanel } from "./ActivityPanelContext";

/** One focus task as the board renders it. Backed by a task item whose
 *  `tasks.focus_rank` is set; the board's order is the rank order. */
export type FocusItem = {
  id: string;
  /** `NO_PROJECT` when the item has no project. */
  projectId: string;
  text: string;
  done: boolean;
};

type FocusGroup = {
  projectId: string;
  name: string;
  color: string | null;
  emoji: string | null;
  items: FocusItem[];
};

type ProjectMeta = Omit<FocusGroup, "items" | "projectId">;

/** Where a dragged row would land: before `index` in `projectId`'s list. */
type DropTarget = { projectId: string; index: number };

/** Items with no project live under this pseudo-project id. */
const NO_PROJECT = "__none__";
const COLLAPSED_TASK_COUNT = 4;

const toProjectId = (id: string | null) => id ?? NO_PROJECT;
const fromProjectId = (id: string) => (id === NO_PROJECT ? null : id);

/** Move `id` so it sits before position `index` of `projectId`'s items
 *  (index counted without the moved item). Items keep one flat list; a
 *  group's order is its items' order in that list. */
function moveItem(list: FocusItem[], id: string, target: DropTarget): FocusItem[] {
  const moving = list.find((it) => it.id === id);
  if (!moving) return list;
  const rest = list.filter((it) => it.id !== id);
  const moved = { ...moving, projectId: target.projectId };
  const groupIdx = rest.reduce<number[]>((acc, it, i) => {
    if (it.projectId === target.projectId) acc.push(i);
    return acc;
  }, []);
  let at: number;
  if (groupIdx.length === 0) at = rest.length;
  else if (target.index >= groupIdx.length) at = groupIdx[groupIdx.length - 1] + 1;
  else at = groupIdx[target.index];
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** The board's flat order, grouped: stored ranks follow card order so what
 *  the user sees top-left → bottom-right is exactly the saved order. */
function boardOrder(list: FocusItem[]): FocusItem[] {
  const groups = new Map<string, FocusItem[]>();
  for (const it of list) {
    const g = groups.get(it.projectId);
    if (g) g.push(it);
    else groups.set(it.projectId, [it]);
  }
  return [...groups.values()].flat();
}

export default function FocusBoard({ projects, showEmpty = false, onHideEmpty }: { projects: Map<string, Project>; showEmpty?: boolean; onHideEmpty?: () => void }) {
  const { t } = useTranslation("main");
  const { push: pushToast } = useToasts();
  const { openItem, refreshTick } = useActivityPanel();
  const [items, setItems] = useState<FocusItem[] | null>(null);
  const current = items ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const rows = await listFocusTasks();
      setItems(
        rows.map((r) => ({
          id: r.item.id,
          projectId: toProjectId(r.item.project_id),
          text: r.item.content,
          done: r.completed_at !== null,
        })),
      );
    } catch (e) {
      console.error("[focus] load failed", e);
      setItems((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      // Tucky commands and other windows change focus tasks behind our back.
      listen("focus:changed", () => void load()),
      listen("item:created", () => void load()),
      listen("app:refresh", () => void load()),
    ]).then((subs) => {
      if (cancelled) subs.forEach((u) => u());
      else unlisteners.push(...subs);
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [load]);

  useEffect(() => {
    if (refreshTick > 0) void load();
  }, [refreshTick, load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleMidnight = () => {
      clearTimeout(timer);
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => {
        void load();
        scheduleMidnight();
      }, midnight.getTime() - now.getTime());
    };
    // Refresh after sleep or returning to the app, when midnight may have passed.
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      void load();
      scheduleMidnight();
    };
    scheduleMidnight();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [load]);

  /** Apply `next` optimistically, run `save`; on failure reload the truth
   *  from the backend and tell the user. */
  const commit = async (next: FocusItem[], save: () => Promise<unknown>) => {
    setItems(next);
    try {
      await save();
    } catch (e) {
      console.error("[focus] save failed", e);
      pushToast({ tone: "error", message: t("dashboard.focus.saveFailed") });
      void load();
    }
  };

  const metaFor = useCallback(
    (projectId: string): ProjectMeta => {
      if (projectId === NO_PROJECT) {
        return { name: t("dashboard.focus.noProject"), color: null, emoji: null };
      }
      const p = projects.get(projectId);
      return {
        name: p?.name ?? t("dashboard.focus.unknownProject"),
        color: p?.color ?? null,
        emoji: p?.emoji ?? null,
      };
    },
    [projects, t],
  );

  const groups = useMemo(() => {
    const byProject = new Map<string, FocusGroup>();
    const ensure = (projectId: string) => {
      let g = byProject.get(projectId);
      if (!g) {
        g = { projectId, ...metaFor(projectId), items: [] };
        byProject.set(projectId, g);
      }
      return g;
    };
    for (const it of current) ensure(it.projectId).items.push(it);
    // A project picked from "Add" shows as an empty card until its first item.
    if (addingTo) ensure(addingTo);
    return [...byProject.values()];
  }, [current, addingTo, metaFor]);

  const toggle = (id: string) => {
    const it = current.find((x) => x.id === id);
    if (!it) return;
    void commit(
      current.map((x) => (x.id === id ? { ...x, done: !x.done } : x)),
      () => (it.done ? uncompleteTask(id) : completeTask(id)),
    );
  };
  const remove = (id: string) => {
    if (current.length === 1) onHideEmpty?.();
    void commit(current.filter((x) => x.id !== id), () => deleteItem(id));
  };
  const rename = (id: string, text: string) =>
    void commit(
      current.map((x) => (x.id === id ? { ...x, text } : x)),
      () => updateItem({ id, content: text }),
    );
  const add = async (projectId: string, text: string) => {
    try {
      const item = await addFocusTask(fromProjectId(projectId), text);
      setItems((prev) => [
        ...(prev ?? []),
        { id: item.id, projectId, text: item.content, done: false },
      ]);
      onHideEmpty?.();
    } catch (e) {
      console.error("[focus] add failed", e);
      pushToast({ tone: "error", message: t("dashboard.focus.addFailed") });
    }
  };
  const reorder = (next: FocusItem[]) => {
    const ordered = boardOrder(next);
    void commit(ordered, () =>
      reorderFocusTasks(
        ordered.map((it) => ({ item_id: it.id, project_id: fromProjectId(it.projectId) })),
      ),
    );
  };

  // ── Pointer-driven reorder ──────────────────────────────────────────────
  // Native HTML5 drag-and-drop is unreliable inside the Tauri webview (the
  // window's file-drop handler can swallow it), so dragging is done by hand:
  // capture the pointer on the grip, hit-test cards/rows on move, commit on up.
  const dropTargetAt = (x: number, y: number, id: string): DropTarget | null => {
    const board = boardRef.current;
    if (!board) return null;
    const cards = [...board.querySelectorAll<HTMLElement>("[data-focus-group]")];
    // The card under the pointer, else the nearest one, so dropping in a gap
    // between cards still lands somewhere sensible.
    let best: { el: HTMLElement; d: number } | null = null;
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { el, d };
    }
    if (!best) return null;
    const projectId = best.el.dataset.focusGroup!;
    const rows = [...best.el.querySelectorAll<HTMLElement>("[data-focus-row]")].filter(
      (r) => r.dataset.focusRow !== id,
    );
    const index = rows.filter((r) => {
      const rr = r.getBoundingClientRect();
      return rr.top + rr.height / 2 < y;
    }).length;
    return { projectId, index };
  };

  const onGripPointerDown = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragId(id);
    setDrop(dropTargetAt(e.clientX, e.clientY, id));
  };
  const onGripPointerMove = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragId !== id) return;
    setDrop(dropTargetAt(e.clientX, e.clientY, id));
  };
  const onGripPointerUp = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragId !== id) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const target = dropTargetAt(e.clientX, e.clientY, id);
    setDragId(null);
    setDrop(null);
    if (!target) return;
    if (target.index >= COLLAPSED_TASK_COUNT) {
      setExpandedProjects((previous) => new Set(previous).add(target.projectId));
    }
    const next = moveItem(current, id, target);
    if (next.map((x) => x.id + x.projectId).join() !== current.map((x) => x.id + x.projectId).join()) {
      reorder(next);
    }
  };
  const onGripPointerCancel = () => {
    setDragId(null);
    setDrop(null);
  };
  // Keyboard reorder on the grip: Alt+↑/↓ moves within the project.
  const onGripKeyDown = (it: FocusItem, index: number) => (e: ReactKeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const next = e.key === "ArrowUp" ? index - 1 : index + 1;
    if (next < 0) return;
    if (next >= COLLAPSED_TASK_COUNT) {
      setExpandedProjects((previous) => new Set(previous).add(it.projectId));
    }
    reorder(moveItem(current, it.id, { projectId: it.projectId, index: next }));
  };

  const pickable = [
    ...[...projects.values()]
      .filter((p) => !p.archived_at)
      .map((p) => ({ id: p.id, ...metaFor(p.id) })),
    { id: NO_PROJECT, ...metaFor(NO_PROJECT) },
  ];

  const startAdding = (projectId: string) => {
    setPickerOpen(false);
    setEditingId(null);
    setAddingTo(projectId);
  };

  // Nothing loaded yet: reserve no space rather than flashing the empty state.
  if (items === null || (items.length === 0 && !addingTo && !showEmpty)) return null;

  return (
    <section className="echo-focus-board py-3" aria-labelledby="focus-heading">
      <h2 id="focus-heading" className="mb-4 text-[11px] font-semibold uppercase tracking-[0.13em] text-accent">
        {t("dashboard.focus.label")}
      </h2>

      {groups.length === 0 ? (
        <Menu
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              className="material-panel is-interactive flex w-full items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3.5 text-left"
            >
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                <Crosshair size={15} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] text-fg">{t("dashboard.focus.emptyTitle")}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted">{t("dashboard.focus.emptyHint")}</p>
              </div>
            </button>
          )}
        >
          <div role="menu" className="absolute left-0 top-full z-20 mt-1.5 max-h-64 w-52 overflow-y-auto rounded-lg border border-line bg-canvas p-1.5 shadow-xl">
            <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
              {t("dashboard.focus.pickProject")}
            </div>
            {pickable.map((p) => (
              <button key={p.id} type="button" role="menuitem" onClick={() => startAdding(p.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-fg hover:bg-elevated">
                <ProjectMark color={p.color} emoji={p.emoji} muted={p.id === NO_PROJECT} />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </Menu>
      ) : (
        <div
          ref={boardRef}
          className={`grid grid-cols-1 items-start gap-x-12 gap-y-8 sm:grid-cols-2 ${dragId ? "cursor-grabbing select-none" : ""}`}
        >
          {groups.map((g) => {
            const expanded = expandedProjects.has(g.projectId);
            const visibleItems = expanded ? g.items : g.items.slice(0, COLLAPSED_TASK_COUNT);
            const isDropCard = drop?.projectId === g.projectId;
            // Count rows other than the one being dragged, so the drop index lines up.
            let visibleIndex = 0;
            return (
              <div
                key={g.projectId}
                data-focus-group={g.projectId}
                className="flex min-w-0 flex-col"
              >
                <div className={`mb-1 flex items-center gap-2 border-b pb-1.5 transition-colors ${
                  isDropCard && dragId ? "border-accent/60" : "border-line"
                }`}>
                  <ProjectMark color={g.color} emoji={g.emoji} muted={g.projectId === NO_PROJECT} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">
                    {g.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => startAdding(g.projectId)}
                    aria-label={t("dashboard.focus.addItemTo", { project: g.name })}
                    title={t("dashboard.focus.addItem")}
                    className="grid h-5 w-5 place-items-center rounded text-faint hover:bg-elevated hover:text-fg"
                  >
                    <Plus size={12} aria-hidden="true" />
                  </button>
                </div>
                <ul className="flex flex-col">
                  {visibleItems.map((it, index) => {
                    const isDragged = it.id === dragId;
                    const showLine =
                      isDropCard && !isDragged && drop?.index === visibleIndex;
                    if (!isDragged) visibleIndex++;
                    return (
                      <li key={it.id} data-focus-row={it.id} className="relative">
                        {showLine ? <DropLine /> : null}
                        <FocusRow
                          item={it}
                          dragging={isDragged}
                          editing={editingId === it.id}
                          onStartEdit={() => {
                            setAddingTo(null);
                            setEditingId(it.id);
                          }}
                          onCommitEdit={(text) => {
                            const next = capitalizeFirst(text);
                            if (next && next !== it.text) rename(it.id, next);
                            setEditingId(null);
                          }}
                          onCancelEdit={() => setEditingId(null)}
                          onToggle={() => toggle(it.id)}
                          onOpen={() => openItem(it.id)}
                          onRemove={() => remove(it.id)}
                          gripProps={{
                            onPointerDown: onGripPointerDown(it.id),
                            onPointerMove: onGripPointerMove(it.id),
                            onPointerUp: onGripPointerUp(it.id),
                            onPointerCancel: onGripPointerCancel,
                            onKeyDown: onGripKeyDown(it, index),
                          }}
                        />
                      </li>
                    );
                  })}
                  {isDropCard && dragId && drop?.index === visibleIndex ? (
                    <li className="relative h-1.5">
                      <DropLine />
                    </li>
                  ) : null}
                </ul>
                {g.items.length > COLLAPSED_TASK_COUNT ? (
                  <button
                    type="button"
                    onClick={() => setExpandedProjects((previous) => {
                      const next = new Set(previous);
                      if (next.has(g.projectId)) next.delete(g.projectId);
                      else next.add(g.projectId);
                      return next;
                    })}
                    aria-expanded={expanded}
                    className="mt-1 self-start rounded px-1 py-0.5 text-[11px] text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {expanded
                      ? t("dashboard.focus.showLess")
                      : t("dashboard.focus.showMore", { count: g.items.length - COLLAPSED_TASK_COUNT })}
                  </button>
                ) : null}
                {addingTo === g.projectId ? (
                  <AddRow
                    onAdd={(text) => void add(g.projectId, capitalizeFirst(text))}
                    onClose={() => setAddingTo(null)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProjectMark({ color, emoji, muted }: { color: string | null; emoji: string | null; muted?: boolean }) {
  if (emoji) {
    return <span className="w-2 text-center text-[12px] leading-none" aria-hidden="true">{emoji}</span>;
  }
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${muted ? "border border-faint" : "bg-accent"}`}
      style={color && !muted ? { backgroundColor: color } : undefined}
      aria-hidden="true"
    />
  );
}

function DropLine() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -top-px left-0 right-1 z-10 h-0.5 rounded-full bg-accent"
    />
  );
}

type GripProps = {
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
};

function FocusRow({
  item,
  dragging,
  editing,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onToggle,
  onOpen,
  onRemove,
  gripProps,
}: {
  item: FocusItem;
  dragging: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCommitEdit: (text: string) => void;
  onCancelEdit: () => void;
  onToggle: () => void;
  onOpen: () => void;
  onRemove: () => void;
  gripProps: GripProps;
}) {
  const { t } = useTranslation("main");
  return (
    <div
      className={`group relative flex items-start gap-1 rounded-md py-1 pr-1 transition-opacity hover:bg-elevated/60 ${
        dragging ? "bg-elevated/80 opacity-50" : ""
      }`}
    >
      <button
        type="button"
        aria-label={t("dashboard.focus.dragHandle", { text: item.text })}
        title={t("dashboard.focus.dragHint")}
        className="absolute -left-3 top-1 grid h-4 w-3 cursor-grab touch-none place-items-center rounded text-faint opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
        {...gripProps}
      >
        <GripVertical size={11} aria-hidden="true" />
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={item.done}
        aria-label={item.text}
        onClick={onToggle}
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${
          item.done
            ? "border-accent bg-accent text-canvas"
            : "border-line text-transparent hover:border-accent"
        }`}
      >
        <Check size={10} strokeWidth={3} aria-hidden="true" />
      </button>
      {editing ? (
        <InlineInput
          initial={item.text}
          onCommit={onCommitEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <span
          onDoubleClick={onStartEdit}
          title={t("dashboard.focus.editHint")}
          className={`ml-1 min-w-0 flex-1 cursor-text select-none text-[12px] leading-4 ${
            item.done ? "text-faint line-through" : "text-fg"
          }`}
        >
          {capitalizeFirst(item.text)}
        </span>
      )}
      {!editing ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("common:itemCard.openAriaLabel", { kind: t("common:itemCard.openTaskWord"), content: item.text.slice(0, 80) })}
          className="shrink-0 rounded p-0.5 text-faint opacity-0 hover:bg-elevated hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Eye size={12} aria-hidden="true" />
        </button>
      ) : null}
      {!editing ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("dashboard.focus.remove")}
          className="shrink-0 rounded p-0.5 text-faint opacity-0 hover:bg-elevated hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={11} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Text field used for both editing and adding. Enter commits, Escape
 *  cancels, blur commits (so clicking away never loses what was typed). */
function InlineInput({
  initial = "",
  placeholder,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (text: string, via: "enter" | "blur") => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done.current = true;
          onCommit(value.trim(), "enter");
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onCommit(value.trim(), "blur");
      }}
      className="ml-1 min-w-0 flex-1 rounded border border-accent/50 bg-canvas px-1.5 py-0 text-[12px] leading-snug text-fg outline-none placeholder:text-faint"
    />
  );
}

/** Inline "new item" field at the bottom of a card. Stays open after Enter
 *  so several items can be typed in a row; closes on Escape or blur. */
function AddRow({ onAdd, onClose }: { onAdd: (text: string) => void; onClose: () => void }) {
  const { t } = useTranslation("main");
  const [key, setKey] = useState(0);
  return (
    <div className="flex items-start gap-1 py-1 pr-1">
      <span className="mt-[1px] h-4 w-4 shrink-0 rounded-full border border-dashed border-line" aria-hidden="true" />
      <InlineInput
        key={key}
        placeholder={t("dashboard.focus.addPlaceholder")}
        onCommit={(text, via) => {
          if (text) onAdd(text);
          if (text && via === "enter") setKey((k) => k + 1);
          else onClose();
        }}
        onCancel={onClose}
      />
    </div>
  );
}
