import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isMeetingActive,
  listMeetings,
  startMeetingManual,
  stopMeeting,
  type MeetingRow,
  type MeetingStatus,
} from "../../lib/api";
import { useToasts } from "../../components/ToastProvider";

type Filter = "all" | "week" | "month" | string;

type Props = { onSelect: (id: string) => void };

/** Numeric rank for meeting status — higher = further along the lifecycle.
 *  Used to enforce monotonic status transitions in the UI so that a stale
 *  refresh can never regress a card's displayed status. */
const STATUS_RANK: Record<string, number> = {
  recording: 0,
  transcribing: 1,
  summarizing: 2,
  complete: 3,
  failed: 3,
  recovered: 3,
};

export function MeetingsView({ onSelect }: Props) {
  const [rows, setRows] = useState<MeetingRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const refreshRows = useCallback(async () => {
    try {
      const fresh = await listMeetings();
      // Enforce monotonic status: never let a stale DB read regress a
      // meeting's displayed status to an earlier lifecycle stage.
      setRows((prev) => {
        const floor = new Map<string, MeetingStatus>();
        for (const r of prev) floor.set(r.item_id, r.status);
        return fresh.map((r) => {
          const prev_status = floor.get(r.item_id);
          if (
            prev_status &&
            (STATUS_RANK[r.status] ?? 0) < (STATUS_RANK[prev_status] ?? 0)
          ) {
            return { ...r, status: prev_status };
          }
          return r;
        });
      });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshActive = useCallback(async () => {
    try {
      setActive(await isMeetingActive());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshRows();
    void refreshActive();
  }, [refreshRows, refreshActive]);

  useEffect(() => {
    let unsubs: UnlistenFn[] = [];
    void Promise.all([
      listen("meeting-started", () => {
        void refreshActive();
        void refreshRows();
      }),
      listen("meeting-status", () => {
        void refreshActive();
        void refreshRows();
      }),
      listen("meeting-complete", () => {
        void refreshActive();
        void refreshRows();
      }),
    ]).then((fns) => {
      unsubs = fns;
    });
    return () => {
      unsubs.forEach((f) => f());
    };
  }, [refreshActive, refreshRows]);

  const onToggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (active) {
        await stopMeeting();
      } else {
        await startMeetingManual();
      }
      await refreshActive();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toasts.push({ tone: "error", message: msg });
    } finally {
      setBusy(false);
    }
  }, [active, busy, refreshActive, toasts]);

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

  const toggleButton = (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors ${
        active ? "bg-danger hover:bg-danger/90" : "bg-accent hover:bg-accent-hover"
      } ${busy ? "opacity-60" : ""}`}
    >
      <span
        className={`relative inline-flex h-2 w-2 ${active ? "" : "opacity-70"}`}
      >
        {active ? (
          <>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
          </>
        ) : (
          <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
        )}
      </span>
      {active ? "Stop meeting" : "Start meeting"}
    </button>
  );

  return (
    <div className="meetings-view flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Meetings</h2>
        {toggleButton}
      </header>

      {!rows.length ? (
        <div className="meetings-empty rounded-md bg-surface-2 p-8 text-center text-sm text-muted">
          <p className="mb-1 font-medium text-fg">No meetings yet</p>
          <p>
            Click <em>Start meeting</em> above, or open Zoom/Teams/FaceTime and
            we'll detect it automatically.
          </p>
        </div>
      ) : (
        <>
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
                      {new Date(r.started_at).toLocaleDateString()}{" "}
                      {new Date(r.started_at).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </div>
                    <div className="text-xs text-muted">
                      {Math.round((r.duration_ms ?? 0) / 60000)}m
                    </div>
                  </div>
                  {summary && (
                    <div className="mt-1 text-xs text-muted">{summary}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
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
