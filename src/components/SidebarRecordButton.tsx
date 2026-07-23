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
export default function SidebarRecordButton() {
  const caps = useCapabilities();
  const { active, busy, toggle } = useMeetingRecorder();

  if (!uiGates(caps).showMeetingRecord) return null;

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={active}
      title={active ? "Stop recording" : "Record system audio + mic as a meeting"}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
        active
          ? "border-danger/30 bg-danger/15 text-danger hover:bg-danger/20"
          : "border-line bg-elevated text-muted hover:text-fg"
      } ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {active ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
      </span>
      <span>{active ? "Stop" : "Record"}</span>
    </button>
  );
}
