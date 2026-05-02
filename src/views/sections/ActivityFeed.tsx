import { useCallback, useEffect, useMemo, useState } from "react";
import {
  archiveProject,
  countItemsForProject,
  deleteItem,
  listItems,
  renameProject,
  restoreItem,
  updateItem,
  type Item,
  type ItemKind,
  type Project,
  type Visibility,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { useToasts } from "../../components/ToastProvider";

type Props = {
  /** Optional project filter; when present, the feed shows only that project. */
  project?: Project | null;
  /** Cache of all known projects (for ItemCard pills). */
  projects: Map<string, Project>;
  /** Refresh global project list (after rename/archive). */
  onProjectsChanged?: () => void;
  /** Called after archive — typically clears the project selection. */
  onProjectArchived?: () => void;
};

type VisibilityFilter = "all" | Visibility;
type KindFilter = "all" | ItemKind | "voice";

const PAGE_SIZE = 50;

export default function ActivityFeed({
  project,
  projects,
  onProjectsChanged,
  onProjectArchived,
}: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project?.name ?? "");
  const toasts = useToasts();

  const projectId = project?.id ?? null;

  const fetchPage = useCallback(
    async (mode: "reset" | "append") => {
      setLoading(true);
      setError(null);
      try {
        const nextOffset = mode === "reset" ? 0 : offset;
        const page = await listItems({
          visibility: visibility === "all" ? null : visibility,
          project_id: projectId,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setHasMore(page.length === PAGE_SIZE);
        if (mode === "reset") {
          setItems(page);
          setOffset(page.length);
        } else {
          setItems((prev) => [...prev, ...page]);
          setOffset((o) => o + page.length);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [offset, visibility, projectId],
  );

  useEffect(() => {
    setItems([]);
    setOffset(0);
    setHasMore(true);
    void fetchPage("reset");
    // Intentionally re-run only when filters/project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility, projectId]);

  useEffect(() => {
    if (!project) {
      setProjectCount(null);
      return;
    }
    setRenameValue(project.name);
    let cancelled = false;
    void (async () => {
      try {
        const n = await countItemsForProject(project.id);
        if (!cancelled) setProjectCount(n);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  const filteredItems = useMemo(() => {
    if (kindFilter === "all") return items;
    if (kindFilter === "voice") {
      return items.filter((i) => i.source === "voice_at_cursor");
    }
    return items.filter((i) => i.kind === kindFilter);
  }, [items, kindFilter]);

  const replaceItem = (updated: Item) => {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  };

  const handleEdited = (updated: Item) => replaceItem(updated);

  const handleDelete = async (item: Item) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    try {
      await deleteItem(item.id);
      toasts.push({
        tone: "info",
        message: "Item deleted",
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await restoreItem(item.id);
                // Re-fetch from current filters so it reappears in proper order.
                await fetchPage("reset");
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
      // Restore optimistic UI: reload.
      await fetchPage("reset");
    }
  };

  const handleToggleKind = async (item: Item, next: "note" | "task") => {
    try {
      const updated = await updateItem({ id: item.id, kind: next });
      replaceItem(updated);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const handleRename = async () => {
    if (!project) return;
    const name = renameValue.trim();
    if (!name || name === project.name) {
      setRenaming(false);
      setRenameValue(project.name);
      return;
    }
    try {
      await renameProject(project.id, name);
      onProjectsChanged?.();
      setRenaming(false);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Rename failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const handleArchive = async () => {
    if (!project) return;
    try {
      await archiveProject(project.id);
      toasts.push({ tone: "success", message: `Archived "${project.name}"` });
      onProjectsChanged?.();
      onProjectArchived?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Archive failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <div className="flex h-full flex-col">
      {project ? (
        <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-lg font-semibold focus:border-neutral-500 focus:outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRename();
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setRenameValue(project.name);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void handleRename()}
                className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-white"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight">
                  {project.name}
                </h1>
                <p className="text-xs text-neutral-400">
                  {projectCount === null
                    ? ""
                    : `${projectCount} capture${projectCount === 1 ? "" : "s"}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => void handleArchive()}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-red-950 hover:text-red-200"
                >
                  Archive
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
          <p className="text-xs text-neutral-400">All your captures</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800 bg-neutral-950/40 px-6 py-3 text-xs text-neutral-300">
        <FilterGroup<VisibilityFilter>
          label="Visibility"
          value={visibility}
          options={[
            { value: "all", label: "All" },
            { value: "visible", label: "Visible" },
            { value: "hidden", label: "Hidden" },
          ]}
          onChange={setVisibility}
        />
        <FilterGroup<KindFilter>
          label="Kind"
          value={kindFilter}
          options={[
            { value: "all", label: "All" },
            { value: "note", label: "Note" },
            { value: "task", label: "Task" },
            { value: "voice", label: "Voice" },
          ]}
          onChange={setKindFilter}
        />
        <button
          type="button"
          onClick={() => void fetchPage("reset")}
          className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <div className="mb-3 rounded-md border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}{" "}
            <button
              type="button"
              onClick={() => void fetchPage("reset")}
              className="ml-2 underline"
            >
              Retry
            </button>
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <SkeletonList />
        ) : filteredItems.length === 0 ? (
          <EmptyState
            title={
              project
                ? `Nothing in “${project.name}” yet.`
                : "No captures yet."
            }
            subtitle={
              project
                ? "Use the log capture hotkey to add to this project."
                : "Hold the dictation hotkey to record your first thought."
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {filteredItems.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                projects={projects}
                onEdited={handleEdited}
                onDelete={() => void handleDelete(item)}
                onToggleKind={(next) => void handleToggleKind(item, next)}
              />
            ))}
            {hasMore ? (
              <div className="my-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void fetchPage("append")}
                  disabled={loading}
                  className="rounded border border-neutral-700 px-4 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterGroup<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-neutral-500">{props.label}:</span>
      <div className="flex overflow-hidden rounded-md border border-neutral-800">
        {props.options.map((opt) => {
          const active = opt.value === props.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => props.onChange(opt.value)}
              className={`px-2 py-1 ${
                active
                  ? "bg-neutral-100 text-neutral-900"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SkeletonList() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-lg border border-neutral-800 bg-neutral-900"
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mt-12 flex flex-col items-center text-center text-neutral-400">
      <div className="rounded-full border border-dashed border-neutral-700 px-6 py-3 text-sm">
        {title}
      </div>
      <p className="mt-3 max-w-[320px] text-xs">{subtitle}</p>
    </div>
  );
}
