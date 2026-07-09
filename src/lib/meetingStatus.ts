import type { MeetingStatus } from "./api";

/** Semantic tone for a status indicator, mapped to colors by the caller. */
export type MeetingStatusTone = "processing" | "danger" | "muted";

export interface MeetingStatusDisplay {
  /** Short human-facing label, e.g. "Transcribing…" or "Failed".
   *  Empty string for `complete` (a finished meeting needs no status word). */
  label: string;
  /** Longer sentence for a detail-panel banner / tooltip.
   *  Empty string for `complete` (no banner shown). */
  description: string;
  /** Render an animated spinner beside the label — true only while work is
   *  actively in progress. */
  spinner: boolean;
  /** Semantic tone used to pick colors. */
  tone: MeetingStatusTone;
  /** When true, the meeting-list card should render this status pill INSTEAD of
   *  its normal summary/action counts + duration, which are absent or
   *  misleading (`0m`) until the meeting finishes processing. */
  pill: boolean;
}

/** True while a meeting is still being captured or processed and has no final
 *  transcript / summary / duration yet. Terminal states (`complete`, `failed`,
 *  `recovered`) return false. */
export function isMeetingProcessing(status: MeetingStatus): boolean {
  return (
    status === "recording" ||
    status === "transcribing" ||
    status === "summarizing"
  );
}

/** Map a meeting lifecycle status to how it should be surfaced in the UI.
 *  Centralizes the copy + styling decisions shared by the meeting list card
 *  (pill) and the detail panel (banner). */
export function meetingStatusDisplay(status: MeetingStatus): MeetingStatusDisplay {
  switch (status) {
    case "recording":
      return {
        label: "Recording…",
        description: "This meeting is still recording.",
        spinner: true,
        tone: "processing",
        pill: true,
      };
    case "transcribing":
      return {
        label: "Transcribing…",
        description:
          "Transcribing the audio — this can take a moment for long meetings.",
        spinner: true,
        tone: "processing",
        pill: true,
      };
    case "summarizing":
      return {
        label: "Summarizing…",
        description: "Summarizing the transcript — almost done.",
        spinner: true,
        tone: "processing",
        pill: true,
      };
    case "failed":
      return {
        label: "Failed",
        description:
          "This meeting didn't finish processing, so its summary may be missing.",
        spinner: false,
        tone: "danger",
        pill: true,
      };
    case "recovered":
      return {
        label: "Recovered",
        description:
          "This meeting was recovered after an interruption; some content may be partial.",
        spinner: false,
        tone: "muted",
        pill: false,
      };
    case "complete":
      return {
        label: "",
        description: "",
        spinner: false,
        tone: "muted",
        pill: false,
      };
  }
}
