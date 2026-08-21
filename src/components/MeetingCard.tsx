import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronRight,
  ListChecks,
  Loader,
  Users,
} from "lucide-react";
import type { Item, MeetingRow, MeetingStatus, Project, StoredSummary } from "../lib/api";
import { listMeetingActionItems } from "../lib/api";
import { relativeTime } from "../lib/format";
import { parseSummary, summaryPreview } from "../lib/meetingDisplay";
import { meetingStatusDisplay } from "../lib/meetingStatus";
import { useActivityPanel } from "./ActivityPanelContext";
import ItemCard from "./ItemCard";

// meetingTitle()/meetingDuration() from ../lib/meetingDisplay and the
// label/description text from ../lib/meetingStatus return hardcoded English
// copy. Those are plain (non-hook) lib helpers outside this extraction's
// file scope, so their translated equivalents are reimplemented here at the
// render callsite instead of touching the shared lib files.
function localizedMeetingTitle(
  t: TFunction,
  mtg: MeetingRow,
  summary: StoredSummary | null,
): string {
  const suggested = summary?.suggested_title?.trim();
  if (suggested) return suggested;
  const app = mtg.detected_app_name?.trim();
  return app
    ? t("meetingCard.appMeetingTitle", { app })
    : t("meetingCard.manualMeeting");
}

function localizedMeetingDuration(t: TFunction, ms: number | null | undefined): string {
  const mins = Math.round((ms ?? 0) / 60000);
  if (mins < 60) return t("meetingCard.durationMinutes", { mins });
  const h = Math.floor(mins / 60);
  return t("meetingCard.durationHoursMinutes", { hours: h, mins: mins % 60 });
}

function localizedMeetingStatusText(
  t: TFunction,
  status: MeetingStatus,
): { label: string; description: string } {
  switch (status) {
    case "recording":
      return {
        label: t("meetingCard.status.recording.label"),
        description: t("meetingCard.status.recording.description"),
      };
    case "transcribing":
      return {
        label: t("meetingCard.status.transcribing.label"),
        description: t("meetingCard.status.transcribing.description"),
      };
    case "summarizing":
      return {
        label: t("meetingCard.status.summarizing.label"),
        description: t("meetingCard.status.summarizing.description"),
      };
    case "failed":
      return {
        label: t("meetingCard.status.failed.label"),
        description: t("meetingCard.status.failed.description"),
      };
    case "recovered":
      return {
        label: t("meetingCard.status.recovered.label"),
        description: t("meetingCard.status.recovered.description"),
      };
    case "complete":
      return { label: "", description: "" };
  }
}

type Props = {
  mtg: MeetingRow;
  /** Optional map of project_id → project, for parity with the other feed
   *  cards. Meetings resolve their project name server-side, so this is only
   *  used by the nested action items. */
  projects?: Map<string, Project>;
  variant?: "card" | "ledger";
};

/** Meeting row for the dashboard feed. Shows what the meeting was, and folds
 *  the tasks it produced underneath it rather than scattering them through the
 *  feed as standalone cards. */
export default function MeetingCard({ mtg, projects, variant = "card" }: Props) {
  const { t } = useTranslation();
  const { openItem } = useActivityPanel();
  const [expanded, setExpanded] = useState(false);
  const [actions, setActions] = useState<Item[] | null>(null);
  const [loadingActions, setLoadingActions] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);

  const summary = parseSummary(mtg.summary_json);
  // spinner/tone/pill are structural and stay lib-owned; label/description
  // are the translated English copy, reimplemented locally (see
  // localizedMeetingStatusText above).
  const status = {
    ...meetingStatusDisplay(mtg.status),
    ...localizedMeetingStatusText(t, mtg.status),
  };
  // Legacy meetings only: action items promoted to tasks before the markdown
  // rework. New meetings keep next steps inside the summary markdown.
  const summaryActions = summary?.action_items ?? [];
  const actionCount = summaryActions.length;
  const firstPoint = summaryPreview(summary);
  const ledger = variant === "ledger";

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
    <div
      className={
        ledger
          ? "activity-ledger-row"
          : "material-feed-card rounded-xl border border-line hover:border-line-strong"
      }
    >
      <button
        type="button"
        onClick={() => openItem(mtg.item_id)}
        className={`group flex w-full cursor-pointer gap-3 text-left ${ledger ? "px-2 py-3" : "px-3.5 py-3"}`}
      >
        <div className="mt-0.5 shrink-0">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Users size={12} strokeWidth={2} aria-hidden="true" />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {ledger ? (
            <div className="activity-kind mb-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-accent">
              {t("meetingCard.ledgerKindLabel")}
            </div>
          ) : null}
          <div className="flex items-start justify-between gap-3">
            <span className={`${ledger ? "text-[14px]" : "text-[13px]"} truncate font-medium text-fg`}>
              {localizedMeetingTitle(t, mtg, summary)}
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

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span>{relativeTime(mtg.started_at)}</span>
            {!status.pill ? (
              <>
                <span>·</span>
                <span>{localizedMeetingDuration(t, mtg.duration_ms)}</span>
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
          </div>
        </div>
      </button>

      {actionCount > 0 ? (
        <div className="border-t border-line">
          <button
            type="button"
            onClick={() => void toggleActions()}
            aria-expanded={expanded}
            className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-[11px] text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            {expanded ? (
              <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
            )}
            <ListChecks size={12} strokeWidth={2} aria-hidden="true" />
            {t("meetingCard.actionItemsCount", { count: actionCount })}
          </button>

          {expanded ? (
            <div className="flex flex-col gap-1.5 px-3.5 pb-3">
              {loadingActions ? (
                <span className="inline-flex items-center gap-1.5 py-1 text-[11px] text-muted">
                  <Loader size={11} className="animate-spin" aria-hidden="true" /> {t("meetingCard.loadingActionItems")}
                </span>
              ) : actions && actions.length > 0 ? (
                actions.map((it) => (
                  <ItemCard
                    key={it.id}
                    item={it}
                    projects={projects}
                    compact
                    variant={variant}
                  />
                ))
              ) : (
                <>
                  {actionsError ? (
                    <span className="text-[11px] text-danger">
                      {t("meetingCard.actionsLoadError")}
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
