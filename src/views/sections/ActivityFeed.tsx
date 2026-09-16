import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Inbox, Mic } from "lucide-react";
import {
  countItemsForProject,
  listItems,
  listRecordings,
  type Item,
  type ItemKind,
  type Project,
  type RecordingRow,
} from "../../lib/api";
import ActivityLedgerEntry from "../../components/ActivityLedgerEntry";
import { mergeFeed, type FeedEntry } from "../../lib/feed";
import { useActivityPanel } from "../../components/ActivityPanelContext";

type Props = {
  /** Optional project filter; when present, the feed shows only that project. */
  project?: Project | null;
  /** Cache of all known projects (for ItemCard pills). */
  projects: Map<string, Project>;
};

type KindFilter = "all" | ItemKind | "recording";

const PAGE_SIZE = 50;

export default function ActivityFeed({
  project,
  projects,
}: Props) {
  const { t } = useTranslation("main");
  const [items, setItems] = useState<Item[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const { refreshTick } = useActivityPanel();

  const projectId = project?.id ?? null;

  const fetchPage = useCallback(
    async (mode: "reset" | "append") => {
      setLoading(true);
      setError(null);
      try {
        const nextOffset = mode === "reset" ? 0 : offset;
        const page = await listItems({
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
    [offset, projectId],
  );

  // Recordings have no project, so they only appear in the global feed.
  const loadRecordings = useCallback(async () => {
    if (projectId) {
      setRecordings([]);
      return;
    }
    try {
      setRecordings(await listRecordings());
    } catch {
      /* non-fatal: feed still shows items */
    }
  }, [projectId]);

  useEffect(() => {
    setItems([]);
    setOffset(0);
    setHasMore(true);
    void fetchPage("reset");
    void loadRecordings();
    // Intentionally re-run only when filters/project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Refetch when the activity panel reports a save/delete.
  useEffect(() => {
    if (refreshTick === 0) return;
    void fetchPage("reset");
    void loadRecordings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const subscribe = async () => {
      const handler = () => {
        if (cancelled) return;
        void fetchPage("reset");
        void loadRecordings();
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
  }, [projectId]);

  useEffect(() => {
    if (!project) {
      setProjectCount(null);
      return;
    }
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
    if (kindFilter === "recording") return [];
    if (kindFilter === "all") return items;
    if (kindFilter === "transcription") {
      return items.filter(
        (i) => i.kind === "transcription" || i.source === "voice_at_cursor",
      );
    }
    if (kindFilter === "meeting") {
      return items.filter(
        (i) => i.kind === "meeting" || i.source === "meeting",
      );
    }
    return items.filter((i) => i.kind === kindFilter);
  }, [items, kindFilter]);

  // Recordings interleave under "All" and "Recordings" (global feed only).
  const entries = useMemo<FeedEntry[]>(() => {
    const recs =
      kindFilter === "all" || kindFilter === "recording" ? recordings : [];
    return mergeFeed(filteredItems, recs);
  }, [filteredItems, recordings, kindFilter]);

  return (
    <div className="flex h-full flex-col">
      {!project && (
        <div className="border-b border-line bg-canvas/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">{t("activityFeed.header.allActivityTitle")}</h1>
          <p className="text-xs text-muted">{t("activityFeed.header.allActivitySubtitle")}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas/40 px-6 py-3 text-xs text-muted">
        {project && projectCount !== null && <span className="mr-auto">{t("activityFeed.header.captureCount", { count: projectCount })}</span>}
        <FilterGroup<KindFilter>
          label={t("activityFeed.filter.kindLabel")}
          value={kindFilter}
          options={[
            { value: "all", label: t("activityFeed.filter.options.all") },
            { value: "transcription", label: t("activityFeed.filter.options.transcription") },
            { value: "note", label: t("activityFeed.filter.options.note") },
            { value: "task", label: t("activityFeed.filter.options.task") },
            { value: "meeting", label: t("activityFeed.filter.options.meeting") },
            { value: "recording", label: t("activityFeed.filter.options.recording") },
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
              {t("activityFeed.error.retry")}
            </button>
          </div>
        ) : null}

        {loading && entries.length === 0 ? (
          <SkeletonList />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={
              project ? (
                <Inbox size={20} strokeWidth={1.75} />
              ) : (
                <Mic size={20} strokeWidth={1.75} />
              )
            }
            title={
              kindFilter === "recording"
                ? t("activityFeed.emptyState.noRecordings")
                : project
                  ? t("activityFeed.emptyState.nothingInProject", { name: project.name })
                  : t("activityFeed.emptyState.noCaptures")
            }
            subtitle={
              kindFilter === "recording"
                ? t("activityFeed.emptyState.recordingsSubtitle")
                : project
                  ? t("activityFeed.emptyState.projectSubtitle")
                  : t("activityFeed.emptyState.defaultSubtitle")
            }
          />
        ) : (
          <div className="echo-activity-ledger flex flex-col">
            {entries.map((entry) => (
              <ActivityLedgerEntry
                key={entry.key}
                entry={entry}
                projects={projects}
              />
            ))}
            {hasMore && kindFilter !== "recording" ? (
              <div className="my-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void fetchPage("append")}
                  disabled={loading}
                  className="rounded border border-line px-4 py-1 text-xs hover:bg-elevated disabled:opacity-50"
                >
                  {loading ? t("activityFeed.loadMore.loading") : t("activityFeed.loadMore.label")}
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
