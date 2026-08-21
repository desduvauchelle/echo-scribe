import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCapabilities } from "../lib/capabilitiesContext";
import { uiGates } from "../lib/capabilities";
import { useMeetingRecorder } from "../lib/useMeetingRecorder";

/**
 * Compact Record pill for the sidebar header, sitting next to the dictation
 * shortcut hint. One click toggles the existing manual meeting recorder (system
 * audio + mic → transcript + summary + notes). Shares recorder state with the
 * Meetings tab and recording overlay via `useMeetingRecorder`. macOS-only —
 * gated on system-audio capability, so it is hidden on Windows. The label stays
 * terse ("Record" / "Stop"); the full meaning lives in the tooltip.
 */
export default function SidebarRecordButton({
  variant = "sidebar",
}: {
  variant?: "sidebar" | "toolbar";
}) {
  const { t } = useTranslation();
  const caps = useCapabilities();
  const { active, busy, toggle } = useMeetingRecorder();

  if (!uiGates(caps).showMeetingRecord) return null;

  if (variant === "toolbar") {
    return (
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={active}
        title={active ? t("sidebarRecordButton.stopRecordingTitle") : t("sidebarRecordButton.captureMeetingTitle")}
        className={`echo-capture-command inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] font-semibold ${
          active ? "is-recording" : ""
        } ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`}
      >
        <Mic size={14} strokeWidth={2} aria-hidden="true" />
        <span>{active ? t("sidebarRecordButton.stopCapture") : t("sidebarRecordButton.capture")}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={active}
      title={active ? t("sidebarRecordButton.stopRecordingTitle") : t("sidebarRecordButton.recordMeetingTitle")}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
        active
          ? "border-danger/30 bg-danger/15 text-danger hover:bg-danger/20"
          : "material-icon-button border-line text-muted hover:text-fg"
      } ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {active ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
        ) : null}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
            active ? "bg-danger" : "bg-faint"
          }`}
        />
      </span>
      <span>{active ? t("sidebarRecordButton.stop") : t("sidebarRecordButton.record")}</span>
    </button>
  );
}
