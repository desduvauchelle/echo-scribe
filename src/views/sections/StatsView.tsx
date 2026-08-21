import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Clock3,
  Flame,
  Hash,
  Sparkles,
} from "lucide-react";
import {
  getDashboardStats,
  type DailyActivity,
  type DashboardStats,
  type StatsCategoryKey,
} from "../../lib/api";
import { compactNumber } from "../../lib/format";
import {
  STATS_CATEGORIES,
  StatsCategoryTabs,
  categoryMeta,
  formatDuration,
} from "../../components/StatsCategoryTabs";

type Props = {
  initialCategory?: StatsCategoryKey;
  onBack: () => void;
};

function activityValue(day: DailyActivity, category: StatsCategoryKey): number {
  return day[category];
}

function hourLabel(hour: number | null): string {
  if (hour === null) return "—";
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

function shortDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
  });
}

function longDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function StatsView({ initialCategory, onBack }: Props) {
  const { t } = useTranslation("main");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [category, setCategory] = useState<StatsCategoryKey>(
    initialCategory ?? "transcriptions",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDashboardStats()
      .then((next) => {
        if (!cancelled) setStats(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const week = useMemo(() => stats?.daily_activity.slice(-7) ?? [], [stats]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-danger">
        <p>{t("stats.error.message")}</p>
        <button type="button" onClick={onBack} className="text-muted hover:text-fg">
          {t("stats.error.backToDashboard")}
        </button>
      </div>
    );
  }

  if (!stats) {
    return <div className="h-full animate-pulse bg-canvas" aria-label={t("stats.loading.ariaLabel")} />;
  }

  const selected = stats.categories[category];
  const meta = categoryMeta(category);
  const timed = category === "meetings" || category === "recordings";
  const weekMax = Math.max(1, ...week.map((day) => activityValue(day, category)));
  const heatMax = Math.max(
    1,
    ...stats.daily_activity.map((day) => activityValue(day, category)),
  );
  const allTimeMax = Math.max(
    1,
    ...STATS_CATEGORIES.map(({ key }) => stats.categories[key].all_time.count),
  );

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl pb-8">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              aria-label={t("stats.error.backToDashboard")}
              className="rounded-md border border-line bg-surface p-1.5 text-muted hover:bg-elevated hover:text-fg"
            >
              <ArrowLeft size={15} />
            </button>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{t("stats.header.title")}</h1>
              <p className="mt-0.5 text-xs text-muted">{t("stats.header.subtitle")}</p>
            </div>
          </div>
        </div>

        <div className="mb-5 overflow-x-auto">
          <StatsCategoryTabs value={category} onChange={setCategory} />
        </div>

        <section className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label={t("stats.overview.ariaLabel", { label: meta.label })}>
          <OverviewStat
            label={t("stats.overview.today")}
            value={compactNumber(selected.today.count)}
            sub={timed ? formatDuration(selected.today.duration_ms) : t("stats.common.wordsCount", { count: compactNumber(selected.today.words) })}
          />
          <OverviewStat
            label={t("stats.overview.thisWeek")}
            value={compactNumber(selected.week.count)}
            sub={timed ? formatDuration(selected.week.duration_ms) : t("stats.common.wordsCount", { count: compactNumber(selected.week.words) })}
          />
          <OverviewStat
            label={t("stats.overview.past30Days")}
            value={compactNumber(selected.month.count)}
            sub={timed ? formatDuration(selected.month.duration_ms) : t("stats.common.wordsCount", { count: compactNumber(selected.month.words) })}
          />
          <OverviewStat
            label={t("stats.overview.allTime")}
            value={timed ? formatDuration(selected.all_time.duration_ms) : compactNumber(selected.all_time.count)}
            sub={timed ? t("stats.common.totalCount", { count: selected.all_time.count.toLocaleString() }) : t("stats.common.wordsCount", { count: compactNumber(selected.all_time.words) })}
            accent
          />
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_1fr]">
          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{t("stats.week.heading")}</h2>
                <p className="mt-0.5 text-xs text-muted">{t("stats.week.subtitle", { label: meta.label.toLowerCase() })}</p>
              </div>
              <span className="rounded-full bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent">
                {t("stats.common.totalCount", { count: selected.week.count })}
              </span>
            </div>
            <div className="flex h-44 items-end gap-2" role="img" aria-label={t("stats.week.chartAriaLabel", { label: meta.label.toLowerCase() })}>
              {week.map((day) => {
                const value = activityValue(day, category);
                return (
                  <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                    <span className="text-[10px] tabular-nums text-muted">{value || ""}</span>
                    <div className="flex h-28 w-full items-end rounded-md bg-elevated/70 px-1">
                      <div
                        className={`w-full rounded-sm ${value === 0 ? "bg-line" : "bg-accent"}`}
                        style={{ height: value === 0 ? 3 : `${Math.max(10, (value / weekMax) * 100)}%` }}
                        title={t("stats.week.barTitle", { day: longDay(day.date), value })}
                      />
                    </div>
                    <span className="truncate text-[10px] text-faint">{shortDay(day.date)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold">{t("stats.mix.heading")}</h2>
            <p className="mt-0.5 text-xs text-muted">{t("stats.mix.subtitle")}</p>
            <div className="mt-5 flex flex-col gap-3.5">
              {STATS_CATEGORIES.map(({ key, label, icon: Icon }) => {
                const value = stats.categories[key].all_time.count;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCategory(key)}
                    className="group text-left"
                  >
                    <span className="mb-1.5 flex items-center justify-between text-[11px]">
                      <span className="flex items-center gap-1.5 text-muted group-hover:text-fg">
                        <Icon size={11} aria-hidden="true" />
                        {label}
                      </span>
                      <span className="tabular-nums text-fg">{value.toLocaleString()}</span>
                    </span>
                    <span className="block h-1.5 overflow-hidden rounded-full bg-elevated">
                      <span
                        className={`block h-full rounded-full ${key === category ? "bg-accent" : "bg-faint"}`}
                        style={{ width: `${Math.max(value > 0 ? 3 : 0, (value / allTimeMax) * 100)}%` }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <section className="mt-4 rounded-xl border border-line bg-surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t("stats.heatmap.heading")}</h2>
              <p className="mt-0.5 text-xs text-muted">{t("stats.heatmap.subtitle")}</p>
            </div>
            <span className="text-[11px] text-muted">{t("stats.heatmap.less")}&nbsp;&nbsp;·&nbsp;&nbsp;{t("stats.heatmap.more")}</span>
          </div>
          <div className="mt-5 overflow-x-auto pb-1">
            <div
              className="grid w-max grid-flow-col grid-rows-7 gap-1"
              role="img"
              aria-label={t("stats.heatmap.ariaLabel", { label: meta.label.toLowerCase() })}
            >
              {stats.daily_activity.map((day) => {
                const value = activityValue(day, category);
                const ratio = value / heatMax;
                const tone =
                  value === 0
                    ? "bg-elevated"
                    : ratio > 0.66
                      ? "bg-accent"
                      : ratio > 0.33
                        ? "bg-accent/65"
                        : "bg-accent/35";
                return (
                  <span
                    key={day.date}
                    className={`h-3 w-3 rounded-[3px] ${tone}`}
                    title={t("stats.heatmap.cellTitle", {
                      day: longDay(day.date),
                      value,
                      unit: value === 1 ? meta.singular : meta.label.toLowerCase(),
                    })}
                  />
                );
              })}
            </div>
          </div>
        </section>

        <section className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label={t("stats.insights.ariaLabel")}>
          <Insight icon={Flame} label={t("stats.insights.currentStreak")} value={t("stats.insights.daysValue", { count: stats.current_streak })} />
          <Insight icon={Sparkles} label={t("stats.insights.bestStreak")} value={t("stats.insights.daysValue", { count: stats.longest_streak })} />
          <Insight icon={Clock3} label={t("stats.insights.busiestTime")} value={hourLabel(stats.busiest_hour)} />
          <Insight icon={Hash} label={t("stats.insights.averageCapture")} value={t("stats.common.wordsCount", { count: Math.round(stats.avg_words_per_capture) })} />
        </section>
      </div>
    </div>
  );
}

function OverviewStat({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${accent ? "text-accent" : "text-fg"}`}>{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </div>
  );
}

function Insight({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Flame;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <Icon size={14} className="text-accent" aria-hidden="true" />
      <div className="mt-3 text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
