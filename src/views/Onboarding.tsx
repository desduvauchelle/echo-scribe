import { useCallback, useEffect, useRef, useState } from "react";
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
  openMicrophoneSettings,
  permissionsStatus,
  promptAccessibilityAccess,
  requestMicrophoneAccess,
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
          className="text-xs text-neutral-500 underline-offset-2 hover:text-amber-300 hover:underline"
        >
          Permission stuck? Reset & quit
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-100">
      <p>
        This wipes Microphone + Accessibility grants and quits Echo Scribe.
        You'll need to relaunch and re-grant access. Continue?
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="rounded-md border border-amber-700 bg-amber-900/50 px-3 py-1 font-semibold hover:bg-amber-900/80 disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Yes, reset & quit"}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={busy}
          className="rounded-md border border-neutral-700 px-3 py-1 text-neutral-300 hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
      {err ? <p className="mt-2 text-amber-300">{err}</p> : null}
    </div>
  );
}

export default function Onboarding({ initialStatus, onStarted, resumeNotice }: Props) {
  const [status, setStatus] = useState<PermissionsStatus>(initialStatus);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
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

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="w-full max-w-[480px] rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <h1 className="text-xl font-semibold tracking-tight">
          Welcome to Echo Scribe
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Grant the two permissions below, pick a speech model, then start
          dictating anywhere.
        </p>

        {resumeNotice ? (
          <div className="mt-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
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

          <div className="h-px bg-neutral-800" />

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

          <div className="h-px bg-neutral-800" />

          <div>
            <SpeechModelPicker
              onChange={() => {
                void refetchStartGate();
              }}
            />
          </div>

          <div className="h-px bg-neutral-800" />

          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold tracking-tight">
                Local AI model{" "}
                <span className="text-xs font-normal text-neutral-400">
                  (optional)
                </span>
              </div>
              {llmReady ? (
                <span className="inline-flex items-center rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-200">
                  Ready
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-neutral-300">
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
                className="mt-3 text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
              >
                Skip for now
              </button>
            ) : null}
            {llmSkipped && !llmReady ? (
              <p className="mt-3 text-xs text-neutral-400">
                Skipped. Log-capture will show a friendly notice until you
                pick a model in Settings.
              </p>
            ) : null}
          </div>

          <div className="h-px bg-neutral-800" />

          <div>
            <div className="font-semibold tracking-tight">
              Dictation shortcut
            </div>
            <p className="mt-1 text-sm text-neutral-300">
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
            <div className="font-semibold tracking-tight">
              Log capture shortcut
            </div>
            <p className="mt-1 text-sm text-neutral-300">
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
          disabled={!canStart || starting}
          onClick={() => {
            void handleStart();
          }}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-md bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent" />
              Starting…
            </>
          ) : (
            "Start Echo Scribe"
          )}
        </button>

        {error ? (
          <p className="mt-3 text-xs text-amber-300">{error}</p>
        ) : null}

        <div className="mt-6 border-t border-neutral-800 pt-3">
          <ResetTccBlock />
        </div>
      </div>
    </div>
  );
}
