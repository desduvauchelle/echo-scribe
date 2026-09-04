import { useTranslation } from "react-i18next";
import type { TranscriptSegment } from "../lib/api";
import {
  floorTimeline,
  longestTurnMs,
  questionCount,
  talkShare,
  wordsPerMinute,
} from "../lib/talkStats";

const FLOOR_BUCKETS = 32;

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * The always-on part of the HUD: it stays put while the tabs change beneath it,
 * because talk balance is the one thing worth seeing without choosing to look.
 * Everything here is derived from the transcript we already have — no model,
 * no extra IPC.
 */
export default function TalkWidgets({
  segments,
  labels,
}: {
  segments: TranscriptSegment[];
  labels: { you: string; them: string };
}) {
  const { t } = useTranslation("windows");
  const share = talkShare(segments);
  const floor = floorTimeline(segments, FLOOR_BUCKETS);
  const longest = longestTurnMs(segments);
  const pace = wordsPerMinute(segments, "you");
  const questions = questionCount(segments, "you");

  const youPct = Math.round(share.you * 100);
  const themPct = 100 - youPct;
  const silent = share.spokenMs === 0;

  return (
    <section className="talk-widgets" aria-label={t("meetingHud.talkWidgetsAria")}>
      <div
        className={`talk-bar${silent ? " silent" : ""}`}
        role="img"
        aria-label={
          silent
            ? t("meetingHud.talkShareSilent")
            : t("meetingHud.talkShareAria", {
                you: labels.you,
                youPct,
                them: labels.them,
                themPct,
              })
        }
      >
        <span className="you" style={{ width: silent ? "50%" : `${youPct}%` }}>
          <span className="talk-name">{labels.you}</span>
          {!silent && <span className="talk-pct">{youPct}%</span>}
        </span>
        <span className="them">
          <span className="talk-name">{labels.them}</span>
          {!silent && <span className="talk-pct">{themPct}%</span>}
        </span>
      </div>

      {floor.length > 0 && (
        <div className="floor-timeline" aria-hidden="true">
          {floor.map((who, i) => (
            <span key={i} className={who ?? "quiet"} />
          ))}
        </div>
      )}

      <div className="talk-tiles">
        <span className="tile">
          <span className="value">{longest === 0 ? "—" : formatDuration(longest)}</span>
          <span className="tile-label">{t("meetingHud.longestTurn")}</span>
        </span>
        <span className="tile">
          <span className="value">{pace === 0 ? "—" : pace}</span>
          <span className="tile-label">{t("meetingHud.wordsPerMinute")}</span>
        </span>
        <span className="tile">
          <span className="value">{questions}</span>
          <span className="tile-label">{t("meetingHud.questionsAsked")}</span>
        </span>
      </div>
    </section>
  );
}
