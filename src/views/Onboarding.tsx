import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import HotkeyRebinder from "../components/HotkeyRebinder";
import LlmModelPicker from "../components/LlmModelPicker";
import PermissionRow from "../components/PermissionRow";
import SpeechModelPicker from "../components/SpeechModelPicker";
import StartAtLoginToggle from "../components/StartAtLoginToggle";
import {
  getLogCaptureBinding,
  listLlmModels,
  listSpeechModels,
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
  setOnboardingCompleted,
  startPipeline,
  updateLogCaptureBinding,
  type PermissionsStatus,
} from "../lib/api";

type Props = {
  initialStatus: PermissionsStatus;
  onStarted: () => void;
  /** Shown when the routing layer kicks the user back to onboarding because
   * a precondition (permission, speech model) regressed after they had
   * previously completed setup. */
  resumeNotice?: string | null;
};

// Permission row UI now lives in components/PermissionRow.tsx so it can be
// reused in Settings → Permissions.

function ResetTccBlock() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onConfirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await resetTccAndQuit();
      // The backend exits the app ~200ms later. If we're still here after
      // a beat, the call returned without quitting — show a hint.
      setTimeout(() => setErr("Reset returned but the app didn't quit. Try restarting manually."), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setArmed(false);
    }
  };

  if (!armed) {
    return (
      <div className="text-center">
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="text-xs text-faint underline-offset-2 hover:text-warning hover:underline"
        >
          Permission stuck? Reset & quit
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
      <p>
        This wipes Microphone + Accessibility + Screen Recording grants and
        quits Echo Scribe. You'll need to relaunch and re-grant access.
        Continue?
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="rounded-md border border-warning/40 bg-warning/15 px-3 py-1 font-semibold hover:bg-warning/15 disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Yes, reset & quit"}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={busy}
          className="rounded-md border border-line px-3 py-1 text-muted hover:bg-elevated"
        >
          Cancel
        </button>
      </div>
      {err ? <p className="mt-2 text-warning">{err}</p> : null}
    </div>
  );
}

export default function Onboarding({ initialStatus, onStarted, resumeNotice }: Props) {
  const [status, setStatus] = useState<PermissionsStatus>(initialStatus);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [llmReady, setLlmReady] = useState(false);
  // Once the user clicks "Skip for now" we hide the LLM step's gating banner
  // so the page reads as "you chose to skip" rather than "you still need to
  // do something". The flag is local to this onboarding session.
  const [llmSkipped, setLlmSkipped] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const refetchStartGate = useCallback(async () => {
    try {
      const ms = await listSpeechModels();
      setModelReady(ms.some((m) => m.active && m.downloaded));
    } catch {
      /* leave gate as-is */
    }
    try {
      const ls = await listLlmModels();
      setLlmReady(ls.some((m) => m.active && m.downloaded));
    } catch {
      /* leave gate as-is */
    }
  }, []);

  useEffect(() => {
    void refetchStartGate();
  }, [refetchStartGate]);

  const refresh = async (): Promise<PermissionsStatus> => {
    setChecking(true);
    try {
      const s = await permissionsStatus();
      setStatus(s);
      return s;
    } finally {
      setChecking(false);
    }
  };

  // Poll every 1.5s so the UI catches up if the user grants in System Settings
  // or finishes a model download in another tab.
  useEffect(() => {
    const tick = async () => {
      try {
        const s = await permissionsStatus();
        setStatus(s);
      } catch {
        /* ignore */
      }
      void refetchStartGate();
    };
    intervalRef.current = window.setInterval(tick, 1500);
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [refetchStartGate]);

  const bothGranted = status.microphone && status.accessibility;
  // Start is gated on: both perms green AND speech model ready. The LLM
  // is intentionally NOT gated here — voice-at-cursor must be reachable
  // even without an LLM. The user can come back to Settings later.
  const canStart = bothGranted && modelReady;

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
    // CGRequestScreenCaptureAccess() registers the app in the macOS Screen
    // Recording list and shows the system prompt. Returns false the first
    // time; the user has to flip the toggle in System Settings. We open
    // the pane as a fallback so they don't have to hunt for it.
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
    // Optional. promptCalendarAccess spawns the calmatch sidecar with
    // --request-access, which calls EKEventStore.requestFullAccessToEvents.
    // First call shows the system dialog; subsequent calls return cached.
    // On deny / sidecar failure we fall back to opening Settings so the
    // user can grant manually.
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
    // First call promptAccessibilityAccess() — this is the call that registers
    // Echo Scribe in the macOS Accessibility list. Without it, the list shows
    // up empty and the user has nothing to toggle. The system raises its own
    // "Open System Settings" button as part of that prompt, so we don't need
    // to open Settings ourselves (avoids the double-modal we had before).
    try {
      const trusted = await promptAccessibilityAccess();
      if (trusted) {
        await refresh();
        return;
      }
    } catch {
      /* fall through to the manual Settings open */
    }
    // Fallback: if the prompt didn't fire (e.g. the app is already in the
    // list but toggled off), open the Settings pane directly.
    try {
      await openAccessibilitySettings();
    } catch {
      /* ignore */
    }
    await refresh().catch(() => {});
  };

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await startPipeline();
      // Mark onboarding as complete *only after* startPipeline succeeds —
      // we don't want to flip the flag if the pipeline rejects (e.g. model
      // not actually ready) and bounce the user out of onboarding.
      try {
        await setOnboardingCompleted(true);
      } catch {
        /* ignore — App.tsx will retry on next launch */
      }
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const handleSkip = async () => {
    setSkipping(true);
    setError(null);
    try {
      // Let people explore the app without starting the capture pipeline.
      // Missing requirements remain visible in the main-view permission
      // banner and can be completed later from Settings.
      await setOnboardingCompleted(true);
    } catch {
      // The current session can still continue. If persistence failed, the
      // onboarding screen will simply appear again on the next launch.
    }
    onStarted();
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-6 py-12 text-fg">
      <div className="w-full max-w-[480px] rounded-xl border border-line bg-surface p-6 shadow-xl shadow-black/40">
        <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Mic size={18} strokeWidth={2} aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">
          Welcome to Echo Scribe
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          Grant the permissions below, pick a speech model, then start
          dictating anywhere. Screen Recording is optional — only needed if
          you want meetings to capture the other person's audio.
        </p>

        {resumeNotice ? (
          <div
            role="alert"
            className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            {resumeNotice}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-6">
          <PermissionRow
            title="Microphone"
            subtitle="Echo Scribe needs your microphone to capture what you say."
            granted={status.microphone}
            onGrant={() => {
              void handleGrantMicrophone();
            }}
            onRecheck={() => {
              void refresh();
            }}
            recheckBusy={checking}
          />

          <div className="h-px bg-elevated" />

          <PermissionRow
            title="Accessibility"
            subtitle="Required to paste transcribed text at the cursor in any app."
            granted={status.accessibility}
            onGrant={() => {
              void handleGrantAccessibility();
            }}
            onRecheck={() => {
              void refresh();
            }}
            recheckBusy={checking}
          />

          <div className="h-px bg-elevated" />

          <PermissionRow
            title="Screen Recording"
            subtitle="Lets Echo Scribe capture the other participant's audio during Zoom, Google Meet, and other meetings. Without it, only your microphone is recorded."
            granted={status.screen_recording}
            onGrant={() => {
              void handleGrantScreenRecording();
            }}
            onRecheck={() => {
              void refresh();
            }}
            recheckBusy={checking}
          />

          <div className="h-px bg-elevated" />

          <PermissionRow
            title="Calendar (optional)"
            subtitle="Matches each meeting to your calendar invite so summaries name attendees and reference the meeting topic. Calendar data never leaves your Mac. Skip — you can grant later in Settings."
            granted={status.calendars}
            onGrant={() => {
              void handleGrantCalendars();
            }}
            onRecheck={() => {
              void refresh();
            }}
            recheckBusy={checking}
          />

          <div className="h-px bg-elevated" />

          <div>
            <SpeechModelPicker
              onChange={() => {
                void refetchStartGate();
              }}
            />
          </div>

          <div className="h-px bg-elevated" />

          <div>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold tracking-tight text-fg">
                Local AI model{" "}
                <span className="text-xs font-normal text-muted">
                  (optional)
                </span>
              </h2>
              {llmReady ? (
                <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
                  Ready
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              Powers the log-capture flow (auto-classifying notes, tasks,
              tags). Voice-at-cursor works without it — skip to come back later.
            </p>
            <div className="mt-3">
              <LlmModelPicker />
            </div>
            {!llmReady && !llmSkipped ? (
              <button
                type="button"
                onClick={() => setLlmSkipped(true)}
                className="mt-3 text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
              >
                Skip for now
              </button>
            ) : null}
            {llmSkipped && !llmReady ? (
              <p className="mt-3 text-xs text-muted">
                Skipped. Log-capture will show a friendly notice until you
                pick a model in Settings.
              </p>
            ) : null}
          </div>

          <div className="h-px bg-elevated" />

          <div>
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              Dictation shortcut
            </h2>
            <p className="mt-1 text-sm text-muted">
              Press and hold to record. Default is Right Control — change it
              here if that conflicts with another app.
            </p>
            <div className="mt-3">
              <HotkeyRebinder />
            </div>
          </div>

          <div>
            <StartAtLoginToggle variant="row" />
          </div>

          <div>
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              Log capture shortcut
            </h2>
            <p className="mt-1 text-sm text-muted">
              Press and hold to capture a thought or task. Default is Right
              Option — Echo Scribe will classify it locally and pop a review
              overlay.
            </p>
            <div className="mt-3">
              <HotkeyRebinder
                load={getLogCaptureBinding}
                save={updateLogCaptureBinding}
              />
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={!canStart || starting || skipping}
          onClick={() => {
            void handleStart();
          }}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-canvas border-t-transparent" />
              Starting…
            </>
          ) : (
            "Start Echo Scribe"
          )}
        </button>

        <button
          type="button"
          disabled={starting || skipping}
          onClick={() => {
            void handleSkip();
          }}
          className="mt-2.5 flex w-full items-center justify-center rounded-md border border-line px-4 py-2 text-sm font-medium text-muted hover:border-line-strong hover:bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {skipping ? "Skipping…" : "Skip setup for now"}
        </button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-faint">
          You can browse Echo Scribe now and finish setup later in Settings.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-xs text-warning">
            {error}
          </p>
        ) : null}

        <div className="mt-6 border-t border-line pt-3">
          <ResetTccBlock />
        </div>
      </div>
    </div>
  );
}
