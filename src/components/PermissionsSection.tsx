import { useEffect, useRef, useState } from "react";
import {
  openAccessibilitySettings,
  openCalendarSettings,
  openMicrophoneSettings,
  openScreenRecordingSettings,
  permissionsStatus,
  promptAccessibilityAccess,
  promptCalendarAccess,
  requestMicrophoneAccess,
  requestScreenRecordingAccess,
  resetTccAndQuit,
  type PermissionsStatus,
} from "../lib/api";
import PermissionRow from "./PermissionRow";
import { useToasts } from "./ToastProvider";

/// Manage Microphone + Accessibility from Settings. Mirrors the onboarding
/// flow so users can re-grant after a reinstall or revoked permission without
/// being kicked all the way back to onboarding. Also exposes a one-click
/// "Reset permissions" button that runs `tccutil reset` for both services
/// and quits the app — equivalent to the manual workflow in CLAUDE.md.
export default function PermissionsSection() {
  const [status, setStatus] = useState<PermissionsStatus>({
    microphone: false,
    accessibility: false,
    screen_recording: false,
    calendars: false,
  });
  const [checking, setChecking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const intervalRef = useRef<number | null>(null);
  const toasts = useToasts();

  const refresh = async () => {
    setChecking(true);
    try {
      const s = await permissionsStatus();
      setStatus(s);
    } catch {
      /* ignore */
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void refresh();
    intervalRef.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const handleGrantMicrophone = async () => {
    try {
      const granted = await requestMicrophoneAccess();
      if (granted) {
        await refresh();
      } else {
        await openMicrophoneSettings();
      }
    } catch {
      await openMicrophoneSettings().catch(() => {});
    }
  };

  const handleGrantScreenRecording = async () => {
    // CGRequestScreenCaptureAccess registers Echo Scribe in the macOS Screen
    // Recording list and shows the system prompt. First call typically
    // returns false — user has to flip the toggle in System Settings. We
    // open the pane as a fallback in that case.
    try {
      const granted = await requestScreenRecordingAccess();
      if (granted) {
        await refresh();
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await openScreenRecordingSettings();
    } catch {
      /* ignore */
    }
    await refresh().catch(() => {});
  };

  const handleGrantCalendars = async () => {
    // Calendar access is optional. promptCalendarAccess shells out to the
    // calmatch sidecar which calls requestFullAccessToEvents — first call
    // shows the system dialog, subsequent calls return cached. If the
    // sidecar isn't available or the user declines, we fall back to
    // opening Settings.
    try {
      const granted = await promptCalendarAccess();
      if (granted) {
        await refresh();
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await openCalendarSettings();
    } catch {
      /* ignore */
    }
    await refresh().catch(() => {});
  };

  const handleGrantAccessibility = async () => {
    // promptAccessibilityAccess() is what registers the app in macOS's
    // Accessibility list. Without it the list is empty so there's nothing
    // for the user to toggle. The system shows its own "Open System Settings"
    // button as part of the prompt.
    try {
      const trusted = await promptAccessibilityAccess();
      if (trusted) {
        await refresh();
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await openAccessibilitySettings();
    } catch {
      /* ignore */
    }
    await refresh().catch(() => {});
  };

  const [confirmReset, setConfirmReset] = useState(false);

  const handleReset = async () => {
    setResetting(true);
    try {
      await resetTccAndQuit();
      setTimeout(() => {
        toasts.push({
          tone: "error",
          message: "Reset returned but the app didn't quit. Try restarting Echo Scribe manually.",
        });
        setResetting(false);
        setConfirmReset(false);
      }, 1500);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't reset permissions: ${e instanceof Error ? e.message : String(e)}`,
      });
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PermissionRow
        title="Microphone"
        subtitle="Echo Scribe needs your microphone to capture what you say."
        granted={status.microphone}
        onGrant={() => void handleGrantMicrophone()}
        onRecheck={() => void refresh()}
        recheckBusy={checking}
      />

      <div className="h-px bg-elevated" />

      <PermissionRow
        title="Accessibility"
        subtitle="Required to paste transcribed text at the cursor in any app."
        granted={status.accessibility}
        onGrant={() => void handleGrantAccessibility()}
        onRecheck={() => void refresh()}
        recheckBusy={checking}
      />

      <div className="h-px bg-elevated" />

      <PermissionRow
        title="Screen Recording"
        subtitle="Lets Echo Scribe capture the other participant's audio during Zoom, Google Meet, and similar meetings. Without it, only your microphone is recorded."
        granted={status.screen_recording}
        onGrant={() => void handleGrantScreenRecording()}
        onRecheck={() => void refresh()}
        recheckBusy={checking}
      />

      <div className="h-px bg-elevated" />

      <PermissionRow
        title="Calendar (optional)"
        subtitle="Matches each meeting to your calendar invite so summaries name attendees and reference the meeting topic. The calendar data never leaves your Mac."
        granted={status.calendars}
        onGrant={() => void handleGrantCalendars()}
        onRecheck={() => void refresh()}
        recheckBusy={checking}
      />

      <div className="h-px bg-elevated" />

      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="font-semibold tracking-tight text-warning">
            Reset permissions
          </div>
          <p className="mt-1 text-sm text-muted">
            Wipes Microphone + Accessibility + Screen Recording grants and
            quits the app. Use if a permission feels broken — relaunch will
            re-prompt from scratch.
          </p>
        </div>
        {confirmReset ? (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={resetting}
              className="rounded-md border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/15 disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Yes, reset & quit"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:bg-elevated"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="shrink-0 rounded-md border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/15"
          >
            Reset & quit
          </button>
        )}
      </div>
    </div>
  );
}
