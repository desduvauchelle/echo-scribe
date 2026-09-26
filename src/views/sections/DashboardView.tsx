import MorningFocus from "../../components/MorningFocus";
import { listen } from "@tauri-apps/api/event";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Crosshair,
  Download,
  Loader2,
  Search as SearchIcon,
  Tags,
  X,
} from "lucide-react";
import {
  exportActivity,
  getDashboardStats,
  listItems,
  listMeetings,
  listRecordings,
  runProjectTaggerAll,
  searchItems,
  type ProjectTaggerProgress,
  type DashboardStats,
  type Item,
  type MeetingRow,
  type Project,
  type RecordingRow,
  type StatsCategoryKey,
} from "../../lib/api";
import { useToasts } from "../../components/ToastProvider";
import Menu from "../../components/a11y/Menu";
import ActivityLedgerEntry from "../../components/ActivityLedgerEntry";
import { useTaskIndex } from "../../lib/useTaskIndex";
import { STATS_CATEGORIES } from "../../components/StatsCategoryTabs";
import SectionHeader from "../../components/SectionHeader";
import { compactNumber } from "../../lib/format";
import {
  groupFeedByDay,
  mergeBrowseFeed,
  mergeFeed,
  recordingMatches,
  type FeedDayGroup,
  type FeedEntry,
} from "../../lib/feed";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import { SkeletonList } from "./ActivityFeed";
import TasksView from "./TasksView";
import KindFilterBar, { type KindFilter } from "../../components/KindFilterBar";
import FocusBoard from "../../components/FocusBoard";
import MeetingDebriefSection from "../../components/MeetingDebrief";
import { LearningCard } from "../../components/Learning";
import { useLearning } from "../../components/LearningContext";
import type { LessonId } from "../../lib/learning";

const PAGE_SIZE = 50;

type Props = {
  projects: Map<string, Project>;
  onOpenStats: (category: StatsCategoryKey) => void;
  searchRequest?: number;
  initialFilter?: "task" | "recording";
  onLesson?: (id?: LessonId) => void;
};


function statsCategoryForFilter(filter: KindFilter): StatsCategoryKey | null {
  switch (filter) {
    case "transcription":
      return "transcriptions";
    case "note":
      return "notes";
    case "task":
      return "tasks";
    case "meeting":
      return "meetings";
    case "recording":
      return "recordings";
    case "all":
      return null;
  }
}

type ExportRangeKey = "day" | "today" | "week" | "month" | "all";

function exportRanges(t: (key: string) => string): { key: ExportRangeKey; label: string }[] {
  return [
    { key: "day", label: t("dashboard.export.ranges.day") },
    { key: "today", label: t("dashboard.export.ranges.today") },
    { key: "week", label: t("dashboard.export.ranges.week") },
    { key: "month", label: t("dashboard.export.ranges.month") },
    { key: "all", label: t("dashboard.export.ranges.all") },
  ];
}

/** ISO-8601 UTC lower bound for an export range; null = no bound. Seconds
 *  precision to match the backend's captured_at format. */
function exportSince(key: ExportRangeKey): string | null {
  const now = new Date();
  let start: Date;
  switch (key) {
    case "today":
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "day":
      start = new Date(now.getTime() - 24 * 3600_000);
      break;
    case "week":
      start = new Date(now.getTime() - 7 * 24 * 3600_000);
      break;
    case "month":
      start = new Date(now.getTime() - 30 * 24 * 3600_000);
      break;
    case "all":
      return null;
  }
  return start.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const EMPTY_LABEL_KEYS: Record<Exclude<KindFilter, "all" | "task">, string> = {
  transcription: "dashboard.empty.transcriptions",
  note: "dashboard.empty.notes",
  meeting: "dashboard.empty.meetings",
  recording: "dashboard.empty.recordings",
};

function emptyLabel(t: (key: string) => string, kind: KindFilter): string {
  if (kind === "all" || kind === "task") return t("dashboard.empty.nothing");
  return t(EMPTY_LABEL_KEYS[kind]);
}

export default function DashboardView({ projects, onOpenStats, searchRequest = 0, initialFilter, onLesson }: Props) {
  const learning = useLearning();
  const { t, i18n } = useTranslation("main");
  const EXPORT_RANGES = exportRanges(t);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>(initialFilter ?? "all");
  const [error, setError] = useState<string | null>(null);
  const [showEmptyFocus, setShowEmptyFocus] = useState(false);

  const [searchOpen, setSearchOpen] = useState(searchRequest > 0);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastSearchRequestRef = useRef(searchRequest);

  if (lastSearchRequestRef.current !== searchRequest) {
    lastSearchRequestRef.current = searchRequest;
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  const [exportOpen, setExportOpen] = useState(false);
  const [exportRange, setExportRange] = useState<ExportRangeKey>("day");
  const [exporting, setExporting] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tagProgress, setTagProgress] = useState<ProjectTaggerProgress | null>(null);
  const { push: pushToast } = useToasts();

  const { refreshTick, selectedItemId, selectedRecordingId } = useActivityPanel();
  const { tasks: taskIndex, reload: reloadTaskIndex } = useTaskIndex();

  // Current kind filter, read inside callbacks (event listeners, refetch) so
  // they always fetch the active filter without being recreated on each change.
  const kindRef = useRef<KindFilter>(kindFilter);
  kindRef.current = kindFilter;

  const loadRecordings = useCallback(async () => {
    try {
      setRecordings(await listRecordings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadMeetings = useCallback(async () => {
    try {
      setMeetings(await listMeetings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fetchItems = useCallback(async (mode: "reset" | "append") => {
    if (mode === "append") setLoadingMore(true);
    try {
      const nextOffset = mode === "reset" ? 0 : offset;
      // "all" and "recording" are not item kinds → no server-side kind filter.
      // "meeting" never reaches here — it's served from `meetings`.
      const kf = kindRef.current;
      const kind = kf === "all" || kf === "recording" ? undefined : kf;
      const page = await listItems({ kind, limit: PAGE_SIZE, offset: nextOffset });
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
      setLoadingMore(false);
    }
  }, [offset]);

  const loadAll = useCallback(async () => {
    try {
      setStats(await getDashboardStats());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadAll();
    void loadRecordings();
    void loadMeetings();
  }, [loadAll, loadRecordings, loadMeetings]);

  // Fetch items on mount and whenever the kind filter changes. Tasks,
  // Meetings and Recordings use their own data path, so skip the item fetch
  // for those.
  useEffect(() => {
    if (
      kindFilter === "task" ||
      kindFilter === "recording" ||
      kindFilter === "meeting"
    )
      return;
    void fetchItems("reset");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindFilter]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void loadAll();
    void fetchItems("reset");
    void loadRecordings();
    void loadMeetings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const handler = () => {
        if (cancelled) return;
        void loadAll();
        void fetchItems("reset");
        void loadRecordings();
        void loadMeetings();
      };
      const meetingHandler = () => {
        if (cancelled) return;
        void loadAll();
        void loadMeetings();
      };
      const recordingHandler = () => {
        if (cancelled) return;
        void loadAll();
        void loadRecordings();
      };
      const subs = await Promise.all([
        listen("item:created", handler),
        listen("app:refresh", handler),
        // A meeting's card changes as it moves through recording →
        // transcribing → summarizing → complete.
        listen("meeting-status", meetingHandler),
        listen("meeting-complete", meetingHandler),
        // A screen recording started/stopped/edited/deleted/uploaded — refresh
        // the recordings that are interleaved into the feed. Without this a
        // finished recording only appears after a full app reload.
        listen("screenrec-changed", recordingHandler),
      ]);
      if (cancelled) {
        subs.forEach((u) => u());
      } else {
        unlisteners.push(...subs);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        // Recordings aren't in the items FTS index; "all"/"recording" search the
        // items table unfiltered and merge client-filtered recordings in render.
        const kind =
          kindFilter === "all" || kindFilter === "recording"
            ? undefined
            : kindFilter;
        const r = await searchItems(q, { kind, limit: 50 });
        setSearchResults(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, kindFilter]);

  const isSearching = searchOpen && query.trim() !== "";
  const isTasks = kindFilter === "task";
  const isRecordings = kindFilter === "recording";
  const isMeetings = kindFilter === "meeting";
  const statsCategory = statsCategoryForFilter(kindFilter);

  // Meetings keyed by their item id, so a meeting-kind search hit can be
  // rendered as a meeting card rather than a bare item.
  const meetingsById = useMemo(
    () => new Map(meetings.map((m) => [m.item_id, m])),
    [meetings],
  );

  // Browse feed: recordings and meetings interleave with items under "All";
  // the single-kind filters show only their own source.
  const browseEntries = useMemo(() => {
    if (kindFilter === "recording") return mergeFeed([], recordings);
    if (kindFilter === "meeting") return mergeFeed([], [], meetings);
    if (kindFilter === "all") {
      return mergeBrowseFeed(items, recordings, meetings, hasMore);
    }
    return mergeFeed(items, []);
  }, [kindFilter, items, recordings, meetings, hasMore]);

  // Search feed: items from FTS + recordings matched client-side on
  // title/transcript. Meeting-kind hits are swapped for their meeting row.
  const searchEntries = useMemo(() => {
    const q = query.trim();
    const recs =
      kindFilter === "all" || kindFilter === "recording"
        ? recordings.filter((r) => recordingMatches(r, q))
        : [];
    const its = kindFilter === "recording" ? [] : searchResults;
    const hitMeetings = its
      .map((i) => meetingsById.get(i.id))
      .filter((m): m is MeetingRow => m !== undefined);
    return mergeFeed(its, recs, hitMeetings);
  }, [kindFilter, query, searchResults, recordings, meetingsById]);

  useEffect(() => {
    if (!isSearching || learning.state.retrieved) return;
    const opened = searchEntries.some((entry) =>
      entry.type === "recording" ? entry.rec.id === selectedRecordingId :
      entry.type === "meeting" ? entry.mtg.item_id === selectedItemId : entry.item.id === selectedItemId);
    if (opened) learning.update((s) => ({ ...s, retrieved: true }));
  }, [selectedItemId, selectedRecordingId, isSearching, searchEntries, learning.state.retrieved, learning.update]);

  const renderEntry = (entry: FeedEntry) => (
    <ActivityLedgerEntry
      key={entry.key}
      entry={entry}
      projects={projects}
      tasks={taskIndex}
      onTaskChanged={() => void reloadTaskIndex()}
    />
  );

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

  /** Feed entries under small per-day dividers (Today / Yesterday / date). */
  const renderGrouped = (entries: FeedEntry[]) =>
    groupFeedByDay(entries).map((group) => (
      <div key={group.key} role="group" aria-label={groupLabel(group)}>
        <div className="echo-feed-day" aria-hidden="true">
          {groupLabel(group)}
        </div>
        {group.entries.map(renderEntry)}
      </div>
    ));

  const runExport = async (format: "markdown" | "csv") => {
    setExporting(true);
    try {
      const range = EXPORT_RANGES.find((r) => r.key === exportRange) ?? EXPORT_RANGES[0];
      const res = await exportActivity({
        since: exportSince(exportRange),
        format,
        rangeLabel: range.label,
      });
      pushToast({
        tone: "success",
        message: t("dashboard.export.successToast", { count: res.count }),
      });
      setExportOpen(false);
    } catch (e) {
      // Backend already returns a friendly message and logs the detail.
      pushToast({
        tone: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExporting(false);
    }
  };

  /** Manual "tag everything now": queues every untagged capture (all item
   *  kinds + recordings), then works through the whole queue — router first,
   *  local AI where the router can't decide. Progress streams back via
   *  `tagger:progress` events and shows on the button. */
  const runTagging = async () => {
    setTagging(true);
    setTagProgress(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<ProjectTaggerProgress>("tagger:progress", (e) => {
        setTagProgress(e.payload);
      });
      const s = await runProjectTaggerAll();
      const undecided = s.scanned - s.assigned;
      if (s.scanned === 0) {
        pushToast({
          tone: "success",
          message: t("dashboard.tagging.toastNothingToTag"),
        });
      } else if (s.sample_error && s.assigned === 0) {
        pushToast({
          tone: "error",
          durationMs: 20_000,
          message: t("dashboard.tagging.toastAllFailed", {
            scanned: s.scanned,
            error: s.sample_error,
          }),
        });
      } else {
        const notes = [
          undecided > 0
            ? t("dashboard.tagging.toastUndecided", { count: undecided })
            : null,
          s.sample_error
            ? t("dashboard.tagging.toastAiErrorNote", { error: s.sample_error })
            : null,
        ]
          .filter(Boolean)
          .join(" ");
        pushToast({
          tone: "success",
          durationMs: 15_000,
          message: `${t("dashboard.tagging.toastFinished", { assigned: s.assigned, scanned: s.scanned })}${notes ? ` ${notes}` : ""}`,
        });
      }
      if (s.assigned > 0) {
        void fetchItems("reset");
        void loadRecordings();
      }
    } catch (e) {
      pushToast({
        tone: "error",
        durationMs: 20_000,
        message: t("dashboard.tagging.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      unlisten?.();
      setTagging(false);
      setTagProgress(null);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setSearchResults([]);
  };

  if (error && !stats) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-danger">
        {error}
      </div>
    );
  }

  const toolbarActions = (
    <>
      <button type="button" onClick={() => setShowEmptyFocus(true)}
        aria-label={t("dashboard.focus.addFirst")} title={t("dashboard.focus.addFirst")}
        className="native-toolbar-button grid h-7 w-7 place-items-center rounded-md text-muted hover:text-fg">
        <Crosshair size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void runTagging()}
        disabled={tagging}
        aria-label={t("dashboard.tagging.button")}
        title={t("dashboard.tagging.buttonTooltip")}
        className="native-toolbar-button flex h-7 items-center gap-1.5 rounded-md px-2 text-muted hover:text-fg disabled:opacity-70"
      >
        {tagging ? (
          <span aria-live="polite" className="flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" />
            {tagProgress ? (
              <span className="text-[11px] tabular-nums">
                {t("dashboard.tagging.progress", {
                  processed: tagProgress.processed,
                  total: tagProgress.total,
                })}
                {tagProgress.assigned > 0
                  ? ` · ${t("dashboard.tagging.taggedSuffix", { count: tagProgress.assigned })}`
                  : ""}
              </span>
            ) : null}
          </span>
        ) : (
          <Tags size={14} />
        )}
      </button>
      <Menu
        open={exportOpen}
        onOpenChange={setExportOpen}
        renderTrigger={(props) => (
          <button
            {...props}
            type="button"
            aria-label={t("dashboard.export.title")}
            title={t("dashboard.export.title")}
            className="native-toolbar-button grid h-7 w-7 place-items-center rounded-md text-muted hover:text-fg"
          >
            <Download size={14} />
          </button>
        )}
      >
            <div className="absolute right-0 top-full z-20 mt-1.5 w-56 rounded-lg border border-line bg-canvas p-3 shadow-xl">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                {t("dashboard.export.title")}
              </div>
              <div className="flex flex-col gap-1">
                {EXPORT_RANGES.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setExportRange(r.key)}
                    className={`rounded px-2 py-1 text-left text-xs transition-colors ${
                      exportRange === r.key
                        ? "bg-fg text-canvas"
                        : "text-muted hover:bg-elevated hover:text-fg"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex gap-1.5">
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void runExport("markdown")}
                  className="flex-1 rounded border border-line bg-surface px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50"
                >
                  {exporting ? t("dashboard.export.exporting") : t("dashboard.export.formats.markdown")}
                </button>
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void runExport("csv")}
                  className="flex-1 rounded border border-line bg-surface px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50"
                >
                  {exporting ? t("dashboard.export.exporting") : t("dashboard.export.formats.csv")}
                </button>
              </div>
            </div>
      </Menu>
    </>
  );

  return (
    <div className="echo-dashboard flex h-full min-h-0 flex-col overflow-hidden">
      <div className="echo-dashboard-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-5">
        <MorningFocus
          pulse={
            stats ? (
              <WeekPulse
                stats={stats}
                onOpen={() => onOpenStats(statsCategory ?? "transcriptions")}
              />
            ) : null
          }
        />
        {onLesson && <LearningCard onLesson={onLesson} />}

        {!isSearching ? <MeetingDebriefSection projects={projects} /> : null}

        {!isSearching ? <FocusBoard projects={projects} showEmpty={showEmptyFocus} onHideEmpty={() => setShowEmptyFocus(false)} /> : null}

        <section className="echo-activity-ledger py-3" aria-labelledby="activity-heading">
          <SectionHeader
            eyebrow={isSearching ? t("dashboard.activity.searchResultsLabel") : t("dashboard.activity.label")}
            title={isSearching ? t("dashboard.activity.matchesFor", { query: query.trim() }) : undefined}
            headingId="activity-heading"
            actions={toolbarActions}
            className="mb-0"
          />

          {searchOpen ? (
          <div className="material-search mt-2 flex items-center gap-2 rounded-md px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
            <SearchIcon size={14} className="shrink-0 text-faint" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("dashboard.search.placeholder")}
              aria-label={t("dashboard.search.ariaLabel")}
              className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
            />
            <button
              type="button"
              onClick={closeSearch}
              aria-label={t("dashboard.search.closeLabel")}
              className="rounded p-0.5 text-faint hover:bg-elevated hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
          ) : null}

          <KindFilterBar value={kindFilter} onChange={setKindFilter} />

        {isTasks ? (
          <div className="py-3">
          <TasksView projects={projects} embedded />
          </div>
        ) : isSearching ? (
          <div className="flex flex-col">
          {searching && searchEntries.length === 0 ? (
            <SkeletonList />
          ) : searchEntries.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted">
              {t("dashboard.search.noResults", { query: query.trim() })}
            </p>
          ) : (
            renderGrouped(searchEntries)
          )}
          </div>
        ) : (
          <div className="flex flex-col">
          {browseEntries.length === 0 &&
          !error &&
          hasMore &&
          !isRecordings &&
          !isMeetings ? (
            <SkeletonList />
          ) : browseEntries.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted">
              {emptyLabel(t, kindFilter)}
            </p>
          ) : (
            <>
              {renderGrouped(browseEntries)}
              {hasMore && !isRecordings && !isMeetings ? (
                <div className="my-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void fetchItems("append")}
                    disabled={loadingMore}
                    className="rounded border border-line px-4 py-1 text-xs hover:bg-elevated disabled:opacity-50"
                  >
                    {loadingMore ? t("dashboard.activity.loading") : t("dashboard.activity.loadMore")}
                  </button>
                </div>
              ) : null}
            </>
          )}
          </div>
        )}
        </section>
      </div>

    </div>
  );
}

const PULSE_PERIOD_KEY = "tucky.dashboard.pulsePeriod";
type PulsePeriod = "today" | "week";

/** One-line activity pulse under the greeting; replaces the stat cards.
 *  Always shows every category (zero counts are skipped), independent of the
 *  activity filter. */
function WeekPulse({
  stats,
  onOpen,
}: {
  stats: DashboardStats;
  onOpen: () => void;
}) {
  const { t } = useTranslation("main");
  const [period, setPeriod] = useState<PulsePeriod>(() => {
    try {
      return localStorage.getItem(PULSE_PERIOD_KEY) === "today" ? "today" : "week";
    } catch {
      return "week";
    }
  });
  const togglePeriod = () => {
    const next = period === "week" ? "today" : "week";
    setPeriod(next);
    try {
      localStorage.setItem(PULSE_PERIOD_KEY, next);
    } catch { /* Keep the toggle usable when storage is unavailable. */ }
  };
  const parts = STATS_CATEGORIES.map(({ key }) => ({
    key,
    count: stats.categories[key][period].count,
  })).filter((p) => p.count > 0);

  return (
    <div
      role="region"
      aria-label={t("dashboard.stats.regionLabel")}
      className="tucky-pulse"
    >
      <button type="button" onClick={togglePeriod} className="tucky-pulse-label">
        {t(period === "week" ? "dashboard.stats.pulseLabel" : "dashboard.stats.pulseTodayLabel")}
      </button>
      {parts.length === 0 ? (
        <span>{t("dashboard.stats.pulseEmpty")}</span>
      ) : (
        parts.map((p, i) => (
          <Fragment key={p.key}>
            {i > 0 ? <span className="tucky-pulse-sep" aria-hidden="true">·</span> : null}
            <span className="tucky-pulse-item">
              <strong>{compactNumber(p.count)}</strong>{" "}
              {t(`dashboard.stats.pulse.${p.key}`, { count: p.count })}
            </span>
          </Fragment>
        ))
      )}
      <span className="tucky-pulse-sep" aria-hidden="true">·</span>
      <button type="button" onClick={onOpen} className="tucky-pulse-link">
        {t("dashboard.stats.viewStats")}
        <ChevronRight size={11} aria-hidden="true" />
      </button>
    </div>
  );
}
