import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ChevronRight,
  Download,
  LayoutGrid,
  Loader2,
  Mic,
  Phone,
  Search as SearchIcon,
  StickyNote,
  Tags,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  exportActivity,
  getDailySummary,
  getDashboardStats,
  listItems,
  listMeetings,
  listRecordings,
  runProjectTaggerAll,
  searchItems,
  type ProjectTaggerProgress,
  type DailySummary,
  type DailySummarySectionItem,
  type DashboardStats,
  type Item,
  type ItemKind,
  type MeetingRow,
  type Project,
  type RecordingRow,
  type StatsCategoryKey,
} from "../../lib/api";
import { useToasts } from "../../components/ToastProvider";
import Menu from "../../components/a11y/Menu";
import Dialog from "../../components/a11y/Dialog";
import ActivityLedgerEntry from "../../components/ActivityLedgerEntry";
import {
  STATS_CATEGORIES,
  categoryMeta,
  formatDuration,
} from "../../components/StatsCategoryTabs";
import { compactNumber } from "../../lib/format";
import {
  mergeBrowseFeed,
  mergeFeed,
  recordingMatches,
  type FeedEntry,
} from "../../lib/feed";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import { SkeletonList } from "./ActivityFeed";
import TasksView from "./TasksView";

const PAGE_SIZE = 50;

type Props = {
  projects: Map<string, Project>;
  onOpenStats: (category: StatsCategoryKey) => void;
  searchRequest?: number;
};

type KindFilter = "all" | ItemKind | "recording";

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

function yesterdayLocalIso(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

type ExportRangeKey = "day" | "today" | "week" | "month" | "all";

const EXPORT_RANGES: { key: ExportRangeKey; label: string }[] = [
  { key: "day", label: "Past 24 hours" },
  { key: "today", label: "Today" },
  { key: "week", label: "Past 7 days" },
  { key: "month", label: "Past 30 days" },
  { key: "all", label: "All time" },
];

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

const EMPTY_LABELS: Record<Exclude<KindFilter, "all" | "task">, string> = {
  transcription: "No transcriptions yet.",
  note: "No notes yet.",
  meeting: "No meetings yet.",
  recording: "No recordings yet.",
};

function emptyLabel(kind: KindFilter): string {
  if (kind === "all" || kind === "task") return "Nothing here yet.";
  return EMPTY_LABELS[kind];
}

export default function DashboardView({ projects, onOpenStats, searchRequest = 0 }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [recapOpen, setRecapOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
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

  const { refreshTick } = useActivityPanel();
  const yesterday = useMemo(() => yesterdayLocalIso(), []);

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
      const [s, d] = await Promise.all([
        getDashboardStats(),
        getDailySummary(yesterday),
      ]);
      setStats(s);
      setSummary(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [yesterday]);

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
        void fetchItems("reset");
        void loadRecordings();
        void loadMeetings();
      };
      const meetingHandler = () => {
        if (cancelled) return;
        void loadMeetings();
      };
      const recordingHandler = () => {
        if (cancelled) return;
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

  const renderEntry = (entry: FeedEntry) => (
    <ActivityLedgerEntry key={entry.key} entry={entry} projects={projects} />
  );

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
        message: `Exported ${res.count} item${res.count === 1 ? "" : "s"} to Downloads.`,
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
          message: "Tagging ran — everything already has a project.",
        });
      } else if (s.sample_error && s.assigned === 0) {
        pushToast({
          tone: "error",
          durationMs: 20_000,
          message: `Tagging checked ${s.scanned} captures but couldn't assign any. AI error: ${s.sample_error}`,
        });
      } else {
        const notes = [
          undecided > 0
            ? `${undecided} had no clear project and will be retried later.`
            : null,
          s.sample_error ? `Some hit an AI error: ${s.sample_error}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        pushToast({
          tone: "success",
          durationMs: 15_000,
          message: `Tagging finished: ${s.assigned} of ${s.scanned} captures assigned to a project.${notes ? ` ${notes}` : ""}`,
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
        message: `Tagging failed: ${e instanceof Error ? e.message : String(e)}`,
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

  return (
    <div className="echo-dashboard flex h-full min-h-0 flex-col overflow-hidden">
      <div className="echo-dashboard-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-5">
        <div className="echo-filter-toolbar flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          {(
            [
              ["all", "All", LayoutGrid],
              ["transcription", "Transcriptions", Mic],
              ["note", "Notes", StickyNote],
              ["task", "Tasks", CheckSquare],
              ["meeting", "Meetings", Phone],
              ["recording", "Recordings", Video],
            ] as [KindFilter, string, LucideIcon][]
          ).map(([value, label, Icon]) => {
            const active = value === kindFilter;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setKindFilter(value)}
                className={`material-filter flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] ${
                  active
                    ? "is-active"
                    : "text-muted hover:text-fg"
                }`}
              >
                <Icon size={12} strokeWidth={2} />
                {label}
              </button>
            );
          })}
          </div>
          <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void runTagging()}
            disabled={tagging}
            aria-label="Tag all captures"
            title="Tag all untagged captures with a project"
            className="native-toolbar-button flex h-7 items-center gap-1.5 rounded-md px-2 text-muted hover:text-fg disabled:opacity-70"
          >
            {tagging ? (
              <span aria-live="polite" className="flex items-center gap-1.5">
                <Loader2 size={14} className="animate-spin" />
                {tagProgress ? (
                  <span className="text-[11px] tabular-nums">
                    {tagProgress.processed}/{tagProgress.total}
                    {tagProgress.assigned > 0 ? ` · ${tagProgress.assigned} tagged` : ""}
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
                aria-label="Export activity"
                title="Export activity"
                className="native-toolbar-button grid h-7 w-7 place-items-center rounded-md text-muted hover:text-fg"
              >
                <Download size={14} />
              </button>
            )}
          >
                <div className="absolute right-0 top-full z-20 mt-1.5 w-56 rounded-lg border border-line bg-canvas p-3 shadow-xl">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                    Export activity
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
                      {exporting ? "Exporting…" : "Markdown"}
                    </button>
                    <button
                      type="button"
                      disabled={exporting}
                      onClick={() => void runExport("csv")}
                      className="flex-1 rounded border border-line bg-surface px-2 py-1 text-xs hover:bg-elevated disabled:opacity-50"
                    >
                      {exporting ? "Exporting…" : "CSV"}
                    </button>
                  </div>
                </div>
          </Menu>
          </div>
        </div>

        {searchOpen ? (
        <div className="material-search mb-3 flex items-center gap-2 rounded-md px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
          <SearchIcon size={14} className="shrink-0 text-faint" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search captures…"
            aria-label="Search captures"
            className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
          />
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Close search"
            className="rounded p-0.5 text-faint hover:bg-elevated hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        ) : null}

        {!isSearching &&
          (stats ? (
            <StatStrip
              stats={stats}
              category={statsCategory}
              onOpen={() => onOpenStats(statsCategory ?? "transcriptions")}
            />
          ) : (
            <div className="h-[76px] border-y border-line" />
          ))}

        {!isSearching ? (
          <div className="echo-recap-row py-3">
            <RecapCard
              summary={summary}
              dateLabel={dayLabel(yesterday)}
              onOpen={() => setRecapOpen(true)}
            />
          </div>
        ) : null}

        <section className="echo-activity-ledger" aria-labelledby="activity-heading">
          <div className="flex items-center justify-between border-b border-line py-2.5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-accent">
                {isSearching ? "Search results" : "Today"}
              </p>
              <h2 id="activity-heading" className="mt-0.5 text-[14px] font-semibold text-fg">
                {isSearching ? `Matches for “${query.trim()}”` : "Recent activity"}
              </h2>
            </div>
            <span className="text-[10px] text-faint">Most recent</span>
          </div>

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
              No results for &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            searchEntries.map(renderEntry)
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
              {emptyLabel(kindFilter)}
            </p>
          ) : (
            <>
              {browseEntries.map(renderEntry)}
              {hasMore && !isRecordings && !isMeetings ? (
                <div className="my-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void fetchItems("append")}
                    disabled={loadingMore}
                    className="rounded border border-line px-4 py-1 text-xs hover:bg-elevated disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
          </div>
        )}
        </section>
      </div>

      {recapOpen && summary?.status === "generated" ? (
        <RecapModal
          summary={summary}
          dateLabel={dayLabel(yesterday)}
          onClose={() => setRecapOpen(false)}
        />
      ) : null}
    </div>
  );
}

function StatStrip({
  stats,
  category,
  onOpen,
}: {
  stats: DashboardStats;
  category: StatsCategoryKey | null;
  onOpen: () => void;
}) {
  const selected = category ? stats.categories[category] : null;
  const meta = category ? categoryMeta(category) : null;
  const timed = category === "meetings" || category === "recordings";

  return (
    <div
      role="region"
      aria-label="Activity statistics"
      className="echo-stat-strip border-y border-line"
    >
      <div className="flex h-8 items-center justify-between border-b border-line px-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
          {meta ? meta.label : "Activity overview"}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="native-toolbar-button flex h-6 items-center gap-1 rounded px-2 text-[10px] font-medium text-muted hover:text-fg"
          aria-label="View stats"
        >
          View stats
          <ChevronRight size={11} aria-hidden="true" />
        </button>
      </div>

      {selected && meta ? (
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <StatCell
            label="Today"
            value={compactNumber(selected.today.count)}
            sub={selected.today.count === 1 ? meta.singular : meta.label.toLowerCase()}
          />
          <StatCell
            label="This week"
            value={compactNumber(selected.week.count)}
            sub={timed ? formatDuration(selected.week.duration_ms) : `${compactNumber(selected.week.words)} words`}
          />
          <StatCell
            label={timed ? "Time this week" : "Words this week"}
            value={timed ? formatDuration(selected.week.duration_ms) : compactNumber(selected.week.words)}
            sub={timed ? `${selected.week.count} ${selected.week.count === 1 ? meta.singular : meta.label.toLowerCase()}` : `${selected.week.words.toLocaleString()} exact`}
          />
          <StatCell
            label={timed ? "Time all time" : "All time"}
            value={timed ? formatDuration(selected.all_time.duration_ms) : compactNumber(selected.all_time.count)}
            sub={timed ? `${selected.all_time.count.toLocaleString()} total` : `${compactNumber(selected.all_time.words)} words`}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-5">
          {STATS_CATEGORIES.map(({ key, label, singular }) => {
            const categoryStats = stats.categories[key];
            return (
              <StatCell
                key={key}
                label={label}
                value={compactNumber(categoryStats.today.count)}
                sub={`${compactNumber(categoryStats.week.count)} this week`}
                srText={`${categoryStats.today.count} ${categoryStats.today.count === 1 ? singular : label.toLowerCase()} today`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
  srText,
}: {
  label: string;
  value: string | number;
  sub: string;
  srText?: string;
}) {
  return (
    <div className="echo-stat-cell min-w-0 px-4 py-3">
      <span className="block truncate text-[10px] font-medium text-muted">{label}</span>
      <span className="mt-1 block text-[22px] tabular-nums leading-none text-fg">{value}</span>
      <span className="mt-1 block truncate text-[10px] text-faint">{sub}</span>
      {srText ? <span className="sr-only">{srText}</span> : null}
    </div>
  );
}

function RecapCard({
  summary,
  dateLabel,
  onOpen,
}: {
  summary: DailySummary | null;
  dateLabel: string;
  onOpen: () => void;
}) {
  const generated = summary?.status === "generated";
  const preview = generated
    ? summary.narrative.slice(0, 140) +
      (summary.narrative.length > 140 ? "…" : "")
    : summary?.status === "skipped_empty"
      ? "Quiet day — nothing recorded."
      : "No recap was generated for yesterday.";

  const body = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Yesterday · {dateLabel}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[13px] text-fg">{preview}</p>
      </div>
      {generated ? (
        <ChevronRight size={16} className="shrink-0 text-faint" />
      ) : null}
    </div>
  );

  if (!generated) {
    return (
      <div className="material-panel rounded-xl border border-line px-4 py-3">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="material-panel is-interactive w-full cursor-pointer rounded-xl border border-line px-4 py-3 text-left"
    >
      {body}
    </button>
  );
}

function RecapModal({
  summary,
  dateLabel,
  onClose,
}: {
  summary: DailySummary;
  dateLabel: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      onClose={onClose}
      labelledBy="recap-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      panelClassName="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-xl"
    >
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2
            id="recap-modal-title"
            className="text-base font-semibold tracking-tight text-fg"
          >
            {dateLabel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex flex-col gap-6 overflow-y-auto px-6 py-5">
          <p className="text-sm leading-relaxed text-fg">
            {summary.narrative}
          </p>
          <RecapSection title="Meetings" items={summary.sections.meetings ?? []} />
          <RecapSection
            title="Focus work"
            items={summary.sections.focus_work ?? []}
          />
          <RecapSection title="Notes" items={summary.sections.notes ?? []} />
          <RecapSection
            title="Things that came up"
            items={summary.sections.things_that_came_up ?? []}
          />
        </div>
    </Dialog>
  );
}

function RecapSection({
  title,
  items,
}: {
  title: string;
  items: DailySummarySectionItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold tracking-tight text-fg">
        {title}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li
            key={i}
            className="rounded-md border border-line bg-surface/60 p-3 text-sm text-fg"
          >
            {it.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
