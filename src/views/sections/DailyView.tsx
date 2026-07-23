import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import {
  dailyRecapNotificationPermissionStatus,
  getDailySummary,
  listRecentDailySummaries,
  regenerateDailySummary,
  type DailySummary,
  type DailySummarySectionItem,
} from "../../lib/api";

const FIRST_RUN_FLAG = "daily_recap_first_run_dismissed";

type Props = {
  initialDate?: string;
};

function todayLocalIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function yesterdayLocalIso(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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

export default function DailyView({ initialDate }: Props) {
  const [date, setDate] = useState<string>(initialDate ?? yesterdayLocalIso());
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [recent, setRecent] = useState<DailySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showFirstRun, setShowFirstRun] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FIRST_RUN_FLAG) !== "1";
    } catch {
      return true;
    }
  });
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = await dailyRecapNotificationPermissionStatus();
        if (!cancelled) setPermissionGranted(ok);
      } catch {
        if (!cancelled) setPermissionGranted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissFirstRun = useCallback(() => {
    try {
      localStorage.setItem(FIRST_RUN_FLAG, "1");
    } catch {
      // ignore
    }
    setShowFirstRun(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        getDailySummary(date),
        listRecentDailySummaries(14),
      ]);
      setSummary(s);
      setRecent(r);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key === "ArrowLeft") setDate((d) => shiftDate(d, -1));
      if (e.key === "ArrowRight") setDate((d) => shiftDate(d, +1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      const s = await regenerateDailySummary(date);
      setSummary(s);
      const r = await listRecentDailySummaries(14);
      setRecent(r);
    } catch (e) {
      console.error("regenerate failed", e);
    } finally {
      setRegenerating(false);
    }
  }, [date]);

  const isToday = date === todayLocalIso();

  return (
    <div className="flex h-full bg-canvas text-fg">
      {/* History strip */}
      <aside className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-2 pt-10">
        <div className="px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Recent days
        </div>
        {recent.length === 0 ? (
          <p className="px-2 text-xs text-muted">No recaps yet.</p>
        ) : (
          recent.map((r) => {
            const isEmpty = r.status === "skipped_empty";
            const isActive = r.date === date;
            return (
              <button
                key={r.date}
                onClick={() => !isEmpty && setDate(r.date)}
                disabled={isEmpty}
                className={[
                  "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  isActive ? "bg-elevated" : "hover:bg-elevated/60",
                  isEmpty ? "cursor-default opacity-50" : "cursor-pointer",
                ].join(" ")}
              >
                <span className="text-[11px] font-semibold text-fg">
                  {r.date}
                </span>
                <span className="line-clamp-1 text-[10px] text-muted">
                  {isEmpty
                    ? "Quiet day"
                    : r.narrative.slice(0, 60) || "(no narrative)"}
                </span>
              </button>
            );
          })
        )}
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto px-8 pt-10">
        {showFirstRun && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-line bg-elevated p-3 text-xs text-muted">
            <p className="leading-relaxed">
              This recap looks at your meetings, notes, and dictations — all
              stored locally on this Mac.
            </p>
            <button
              onClick={dismissFirstRun}
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 hover:bg-canvas"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}

        {permissionGranted === false && (
          <div className="mb-4 rounded-md border border-warning/40 bg-warning/15 p-3 text-xs text-fg">
            <p className="leading-relaxed">
              Notifications are disabled — your daily recap won't surface until
              you enable them in{" "}
              <span className="font-semibold">
                System Settings → Notifications → Echo Scribe
              </span>
              .
            </p>
          </div>
        )}

        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={() => setDate((d) => shiftDate(d, -1))}
            aria-label="Previous day"
            className="rounded-md p-1 hover:bg-elevated"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <h2
            aria-live="polite"
            className="text-lg font-semibold tracking-tight text-fg"
          >
            {dayLabel(date)}
          </h2>
          <button
            onClick={() => setDate((d) => shiftDate(d, +1))}
            aria-label="Next day"
            className="rounded-md p-1 hover:bg-elevated"
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </header>

        {loading && <p className="text-sm text-muted">Loading…</p>}

        {!loading && !summary && (
          <div className="rounded-lg border border-line bg-canvas p-6">
            <p className="text-sm text-muted">
              {isToday
                ? "Today's recap will generate tomorrow morning."
                : "No recap was generated for this day."}
            </p>
            <button
              onClick={() => void onRegenerate()}
              disabled={regenerating}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line bg-elevated px-3 py-1 text-xs text-fg hover:bg-elevated/70 disabled:opacity-50"
            >
              <RefreshCw size={14} aria-hidden="true" />
              {regenerating ? "Generating…" : "Generate now"}
            </button>
          </div>
        )}

        {!loading && summary?.status === "skipped_empty" && (
          <p className="rounded-lg border border-line bg-canvas p-6 text-sm text-muted">
            Nothing recorded on this day.
          </p>
        )}

        {!loading && summary?.status === "failed" && (
          <div className="rounded-lg border border-danger/40 bg-canvas p-6">
            <p className="text-sm text-danger">Couldn't generate this recap.</p>
            <button
              onClick={() => void onRegenerate()}
              disabled={regenerating}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line bg-elevated px-3 py-1 text-xs text-fg hover:bg-elevated/70 disabled:opacity-50"
            >
              <RefreshCw size={14} aria-hidden="true" />
              {regenerating ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}

        {!loading && summary?.status === "generated" && (
          <article className="flex flex-col gap-6">
            <p className="text-base leading-relaxed text-fg">
              {summary.narrative}
            </p>

            <Section title="Meetings" items={summary.sections.meetings ?? []} />
            <Section
              title="Focus work"
              items={summary.sections.focus_work ?? []}
            />
            <Section title="Notes" items={summary.sections.notes ?? []} />
            <Section
              title="Things that came up"
              items={summary.sections.things_that_came_up ?? []}
            />

            <footer className="mt-2 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
              <span>Generated {summary.generated_at}</span>
              <button
                onClick={() => void onRegenerate()}
                disabled={regenerating}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-elevated px-2 py-1 text-xs text-fg hover:bg-elevated/70 disabled:opacity-50"
              >
                <RefreshCw size={12} />
                {regenerating ? "Regenerating…" : "Regenerate"}
              </button>
            </footer>
          </article>
        )}
      </main>
    </div>
  );
}

function Section({
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
            className="rounded-md border border-line bg-canvas p-3 text-sm text-fg"
          >
            <span>{it.text}</span>
            {it.source_id ? (
              <span className="ml-2 text-[10px] text-faint">
                [{it.source_id}]
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
