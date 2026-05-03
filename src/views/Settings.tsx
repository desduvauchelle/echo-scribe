import { useEffect, useState } from "react";
import HotkeyRebinder from "../components/HotkeyRebinder";
import SpeechModelPicker from "../components/SpeechModelPicker";
import LlmModelPicker from "../components/LlmModelPicker";
import ProjectManager from "../components/ProjectManager";
import PermissionsSection from "../components/PermissionsSection";
import StartAtLoginToggle from "../components/StartAtLoginToggle";
import TranscriptionSettings from "../components/TranscriptionSettings";
import {
  diagnosticsLogDir,
  diagnosticsOpenLogFolder,
  diagnosticsRecentLog,
  getAsrUnloadSecs,
  getAudioFeedbackEnabled,
  getAutoFileEnabled,
  getAutoFileThreshold,
  getLlmUnloadSecs,
  getLogCaptureBinding,
  getMuteWhileRecording,
  resetOnboardingAndQuit,
  setAsrUnloadSecs,
  setAudioFeedbackEnabled,
  setAutoFileEnabled,
  setAutoFileThreshold,
  setLlmUnloadSecs,
  setMuteWhileRecording,
  testLlmInference,
  updateLogCaptureBinding,
} from "../lib/api";
import { useToasts } from "../components/ToastProvider";

type Tab = "voice" | "ai" | "general" | "advanced";

const TABS: { id: Tab; label: string }[] = [
  { id: "voice", label: "Voice" },
  { id: "ai", label: "AI" },
  { id: "general", label: "General" },
  { id: "advanced", label: "Advanced" },
];

type Props = {
  onBack: () => void;
};

export default function Settings({ onBack }: Props) {
  const [tab, setTab] = useState<Tab>("voice");

  return (
    <div className="flex min-h-full items-start justify-center bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="relative w-full max-w-[640px] rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          ← Back
        </button>

        {/* Tab bar */}
        <div className="flex gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-1">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={[
                "flex-1 rounded-md py-1.5 text-xs font-semibold transition-colors",
                tab === id
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab panels */}
        <div className="mt-6">
          {tab === "voice" && <VoiceTab />}
          {tab === "ai" && <AiTab />}
          {tab === "general" && <GeneralTab />}
          {tab === "advanced" && <AdvancedTab />}
        </div>
      </div>
    </div>
  );
}

function VoiceTab() {
  return (
    <div className="flex flex-col gap-8">
      <SpeechModelPicker />

      <Section
        title="Voice-at-cursor hotkey"
        subtitle="Hold this key combination anywhere in macOS to dictate at the cursor."
      >
        <HotkeyRebinder />
      </Section>

      <Section
        title="Log capture hotkey"
        subtitle="Hold this key combination to capture a thought, idea, or task — classified locally and saved to your log."
      >
        <HotkeyRebinder
          load={getLogCaptureBinding}
          save={updateLogCaptureBinding}
        />
      </Section>

      <Section
        title="Transcription"
        subtitle="Clean up speech-to-text output before it's pasted or saved."
      >
        <TranscriptionSettings />
      </Section>

      <Section
        title="Keep speech model in memory"
        subtitle="How long the speech-to-text model stays loaded after its last use. Longer = faster next transcription, but uses more RAM."
      >
        <AsrUnloadTimeoutSelect />
      </Section>
    </div>
  );
}

function AiTab() {
  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Language model"
        subtitle="Local Gemma model used for log-capture classification."
      >
        <LlmModelPicker />
        <div className="mt-4">
          <TestInference />
        </div>
      </Section>

      <Section
        title="Keep model in memory"
        subtitle="How long the AI model stays loaded after its last use. Longer = faster next use, but more RAM."
      >
        <LlmUnloadTimeoutSelect />
      </Section>

      <AutoFileSettings />
    </div>
  );
}

function AutoFileSettings() {
  const [autoFileEnabled, setAutoFileEnabledLocal] = useState(true);
  const [autoFileThreshold, setAutoFileThresholdLocal] = useState(0.75);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [enabled, threshold] = await Promise.all([
        getAutoFileEnabled().catch(() => true),
        getAutoFileThreshold().catch(() => 0.75),
      ]);
      if (cancelled) return;
      setAutoFileEnabledLocal(enabled);
      setAutoFileThresholdLocal(threshold);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Section
      title="Auto-file confident captures"
      subtitle="File high-confidence captures silently. New-project proposals always show the review overlay."
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-neutral-400">
          When the local AI is at least <span className="font-mono">
          {Math.round(autoFileThreshold * 100)}%</span> sure about the project and
          kind, file the capture silently with a toast (or system notification when
          the window is closed).
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoFileEnabled}
            onChange={async (e) => {
              const next = e.target.checked;
              setAutoFileEnabledLocal(next);
              try {
                await setAutoFileEnabled(next);
              } catch {
                setAutoFileEnabledLocal(!next);
              }
            }}
          />
          Enable auto-file
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-300">
            Threshold: {Math.round(autoFileThreshold * 100)}%
          </span>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            disabled={!autoFileEnabled}
            value={autoFileThreshold}
            onChange={(e) => setAutoFileThresholdLocal(Number(e.target.value))}
            onMouseUp={async (e) => {
              const next = Number((e.target as HTMLInputElement).value);
              try {
                await setAutoFileThreshold(next);
              } catch {
                // Reload from backend on error.
                getAutoFileThreshold().then(setAutoFileThresholdLocal).catch(() => {});
              }
            }}
            onTouchEnd={async (e) => {
              const next = Number((e.target as HTMLInputElement).value);
              try {
                await setAutoFileThreshold(next);
              } catch {
                getAutoFileThreshold().then(setAutoFileThresholdLocal).catch(() => {});
              }
            }}
            className="w-full"
          />
        </label>
      </div>
    </Section>
  );
}

function GeneralTab() {
  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Audio feedback"
        subtitle="Subtle blips when recording starts, stops, and a log capture is ready for review."
      >
        <AudioFeedbackToggle />
      </Section>

      <Section
        title="Mute while recording"
        subtitle="Pause music and system audio while the hotkey is held, then restore it when you release."
      >
        <MuteWhileRecordingToggle />
      </Section>

      <Section
        title="Startup"
        subtitle="Launch Echo Scribe automatically when you log in."
      >
        <StartAtLoginToggle />
      </Section>

      <Section
        title="Permissions"
        subtitle="Re-grant microphone or accessibility access if something feels broken. Reset & quit clears macOS's TCC grants for both services so the next launch re-prompts cleanly."
      >
        <PermissionsSection />
      </Section>
    </div>
  );
}

function AdvancedTab() {
  return (
    <div className="flex flex-col gap-8">
      <Section title="Projects" subtitle="Rename, archive, or unarchive projects.">
        <ProjectManager />
      </Section>

      <Section
        title="Diagnostics"
        subtitle="Inspect the rolling crash log Echo Scribe writes to your home folder."
      >
        <DiagnosticsPane />
      </Section>

      <ResetSection />
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold tracking-tight text-neutral-200">
        {title}
      </h2>
      <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AudioFeedbackToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getAudioFeedbackEnabled();
        if (!cancelled) setEnabled(v);
      } catch {
        if (!cancelled) setEnabled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      await setAudioFeedbackEnabled(next);
      setEnabled(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update audio feedback: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div>
        <div className="text-sm font-semibold text-neutral-100">
          Play recording sounds
        </div>
        <p className="text-xs text-neutral-400">
          Three short tones tied to start, stop, and classification ready.
        </p>
      </div>
      <input
        type="checkbox"
        disabled={busy || enabled === null}
        checked={enabled ?? true}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-neutral-100"
      />
    </label>
  );
}

function MuteWhileRecordingToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getMuteWhileRecording();
        if (!cancelled) setEnabled(v);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      await setMuteWhileRecording(next);
      setEnabled(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update mute setting: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div>
        <div className="text-sm font-semibold text-neutral-100">
          Mute system audio while recording
        </div>
        <p className="text-xs text-neutral-400">
          Silences music and video playback for the duration of the recording.
        </p>
      </div>
      <input
        type="checkbox"
        disabled={busy || enabled === null}
        checked={enabled ?? false}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-neutral-100"
      />
    </label>
  );
}

function DiagnosticsPane() {
  const [logDir, setLogDir] = useState<string>("");
  const [recent, setRecent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();

  const loadRecent = async () => {
    setBusy(true);
    setError(null);
    try {
      const txt = await diagnosticsRecentLog(200);
      setRecent(txt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dir = await diagnosticsLogDir();
        if (!cancelled) setLogDir(dir);
      } catch {
        /* ignore */
      }
    })();
    void loadRecent();
    return () => {
      cancelled = true;
    };
  }, []);

  const onOpenFolder = async () => {
    try {
      await diagnosticsOpenLogFolder();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't open folder: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-neutral-100">
            Log folder
          </div>
          <p className="truncate text-xs text-neutral-400" title={logDir}>
            {logDir || "—"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onOpenFolder()}
          disabled={!logDir}
          className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
        >
          Open
        </button>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-neutral-100">
            Recent log (last 200 lines)
          </div>
          <button
            type="button"
            onClick={() => void loadRecent()}
            disabled={busy}
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? "…" : "Refresh"}
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-xs text-amber-300">{error}</p>
        ) : null}
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] leading-snug text-neutral-300">
          {recent || "(no log content yet)"}
        </pre>
      </div>
    </div>
  );
}

function TestInference() {
  const [prompt, setPrompt] = useState("Say hello in five words.");
  const [response, setResponse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRun = async () => {
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      const r = await testLlmInference(prompt);
      setResponse(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <p className="text-xs font-semibold tracking-tight text-neutral-300">
        Test inference
      </p>
      <div className="mt-2 flex gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-sm focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
      {response ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-950 p-2 text-xs text-neutral-200">
          {response}
        </pre>
      ) : null}
    </div>
  );
}

const LLM_UNLOAD_OPTIONS: { label: string; secs: number }[] = [
  { label: "1 minute", secs: 60 },
  { label: "2 minutes", secs: 120 },
  { label: "5 minutes", secs: 300 },
  { label: "15 minutes", secs: 900 },
  { label: "Keep loaded", secs: 0 },
];

function LlmUnloadTimeoutSelect() {
  const [secs, setSecs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getLlmUnloadSecs();
        if (!cancelled) setSecs(v);
      } catch {
        if (!cancelled) setSecs(120);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = async (next: number) => {
    setBusy(true);
    try {
      await setLlmUnloadSecs(next);
      setSecs(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update AI memory setting: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div>
        <div className="text-sm font-semibold text-neutral-100">
          Unload after idle
        </div>
        <p className="text-xs text-neutral-400">
          Frees RAM when you haven't used log-capture for a while.
        </p>
      </div>
      <select
        disabled={busy || secs === null}
        value={secs ?? 120}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
      >
        {LLM_UNLOAD_OPTIONS.map(({ label, secs: s }) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

const ASR_UNLOAD_OPTIONS: { label: string; secs: number }[] = [
  { label: "30 seconds", secs: 30 },
  { label: "1 minute", secs: 60 },
  { label: "2 minutes", secs: 120 },
  { label: "5 minutes", secs: 300 },
  { label: "15 minutes", secs: 900 },
  { label: "Keep loaded", secs: 0 },
];

function AsrUnloadTimeoutSelect() {
  const [secs, setSecs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getAsrUnloadSecs();
        if (!cancelled) setSecs(v);
      } catch {
        if (!cancelled) setSecs(120);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = async (next: number) => {
    setBusy(true);
    try {
      await setAsrUnloadSecs(next);
      setSecs(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update speech model memory setting: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div>
        <div className="text-sm font-semibold text-neutral-100">
          Unload after idle
        </div>
        <p className="text-xs text-neutral-400">
          Frees RAM when you haven't dictated for a while. The model reloads automatically on next use.
        </p>
      </div>
      <select
        disabled={busy || secs === null}
        value={secs ?? 120}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
      >
        {ASR_UNLOAD_OPTIONS.map(({ label, secs: s }) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ResetSection() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const onReset = async () => {
    if (
      !window.confirm(
        "Reset onboarding? This clears the settings store and quits the app. You'll need to relaunch.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await resetOnboardingAndQuit();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Reset failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      setBusy(false);
    }
  };

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
      >
        {open ? "Hide reset options" : "Show reset options"}
      </button>
      {open ? (
        <div className="mt-3 rounded-lg border border-red-900/40 bg-red-950/20 p-3">
          <p className="text-xs text-red-200">
            Wipes the settings store (hotkeys, active models, persisted
            preferences) and quits the app. Your captured items are
            preserved — they live in the SQLite database, not the settings store.
          </p>
          <button
            type="button"
            onClick={() => void onReset()}
            disabled={busy}
            className="mt-3 rounded-md border border-red-700 bg-red-900/40 px-3 py-1 text-xs text-red-100 hover:bg-red-900/60 disabled:opacity-50"
          >
            {busy ? "Resetting…" : "Reset onboarding"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
