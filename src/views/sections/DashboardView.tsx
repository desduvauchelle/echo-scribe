import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search as SearchIcon, X } from "lucide-react";
import {
  getDailySummary,
  getDashboardStats,
  listItems,
  searchItems,
  type DailySummary,
  type DailySummarySectionItem,
  type DashboardStats,
  type Item,
  type ItemKind,
  type Project,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import { SkeletonList } from "./ActivityFeed";
import TasksView from "./TasksView";

const SECONDS_SAVED_PER_CAPTURE = 30;
const PAGE_SIZE = 50;

type Props = {
  projects: Map<string, Project>;
};

type KindFilter = "all" | ItemKind;

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

function formatSaved(count: number): string {
  const secs = count * SECONDS_SAVED_PER_CAPTURE;
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

function applyKindFilter(list: Item[], kind: KindFilter): Item[] {
  if (kind === "all") return list;
  if (kind === "meeting") {
    return list.filter((i) => i.kind === "meeting" || i.source === "meeting");
  }
  return list.filter((i) => i.kind === kind);
}

export default function DashboardView({ projects }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [items, setItems] = useState<Item[]>([]);
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

  const { refreshTick } = useActivityPanel();
  const yesterday = useMemo(() => yesterdayLocalIso(), []);

  const fetchItems = useCallback(async (mode: "reset" | "append") => {
    if (mode === "append") setLoadingMore(true);
    try {
      const nextOffset = mode === "reset" ? 0 : offset;
      const page = await listItems({ limit: PAGE_SIZE, offset: nextOffset });
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
    await fetchItems("reset");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yesterday]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void fetchItems("reset");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const handler = () => {
        if (!cancelled) void fetchItems("reset");
      };
      const u1 = await listen("item:created", handler);
      const u2 = await listen("app:refresh", handler);
      if (cancelled) {
        u1();
        u2();
      } else {
        unlisteners.push(u1, u2);
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
        const r = await searchItems(q, 50);
        setSearchResults(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const isSearching = searchOpen && query.trim() !== "";
  const isTasks = kindFilter === "task";

  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setSearchResults([]);
  };

  const filteredItems = useMemo(
    () => applyKindFilter(items, kindFilter),
    [items, kindFilter],
  );
  const filteredResults = useMemo(
    () => applyKindFilter(searchResults, kindFilter),
    [searchResults, kindFilter],
  );

  if (error && !stats) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-6">
      <h1 className="mb-4 text-lg font-semibold tracking-tight">Dashboard</h1>

      {!isSearching && (stats ? <StatStrip stats={stats} /> : <div className="h-12" />)}

      {!isSearching && (
        <RecapCard
          summary={summary}
          dateLabel={dayLabel(yesterday)}
          onOpen={() => setRecapOpen(true)}
        />
      )}

      {searchOpen ? (
        <div className="mt-5 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 focus-within:border-accent">
          <SearchIcon size={14} className="shrink-0 text-faint" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search captures…"
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

      <div className="mt-5 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ["all", "All"],
              ["transcription", "Transcriptions"],
              ["note", "Notes"],
              ["task", "Tasks"],
              ["meeting", "Meetings"],
            ] as [KindFilter, string][]
          ).map(([value, label]) => {
            const active = value === kindFilter;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setKindFilter(value)}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  active
                    ? "bg-fg text-canvas"
                    : "border border-line bg-surface text-muted hover:bg-elevated"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {!searchOpen ? (
          <button
            type="button"
            onClick={openSearch}
            aria-label="Search"
            className="rounded-md border border-line bg-surface p-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <SearchIcon size={14} />
          </button>
        ) : null}
      </div>

      {isTasks ? (
        <div className="mt-3 pb-4">
          <TasksView projects={projects} embedded />
        </div>
      ) : isSearching ? (
        <div className="mt-3 flex flex-col gap-2 pb-4">
          {searching && filteredResults.length === 0 ? (
            <SkeletonList />
          ) : filteredResults.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface/40 px-4 py-6 text-center text-xs text-muted">
              No results for &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            filteredResults.map((item) => (
              <ItemCard key={item.id} item={item} projects={projects} />
            ))
          )}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2 pb-4">
          {items.length === 0 && !error ? (
            <SkeletonList />
          ) : filteredItems.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface/40 px-4 py-6 text-center text-xs text-muted">
              Nothing here yet.
            </p>
          ) : (
            <>
              {filteredItems.map((item) => (
                <ItemCard key={item.id} item={item} projects={projects} />
              ))}
              {hasMore ? (
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

function StatStrip({ stats }: { stats: DashboardStats }) {
  return (
    <div className="flex flex-wrap items-stretch gap-x-8 gap-y-3 rounded-xl border border-line bg-surface px-6 py-5">
      <Stat label="Today" value={stats.today.transcriptions} sub={`${stats.today.words.toLocaleString()} words`} />
      <Stat label="Week" value={stats.week.transcriptions} sub={`${stats.week.words.toLocaleString()} words`} />
      <Stat
        label="All time"
        value={stats.all_time.transcriptions.toLocaleString()}
        sub={`${stats.all_time.words.toLocaleString()} words`}
      />
      <Divider />
      <Stat
        label="Saved (all time)"
        value={formatSaved(stats.all_time.transcriptions)}
        sub="vs typing"
        tone="success"
      />
    </div>
  );
}

function Divider() {
  return <div className="w-px self-stretch bg-line" />;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub: string;
  tone?: "success";
}) {
  return (
    <div className="flex flex-col justify-center gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <span
        className={`text-2xl font-semibold tabular-nums leading-none ${
          tone === "success" ? "text-success" : "text-fg"
        }`}
      >
        {value}
      </span>
      <span className="text-xs text-muted">{sub}</span>
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
      <div className="mt-4 rounded-lg border border-line bg-surface/40 px-4 py-3">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-4 w-full cursor-pointer rounded-lg border border-line bg-surface/60 px-4 py-3 text-left transition-colors hover:bg-elevated"
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight text-fg">
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
      </div>
    </div>
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
