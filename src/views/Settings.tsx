import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Mic,
  Phone,
  Settings as SettingsIcon,
  Sparkles,
  Wrench,
  X,
  Info,
  Check,
  type LucideIcon,
} from "lucide-react";
import HotkeyRebinder from "../components/HotkeyRebinder";
import SpeechModelPicker from "../components/SpeechModelPicker";
import LlmModelPicker from "../components/LlmModelPicker";
import ProjectManager from "../components/ProjectManager";
import GuideTemplateManager from "../components/GuideTemplateManager";
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
  getDailyRecapSettings,
  getInputDeviceSort,
  getLlmUnloadSecs,
  getLogCaptureBinding,
  getMuteWhileRecording,
  getPreferredInputDevice,
  getRecentInputDevices,
  listInputDevices,
  resetOnboardingAndQuit,
  setAsrUnloadSecs,
  setAudioFeedbackEnabled,
  setAutoFileEnabled,
  setAutoFileThreshold,
  setDailyRecapSettings,
  setInputDeviceSort,
  setLlmUnloadSecs,
  setMuteWhileRecording,
  setPreferredInputDevice,
  testLlmInference,
  updateLogCaptureBinding,
  getAppLauncherEnabled,
  setAppLauncherEnabled,
  getActionCounter,
  resetActionCounter,
  getCommonActions,
  getActionBinding,
  updateActionBinding,
  getTriggerWordRoutingEnabled,
  setTriggerWordRoutingEnabled,
  getActionTriggerWord,
  setActionTriggerWord,
  driveStatus,
  driveConnect,
  driveDisconnect,
  getDriveClientId,
  setDriveClientCredentials,
  type DriveStatus,
  type CommonActionTemplate,
  type DailyRecapSettings as DailyRecapSettingsT,
  type InputDevice,
  type InputDeviceSort,
} from "../lib/api";
import { useToasts } from "../components/ToastProvider";
import { ask } from "@tauri-apps/plugin-dialog";

type Tab = "voice" | "ai" | "meetings" | "general" | "advanced";

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "voice", label: "Voice", icon: Mic },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "meetings", label: "Meetings", icon: Phone },
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "advanced", label: "Advanced", icon: Wrench },
];

type Props = {
  onBack: () => void;
};

export default function Settings({ onBack }: Props) {
  const [tab, setTab] = useState<Tab>("voice");

  return (
    <div className="flex min-h-full items-start justify-center bg-canvas px-6 py-12 text-fg">
      <div className="relative w-full max-w-[640px] rounded-xl border border-line bg-surface p-6 shadow-xl shadow-black/40">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-fg"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          Back
        </button>

        {/* Tab bar */}
        <div className="flex gap-1 rounded-lg border border-line bg-canvas p-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={[
                  "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition-colors",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-faint hover:bg-elevated hover:text-muted",
                ].join(" ")}
              >
                <Icon size={12} strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>

        {/* Tab panels */}
        <div className="mt-6">
          {tab === "voice" && <VoiceTab />}
          {tab === "ai" && <AiTab />}
          {tab === "meetings" && <MeetingsTab />}
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
        title="Microphone"
        subtitle="Pick which input device Echo Scribe records from. Default uses whatever macOS has selected."
      >
        <MicrophonePicker />
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
        <p className="text-xs text-muted">
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
          <span className="text-muted">
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

function MicrophonePicker() {
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [sort, setSort] = useState<InputDeviceSort>("last_used");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [d, p, r, s] = await Promise.all([
        listInputDevices(),
        getPreferredInputDevice(),
        getRecentInputDevices(),
        getInputDeviceSort(),
      ]);
      setDevices(d);
      setPreferred(p);
      setRecent(r);
      setSort(s);
      setError(null);
    } catch (e) {
      setError(`Couldn't load microphones: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  // Order: system default first, then preferred (if not the same as default
  // and present), then everything else by chosen sort. The system-default
  // entry is always shown — even if it changed since last selection — so the
  // user can revert to "follow macOS" with one click.
  const ordered = orderDevices(devices, recent, sort);
  const systemDefault = devices.find((d) => d.is_system_default) ?? null;
  const preferredMissing =
    preferred !== null && !devices.some((d) => d.name === preferred);

  if (loading) {
    return <p className="text-xs text-muted">Loading microphones…</p>;
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-warning">{error}</p>
        <button
          type="button"
          onClick={reload}
          className="self-start rounded border border-line px-2 py-1 text-xs"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {preferredMissing && (
        <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">
          Saved mic <span className="font-mono">{preferred}</span> isn't
          connected. Pick another below or revert to the system default.
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Input device</span>
        <select
          className="rounded border border-line bg-canvas px-2 py-1 text-sm"
          value={preferred ?? ""}
          onChange={async (e) => {
            const next = e.target.value === "" ? null : e.target.value;
            const prev = preferred;
            setPreferred(next);
            try {
              await setPreferredInputDevice(next);
              if (next !== null) {
                setRecent((curr) => {
                  const without = curr.filter((n) => n !== next);
                  return [next, ...without].slice(0, 10);
                });
              }
            } catch {
              setPreferred(prev);
            }
          }}
        >
          <option value="">
            System default
            {systemDefault ? ` — ${systemDefault.name}` : ""}
          </option>
          {ordered.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
              {d.sample_rate ? ` · ${d.sample_rate / 1000}kHz` : ""}
              {d.channels ? ` · ${d.channels}ch` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted">Sort by</span>
        <select
          className="rounded border border-line bg-canvas px-2 py-1 text-sm"
          value={sort}
          onChange={async (e) => {
            const next = e.target.value as InputDeviceSort;
            const prev = sort;
            setSort(next);
            try {
              await setInputDeviceSort(next);
            } catch {
              setSort(prev);
            }
          }}
        >
          <option value="last_used">Last used</option>
          <option value="alphabetical">Alphabetical</option>
        </select>
      </label>

      <p className="text-[11px] text-muted">
        When a saved mic is unplugged, Echo Scribe will refuse to record and
        notify you — it won't silently fall back to another device.
      </p>
    </div>
  );
}

function orderDevices(
  devices: InputDevice[],
  recent: string[],
  sort: InputDeviceSort,
): InputDevice[] {
  if (sort === "alphabetical") {
    return [...devices].sort((a, b) => a.name.localeCompare(b.name));
  }
  // last_used: recent-MRU first (in order), then unseen devices alphabetical.
  const recentSet = new Set(recent);
  const recentDevices: InputDevice[] = [];
  for (const name of recent) {
    const d = devices.find((x) => x.name === name);
    if (d) recentDevices.push(d);
  }
  const rest = devices
    .filter((d) => !recentSet.has(d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...recentDevices, ...rest];
}

const SUMMARY_TEMPLATES = [
  {
    id: "standard",
    name: "Standard Note-Taker",
    description: "General summary and actionable next steps",
    prompt: `You are an expert meeting note-taker. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side).

Generate a comprehensive meeting summary that captures the essence of the discussion. Focus on:
1. The main objectives and topics of the meeting.
2. The key discussion points, arguments, and context.
3. Crucial decisions made or consensus reached.
4. Specific action items with clear ownership.`,
  },
  {
    id: "action-item",
    name: "Action-Item Focused",
    description: "Prioritizes tasks, owners, and deadlines",
    prompt: `You are a highly efficient project manager. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side).

Focus deeply on extracting all action items, ownership, deadlines, and deliverables. Ensure:
1. Every task is explicitly captured with its owner (either 'you', 'them', or 'unspecified').
2. Mention any deadlines, timelines, or dependencies mentioned.
3. Keep the general summary extremely concise, highlighting only what led to the tasks.`,
  },
  {
    id: "executive",
    name: "Executive Summary",
    description: "Strategic roadmaps, outcomes, and business impact",
    prompt: `You are a high-level strategic advisor. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side).

Create a premium, high-level executive summary for leadership. Focus on:
1. Key takeaways, strategic decisions, and alignment.
2. Core business/product outcomes and why they matter.
3. High-level roadmaps, major milestones, and strategic action items.
4. Keep technical minutiae to an absolute minimum, focusing on high-level impact.`,
  },
  {
    id: "technical",
    name: "Technical Sync",
    description: "Deep dev syncs, APIs, and blockers",
    prompt: `You are a lead systems architect and technical writer. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side).

Generate a highly detailed technical sync note. Focus on:
1. Architectural decisions, system designs, and code changes discussed.
2. Specific APIs, libraries, endpoints, database schemas, or protocols mentioned.
3. Blockers, bugs, performance issues, and debugging steps.
4. Precise technical tasks, dev ownership, and next steps for the engineering team.`,
  },
];

interface SummaryPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPrompt: string;
  onSave: (prompt: string) => Promise<void>;
}

function SummaryPromptModal({
  isOpen,
  onClose,
  currentPrompt,
  onSave,
}: SummaryPromptModalProps) {
  const [prompt, setPrompt] = useState(currentPrompt);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPrompt(currentPrompt);
      const matched = SUMMARY_TEMPLATES.find(
        (t) => t.prompt.trim() === currentPrompt.trim()
      );
      setSelectedTemplate(matched ? matched.id : null);
    }
  }, [isOpen, currentPrompt]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setBusy(true);
    try {
      await onSave(prompt);
      onClose();
    } catch {
      // Parent's handler processes reporting errors via Toast
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-backdrop">
      <style>{`
        @keyframes modal-backdrop-fade {
          from { opacity: 0; background-color: rgba(0, 0, 0, 0); backdrop-filter: blur(0px); }
          to { opacity: 1; background-color: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); }
        }
        @keyframes modal-card-appear {
          from { opacity: 0; transform: scale(0.96) translateY(12px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .animate-backdrop {
          animation: modal-backdrop-fade 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .animate-card {
          animation: modal-card-appear 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
      `}</style>
      <div className="w-full max-w-[680px] rounded-xl border border-line bg-surface p-6 text-fg shadow-2xl flex flex-col max-h-[90vh] animate-card">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-line pb-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-1.5">
              <Sparkles size={14} className="text-accent animate-pulse" />
              Meeting Summary Guidelines
            </h2>
            <p className="mt-1 text-xs text-muted">
              Customize the instructions the local AI uses to summarize and extract action items from transcripts.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4 flex-1 overflow-y-auto pr-1 flex flex-col gap-4">
          {/* Templates Section */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-fg">Load from pre-defined templates</span>
            <div className="grid grid-cols-2 gap-2">
              {SUMMARY_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setPrompt(t.prompt);
                    setSelectedTemplate(t.id);
                  }}
                  className={[
                    "flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all",
                    selectedTemplate === t.id
                      ? "border-accent bg-accent-soft/30 text-fg ring-1 ring-accent"
                      : "border-line bg-canvas hover:bg-elevated text-muted hover:text-fg",
                  ].join(" ")}
                >
                  <span className="text-xs font-bold">{t.name}</span>
                  <span className="text-[10px] text-muted leading-tight">{t.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Textarea Section */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-fg">Custom guidelines</span>
              {selectedTemplate && (
                <span className="text-[10px] text-accent font-medium">
                  Template loaded
                </span>
              )}
            </div>
            <textarea
              rows={11}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setSelectedTemplate(null);
              }}
              placeholder="Describe how the AI should summarize the meeting transcript..."
              className="w-full rounded-lg border border-line bg-canvas p-3 text-xs leading-relaxed font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all resize-none"
            />
          </div>

          {/* Guidelines info card */}
          <div className="rounded-lg border border-line bg-canvas p-3 flex flex-col gap-1.5 text-xs text-muted">
            <div className="flex items-center gap-1.5 font-semibold text-fg">
              <Info size={12} className="text-accent" />
              Dynamic Placeholders
            </div>
            <p className="text-[11px] leading-relaxed">
              You can insert <code className="font-mono text-accent bg-accent-soft px-1 rounded">{"{duration_minutes}"}</code> and <code className="font-mono text-accent bg-accent-soft px-1 rounded">{"{app}"}</code> in your guidelines. They will be replaced at runtime with the meeting's duration and app name (e.g., Zoom, Teams).
            </p>
          </div>

          {/* Safety Notice */}
          <div className="rounded-lg border border-success/20 bg-success/5 p-3 flex flex-col gap-1.5 text-xs text-success">
            <div className="flex items-center gap-1.5 font-semibold">
              <Check size={12} />
              Format Safety Handled Automatically
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              Do not worry about instructing the AI to output JSON or specific lists format. The backend automatically appends formatting schemas to ensure the meeting summary is properly parsed and displayed in the application layout.
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-line pt-4 shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:bg-elevated hover:text-fg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            onClick={handleSave}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-canvas hover:bg-accent-hover transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save Guidelines"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MeetingsTab() {
  const [settings, setSettings] = useState<{
    auto_detect: boolean;
    app_prefs: Record<string, "always" | "ask" | "never">;
    soft_warn_min: number;
    hard_cap_min: number;
    summary_prompt: string;
  } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    void import("../lib/api").then(({ getMeetingSettings }) =>
      getMeetingSettings().then(setSettings),
    );
  }, []);

  const handleSavePrompt = async (nextPrompt: string) => {
    try {
      const { setMeetingSummaryPrompt } = await import("../lib/api");
      await setMeetingSummaryPrompt(nextPrompt);
      setSettings((prev) => prev ? { ...prev, summary_prompt: nextPrompt } : null);
      toasts.push({
        tone: "success",
        message: "Meeting summary guidelines updated successfully.",
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Failed to save guidelines: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  if (!settings) {
    return <div className="text-sm text-muted">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Auto-detect meetings"
        subtitle="Echo Scribe watches for Zoom, Teams, FaceTime, Discord, Slack, and browser tabs and offers to record."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.auto_detect}
            onChange={async (e) => {
              const on = e.target.checked;
              const { setMeetingAutoDetect } = await import("../lib/api");
              await setMeetingAutoDetect(on);
              setSettings({ ...settings, auto_detect: on });
            }}
          />
          <span>Detect supported meeting apps automatically</span>
        </label>
      </Section>

      {Object.keys(settings.app_prefs).length > 0 && (
        <Section
          title="Per-app preferences"
          subtitle="Override the per-app prompt: always record, always ask, or never record."
        >
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(settings.app_prefs).map(([bundle, pref]) => (
                <tr key={bundle} className="border-t border-line">
                  <td className="py-2">{bundle}</td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <select
                        className="rounded-md bg-canvas px-2 py-1 text-xs"
                        value={pref}
                        onChange={async (e) => {
                          const next = e.target.value as
                            | "always"
                            | "ask"
                            | "never";
                          const { setMeetingAppPref } = await import(
                            "../lib/api"
                          );
                          await setMeetingAppPref(bundle, next);
                          setSettings({
                            ...settings,
                            app_prefs: {
                              ...settings.app_prefs,
                              [bundle]: next,
                            },
                          });
                        }}
                      >
                        <option value="always">Always</option>
                        <option value="ask">Ask</option>
                        <option value="never">Never</option>
                      </select>
                      <button
                        className="rounded-md bg-surface-2 px-2 py-1 text-xs text-muted hover:text-fg"
                        onClick={async () => {
                          const { clearMeetingAppPref } = await import(
                            "../lib/api"
                          );
                          await clearMeetingAppPref(bundle);
                          const next = { ...settings.app_prefs };
                          delete next[bundle];
                          setSettings({ ...settings, app_prefs: next });
                        }}
                        title="Remove this app's preference (revert to Ask on next detection)"
                      >
                        Clear
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section
        title="Meeting summary guidelines"
        subtitle="Configure custom prompt guidelines used by the local AI to summarize your meetings."
      >
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="text-xs font-semibold text-muted">Active guidelines</span>
              <p className="mt-1.5 text-xs text-muted/80 line-clamp-3 italic whitespace-pre-wrap leading-relaxed font-mono">
                {settings.summary_prompt || "No custom guidelines set."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-fg transition-all hover:bg-elevated hover:text-accent active:scale-[0.98]"
            >
              <Sparkles size={12} className="text-accent" />
              Edit guidelines...
            </button>
          </div>
        </div>
      </Section>

      <Section
        title="Time limits"
        subtitle="Echo Scribe shows a soft warning at the soft-warn time and auto-stops at the hard cap."
      >
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>Soft warn at (minutes)</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.soft_warn_min}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  soft_warn_min: Number(e.target.value),
                })
              }
              className="w-20 rounded-md bg-canvas px-2 py-1 text-right text-xs"
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>Hard cap at (minutes)</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.hard_cap_min}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  hard_cap_min: Number(e.target.value),
                })
              }
              className="w-20 rounded-md bg-canvas px-2 py-1 text-right text-xs"
            />
          </label>
        </div>
      </Section>

      <Section
        title="Guide templates"
        subtitle="Reusable goals + notes you can attach to a guided meeting session."
      >
        <GuideTemplateManager />
      </Section>

      <SummaryPromptModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        currentPrompt={settings.summary_prompt}
        onSave={handleSavePrompt}
      />
    </div>
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
        title="Voice Commands & App Launcher"
        subtitle="Detect command actions inside your voice dictations to launch applications, open links, compose emails, and manage counters."
      >
        <AppLauncherSettingsSection />
      </Section>

      <Section
        title="Daily recap"
        subtitle="A morning notification that summarizes yesterday's meetings, notes, and dictations."
      >
        <DailyRecapSection />
      </Section>

      <Section
        title="Google Drive"
        subtitle="Upload screen recordings to Drive and get an anyone-with-the-link share URL. The app only sees files it creates (scope drive.file)."
      >
        <DriveSettings />
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
      <h2 className="text-[13px] font-semibold tracking-tight text-fg">
        {title}
      </h2>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{subtitle}</p>
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
    <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          Play recording sounds
        </div>
        <p className="text-xs text-muted">
          Three short tones tied to start, stop, and classification ready.
        </p>
      </div>
      <input
        type="checkbox"
        disabled={busy || enabled === null}
        checked={enabled ?? true}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-accent"
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
    <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          Mute system audio while recording
        </div>
        <p className="text-xs text-muted">
          Silences music and video playback for the duration of the recording.
        </p>
      </div>
      <input
        type="checkbox"
        disabled={busy || enabled === null}
        checked={enabled ?? false}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-accent"
      />
    </label>
  );
}

function AppLauncherSettingsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [counter, setCounter] = useState<number>(0);
  const [templates, setTemplates] = useState<CommonActionTemplate[]>([]);
  const [routingEnabled, setRoutingEnabled] = useState<boolean | null>(null);
  const [triggerWord, setTriggerWord] = useState<string>("echo");
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [en, cnt, tmpl, routEnabled, trgWord] = await Promise.all([
          getAppLauncherEnabled(),
          getActionCounter(),
          getCommonActions(),
          getTriggerWordRoutingEnabled().catch(() => false),
          getActionTriggerWord().catch(() => "echo"),
        ]);
        if (!cancelled) {
          setEnabled(en);
          setCounter(cnt);
          setTemplates(tmpl);
          setRoutingEnabled(routEnabled);
          setTriggerWord(trgWord);
        }
      } catch (e) {
        console.error("Failed to load launcher settings:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      await setAppLauncherEnabled(next);
      setEnabled(next);
      toasts.push({
        tone: "success",
        message: next ? "Voice Command App Launcher enabled" : "Voice Command App Launcher disabled",
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't update launcher setting: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    setBusy(true);
    try {
      await resetActionCounter();
      setCounter(0);
      toasts.push({
        tone: "success",
        message: "Action counter reset to 0",
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't reset counter: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3 transition-all duration-200 hover:border-accent/40">
        <div>
          <div className="text-sm font-semibold text-fg flex items-center gap-1.5">
            <span>Voice command app launcher</span>
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">Sonoma+</span>
          </div>
          <p className="text-xs text-muted mt-0.5">
            Intercept voice dictation to launch apps, open links, compose emails, and manage counters.
          </p>
        </div>
        <input
          type="checkbox"
          disabled={busy || enabled === null}
          checked={enabled ?? false}
          onChange={(e) => void onToggle(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-accent"
        />
      </label>

      {enabled && (
        <div className="rounded-lg border border-line bg-canvas p-4 flex flex-col gap-4 transition-all duration-300">
          {/* Option 2: Prefix-Based Routing */}
          <div className="border border-line rounded-lg p-4 bg-surface/30 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-fg block">Prefix-Based Trigger Routing</span>
                <span className="text-[11px] text-muted block mt-0.5">
                  Route normal voice dictations to AI only if they start with a trigger word (e.g. "echo"). Prevents dictation latency!
                </span>
              </div>
              <input
                type="checkbox"
                disabled={busy || routingEnabled === null}
                checked={routingEnabled ?? false}
                onChange={async (e) => {
                  const val = e.target.checked;
                  setRoutingEnabled(val);
                  try {
                    await setTriggerWordRoutingEnabled(val);
                    toasts.push({ tone: "success", message: `Prefix trigger routing ${val ? "enabled" : "disabled"}` });
                  } catch (err) {
                    setRoutingEnabled(!val);
                    toasts.push({ tone: "error", message: "Failed to update prefix routing settings" });
                  }
                }}
                className="h-4 w-4 cursor-pointer accent-accent"
              />
            </div>

            {routingEnabled && (
              <div className="flex flex-col gap-1.5 mt-1 border-t border-line/30 pt-3">
                <label className="text-[11px] font-medium text-muted">Trigger Prefix Word</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={triggerWord}
                    onChange={(e) => setTriggerWord(e.target.value)}
                    onBlur={async () => {
                      const word = triggerWord.trim();
                      if (!word) {
                        setTriggerWord("echo");
                        await setActionTriggerWord("echo");
                        return;
                      }
                      try {
                        await setActionTriggerWord(word);
                        toasts.push({ tone: "success", message: `Trigger word updated to "${word}"` });
                      } catch (err) {
                        toasts.push({ tone: "error", message: "Failed to save trigger word" });
                      }
                    }}
                    className="flex-1 bg-surface border border-line rounded-md px-2.5 py-1 text-xs text-fg focus:outline-none focus:border-accent"
                    placeholder="echo"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      setTriggerWord("echo");
                      await setActionTriggerWord("echo");
                      toasts.push({ tone: "success", message: 'Trigger word reset to "echo"' });
                    }}
                    className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-elevated hover:text-accent transition-colors"
                  >
                    Reset
                  </button>
                </div>
                <p className="text-[10px] text-faint italic leading-snug">
                  * Note: "echo" triggers loose phonetic matches (echo, eco, ekko, hecho) automatically!
                </p>
              </div>
            )}
          </div>

          {/* Option 3: Dedicated Action Hotkey */}
          <div className="border border-line rounded-lg p-4 bg-surface/30 flex flex-col gap-3">
            <div>
              <span className="text-xs font-semibold text-fg block">Dedicated Action Hotkey</span>
              <span className="text-[11px] text-muted block mt-0.5">
                Press a custom key combination to trigger Action Command mode directly. Always runs AI and bypasses prefix rules.
              </span>
            </div>
            <div className="mt-1">
              <HotkeyRebinder
                load={getActionBinding}
                save={updateActionBinding}
              />
            </div>
          </div>
          <div className="flex items-center justify-between bg-surface-2/40 border border-line/50 rounded-lg p-3">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-fg">Automated Actions Count</span>
              <span className="text-[11px] text-muted">Number of voice actions run successfully</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg font-bold text-accent px-2.5 py-0.5 rounded-md bg-accent/10 border border-accent/20">
                {counter}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onReset()}
                className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-elevated hover:text-accent transition-colors disabled:opacity-50"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-xs font-bold tracking-wide uppercase text-[10px] text-muted mb-1">
              Voice Action Cheatsheet
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {templates.map((t) => (
                <div key={t.category} className="border border-line rounded-lg p-3 bg-surface/50 hover:bg-surface transition-colors flex flex-col gap-2">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-accent">{t.category}</span>
                    <span className="text-[10px] text-muted leading-snug mt-0.5">{t.description}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {t.voice_phrases.map((phrase) => (
                      <span
                        key={phrase}
                        className="rounded font-mono bg-surface-2 px-1.5 py-0.5 border border-line text-[10px] text-fg whitespace-nowrap"
                      >
                        "{phrase}"
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
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
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">
            Log folder
          </div>
          <p className="truncate text-xs text-muted" title={logDir}>
            {logDir || "—"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onOpenFolder()}
          disabled={!logDir}
          className="rounded border border-line px-3 py-1 text-xs hover:bg-elevated disabled:opacity-50"
        >
          Open
        </button>
      </div>

      <div className="rounded-lg border border-line bg-canvas p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">
            Recent log (last 200 lines)
          </div>
          <button
            type="button"
            onClick={() => void loadRecent()}
            disabled={busy}
            className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated disabled:opacity-50"
          >
            {busy ? "…" : "Refresh"}
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-xs text-warninging">{error}</p>
        ) : null}
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] leading-snug text-muted">
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
    <div className="rounded-lg border border-line bg-canvas p-3">
      <p className="text-xs font-semibold tracking-tight text-muted">
        Test inference
      </p>
      <div className="mt-2 flex gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="flex-1 rounded-md border border-line bg-surface px-3 py-1 text-sm focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      {response ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-canvas p-2 text-xs text-fg">
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
    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          Unload after idle
        </div>
        <p className="text-xs text-muted">
          Frees RAM when you haven't used log-capture for a while.
        </p>
      </div>
      <select
        disabled={busy || secs === null}
        value={secs ?? 120}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
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
    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          Unload after idle
        </div>
        <p className="text-xs text-muted">
          Frees RAM when you haven't dictated for a while. The model reloads automatically on next use.
        </p>
      </div>
      <select
        disabled={busy || secs === null}
        value={secs ?? 120}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
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
    const confirmed = await ask(
      "Reset onboarding? This clears the settings store and quits the app. You'll need to relaunch.",
      { title: "Reset onboarding", kind: "warning" },
    );
    if (!confirmed) {
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
        className="text-xs text-faint underline-offset-2 hover:text-muted hover:underline"
      >
        {open ? "Hide reset options" : "Show reset options"}
      </button>
      {open ? (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger/15 p-3">
          <p className="text-xs text-danger">
            Wipes the settings store (hotkeys, active models, persisted
            preferences) and quits the app. Your captured items are
            preserved — they live in the SQLite database, not the settings store.
          </p>
          <button
            type="button"
            onClick={() => void onReset()}
            disabled={busy}
            className="mt-3 rounded-md border border-danger/40 bg-danger/15 px-3 py-1 text-xs text-danger hover:bg-danger/15 disabled:opacity-50"
          >
            {busy ? "Resetting…" : "Reset onboarding"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function DriveSettings() {
  const [status, setStatus] = useState<DriveStatus>({ connected: false, email: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showByo, setShowByo] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    void driveStatus().then(setStatus);
    void getDriveClientId().then((id) => {
      setClientId(id);
      setShowByo(id.trim().length > 0);
    });
  }, []);

  const onConnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (showByo) await setDriveClientCredentials(clientId, clientSecret);
      setStatus(await driveConnect());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await driveDisconnect();
      setStatus({ connected: false, email: null });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {status.connected ? (
        <div className="flex items-center gap-3">
          <span className="text-[13px]">
            Connected{status.email ? ` as ${status.email}` : ""}.
          </span>
          <button
            onClick={() => void onDisconnect()}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={() => void onConnect()}
          disabled={busy}
          className="self-start rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect Drive"}
        </button>
      )}
      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={showByo}
          onChange={(e) => setShowByo(e.target.checked)}
        />
        Use my own Google OAuth client (removes the unverified-app warning)
      </label>
      {showByo ? (
        <div className="flex flex-col gap-2">
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID (…apps.googleusercontent.com)"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-[13px]"
          />
          <input
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client secret"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-[13px]"
          />
        </div>
      ) : null}
      {err ? <div className="text-[12px] text-red-400">{err}</div> : null}
    </div>
  );
}

function DailyRecapSection() {
  const [settings, setSettings] = useState<DailyRecapSettingsT | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getDailyRecapSettings();
        if (!cancelled) setSettings(v);
      } catch (e) {
        if (!cancelled) {
          toasts.push({
            tone: "error",
            message: `Couldn't load daily recap settings: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // toasts is stable from context; intentionally excluded to avoid re-fetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<DailyRecapSettingsT>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setBusy(true);
    try {
      await setDailyRecapSettings(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't save daily recap settings: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-3 text-xs text-muted">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
        <div>
          <div className="text-sm font-semibold text-fg">
            Generate a daily recap each morning
          </div>
          <p className="text-xs text-muted">
            One macOS notification at your chosen hour, summarizing yesterday.
          </p>
        </div>
        <input
          type="checkbox"
          disabled={busy}
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
          className="h-4 w-4 cursor-pointer accent-accent"
        />
      </label>

      <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
        <div>
          <div className="text-sm font-semibold text-fg">Deliver at</div>
          <p className="text-xs text-muted">Local time. Default 08:00.</p>
        </div>
        <select
          disabled={busy || !settings.enabled}
          value={settings.deliver_hour}
          onChange={(e) =>
            void save({ deliver_hour: Number(e.target.value) })
          }
          className="rounded-md border border-line bg-canvas px-2 py-1 text-sm text-fg disabled:opacity-50"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {`${String(h).padStart(2, "0")}:00`}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
        <div>
          <div className="text-sm font-semibold text-fg">Include weekends</div>
          <p className="text-xs text-muted">
            Off by default — no Sunday morning summary unless you want one.
          </p>
        </div>
        <input
          type="checkbox"
          disabled={busy || !settings.enabled}
          checked={settings.include_weekends}
          onChange={(e) => void save({ include_weekends: e.target.checked })}
          className="h-4 w-4 cursor-pointer accent-accent"
        />
      </label>
    </div>
  );
}
