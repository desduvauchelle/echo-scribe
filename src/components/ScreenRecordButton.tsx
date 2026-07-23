import { Loader, Video } from "lucide-react";
import { useCapabilities } from "../lib/capabilitiesContext";
import { uiGates } from "../lib/capabilities";
import { useScreenRecorder } from "../lib/useScreenRecorder";

type Variant = "sidebar" | "header";

/**
 * Starts / stops screen recording. `openScreenrecSetup` opens the source+audio
 * picker window (the actual capture starts there); when a recording is in
 * progress the button stops it. Gated on `screen_recording` so it hides on
 * Windows. Rendered in two places — the sidebar header (pill) and the dashboard
 * toolbar (icon) — via the `variant` prop.
 */
export default function ScreenRecordButton({
  variant = "sidebar",
}: {
  variant?: Variant;
}) {
  const caps = useCapabilities();
  const { active, busy, toggle } = useScreenRecorder();

  // Screen recording (and its Drive upload) share this capability gate.
  if (!uiGates(caps).showRecordingsNav) return null;

  const label = active ? "Stop screen recording" : "Record screen";

  if (variant === "header") {
    return (
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={active}
        aria-label={label}
        title={active ? "Stop screen recording" : "Record your screen"}
        className={`flex items-center gap-1.5 rounded-md border p-1.5 transition-colors disabled:opacity-70 ${
          active
            ? "border-danger/30 bg-danger/15 text-danger hover:bg-danger/20"
            : "border-line bg-surface text-muted hover:bg-elevated hover:text-fg"
        }`}
      >
        {busy ? (
          <Loader size={14} className="animate-spin" aria-hidden="true" />
        ) : active ? (
          <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
            <span className="h-2 w-2 rounded-[2px] bg-danger" />
          </span>
        ) : (
          <Video size={14} aria-hidden="true" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={active}
      title={active ? "Stop screen recording" : "Record your screen"}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
        active
          ? "border-danger/30 bg-danger/15 text-danger hover:bg-danger/20"
          : "border-line bg-elevated text-muted hover:text-fg"
      } ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`}
    >
      {busy ? (
        <Loader size={11} className="animate-spin" aria-hidden="true" />
      ) : active ? (
        <span className="flex h-1.5 w-1.5 items-center justify-center" aria-hidden="true">
          <span className="h-1.5 w-1.5 rounded-[1px] bg-danger" />
        </span>
      ) : (
        <Video size={11} strokeWidth={2} aria-hidden="true" />
      )}
      <span>{active ? "Stop" : "Screen"}</span>
    </button>
  );
}
