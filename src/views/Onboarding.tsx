import { useCallback, useEffect, useRef, useState } from "react";
import HotkeyRebinder from "../components/HotkeyRebinder";
import LlmModelPicker from "../components/LlmModelPicker";
import SpeechModelPicker from "../components/SpeechModelPicker";
import {
  getLogCaptureBinding,
  listLlmModels,
  listSpeechModels,
  openAccessibilitySettings,
  openMicrophoneSettings,
  permissionsStatus,
  promptAccessibilityAccess,
  requestMicrophoneAccess,
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

function StatusPill({ granted }: { granted: boolean }) {
  return granted ? (
    <span className="inline-flex items-center rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-200">
      Granted
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-900 px-2 py-0.5 text-xs text-amber-200">
      Not granted
    </span>
  );
}

function Row(props: {
  title: string;
  subtitle: string;
  granted: boolean;
  onGrant: () => void;
  onRecheck: () => void;
  recheckBusy: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="font-semibold tracking-tight">{props.title}</div>
        <p className="mt-1 text-sm text-neutral-300">{props.subtitle}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <StatusPill granted={props.granted} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={props.onGrant}
            className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
          >
            Grant access
          </button>
          <button
            type="button"
            onClick={props.onRecheck}
            disabled={props.recheckBusy}
            className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
          >
            {props.recheckBusy ? "…" : "Re-check"}
          </button>
        </div>
      </div>
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
    try {
      await promptAccessibilityAccess();
    } catch {
      /* ignore */
    }
    try {
      await openAccessibilitySettings();
    } catch {
      /* ignore */
    }
    await refresh().catch(() => {
      /* ignore */
    });
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
          <Row
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

          <Row
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
      </div>
    </div>
  );
}
