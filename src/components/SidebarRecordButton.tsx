import { useCapabilities } from "../lib/capabilitiesContext";
import { uiGates } from "../lib/capabilities";
import { useMeetingRecorder } from "../lib/useMeetingRecorder";

/**
 * Sidebar Record button: one-click start/stop of a full capture (system audio
 * + mic) that is logged as a meeting (transcript + summary + notes come for
 * free through the existing meeting pipeline). Shares recorder state with the
 * Meetings tab and the recording overlay via `useMeetingRecorder`. macOS-only —
 * gated on system-audio capability, so it is hidden on Windows.
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
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-danger text-white hover:bg-danger/90"
          : "text-muted hover:bg-elevated hover:text-fg"
      } ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`}
    >
      <span className="relative inline-flex h-2 w-2">
        {active ? (
          <>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
          </>
        ) : (
          <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
        )}
      </span>
      <span>{active ? "Stop recording" : "Record"}</span>
    </button>
  );
}
