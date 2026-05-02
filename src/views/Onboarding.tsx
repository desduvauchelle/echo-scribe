import { useEffect, useRef, useState } from "react";
import HotkeyRebinder from "../components/HotkeyRebinder";
import {
  openAccessibilitySettings,
  openMicrophoneSettings,
  permissionsStatus,
  startPipeline,
  type PermissionsStatus,
} from "../lib/api";

type Props = {
  initialStatus: PermissionsStatus;
  onStarted: () => void;
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

export default function Onboarding({ initialStatus, onStarted }: Props) {
  const [status, setStatus] = useState<PermissionsStatus>(initialStatus);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

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

  // Poll every 1.5s so the UI catches up if the user grants in System Settings.
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

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await startPipeline();
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
          Grant the two permissions below, then start dictating anywhere.
        </p>

        <div className="mt-6 flex flex-col gap-6">
          <Row
            title="Microphone"
            subtitle="Echo Scribe needs your microphone to capture what you say."
            granted={status.microphone}
            onGrant={() => {
              void openMicrophoneSettings();
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
              void openAccessibilitySettings();
            }}
            onRecheck={() => {
              void refresh();
            }}
            recheckBusy={checking}
          />

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
        </div>

        <button
          type="button"
          disabled={!bothGranted || starting}
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
