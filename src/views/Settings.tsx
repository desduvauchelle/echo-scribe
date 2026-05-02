import { useEffect, useState } from "react";
import HotkeyRebinder from "../components/HotkeyRebinder";
import SpeechModelPicker from "../components/SpeechModelPicker";
import LlmModelPicker from "../components/LlmModelPicker";
import ProjectManager from "../components/ProjectManager";
import {
  diagnosticsLogDir,
  diagnosticsRecentLog,
  getAudioFeedbackEnabled,
  getLogCaptureBinding,
  resetOnboardingAndQuit,
  setAudioFeedbackEnabled,
  testLlmInference,
  updateLogCaptureBinding,
} from "../lib/api";
import { useToasts } from "../components/ToastProvider";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  onBack: () => void;
};

export default function Settings({ onBack }: Props) {
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

        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

        <Section title="Speech model" subtitle="Switch between downloaded models or download a new one.">
          <SpeechModelPicker />
        </Section>

        <Section
          title="LLM model"
          subtitle="Local Gemma model used for log-capture classification."
        >
          <LlmModelPicker />
          <div className="mt-4">
            <TestInference />
          </div>
        </Section>

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
          title="Audio feedback"
          subtitle="Subtle blips when recording starts, stops, and a log capture is ready for review."
        >
          <AudioFeedbackToggle />
        </Section>

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
    <section className="mt-8">
      <h2 className="text-sm font-semibold tracking-tight text-neutral-200">
        {title}
      </h2>
      <p className="mt-1 text-sm text-neutral-300">{subtitle}</p>
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
    if (!logDir) return;
    try {
      // tauri-plugin-shell exposes `plugin:shell|open` over invoke. We pass
      // the directory path; the shell plugin will Reveal-in-Finder it.
      await invoke("plugin:shell|open", { path: logDir });
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
    <section className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
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
