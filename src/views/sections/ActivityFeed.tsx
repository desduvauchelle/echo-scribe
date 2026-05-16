import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Mic } from "lucide-react";
import {
  archiveProject,
  countItemsForProject,
  listItems,
  renameProject,
  type Item,
  type ItemKind,
  type Project,
  type Visibility,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { useActivityPanel } from "../../components/ActivityPanelContext";
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
  const { refreshTick } = useActivityPanel();

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

  // Refetch when the activity panel reports a save/delete.
  useEffect(() => {
    if (refreshTick === 0) return;
    void fetchPage("reset");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const subscribe = async () => {
      const handler = () => {
        if (!cancelled) void fetchPage("reset");
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
        <div className="border-b border-line bg-canvas/40 px-6 py-4">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-lg font-semibold focus:border-accent focus:outline-none"
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
                className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
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
                <p className="text-xs text-muted">
                  {projectCount === null
                    ? ""
                    : `${projectCount} capture${projectCount === 1 ? "" : "s"}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="rounded border border-line px-2 py-1 text-xs hover:bg-elevated"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => void handleArchive()}
                  className="rounded border border-line px-2 py-1 text-xs hover:bg-danger/15 hover:text-danger"
                >
                  Archive
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="border-b border-line bg-canvas/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
          <p className="text-xs text-muted">All your captures</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas/40 px-6 py-3 text-xs text-muted">
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
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/15 px-3 py-2 text-sm text-danger">
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
            icon={
              project ? (
                <Inbox size={20} strokeWidth={1.75} />
              ) : (
                <Mic size={20} strokeWidth={1.75} />
              )
            }
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
              />
            ))}
            {hasMore ? (
              <div className="my-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void fetchPage("append")}
                  disabled={loading}
                  className="rounded border border-line px-4 py-1 text-xs hover:bg-elevated disabled:opacity-50"
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
      <span className="text-faint">{props.label}:</span>
      <div className="flex overflow-hidden rounded-md border border-line">
        {props.options.map((opt) => {
          const active = opt.value === props.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => props.onChange(opt.value)}
              className={`px-2 py-1 ${
                active
                  ? "bg-fg text-canvas"
                  : "bg-surface text-muted hover:bg-elevated"
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
          className="h-16 animate-pulse rounded-lg border border-line bg-surface"
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mt-12 flex flex-col items-center gap-3 text-center text-muted">
      {icon ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
          {icon}
        </div>
      ) : null}
      <div className="rounded-full border border-dashed border-line px-5 py-2 text-[13px] font-medium text-fg">
        {title}
      </div>
      <p className="max-w-[320px] text-xs leading-relaxed">{subtitle}</p>
    </div>
  );
}
