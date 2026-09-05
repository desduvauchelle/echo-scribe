import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import SpeechSetupStatus from "../components/SpeechSetupStatus";
import { useSpeechSetup } from "../lib/speechSetup";
import PermissionRow from "../components/PermissionRow";
import {
  openAccessibilitySettings,
  openMicrophoneSettings,
  permissionsStatus,
  promptAccessibilityAccess,
  requestMicrophoneAccess,
  resetTccAndQuit,
  setOnboardingCompleted,
  startPipeline,
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
  const { t } = useTranslation("onboarding");
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
      setTimeout(() => setErr(t("resetTcc.timeoutError")), 1500);
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
          {t("resetTcc.linkLabel")}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
      <p>
        {t("resetTcc.confirmBody")}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="rounded-md border border-warning/40 bg-warning/15 px-3 py-1 font-semibold hover:bg-warning/15 disabled:opacity-50"
        >
          {busy ? t("resetTcc.resetting") : t("resetTcc.confirmButton")}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={busy}
          className="rounded-md border border-line px-3 py-1 text-muted hover:bg-elevated"
        >
          {t("resetTcc.cancelButton")}
        </button>
      </div>
      {err ? <p className="mt-2 text-warning">{err}</p> : null}
    </div>
  );
}

export default function Onboarding({ initialStatus, onStarted, resumeNotice }: Props) {
  const { t } = useTranslation("onboarding");
  const [status, setStatus] = useState<PermissionsStatus>(initialStatus);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speech = useSpeechSetup(true);
  const intervalRef = useRef<number | null>(null);
  const prompted = useRef({ accessibility: false });
  const [accessibilityHint, setAccessibilityHint] = useState(false);

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

    };
    intervalRef.current = window.setInterval(tick, 1500);
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const bothGranted = status.microphone && status.accessibility;
  // Start is gated on: both perms green AND speech model ready. The LLM
  // is intentionally NOT gated here — voice-at-cursor must be reachable
  // even without an LLM. The user can come back to Settings later.
  const canStart = bothGranted && speech.phase === "ready";

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
    // promptAccessibilityAccess() (AXIsProcessTrustedWithOptions) registers
    // Tucky in the macOS Accessibility list *asynchronously* and always
    // returns false on a fresh install. The system raises its own "Open
    // System Settings" button as part of that prompt — opening Settings
    // ourselves in the same tick shows a stale list WITHOUT the app in it and
    // hides the system dialog. First click: prompt + hint only. Later clicks:
    // open the pane (the app is in the list by then, e.g. toggled off).
    if (!prompted.current.accessibility) {
      prompted.current.accessibility = true;
      try {
        const trusted = await promptAccessibilityAccess();
        if (trusted) {
          await refresh();
          return;
        }
      } catch {
        /* registered or not — show the hint either way */
      }
      setAccessibilityHint(true);
      await refresh().catch(() => {});
      return;
    }
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
          {t("welcome.title")}
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          {t("simple.intro")}
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
            title={t("permissions.microphone.title")}
            subtitle={t("permissions.microphone.subtitle")}
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
            title={t("permissions.accessibility.title")}
            subtitle={t("permissions.accessibility.subtitle")}
            hint={accessibilityHint ? t("permissions.promptHint") : undefined}
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

          <SpeechSetupStatus start />
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
              {t("startButton.starting")}
            </>
          ) : (
            t("startButton.label")
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
          {skipping ? t("skipButton.skipping") : t("skipButton.label")}
        </button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-faint">
          {t("skipButton.note")}
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-xs text-warning">
            {error}
          </p>
        ) : null}

        <details className="mt-6 border-t border-line pt-3 text-xs text-muted"><summary className="cursor-pointer">{t("simple.help")}</summary><div className="pt-3"><ResetTccBlock /></div></details>
      </div>
    </div>
  );
}
