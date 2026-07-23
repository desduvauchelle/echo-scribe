import { useState } from "react";
import {
  AlignLeft,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Loader,
  Users,
} from "lucide-react";
import type { Item, MeetingRow, Project } from "../lib/api";
import { listMeetingActionItems } from "../lib/api";
import { relativeTime } from "../lib/format";
import {
  meetingDuration,
  meetingTitle,
  parseSummary,
} from "../lib/meetingDisplay";
import { meetingStatusDisplay } from "../lib/meetingStatus";
import { useActivityPanel } from "./ActivityPanelContext";
import ItemCard from "./ItemCard";

type Props = {
  mtg: MeetingRow;
  /** Optional map of project_id → project, for parity with the other feed
   *  cards. Meetings resolve their project name server-side, so this is only
   *  used by the nested action items. */
  projects?: Map<string, Project>;
};

/** Meeting row for the dashboard feed. Shows what the meeting was, and folds
 *  the tasks it produced underneath it rather than scattering them through the
 *  feed as standalone cards. */
export default function MeetingCard({ mtg, projects }: Props) {
  const { openItem } = useActivityPanel();
  const [expanded, setExpanded] = useState(false);
  const [actions, setActions] = useState<Item[] | null>(null);
  const [loadingActions, setLoadingActions] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);

  const summary = parseSummary(mtg.summary_json);
  const status = meetingStatusDisplay(mtg.status);
  const summaryPoints = summary?.summary ?? [];
  const summaryActions = summary?.action_items ?? [];
  const actionCount = summaryActions.length;
  const firstPoint = summaryPoints[0] ?? "";

  const toggleActions = async () => {
    const next = !expanded;
    setExpanded(next);
    // Lazily fetch the promoted items once, on first expand.
    if (!next || actions !== null || loadingActions) return;
    setLoadingActions(true);
    setActionsError(null);
    try {
      setActions(await listMeetingActionItems(mtg.item_id));
    } catch (e) {
      setActions([]);
      setActionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingActions(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface transition-colors hover:border-line-strong">
      <button
        type="button"
        onClick={() => openItem(mtg.item_id)}
        className="group flex w-full cursor-pointer gap-3 px-3 py-2 text-left"
      >
        <div className="pt-0.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Users size={12} strokeWidth={2} aria-hidden="true" />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="truncate text-[13px] font-medium text-fg">
              {meetingTitle(mtg, summary)}
            </span>
            {status.pill ? (
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  status.tone === "danger"
                    ? "bg-danger/15 text-danger"
                    : "bg-accent-soft text-accent"
                }`}
                title={status.description}
              >
                {status.spinner ? (
                  <Loader
                    size={11}
                    strokeWidth={2}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {status.label}
                {status.description ? (
                  <span className="sr-only">{status.description}</span>
                ) : null}
              </span>
            ) : null}
          </div>

          {firstPoint ? (
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
              {firstPoint}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span>{relativeTime(mtg.started_at)}</span>
            {!status.pill ? (
              <>
                <span>·</span>
                <span>{meetingDuration(mtg.duration_ms)}</span>
              </>
            ) : null}
            {mtg.detected_app_name ? (
              <>
                <span>·</span>
                <span>{mtg.detected_app_name}</span>
              </>
            ) : null}
            {mtg.project_name ? (
              <span className="rounded-full bg-elevated px-2 py-0.5 text-fg">
                {mtg.project_name}
              </span>
            ) : null}
            {summaryPoints.length > 0 ? (
              <span
                className="inline-flex items-center gap-1"
                title={`${summaryPoints.length} summary point${summaryPoints.length === 1 ? "" : "s"}`}
              >
                <AlignLeft size={11} strokeWidth={2} aria-hidden="true" />
                {summaryPoints.length}
              </span>
            ) : null}
          </div>
        </div>
      </button>

      {actionCount > 0 ? (
        <div className="border-t border-line">
          <button
            type="button"
            onClick={() => void toggleActions()}
            aria-expanded={expanded}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            {expanded ? (
              <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
            )}
            <ListChecks size={12} strokeWidth={2} aria-hidden="true" />
            {actionCount} action item{actionCount === 1 ? "" : "s"}
          </button>

          {expanded ? (
            <div className="flex flex-col gap-1.5 px-3 pb-2.5">
              {loadingActions ? (
                <span className="inline-flex items-center gap-1.5 py-1 text-[11px] text-muted">
                  <Loader size={11} className="animate-spin" aria-hidden="true" /> Loading…
                </span>
              ) : actions && actions.length > 0 ? (
                actions.map((it) => (
                  <ItemCard key={it.id} item={it} projects={projects} compact />
                ))
              ) : (
                <>
                  {actionsError ? (
                    <span className="text-[11px] text-danger">
                      Couldn&rsquo;t load the linked tasks — showing the
                      summary&rsquo;s action items instead.
                    </span>
                  ) : null}
                  {/* Meetings whose actions were never promoted to items still
                      have them in the summary JSON. */}
                  <ul className="flex flex-col gap-1">
                    {summaryActions.map((a, i) => (
                      <li
                        key={i}
                        className="rounded border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-fg"
                      >
                        {a.text}
                        {a.owner && a.owner !== "unspecified" ? (
                          <span className="ml-1.5 text-[11px] text-muted">
                            · {a.owner}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
