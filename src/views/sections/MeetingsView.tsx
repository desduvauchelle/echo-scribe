import { useEffect, useMemo, useState } from "react";
import { listMeetings, type MeetingRow } from "../../lib/api";

type Filter = "all" | "week" | "month" | string;

type Props = { onSelect: (id: string) => void };

export function MeetingsView({ onSelect }: Props) {
  const [rows, setRows] = useState<MeetingRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    void listMeetings().then(setRows);
  }, []);

  const apps = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.detected_app && r.detected_app_name)
        m.set(r.detected_app, r.detected_app_name);
    }
    return [...m.entries()];
  }, [rows]);

  const filtered = useMemo(() => {
    const now = Date.now();
    return rows.filter((r) => {
      if (filter === "all") return true;
      if (filter === "week")
        return now - new Date(r.started_at).getTime() < 7 * 86400 * 1000;
      if (filter === "month")
        return now - new Date(r.started_at).getTime() < 30 * 86400 * 1000;
      return r.detected_app === filter;
    });
  }, [rows, filter]);

  if (!rows.length) {
    return (
      <div className="meetings-empty p-8 text-center text-sm text-muted">
        <h2 className="mb-2 text-lg font-semibold text-fg">No meetings yet</h2>
        <p>
          Start a meeting in Zoom, Teams, or FaceTime, or press ⌘⇧M to record
          manually.
        </p>
      </div>
    );
  }

  return (
    <div className="meetings-view flex flex-col gap-4 p-6">
      <div className="filter-chips flex flex-wrap gap-2">
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label="All"
        />
        <FilterChip
          active={filter === "week"}
          onClick={() => setFilter("week")}
          label="This week"
        />
        <FilterChip
          active={filter === "month"}
          onClick={() => setFilter("month")}
          label="This month"
        />
        {apps.map(([id, name]) => (
          <FilterChip
            key={id}
            active={filter === id}
            onClick={() => setFilter(id)}
            label={name}
          />
        ))}
      </div>
      <ul className="meeting-rows flex flex-col gap-2">
        {filtered.map((r) => {
          const summary = r.summary_json
            ? (() => {
                try {
                  return (
                    (JSON.parse(r.summary_json!) as { summary?: string[] })
                      .summary?.[0] ?? ""
                  );
                } catch {
                  return "";
                }
              })()
            : "";
          return (
            <li
              key={r.item_id}
              className="cursor-pointer rounded-md bg-surface-2 p-3 hover:bg-surface-3"
              onClick={() => onSelect(r.item_id)}
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  {r.detected_app_name ?? "Manual"} ·{" "}
                  {new Date(r.started_at).toLocaleDateString()}
                </div>
                <div className="text-xs text-muted">
                  {Math.round((r.duration_ms ?? 0) / 60000)}m
                </div>
              </div>
              {summary && <div className="mt-1 text-xs text-muted">{summary}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs ${
        active ? "bg-accent text-white" : "bg-surface-2 text-fg"
      }`}
    >
      {label}
    </button>
  );
}
