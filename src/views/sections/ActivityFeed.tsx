import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  countItemsForProject,
  listItems,
  listMeetings,
  listRecordings,
  type Item,
  type MeetingRow,
  type Project,
  type RecordingRow,
} from "../../lib/api";
import ActivityLedgerEntry from "../../components/ActivityLedgerEntry";
import { useTaskIndex } from "../../lib/useTaskIndex";
import KindFilterBar, { type KindFilter } from "../../components/KindFilterBar";
import {
  groupFeedByDay,
  mergeFeed,
  type FeedDayGroup,
  type FeedEntry,
} from "../../lib/feed";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import TasksView from "./TasksView";

type Props = {
  /** Optional project filter; when present, the feed shows only that project. */
  project?: Project | null;
  /** Cache of all known projects (for ItemCard pills). */
  projects: Map<string, Project>;
};

const PAGE_SIZE = 50;

/** Project page feed. Uses the Dashboard's filter toolbar, ledger section and
 *  entry components so both pages look the same. */
export default function ActivityFeed({
  project,
  projects,
}: Props) {
  const { t, i18n } = useTranslation("main");
  const [items, setItems] = useState<Item[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const { refreshTick } = useActivityPanel();

  const projectId = project?.id ?? null;
  const { tasks: taskIndex, reload: reloadTaskIndex } = useTaskIndex(projectId);
  // Read inside fetch callbacks so listeners always fetch the active filter.
  const kindRef = useRef<KindFilter>(kindFilter);
  kindRef.current = kindFilter;

  const fetchPage = useCallback(
    async (mode: "reset" | "append") => {
      const kf = kindRef.current;
      // Tasks render through TasksView; recordings have their own source.
      if (kf === "task" || kf === "recording") return;
      setLoading(true);
      setError(null);
      try {
        const nextOffset = mode === "reset" ? 0 : offset;
        const page = await listItems({
          project_id: projectId,
          kind: kf === "all" ? undefined : kf,
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

  // Meeting rows let meeting items render as the Dashboard's meeting card.
  const loadMeetings = useCallback(async () => {
    try {
      setMeetings(await listMeetings());
    } catch {
      /* non-fatal: meetings fall back to plain item rows */
    }
  }, []);

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
    // Intentionally re-run only when filters/project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, kindFilter]);

  useEffect(() => {
    void loadRecordings();
    void loadMeetings();
  }, [loadRecordings, loadMeetings]);

  // Refetch when the activity panel reports a save/delete.
  useEffect(() => {
    if (refreshTick === 0) return;
    void fetchPage("reset");
    void loadRecordings();
    void loadMeetings();
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
        void loadMeetings();
      };
      const subs = await Promise.all([
        listen("item:created", handler),
        listen("app:refresh", handler),
        listen("meeting-status", handler),
        listen("meeting-complete", handler),
      ]);
      if (cancelled) {
        subs.forEach((u) => u());
      } else {
        unlisteners.push(...subs);
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

  const entries = useMemo<FeedEntry[]>(() => {
    if (kindFilter === "recording") return mergeFeed([], recordings);
    const visible =
      kindFilter === "transcription"
        ? items.filter((i) => i.kind === "transcription" || i.source === "voice_at_cursor")
        : items;
    // Swap loaded meeting items for their meeting row → MeetingCard.
    const loadedIds = new Set(visible.map((i) => i.id));
    const mtgs = meetings.filter((m) => loadedIds.has(m.item_id));
    const recs = kindFilter === "all" ? recordings : [];
    return mergeFeed(visible, recs, mtgs);
  }, [items, recordings, meetings, kindFilter]);

  const isTasks = kindFilter === "task";

  // Same day dividers (and i18n keys / .echo-feed-day styling) as the Dashboard.
  const groupLabel = (group: FeedDayGroup) =>
    group.day === "today"
      ? t("dashboard.activity.todayLabel")
      : group.day === "yesterday"
        ? t("dashboard.activity.yesterdayLabel")
        : group.date.toLocaleDateString(i18n.language, {
            weekday: "long",
            month: "long",
            day: "numeric",
            ...(group.date.getFullYear() !== new Date().getFullYear()
              ? { year: "numeric" as const }
              : {}),
          });

  return (
    <div className="echo-dashboard flex h-full min-h-0 flex-col overflow-hidden">
      <div className="echo-dashboard-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-5">
        <KindFilterBar
          value={kindFilter}
          onChange={setKindFilter}
          hide={project ? ["recording"] : []}
        >
          {project && projectCount !== null ? (
            <span className="text-[11px] tabular-nums text-faint">
              {t("activityFeed.header.captureCount", { count: projectCount })}
            </span>
          ) : null}
        </KindFilterBar>

        <section
          className="echo-activity-ledger"
          aria-label={project ? project.name : t("activityFeed.header.allActivityTitle")}
        >

          {error ? (
            <div className="my-3 rounded-md border border-danger/40 bg-danger/15 px-3 py-2 text-sm text-danger">
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

          {isTasks ? (
            <div className="py-3">
              <TasksView projects={projects} embedded projectId={projectId} />
            </div>
          ) : loading && entries.length === 0 ? (
            <SkeletonList />
          ) : entries.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-muted">
                {kindFilter === "recording"
                  ? t("activityFeed.emptyState.noRecordings")
                  : project
                    ? t("activityFeed.emptyState.nothingInProject", { name: project.name })
                    : t("activityFeed.emptyState.noCaptures")}
              </p>
              <p className="mt-1 text-[11px] text-faint">
                {kindFilter === "recording"
                  ? t("activityFeed.emptyState.recordingsSubtitle")
                  : project
                    ? t("activityFeed.emptyState.projectSubtitle")
                    : t("activityFeed.emptyState.defaultSubtitle")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col">
              {groupFeedByDay(entries).map((group) => (
                <div key={group.key} role="group" aria-label={groupLabel(group)}>
                  <div className="echo-feed-day" aria-hidden="true">
                    {groupLabel(group)}
                  </div>
                  {group.entries.map((entry) => (
                    <ActivityLedgerEntry
                      key={entry.key}
                      entry={entry}
                      projects={projects}
                      hideProject={project}
                      tasks={taskIndex}
                      onTaskChanged={() => void reloadTaskIndex()}
                    />
                  ))}
                </div>
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
        </section>
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
