import { useCallback, useEffect, useState } from "react";
import { getDashboardStats, type DashboardStats } from "../../lib/api";

const SECONDS_SAVED_PER_CAPTURE = 30;

export default function DashboardView() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getDashboardStats();
      setStats(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-6">
      <h1 className="mb-5 text-lg font-semibold tracking-tight">Dashboard</h1>

      <div className="grid grid-cols-3 gap-3">
        <PeriodCard label="Today" transcriptions={stats.today.transcriptions} words={stats.today.words} />
        <PeriodCard label="This Week" transcriptions={stats.week.transcriptions} words={stats.week.words} />
        <PeriodCard label="This Month" transcriptions={stats.month.transcriptions} words={stats.month.words} />
      </div>

      <div className="mt-4 rounded-lg border border-emerald-800/40 bg-emerald-950/30 px-4 py-3">
        <div className="text-xs text-emerald-400/70">Estimated time saved</div>
        <div className="mt-0.5 flex items-baseline gap-4">
          <TimeSaved label="Today" count={stats.today.transcriptions} />
          <TimeSaved label="Week" count={stats.week.transcriptions} />
          <TimeSaved label="Month" count={stats.month.transcriptions} />
          <TimeSaved label="All time" count={stats.all_time.transcriptions} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-3">
        <InsightCard label="Current streak" value={`${stats.current_streak}d`} sub={`Longest: ${stats.longest_streak}d`} />
        <InsightCard label="Avg words" value={stats.avg_words_per_capture.toFixed(0)} sub="per capture" />
        <InsightCard
          label="Busiest hour"
          value={stats.busiest_hour !== null ? `${stats.busiest_hour.toString().padStart(2, "0")}:00` : "--"}
          sub="UTC"
        />
        <InsightCard label="All time" value={stats.all_time.transcriptions.toLocaleString()} sub={`${stats.all_time.words.toLocaleString()} words`} />
      </div>

      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-neutral-400">Activity — last 90 days</div>
        <Heatmap data={stats.daily_counts} />
      </div>

      <Tips stats={stats} />
    </div>
  );
}

function PeriodCard({ label, transcriptions, words }: { label: string; transcriptions: number; words: number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{transcriptions}</div>
      <div className="mt-0.5 text-xs text-neutral-400">{words.toLocaleString()} words</div>
    </div>
  );
}

function TimeSaved({ label, count }: { label: string; count: number }) {
  const totalSecs = count * SECONDS_SAVED_PER_CAPTURE;
  const display =
    totalSecs < 60
      ? `${totalSecs}s`
      : totalSecs < 3600
        ? `${Math.round(totalSecs / 60)}m`
        : `${(totalSecs / 3600).toFixed(1)}h`;
  return (
    <div>
      <span className="text-lg font-semibold text-emerald-300 tabular-nums">{display}</span>
      <span className="ml-1 text-xs text-emerald-400/50">{label}</span>
    </div>
  );
}

function InsightCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-neutral-500">{sub}</div>
    </div>
  );
}

function Heatmap({ data }: { data: [string, number][] }) {
  const countMap = new Map<string, number>();
  let maxCount = 1;
  for (const [d, c] of data) {
    countMap.set(d, c);
    if (c > maxCount) maxCount = c;
  }

  const now = new Date();
  const cells: { date: string; count: number }[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    cells.push({ date: ds, count: countMap.get(ds) ?? 0 });
  }

  const firstDay = new Date(cells[0].date + "T12:00:00Z").getUTCDay();
  const padBefore = firstDay === 0 ? 6 : firstDay - 1;
  const padded: ({ date: string; count: number } | null)[] = [
    ...Array.from({ length: padBefore }, () => null),
    ...cells,
  ];
  const weeks: (typeof padded[0])[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }

  const intensity = (count: number) => {
    if (count === 0) return "bg-neutral-800/50";
    const ratio = count / maxCount;
    if (ratio <= 0.25) return "bg-emerald-900/60";
    if (ratio <= 0.5) return "bg-emerald-700/60";
    if (ratio <= 0.75) return "bg-emerald-500/60";
    return "bg-emerald-400/80";
  };

  return (
    <div className="flex gap-[3px]">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-[3px]">
          {Array.from({ length: 7 }, (_, di) => {
            const cell = week[di] ?? null;
            if (!cell) {
              return <div key={di} className="h-[13px] w-[13px] rounded-[2px]" />;
            }
            return (
              <div
                key={di}
                className={`h-[13px] w-[13px] rounded-[2px] ${intensity(cell.count)}`}
                title={`${cell.date}: ${cell.count} capture${cell.count === 1 ? "" : "s"}`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Tips({ stats }: { stats: DashboardStats }) {
  const tips: string[] = [];

  if (stats.current_streak >= 3) {
    tips.push(`You're on a ${stats.current_streak}-day streak! Keep capturing to maintain it.`);
  } else if (stats.today.transcriptions === 0) {
    tips.push("No captures today yet — try a quick voice note to get started.");
  }

  if (stats.all_time.transcriptions >= 10 && stats.avg_words_per_capture < 10) {
    tips.push("Your captures are pretty short. Try speaking in full sentences for richer notes.");
  }

  if (stats.busiest_hour !== null) {
    const h = stats.busiest_hour;
    const label = h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
    tips.push(`You're most productive around ${label} UTC.`);
  }

  if (stats.all_time.transcriptions > 0 && stats.longest_streak > stats.current_streak && stats.current_streak < 2) {
    tips.push(`Your record streak is ${stats.longest_streak} days — start building towards it again!`);
  }

  if (tips.length === 0) return null;

  return (
    <div className="mt-5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-500">Tips & Insights</div>
      <ul className="space-y-1">
        {tips.map((tip, i) => (
          <li key={i} className="text-xs text-neutral-300">{tip}</li>
        ))}
      </ul>
    </div>
  );
}
