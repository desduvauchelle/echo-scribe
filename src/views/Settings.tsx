import { useEffect, useState, type SyntheticEvent } from "react";
import {
  ArrowLeft,
  Bot,
  CalendarDays,
  Copy,
  Mic,
  NotebookPen,
  Phone,
  Zap,
  WandSparkles,
  Settings as SettingsIcon,
  Sparkles,
  Cloud,
  FolderKanban,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  Info,
  Check,
  type LucideIcon,
} from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { mcpInstallSnippets } from "../lib/mcpInstall";
import AppLanguagePicker from "../components/AppLanguagePicker";
import HotkeyRebinder from "../components/HotkeyRebinder";
import SpeechModelPicker from "../components/SpeechModelPicker";
import LlmModelPicker from "../components/LlmModelPicker";
import ProjectManager from "../components/ProjectManager";
import GuideTemplateManager from "../components/GuideTemplateManager";
import PermissionsSection from "../components/PermissionsSection";
import StartAtLoginToggle from "../components/StartAtLoginToggle";
import TranscriptionSettings from "../components/TranscriptionSettings";
import Dialog from "../components/a11y/Dialog";
import { useCapabilities } from "../lib/capabilitiesContext";
import { uiGates } from "../lib/capabilities";
import {
  diagnosticsLogDir,
  diagnosticsOpenLogFolder,
  diagnosticsRecentLog,
  getAsrUnloadSecs,
  getAudioFeedbackEnabled,
  getAutoFileEnabled,
  getAutoFileThreshold,
  getExportConfidenceThreshold,
  setExportConfidenceThreshold,
  getDailyRecapSettings,
  getInputDeviceSort,
  getLlmUnloadSecs,
  getLogCaptureBinding,
  getMcpSettings,
  setMcpPermission,
  installMcpForAgent,
  type McpSettings,
  type McpPermissionState,
  type McpInstallAgent,
  getMuteWhileRecording,
  getPreferredInputDevice,
  getRecentInputDevices,
  listInputDevices,
  resetOnboardingAndQuit,
  uninstallApplication,
  getAppVersion,
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
  getEditSelectionBinding,
  updateEditSelectionBinding,
  getTriggerWordRoutingEnabled,
  setTriggerWordRoutingEnabled,
  getActionTriggerWord,
  setActionTriggerWord,
  getFormatTemplates,
  setFormatTemplates,
  getProjectAutoTaggingEnabled,
  setProjectAutoTaggingEnabled,
  projectTaggerStatus,
  projectTaggerBackfill,
  runProjectTaggerDeterministicOnce,
  runProjectTaggerLlmOnce,
  type FormatTemplate,
  type ProjectTaggerStatus,
  driveStatus,
  driveConnect,
  driveDisconnect,
  getDriveClientId,
  setDriveClientCredentials,
  getDrivePrefs,
  setDrivePrefs,
  type DriveStatus,
  type CommonActionTemplate,
  type DailyRecapSettings as DailyRecapSettingsT,
  type InputDevice,
  type InputDeviceSort,
} from "../lib/api";
import { useToasts } from "../components/ToastProvider";
import { useUpdateCheck } from "../lib/useUpdateCheck";
import { ask } from "@tauri-apps/plugin-dialog";

export type PageId =
  | "dictation"
  | "logcapture"
  | "meetings"
  | "daily-recap"
  | "actions"
  | "templates"
  | "language-model"
  | "general"
  | "drive"
  | "projects"
  | "coding-agents"
  | "permissions"
  | "diagnostics"
  | "uninstall";

type NavItem = { id: PageId; icon: LucideIcon };
type NavGroup = { key: "capture" | "automation" | "system"; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    key: "capture",
    items: [
      { id: "dictation", icon: Mic },
      { id: "logcapture", icon: NotebookPen },
      { id: "meetings", icon: Phone },
      { id: "daily-recap", icon: CalendarDays },
    ],
  },
  {
    key: "automation",
    items: [
      { id: "actions", icon: Zap },
      { id: "templates", icon: WandSparkles },
    ],
  },
  {
    key: "system",
    items: [
      { id: "language-model", icon: Sparkles },
      { id: "general", icon: SettingsIcon },
      { id: "drive", icon: Cloud },
      { id: "projects", icon: FolderKanban },
      { id: "coding-agents", icon: Bot },
      { id: "permissions", icon: ShieldCheck },
      { id: "diagnostics", icon: Wrench },
      { id: "uninstall", icon: Trash2 },
    ],
  },
];

const SUPPORTED_MEETING_PLATFORMS = [
  "Zoom",
  "Microsoft Teams",
  "Google Meet",
  "Slack Huddles",
  "FaceTime",
  "Discord",
  "Webex",
  "Browser calls",
] as const;

const PAGES: Record<PageId, () => React.ReactElement> = {
  dictation: DictationPage,
  logcapture: LogCapturePage,
  meetings: MeetingsPage,
  "daily-recap": DailyRecapPage,
  actions: ActionsPage,
  templates: TemplatesPage,
  "language-model": LanguageModelPage,
  general: GeneralPage,
  drive: DrivePage,
  projects: ProjectsPage,
  "coding-agents": CodingAgentsPage,
  permissions: PermissionsPage,
  diagnostics: DiagnosticsPage,
  uninstall: UninstallPage,
};

type Props = {
  onBack: () => void;
  initialPage?: PageId;
};

export default function Settings({ onBack, initialPage = "dictation" }: Props) {
  const { t } = useTranslation("settings");
  const [page, setPage] = useState<PageId>(initialPage);
  const gates = uiGates(useCapabilities());

  // Drop nav items gated behind macOS-only capabilities, then drop any group
  // that ends up empty. Everything not explicitly gated stays visible.
  const visibleGroups: NavGroup[] = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.id === "meetings") return gates.showMeetingsNav;
      if (item.id === "drive") return gates.showDrive;
      if (item.id === "permissions") return gates.showNativePermissions;
      if (item.id === "uninstall") return gates.showSelfUpdate;
      return true;
    }),
  })).filter((group) => group.items.length > 0);

  const activeItem = visibleGroups.flatMap((g) => g.items).find(
    (i) => i.id === page,
  );

  // Fallback: if the persisted/default page id isn't visible on this platform
  // (e.g. a Windows build inherited "meetings" from a synced macOS profile),
  // redirect to the first visible page instead of rendering nothing.
  useEffect(() => {
    if (!activeItem) {
      const firstVisible = visibleGroups[0]?.items[0]?.id;
      if (firstVisible) setPage(firstVisible);
    }
  }, [activeItem, visibleGroups]);

  const ActivePage = activeItem ? PAGES[page] : null;

  return (
    <div className="echo-settings-shell flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-fg">
      <header className="echo-app-toolbar flex h-12 shrink-0 items-stretch border-b border-line">
        <div className="echo-app-toolbar-sidebar flex w-[232px] shrink-0 items-center border-r border-line px-3">
          <span
            className="h-full w-[72px] shrink-0"
            aria-hidden="true"
            data-tauri-drag-region
          />
          <button
            type="button"
            onClick={onBack}
            className="native-toolbar-button inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-fg"
          >
            <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" />
            {t("header.back")}
          </button>
        </div>
        <div className="flex min-w-0 flex-1 items-center px-4">
          <div className="min-w-0">
            <h1 className="truncate text-[12px] font-semibold leading-tight">
              {t("header.title")}
            </h1>
            <div className="truncate text-[9px] leading-tight text-faint">
              {activeItem ? t(`nav.items.${activeItem.id}`) : t("header.preferences")}
            </div>
          </div>
          <div className="h-full min-w-12 flex-1" data-tauri-drag-region />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav
          aria-label={t("nav.ariaLabel")}
          className="echo-settings-nav echo-sidebar h-full w-[232px] shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-surface p-3"
        >
          <div className="flex flex-col gap-4">
            {visibleGroups.map((group) => (
              <div key={group.key} className="flex flex-col gap-0.5">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                  {t(`nav.groups.${group.key}`)}
                </div>
                {group.items.map(({ id, icon: Icon }) => {
                  const active = page === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setPage(id)}
                      className={[
                        "echo-nav-item flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
                        active
                          ? "is-active bg-accent-soft text-accent"
                          : "text-muted hover:bg-elevated hover:text-fg",
                      ].join(" ")}
                    >
                      <Icon
                        size={14}
                        strokeWidth={2}
                        className={active ? "text-accent" : "text-faint"}
                      />
                      <span className="truncate">{t(`nav.items.${id}`)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>

        <main className="echo-settings-content min-w-0 flex-1 overflow-y-auto overscroll-contain bg-canvas p-6 lg:p-8">
          <div className="w-full max-w-[960px]">
            {activeItem && ActivePage ? (
              <>
                <header className="mb-6 border-b border-line pb-4">
                  <h1 className="text-[15px] font-semibold tracking-tight text-fg">
                    {t(`nav.items.${activeItem.id}`)}
                  </h1>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    {t(`pageDesc.${page}`)}
                  </p>
                </header>
                <ActivePage />
              </>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function DictationPage() {
  const gates = uiGates(useCapabilities());
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-8">
      <SpeechModelPicker />

      <Section
        title={t("dictation.microphone.title")}
        subtitle={t("dictation.microphone.subtitle")}
      >
        <MicrophonePicker />
      </Section>

      <Section
        title={t("dictation.audioFeedback.title")}
        subtitle={t("dictation.audioFeedback.subtitle")}
      >
        <AudioFeedbackToggle />
      </Section>

      {/* Mute-while-recording is implemented via osascript volume control
       *  (audio/mute.rs), which is macOS-only — hide on other platforms. */}
      {gates.showSystemAudio && (
        <Section
          title={t("dictation.muteWhileRecording.title")}
          subtitle={t("dictation.muteWhileRecording.subtitle")}
        >
          <MuteWhileRecordingToggle />
        </Section>
      )}

      <Section
        title={t("dictation.hotkey.title")}
        subtitle={t("dictation.hotkey.subtitle")}
      >
        <HotkeyRebinder />
      </Section>

      <Section
        title={t("dictation.transcription.title")}
        subtitle={t("dictation.transcription.subtitle")}
      >
        <TranscriptionSettings />
      </Section>

      <Section
        title={t("dictation.keepModelInMemory.title")}
        subtitle={t("dictation.keepModelInMemory.subtitle")}
      >
        <AsrUnloadTimeoutSelect />
      </Section>
    </div>
  );
}

function LogCapturePage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("logCapture.hotkey.title")}
        subtitle={t("logCapture.hotkey.subtitle")}
      >
        <HotkeyRebinder
          load={getLogCaptureBinding}
          save={updateLogCaptureBinding}
        />
      </Section>

      <AutoFileSettings />
      <ProjectAutoTaggingSettings />
      <ExportSettings />
    </div>
  );
}

function DailyRecapPage() {
  return (
    <div className="flex flex-col gap-8">
      <DailyRecapSection />
    </div>
  );
}

function LanguageModelPage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("languageModel.model.title")}
        subtitle={t("languageModel.model.subtitle")}
      >
        <LlmModelPicker />
        <div className="mt-4">
          <TestInference />
        </div>
      </Section>

      <Section
        title={t("languageModel.keepInMemory.title")}
        subtitle={t("languageModel.keepInMemory.subtitle")}
      >
        <LlmUnloadTimeoutSelect />
      </Section>
    </div>
  );
}

function ActionsPage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("actions.section.title")}
        subtitle={t("actions.section.subtitle")}
      >
        <AppLauncherSettingsSection />
      </Section>
    </div>
  );
}

function TemplatesPage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("templates.section.title")}
        subtitle={t("templates.section.subtitle")}
      >
        <FormatTemplatesSection />
      </Section>
    </div>
  );
}

function ExportSettings() {
  const { t } = useTranslation("settings");
  const [threshold, setThresholdLocal] = useState(0.75);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const v = await getExportConfidenceThreshold().catch(() => 0.75);
      if (!cancelled) setThresholdLocal(v);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on mouse, touch AND keyboard interaction — arrow-key changes on
  // the range input never fire mouseup/touchend.
  const commitThreshold = async (e: SyntheticEvent<HTMLInputElement>) => {
    const next = Number((e.target as HTMLInputElement).value);
    try {
      await setExportConfidenceThreshold(next);
    } catch {
      getExportConfidenceThreshold()
        .then(setThresholdLocal)
        .catch(() => {});
    }
  };

  return (
    <Section
      title={t("logCapture.export.title")}
      subtitle={t("logCapture.export.subtitle")}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          <Trans
            i18nKey="logCapture.export.confidenceNote"
            t={t}
            values={{ percent: Math.round(threshold * 100) }}
            components={{ mono: <span className="font-mono" /> }}
          />
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">
            {t("logCapture.export.confidenceThresholdLabel", {
              percent: Math.round(threshold * 100),
            })}
          </span>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={threshold}
            onChange={(e) => setThresholdLocal(Number(e.target.value))}
            onMouseUp={commitThreshold}
            onTouchEnd={commitThreshold}
            onKeyUp={commitThreshold}
            onBlur={commitThreshold}
            className="w-full"
          />
        </label>
      </div>
    </Section>
  );
}

function ProjectAutoTaggingSettings() {
  const { t } = useTranslation("settings");
  const toasts = useToasts();
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<ProjectTaggerStatus | null>(null);
  const [busy, setBusy] = useState<"backfill" | "router" | "llm" | null>(null);

  const refresh = async () => {
    const [enabledValue, statusValue] = await Promise.all([
      getProjectAutoTaggingEnabled().catch(() => true),
      projectTaggerStatus().catch(() => null),
    ]);
    setEnabled(enabledValue);
    setStatus(statusValue);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (kind: "backfill" | "router" | "llm") => {
    setBusy(kind);
    try {
      if (kind === "backfill") {
        const n = await projectTaggerBackfill({ source: "voice_at_cursor", limit: 500 });
        toasts.push({ tone: "success", message: t("logCapture.autoTagging.toasts.queued", { count: n }) });
      } else if (kind === "router") {
        const s = await runProjectTaggerDeterministicOnce();
        toasts.push({
          tone: "success",
          message: t("logCapture.autoTagging.toasts.routerAssigned", {
            assigned: s.assigned,
            count: s.scanned,
          }),
        });
      } else {
        const s = await runProjectTaggerLlmOnce();
        toasts.push({
          tone: "success",
          message: t("logCapture.autoTagging.toasts.llmAssigned", {
            assigned: s.assigned,
            count: s.scanned,
          }),
        });
      }
      await refresh();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("logCapture.autoTagging.toasts.failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={t("logCapture.autoTagging.title")}
      subtitle={t("logCapture.autoTagging.subtitle")}
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={async (e) => {
              const next = e.target.checked;
              setEnabled(next);
              try {
                await setProjectAutoTaggingEnabled(next);
                await refresh();
              } catch {
                setEnabled(!next);
              }
            }}
          />
          {t("logCapture.autoTagging.enableLabel")}
        </label>
        {status && (
          <div className="grid grid-cols-2 gap-2 text-xs text-muted sm:grid-cols-4">
            <span>{t("logCapture.autoTagging.status.pending")} <span className="font-mono text-fg">{status.pending}</span></span>
            <span>{t("logCapture.autoTagging.status.deferred")} <span className="font-mono text-fg">{status.deferred}</span></span>
            <span>{t("logCapture.autoTagging.status.done")} <span className="font-mono text-fg">{status.done}</span></span>
            <span>{t("logCapture.autoTagging.status.failed")} <span className="font-mono text-fg">{status.failed}</span></span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("backfill")}
            className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated disabled:opacity-50"
          >
            {busy === "backfill" ? t("logCapture.autoTagging.buttons.queueing") : t("logCapture.autoTagging.buttons.queueUnassigned")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("router")}
            className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated disabled:opacity-50"
          >
            {busy === "router" ? t("logCapture.autoTagging.buttons.running") : t("logCapture.autoTagging.buttons.runRouter")}
          </button>
          <button
            type="button"
            disabled={busy !== null || status?.llm_ready === false}
            onClick={() => void run("llm")}
            className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated disabled:opacity-50"
          >
            {busy === "llm" ? t("logCapture.autoTagging.buttons.running") : t("logCapture.autoTagging.buttons.runLlmBatch")}
          </button>
        </div>
      </div>
    </Section>
  );
}

function AutoFileSettings() {
  const { t } = useTranslation("settings");
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

  // Persist on mouse, touch AND keyboard interaction — arrow-key changes on
  // the range input never fire mouseup/touchend.
  const commitAutoFileThreshold = async (
    e: SyntheticEvent<HTMLInputElement>,
  ) => {
    const next = Number((e.target as HTMLInputElement).value);
    try {
      await setAutoFileThreshold(next);
    } catch {
      // Reload from backend on error.
      getAutoFileThreshold().then(setAutoFileThresholdLocal).catch(() => {});
    }
  };

  return (
    <Section
      title={t("logCapture.autoFile.title")}
      subtitle={t("logCapture.autoFile.subtitle")}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          <Trans
            i18nKey="logCapture.autoFile.confidenceNote"
            t={t}
            values={{ percent: Math.round(autoFileThreshold * 100) }}
            components={{ mono: <span className="font-mono" /> }}
          />
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
          {t("logCapture.autoFile.enableLabel")}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">
            {t("logCapture.autoFile.thresholdLabel", {
              percent: Math.round(autoFileThreshold * 100),
            })}
          </span>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            disabled={!autoFileEnabled}
            value={autoFileThreshold}
            onChange={(e) => setAutoFileThresholdLocal(Number(e.target.value))}
            onMouseUp={commitAutoFileThreshold}
            onTouchEnd={commitAutoFileThreshold}
            onKeyUp={commitAutoFileThreshold}
            onBlur={commitAutoFileThreshold}
            className="w-full"
          />
        </label>
      </div>
    </Section>
  );
}

function MicrophonePicker() {
  const { t } = useTranslation("settings");
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
      setError(t("dictation.microphonePicker.loadError", { error: String(e) }));
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
    return <p className="text-xs text-muted">{t("dictation.microphonePicker.loading")}</p>;
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
          {t("common.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {preferredMissing && (
        <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">
          <Trans
            i18nKey="dictation.microphonePicker.savedMicMissing"
            t={t}
            values={{ name: preferred }}
            components={{ mono: <span className="font-mono" /> }}
          />
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t("dictation.microphonePicker.inputDeviceLabel")}</span>
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
            {t("dictation.microphonePicker.systemDefaultOption")}
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
        <span className="text-muted">{t("dictation.microphonePicker.sortByLabel")}</span>
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
          <option value="last_used">{t("dictation.microphonePicker.sortLastUsed")}</option>
          <option value="alphabetical">{t("dictation.microphonePicker.sortAlphabetical")}</option>
        </select>
      </label>

      <p className="text-[11px] text-muted">
        {t("dictation.microphonePicker.footerNote")}
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
  const { t } = useTranslation("settings");
  const [prompt, setPrompt] = useState(currentPrompt);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPrompt(currentPrompt);
      const matched = SUMMARY_TEMPLATES.find(
        (tpl) => tpl.prompt.trim() === currentPrompt.trim()
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
    <Dialog
      onClose={onClose}
      labelledBy="summary-prompt-modal-title"
      dismissible={!busy}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-backdrop"
      panelClassName="w-full max-w-[680px] rounded-xl border border-line bg-surface p-6 text-fg shadow-2xl flex flex-col max-h-[90vh] animate-card"
    >
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
        {/* Header */}
        <div className="flex items-start justify-between border-b border-line pb-4">
          <div>
            <h2
              id="summary-prompt-modal-title"
              className="text-base font-semibold tracking-tight flex items-center gap-1.5"
            >
              <Sparkles size={14} className="text-accent animate-pulse" />
              {t("meetings.promptModal.title")}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {t("meetings.promptModal.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="mt-4 flex-1 overflow-y-auto pr-1 flex flex-col gap-4">
          {/* Templates Section */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-fg">{t("meetings.promptModal.loadTemplatesLabel")}</span>
            <div className="grid grid-cols-2 gap-2">
              {SUMMARY_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => {
                    setPrompt(tpl.prompt);
                    setSelectedTemplate(tpl.id);
                  }}
                  className={[
                    "flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all",
                    selectedTemplate === tpl.id
                      ? "border-accent bg-accent-soft/30 text-fg ring-1 ring-accent"
                      : "border-line bg-canvas hover:bg-elevated text-muted hover:text-fg",
                  ].join(" ")}
                >
                  <span className="text-xs font-bold">{t(`meetings.summaryTemplates.${tpl.id}.name`)}</span>
                  <span className="text-[10px] text-muted leading-tight">{t(`meetings.summaryTemplates.${tpl.id}.description`)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Textarea Section */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-fg">{t("meetings.promptModal.customGuidelinesLabel")}</span>
              {selectedTemplate && (
                <span className="text-[10px] text-accent font-medium">
                  {t("meetings.promptModal.templateLoaded")}
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
              placeholder={t("meetings.promptModal.textareaPlaceholder")}
              className="w-full rounded-lg border border-line bg-canvas p-3 text-xs leading-relaxed font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all resize-none"
            />
          </div>

          {/* Guidelines info card */}
          <div className="rounded-lg border border-line bg-canvas p-3 flex flex-col gap-1.5 text-xs text-muted">
            <div className="flex items-center gap-1.5 font-semibold text-fg">
              <Info size={12} className="text-accent" />
              {t("meetings.promptModal.placeholdersTitle")}
            </div>
            <p className="text-[11px] leading-relaxed">
              <Trans
                i18nKey="meetings.promptModal.placeholdersBody"
                t={t}
                components={{ code: <code className="font-mono text-accent bg-accent-soft px-1 rounded" /> }}
              />
            </p>
          </div>

          {/* Safety Notice */}
          <div className="rounded-lg border border-success/20 bg-success/5 p-3 flex flex-col gap-1.5 text-xs text-success">
            <div className="flex items-center gap-1.5 font-semibold">
              <Check size={12} />
              {t("meetings.promptModal.formatSafetyTitle")}
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              {t("meetings.promptModal.formatSafetyBody")}
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
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            onClick={handleSave}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-canvas hover:bg-accent-hover transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            {busy ? t("meetings.promptModal.saving") : t("meetings.promptModal.saveGuidelines")}
          </button>
        </div>
    </Dialog>
  );
}

function MeetingsPage() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<{
    auto_detect: boolean;
    app_prefs: Record<string, "always" | "ask" | "never">;
    summary_prompt: string;
    export_folder: string | null;
  } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [exportFolderBusy, setExportFolderBusy] = useState(false);
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
        message: t("meetings.toasts.guidelinesUpdated"),
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("meetings.toasts.guidelinesSaveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const saveExportFolder = async (folder: string | null) => {
    setExportFolderBusy(true);
    try {
      const { setMeetingExportFolder } = await import("../lib/api");
      await setMeetingExportFolder(folder);
      setSettings((prev) => prev ? { ...prev, export_folder: folder } : null);
      toasts.push({
        tone: "success",
        message: folder
          ? t("meetings.toasts.exportFolderUpdated")
          : t("meetings.toasts.exportDisabled"),
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("meetings.toasts.exportFolderUpdateFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setExportFolderBusy(false);
    }
  };

  const handlePickExportFolder = async () => {
    try {
      const { pickExportFolder } = await import("../lib/api");
      const folder = await pickExportFolder();
      if (folder) await saveExportFolder(folder);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("meetings.toasts.folderPickerFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const handleOpenExportFolder = async () => {
    setExportFolderBusy(true);
    try {
      const { openMeetingExportFolder } = await import("../lib/api");
      await openMeetingExportFolder();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("meetings.toasts.openFolderFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setExportFolderBusy(false);
    }
  };

  if (!settings) {
    return <div className="text-sm text-muted">{t("common.loading")}</div>;
  }

  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("meetings.autoDetect.title")}
        subtitle={t("meetings.autoDetect.subtitle")}
      >
        <div className="flex flex-col gap-3">
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
            <span>{t("meetings.autoDetect.checkboxLabel")}</span>
          </label>

          <ul
            aria-label={t("meetings.autoDetect.platformsAriaLabel")}
            className="flex flex-wrap gap-1.5"
          >
            {SUPPORTED_MEETING_PLATFORMS.map((platform) => (
              <li
                key={platform}
                className="rounded-full border border-line bg-canvas px-2.5 py-1 text-[11px] font-medium text-muted"
              >
                {platform}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {Object.keys(settings.app_prefs).length > 0 && (
        <Section
          title={t("meetings.perAppPrefs.title")}
          subtitle={t("meetings.perAppPrefs.subtitle")}
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
                        <option value="always">{t("meetings.perAppPrefs.always")}</option>
                        <option value="ask">{t("meetings.perAppPrefs.ask")}</option>
                        <option value="never">{t("meetings.perAppPrefs.never")}</option>
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
                        title={t("meetings.perAppPrefs.clearTitle")}
                      >
                        {t("meetings.perAppPrefs.clearButton")}
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
        title={t("meetings.summaryGuidelines.title")}
        subtitle={t("meetings.summaryGuidelines.subtitle")}
      >
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <span className="text-xs font-semibold text-muted">{t("meetings.summaryGuidelines.activeLabel")}</span>
              <p className="mt-1.5 text-xs text-muted/80 line-clamp-3 italic whitespace-pre-wrap leading-relaxed font-mono">
                {settings.summary_prompt || t("meetings.summaryGuidelines.noneSet")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-fg transition-all hover:bg-elevated hover:text-accent active:scale-[0.98]"
            >
              <Sparkles size={12} className="text-accent" />
              {t("meetings.summaryGuidelines.editButton")}
            </button>
          </div>
        </div>
      </Section>

      <Section
        title={t("meetings.notesFolder.title")}
        subtitle={t("meetings.notesFolder.subtitle")}
      >
        <div className="flex flex-col gap-2 text-xs text-muted">
          <div className="flex items-center gap-2">
            {settings.export_folder ? (
              <>
                <span
                  className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] text-fg"
                  title={settings.export_folder}
                >
                  {settings.export_folder}
                </span>
                <button
                  type="button"
                  disabled={exportFolderBusy}
                  onClick={() => void handleOpenExportFolder()}
                  className="rounded-md border border-line px-2 py-1.5 text-xs hover:bg-elevated disabled:opacity-50"
                >
                  {t("common.open")}
                </button>
                <button
                  type="button"
                  disabled={exportFolderBusy}
                  onClick={() => void handlePickExportFolder()}
                  className="rounded-md border border-line px-2 py-1.5 text-xs hover:bg-elevated disabled:opacity-50"
                >
                  {t("common.change")}
                </button>
                <button
                  type="button"
                  disabled={exportFolderBusy}
                  onClick={() => void saveExportFolder(null)}
                  className="text-xs text-faint hover:text-danger disabled:opacity-50"
                >
                  {t("common.clear")}
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={exportFolderBusy}
                onClick={() => void handlePickExportFolder()}
                className="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-elevated disabled:opacity-50"
              >
                {exportFolderBusy ? t("common.savingEllipsis") : t("meetings.notesFolder.chooseFolder")}
              </button>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-faint">
            {t("meetings.notesFolder.note")}
          </p>
        </div>
      </Section>

      <Section
        title={t("meetings.guideTemplates.title")}
        subtitle={t("meetings.guideTemplates.subtitle")}
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

function GeneralPage() {
  const gates = uiGates(useCapabilities());
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-8">
      <Section title={t("language.title")} subtitle={t("language.subtitle")}>
        <AppLanguagePicker />
      </Section>

      <Section
        title={t("general.startup.title")}
        subtitle={t("general.startup.subtitle")}
      >
        <StartAtLoginToggle />
      </Section>

      {/* Self-update swaps the macOS .app bundle — gate on the same capability
       *  as the update banner and uninstall page. */}
      {gates.showSelfUpdate && (
        <Section
          title={t("general.updates.title")}
          subtitle={t("general.updates.subtitle")}
        >
          <UpdateSettingsSection />
        </Section>
      )}
    </div>
  );
}

function UpdateSettingsSection() {
  const { t } = useTranslation("settings");
  const { check, checking } = useUpdateCheck();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAppVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-[13px] text-muted">
        {version
          ? t("general.updates.currentVersionWithNumber", { version })
          : t("general.updates.currentVersion")}
      </p>
      <button
        type="button"
        onClick={() => void check()}
        disabled={checking}
        className="shrink-0 cursor-pointer rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-60"
      >
        {checking ? t("general.updates.checking") : t("general.updates.checkButton")}
      </button>
    </div>
  );
}

function DrivePage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("drive.section.title")}
        subtitle={t("drive.section.subtitle")}
      >
        <DriveSettings />
      </Section>
    </div>
  );
}

function ProjectsPage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("projects.section.title")}
        subtitle={t("projects.section.subtitle")}
      >
        <ProjectManager />
      </Section>
    </div>
  );
}

function PermissionsPage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("permissions.section.title")}
        subtitle={t("permissions.section.subtitle")}
      >
        <PermissionsSection />
      </Section>
    </div>
  );
}

function DiagnosticsPage() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("diagnostics.section.title")}
        subtitle={t("diagnostics.section.subtitle")}
      >
        <DiagnosticsPane />
      </Section>

      <ResetSection />
    </div>
  );
}

/** Fallback for the install snippets when the backend can't report its own
 *  executable path (it always can on a normal install). */
const DEFAULT_MCP_BINARY_PATH =
  "/Applications/Tucky.app/Contents/MacOS/echo-scribe";

function CodingAgentsPage() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMcpSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        // Instructions still render with the canonical install path; only the
        // permission checkboxes need the real backend.
        if (!cancelled) {
          setLoadFailed(true);
          setSettings({ binary_path: DEFAULT_MCP_BINARY_PATH, permissions: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const snippets = mcpInstallSnippets(
    settings?.binary_path ?? DEFAULT_MCP_BINARY_PATH,
  );

  const setPermission = (id: string, enabled: boolean) => {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            permissions: prev.permissions.map((perm) =>
              perm.id === id ? { ...perm, enabled } : perm,
            ),
          }
        : prev,
    );
  };

  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("codingAgents.toolPermissions.title")}
        subtitle={t("codingAgents.toolPermissions.subtitle")}
      >
        {loadFailed ? (
          <p className="text-[12px] text-muted">
            {t("codingAgents.toolPermissions.loadFailed")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(settings?.permissions ?? []).map((perm) => (
              <McpPermissionRow
                key={perm.id}
                perm={perm}
                onChange={(enabled) => setPermission(perm.id, enabled)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t("codingAgents.connect.title")}
        subtitle={t("codingAgents.connect.subtitle")}
      >
        <div className="flex flex-col gap-3">
          <McpSnippet
            title={t("codingAgents.snippets.claudeCode.title")}
            hint={t("codingAgents.snippets.claudeCode.hint")}
            text={snippets.claudeCode}
            installAgent="claude-code"
          />
          <McpSnippet
            title={t("codingAgents.snippets.codex.title")}
            hint={t("codingAgents.snippets.codex.hint")}
            text={snippets.codexToml}
            installAgent="codex"
          />
          <McpSnippet
            title={t("codingAgents.snippets.other.title")}
            hint={t("codingAgents.snippets.other.hint")}
            text={snippets.genericJson}
          />
        </div>
      </Section>

      <Section
        title={t("codingAgents.howToUse.title")}
        subtitle={t("codingAgents.howToUse.subtitle")}
      >
        <div className="flex flex-col gap-2">
          {MCP_EXAMPLE_PROMPT_KEYS.map((key) => (
            <McpExamplePrompt key={key} text={t(`codingAgents.examplePrompts.${key}`)} />
          ))}
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {t("codingAgents.howToUse.recordingNote")}
          </p>
        </div>
      </Section>
    </div>
  );
}

const MCP_EXAMPLE_PROMPT_KEYS = [
  "listWindows",
  "recordBug",
  "searchMeetings",
  "lastWeekDictation",
] as const;

/** One example prompt the user can paste into their coding agent. */
function McpExamplePrompt({ text }: { text: string }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
      <p className="text-[12px] leading-relaxed text-fg">“{text}”</p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
        aria-label={t("codingAgents.examplePrompts.copyAriaLabel")}
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border hover:bg-elevated ${
          copied ? "border-green-500/40 text-green-500" : "border-line text-fg"
        }`}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** One permission checkbox row. The label/description come from the backend
 *  (`mcp_permissions.rs`), so new categories appear here without UI changes. */
function McpPermissionRow({
  perm,
  onChange,
}: {
  perm: McpPermissionState;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      await setMcpPermission(perm.id, next);
      onChange(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("codingAgents.toolPermissions.updateFailed", {
          label: perm.label,
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">{perm.label}</div>
        <p className="text-xs text-muted">{perm.description}</p>
      </div>
      <input
        type="checkbox"
        aria-label={perm.label}
        disabled={busy}
        checked={perm.enabled}
        onChange={(e) => void onToggle(e.target.checked)}
        className="h-4 w-4 shrink-0 cursor-pointer accent-accent"
      />
    </label>
  );
}

/** One install option: heading + hint on the left, Install (when the agent
 *  has a CLI we can drive) + copy buttons on the right, and the snippet in a
 *  monospace block underneath as the manual fallback. */
function McpSnippet({
  title,
  hint,
  text,
  installAgent,
}: {
  title: string;
  hint: string;
  text: string;
  installAgent?: McpInstallAgent;
}) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const toasts = useToasts();

  const onInstall = async (agent: McpInstallAgent) => {
    setInstalling(true);
    try {
      const message = await installMcpForAgent(agent);
      toasts.push({ tone: "success", message });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-fg">{title}</div>
          <p className="text-xs text-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installAgent && (
            <button
              type="button"
              onClick={() => void onInstall(installAgent)}
              disabled={installing}
              className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing ? t("codingAgents.snippets.installing") : t("codingAgents.snippets.installButton")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
            aria-label={t("codingAgents.snippets.copyAriaLabel", { title })}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors hover:bg-elevated ${
              copied ? "border-green-500/40 text-green-500" : "border-line text-fg"
            }`}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] leading-snug text-muted">
        {text}
      </pre>
    </div>
  );
}

function UninstallPage() {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState<"app" | "all" | null>(null);
  const toasts = useToasts();

  const uninstall = async (deleteData: boolean) => {
    const confirmed = await ask(
      deleteData
        ? t("uninstall.confirmDeleteMessage")
        : t("uninstall.confirmKeepMessage"),
      {
        title: deleteData
          ? t("uninstall.confirmDeleteTitle")
          : t("uninstall.confirmTitle"),
        kind: "warning",
      },
    );
    if (!confirmed) return;

    setBusy(deleteData ? "all" : "app");
    try {
      await uninstallApplication(deleteData);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("uninstall.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line bg-canvas p-4">
        <div className="flex items-start justify-between gap-5">
          <div>
            <h2 className="text-sm font-semibold text-fg">
              {t("uninstall.appOnly.title")}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {t("uninstall.appOnly.body")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void uninstall(false)}
            disabled={busy !== null}
            className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50"
          >
            {busy === "app" ? t("uninstall.uninstalling") : t("uninstall.appOnly.button")}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-danger/40 bg-danger/10 p-4">
        <div className="flex items-start justify-between gap-5">
          <div>
            <h2 className="text-sm font-semibold text-danger">
              {t("uninstall.appAndData.title")}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {t("uninstall.appAndData.body")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void uninstall(true)}
            disabled={busy !== null}
            className="shrink-0 rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
          >
            {busy === "all" ? t("uninstall.uninstalling") : t("uninstall.appAndData.button")}
          </button>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-faint">
        {t("uninstall.trashNote")}
      </p>
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
  const { t } = useTranslation("settings");
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
        message: t("dictation.audioFeedback.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          {t("dictation.audioFeedback.label")}
        </div>
        <p className="text-xs text-muted">
          {t("dictation.audioFeedback.description")}
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
  const { t } = useTranslation("settings");
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
        message: t("dictation.muteWhileRecording.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          {t("dictation.muteWhileRecording.label")}
        </div>
        <p className="text-xs text-muted">
          {t("dictation.muteWhileRecording.description")}
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
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [counter, setCounter] = useState<number>(0);
  const [templates, setTemplates] = useState<CommonActionTemplate[]>([]);
  const [routingEnabled, setRoutingEnabled] = useState<boolean | null>(null);
  const [triggerWord, setTriggerWord] = useState<string>("tucky");
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
          getActionTriggerWord().catch(() => "tucky"),
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
        message: next ? t("actions.toasts.launcherEnabled") : t("actions.toasts.launcherDisabled"),
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("actions.toasts.launcherUpdateFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
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
        message: t("actions.toasts.counterReset"),
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("actions.toasts.counterResetFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
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
            <span>{t("actions.launcher.label")}</span>
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">{t("actions.launcher.badge")}</span>
          </div>
          <p className="text-xs text-muted mt-0.5">
            {t("actions.launcher.description")}
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
                <span className="text-xs font-semibold text-fg block">{t("actions.prefixRouting.title")}</span>
                <span className="text-[11px] text-muted block mt-0.5">
                  {t("actions.prefixRouting.description")}
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
                    toasts.push({
                      tone: "success",
                      message: val
                        ? t("actions.prefixRouting.toastEnabled")
                        : t("actions.prefixRouting.toastDisabled"),
                    });
                  } catch (err) {
                    setRoutingEnabled(!val);
                    toasts.push({ tone: "error", message: t("actions.prefixRouting.toastUpdateFailed") });
                  }
                }}
                className="h-4 w-4 cursor-pointer accent-accent"
              />
            </div>

            {routingEnabled && (
              <div className="flex flex-col gap-1.5 mt-1 border-t border-line/30 pt-3">
                <label className="text-[11px] font-medium text-muted">{t("actions.prefixRouting.triggerWordLabel")}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={triggerWord}
                    onChange={(e) => setTriggerWord(e.target.value)}
                    onBlur={async () => {
                      const word = triggerWord.trim();
                      if (!word) {
                        setTriggerWord("tucky");
                        await setActionTriggerWord("tucky");
                        return;
                      }
                      try {
                        await setActionTriggerWord(word);
                        toasts.push({ tone: "success", message: t("actions.prefixRouting.toastWordUpdated", { word }) });
                      } catch (err) {
                        toasts.push({ tone: "error", message: t("actions.prefixRouting.toastWordSaveFailed") });
                      }
                    }}
                    className="flex-1 bg-surface border border-line rounded-md px-2.5 py-1 text-xs text-fg focus:outline-none focus:border-accent"
                    placeholder="tucky"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      setTriggerWord("tucky");
                      await setActionTriggerWord("tucky");
                      toasts.push({ tone: "success", message: t("actions.prefixRouting.toastWordReset") });
                    }}
                    className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-elevated hover:text-accent transition-colors"
                  >
                    {t("common.reset")}
                  </button>
                </div>
                <p className="text-[10px] text-faint italic leading-snug">
                  {t("actions.prefixRouting.phoneticNote")}
                </p>
              </div>
            )}
          </div>

          {/* Option 3: Dedicated Action Hotkey */}
          <div className="border border-line rounded-lg p-4 bg-surface/30 flex flex-col gap-3">
            <div>
              <span className="text-xs font-semibold text-fg block">{t("actions.actionHotkey.title")}</span>
              <span className="text-[11px] text-muted block mt-0.5">
                {t("actions.actionHotkey.description")}
              </span>
            </div>
            <div className="mt-1">
              <HotkeyRebinder
                load={getActionBinding}
                save={updateActionBinding}
              />
            </div>
          </div>

          {/* Edit selection: voice-rewrite highlighted text in place */}
          <div className="border border-line rounded-lg p-4 bg-surface/30 flex flex-col gap-3">
            <div>
              <span className="text-xs font-semibold text-fg block">{t("actions.editSelection.title")}</span>
              <span className="text-[11px] text-muted block mt-0.5">
                {t("actions.editSelection.description")}
              </span>
            </div>
            <div className="mt-1">
              <HotkeyRebinder
                load={getEditSelectionBinding}
                save={updateEditSelectionBinding}
              />
            </div>
          </div>
          <div className="flex items-center justify-between bg-surface-2/40 border border-line/50 rounded-lg p-3">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-fg">{t("actions.counter.title")}</span>
              <span className="text-[11px] text-muted">{t("actions.counter.description")}</span>
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
                {t("common.reset")}
              </button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="text-xs font-bold tracking-wide uppercase text-[10px] text-muted mb-1">
              {t("actions.cheatsheet.title")}
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
              {templates.map((t) => (
                <div
                  key={t.category}
                  data-action-category={t.category}
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface/50 p-3 transition-colors hover:bg-surface"
                >
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-accent">{t.category}</span>
                    <span className="text-[10px] text-muted leading-snug mt-0.5">{t.description}</span>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                    {t.voice_phrases.map((phrase) => (
                      <code
                        key={phrase}
                        className="min-w-0 max-w-full whitespace-normal break-words rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-relaxed text-fg [overflow-wrap:anywhere]"
                      >
                        "{phrase}"
                      </code>
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

function FormatTemplatesSection() {
  const { t } = useTranslation("settings");
  const [templates, setTemplates] = useState<FormatTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getFormatTemplates();
        if (!cancelled) setTemplates(list);
      } catch (e) {
        console.error("Failed to load format templates:", e);
        if (!cancelled) setTemplates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (next: FormatTemplate[]) => {
    setBusy(true);
    try {
      await setFormatTemplates(next);
      setTemplates(next);
      toasts.push({ tone: "success", message: t("templates.toasts.saved") });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("templates.toasts.saveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  const updateOne = (id: string, patch: Partial<FormatTemplate>) => {
    if (!templates) return;
    setTemplates(templates.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || `tpl_${Date.now().toString(36)}`;

  const addNew = () => {
    if (!templates) return;
    let base = "new_template";
    let id = base;
    let n = 1;
    const taken = new Set(templates.map((t) => t.id));
    while (taken.has(id)) {
      id = `${base}_${n++}`;
    }
    const next: FormatTemplate[] = [
      ...templates,
      {
        id,
        name: t("templates.newTemplateName"),
        trigger_phrases: ["format as new"],
        system_prompt:
          "Rewrite the user's raw dictation in the desired style. Output ONLY the rewritten text.",
      },
    ];
    setTemplates(next);
  };

  const removeOne = async (id: string) => {
    if (!templates) return;
    const ok = await ask(t("templates.confirmDelete.message"), {
      title: t("templates.confirmDelete.title"),
      kind: "warning",
    });
    if (!ok) return;
    const next = templates.filter((t) => t.id !== id);
    await persist(next);
  };

  const renameId = (oldId: string, newName: string) => {
    if (!templates) return;
    const newId = slugify(newName);
    if (newId === oldId || templates.some((t) => t.id === newId)) {
      // keep id stable if collision or unchanged; just update name
      updateOne(oldId, { name: newName });
      return;
    }
    setTemplates(
      templates.map((t) =>
        t.id === oldId ? { ...t, id: newId, name: newName } : t,
      ),
    );
  };

  if (templates === null) {
    return <div className="text-xs text-muted">{t("templates.loading")}</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line/50 bg-surface-2/40 p-3">
        <p className="text-[11px] text-muted leading-snug">
          <Trans
            i18nKey="templates.explainer"
            t={t}
            components={{ mono: <span className="font-mono text-fg" /> }}
          />
        </p>
      </div>

      {templates.length === 0 && (
        <div className="text-xs text-muted italic">
          {t("templates.empty")}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className="rounded-lg border border-line bg-canvas p-3 flex flex-col gap-2.5"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={tpl.name}
                onChange={(e) => renameId(tpl.id, e.target.value)}
                className="flex-1 bg-surface border border-line rounded-md px-2.5 py-1 text-sm font-semibold text-fg focus:outline-none focus:border-accent"
                placeholder={t("templates.fields.namePlaceholder")}
              />
              <span className="font-mono text-[10px] text-muted px-1.5 py-0.5 rounded bg-surface-2 border border-line">
                {t("templates.fields.idLabel", { id: tpl.id })}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeOne(tpl.id)}
                className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-elevated hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {t("common.delete")}
              </button>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted">
                {t("templates.fields.triggerPhrasesLabel")}
              </label>
              <input
                type="text"
                value={tpl.trigger_phrases.join(", ")}
                onChange={(e) =>
                  updateOne(tpl.id, {
                    trigger_phrases: e.target.value
                      .split(",")
                      .map((p) => p.trim())
                      .filter((p) => p.length > 0),
                  })
                }
                className="bg-surface border border-line rounded-md px-2.5 py-1 text-xs text-fg focus:outline-none focus:border-accent"
                placeholder={t("templates.fields.triggerPhrasesPlaceholder")}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted">
                {t("templates.fields.systemPromptLabel")}
              </label>
              <textarea
                value={tpl.system_prompt}
                onChange={(e) =>
                  updateOne(tpl.id, { system_prompt: e.target.value })
                }
                rows={6}
                className="bg-surface border border-line rounded-md px-2.5 py-1.5 text-xs text-fg leading-relaxed focus:outline-none focus:border-accent font-mono resize-y"
                placeholder={t("templates.fields.systemPromptPlaceholder")}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={addNew}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated hover:text-accent transition-colors disabled:opacity-50"
        >
          {t("templates.addButton")}
        </button>
        <button
          type="button"
          disabled={busy || templates === null}
          onClick={() => void persist(templates)}
          className="rounded-md border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
        >
          {t("common.saveChanges")}
        </button>
      </div>
    </div>
  );
}

function DiagnosticsPane() {
  const { t } = useTranslation("settings");
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
        message: t("diagnostics.logFolder.openFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">
            {t("diagnostics.logFolder.title")}
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
          {t("common.open")}
        </button>
      </div>

      <div className="rounded-lg border border-line bg-canvas p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-fg">
            {t("diagnostics.recentLog.title")}
          </div>
          <button
            type="button"
            onClick={() => void loadRecent()}
            disabled={busy}
            className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated disabled:opacity-50"
          >
            {busy ? t("diagnostics.recentLog.refreshing") : t("common.refresh")}
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-xs text-warninging">{error}</p>
        ) : null}
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] leading-snug text-muted">
          {recent || t("diagnostics.recentLog.empty")}
        </pre>
      </div>
    </div>
  );
}

function TestInference() {
  const { t } = useTranslation("settings");
  const [prompt, setPrompt] = useState(t("languageModel.testInference.defaultPrompt"));
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
        {t("languageModel.testInference.title")}
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
          {busy ? t("languageModel.testInference.running") : t("languageModel.testInference.runButton")}
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

const LLM_UNLOAD_OPTIONS: { labelKey: string; secs: number }[] = [
  { labelKey: "common.duration.oneMinute", secs: 60 },
  { labelKey: "common.duration.twoMinutes", secs: 120 },
  { labelKey: "common.duration.fiveMinutes", secs: 300 },
  { labelKey: "common.duration.fifteenMinutes", secs: 900 },
  { labelKey: "common.duration.keepLoaded", secs: 0 },
];

function LlmUnloadTimeoutSelect() {
  const { t } = useTranslation("settings");
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
        message: t("languageModel.unloadTimeout.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          {t("languageModel.unloadTimeout.title")}
        </div>
        <p className="text-xs text-muted">
          {t("languageModel.unloadTimeout.description")}
        </p>
      </div>
      <select
        disabled={busy || secs === null}
        value={secs ?? 120}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
      >
        {LLM_UNLOAD_OPTIONS.map(({ labelKey, secs: s }) => (
          <option key={s} value={s}>
            {t(labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

const ASR_UNLOAD_OPTIONS: { labelKey: string; secs: number }[] = [
  { labelKey: "common.duration.thirtySeconds", secs: 30 },
  { labelKey: "common.duration.oneMinute", secs: 60 },
  { labelKey: "common.duration.twoMinutes", secs: 120 },
  { labelKey: "common.duration.fiveMinutes", secs: 300 },
  { labelKey: "common.duration.fifteenMinutes", secs: 900 },
  { labelKey: "common.duration.keepLoaded", secs: 0 },
];

function AsrUnloadTimeoutSelect() {
  const { t } = useTranslation("settings");
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
        message: t("dictation.asrUnloadTimeout.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          {t("dictation.asrUnloadTimeout.title")}
        </div>
        <p className="text-xs text-muted">
          {t("dictation.asrUnloadTimeout.description")}
        </p>
      </div>
      <select
        disabled={busy || secs === null}
        value={secs ?? 120}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
      >
        {ASR_UNLOAD_OPTIONS.map(({ labelKey, secs: s }) => (
          <option key={s} value={s}>
            {t(labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ResetSection() {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const onReset = async () => {
    const confirmed = await ask(
      t("diagnostics.resetSection.confirmMessage"),
      { title: t("diagnostics.resetSection.confirmTitle"), kind: "warning" },
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
        message: t("diagnostics.resetSection.toastFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
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
        {open ? t("diagnostics.resetSection.hideButton") : t("diagnostics.resetSection.showButton")}
      </button>
      {open ? (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger/15 p-3">
          <p className="text-xs text-danger">
            {t("diagnostics.resetSection.warning")}
          </p>
          <button
            type="button"
            onClick={() => void onReset()}
            disabled={busy}
            className="mt-3 rounded-md border border-danger/40 bg-danger/15 px-3 py-1 text-xs text-danger hover:bg-danger/15 disabled:opacity-50"
          >
            {busy ? t("diagnostics.resetSection.resetting") : t("diagnostics.resetSection.resetButton")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function DriveSettings() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<DriveStatus>({ connected: false, email: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showByo, setShowByo] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [saving, setSaving] = useState(false);
  const [folderName, setFolderName] = useState("Tucky");
  const [makePublic, setMakePublic] = useState(true);

  useEffect(() => {
    void driveStatus().then(setStatus);
    void getDriveClientId().then((id) => {
      setClientId(id);
      setShowByo(id.trim().length > 0);
    });
    void getDrivePrefs().then((p) => {
      setFolderName(p.folder_name);
      setMakePublic(p.make_public);
    });
  }, []);

  const savePrefs = async (name: string, isPublic: boolean) => {
    try {
      await setDrivePrefs(name.trim() || "Tucky", isPublic);
    } catch (e) {
      setErr(String(e));
    }
  };

  const onConnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (showByo && clientId.trim() && clientSecret.trim()) {
        await setDriveClientCredentials(clientId, clientSecret);
      }
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

  const onSaveClient = async () => {
    setSaving(true);
    setErr(null);
    try {
      if (clientId.trim() && clientSecret.trim()) {
        await setDriveClientCredentials(clientId, clientSecret);
      }
      setShowSetup(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {status.connected ? (
        <div className="flex items-center gap-3">
          <span className="text-[13px]">
            {status.email ? t("drive.connectedAsEmail", { email: status.email }) : t("drive.connected")}
          </span>
          <button
            onClick={() => void onDisconnect()}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
          >
            {t("drive.disconnectButton")}
          </button>
        </div>
      ) : (
        <button
          onClick={() => void onConnect()}
          disabled={busy}
          className="self-start rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
        >
          {busy ? t("drive.connecting") : t("drive.connectButton")}
        </button>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted">{t("drive.folderLabel")}</label>
        <input
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onBlur={() => void savePrefs(folderName, makePublic)}
          placeholder="Tucky"
          className="w-full max-w-xs rounded-md border border-line bg-canvas px-2 py-1.5 text-[13px]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={makePublic}
            onChange={(e) => {
              setMakePublic(e.target.checked);
              void savePrefs(folderName, e.target.checked);
            }}
          />
          {t("drive.defaultSharingLabel")}
        </label>
        <span className="pl-6 text-[11px] text-muted/70">
          {t("drive.sharingNote")}
        </span>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={showByo}
          onChange={(e) => setShowByo(e.target.checked)}
        />
        {t("drive.byoClientLabel")}
      </label>
      {showByo ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">
            {clientId.trim()
              ? t("drive.clientConfigured", { suffix: clientId.trim().slice(-14) })
              : t("drive.noClientConfigured")}
          </span>
          <button
            onClick={() => setShowSetup(true)}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-surface"
          >
            {clientId.trim() ? t("common.edit") : t("drive.setUpButton")}
          </button>
          <button
            onClick={() => setShowSetup(true)}
            aria-label={t("drive.howToCreateClientId")}
            title={t("drive.howToCreateClientId")}
            className="grid h-5 w-5 place-items-center rounded-full border border-line text-[11px] text-muted hover:bg-surface"
          >
            ?
          </button>
        </div>
      ) : null}
      {err ? <div className="text-[12px] text-red-400">{err}</div> : null}

      {showSetup ? (
        <DriveClientSetupModal
          clientId={clientId}
          clientSecret={clientSecret}
          saving={saving}
          onClientId={setClientId}
          onClientSecret={setClientSecret}
          onSave={() => void onSaveClient()}
          onCancel={() => setShowSetup(false)}
        />
      ) : null}
    </div>
  );
}

function DriveClientSetupModal(props: {
  clientId: string;
  clientSecret: string;
  saving: boolean;
  onClientId: (v: string) => void;
  onClientSecret: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Dialog
      onClose={props.onCancel}
      labelledBy="drive-client-setup-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      panelClassName="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-canvas p-5 text-fg shadow-xl"
    >
        <h3 id="drive-client-setup-title" className="mb-3 text-[15px] font-semibold">
          {t("drive.setupModal.title")}
        </h3>
        <ol className="mb-4 list-decimal space-y-2 pl-5 text-[12px] leading-relaxed text-muted">
          <li>
            <Trans
              i18nKey="drive.setupModal.step1"
              t={t}
              components={{
                link: (
                  <a
                    className="text-accent underline"
                    href="https://console.cloud.google.com/"
                    target="_blank"
                    rel="noreferrer"
                  />
                ),
              }}
            />
          </li>
          <li>
            <Trans i18nKey="drive.setupModal.step2" t={t} components={{ b: <b /> }} />
          </li>
          <li>
            <Trans
              i18nKey="drive.setupModal.step3"
              t={t}
              components={{ b: <b />, code: <code /> }}
            />
          </li>
          <li>
            <Trans i18nKey="drive.setupModal.step4" t={t} components={{ b: <b /> }} />
          </li>
          <li>
            <Trans i18nKey="drive.setupModal.step5" t={t} components={{ b: <b /> }} />
          </li>
        </ol>
        <div className="flex flex-col gap-2">
          <input
            value={props.clientId}
            onChange={(e) => props.onClientId(e.target.value)}
            placeholder={t("drive.setupModal.clientIdPlaceholder")}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[13px]"
          />
          <input
            value={props.clientSecret}
            onChange={(e) => props.onClientSecret(e.target.value)}
            placeholder={t("drive.setupModal.clientSecretPlaceholder")}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[13px]"
          />
          <p className="text-[11px] text-muted">
            {t("drive.setupModal.secretNote")}
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={props.onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={props.onSave}
            disabled={props.saving}
            className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50"
          >
            {props.saving ? t("common.savingEllipsis") : t("common.save")}
          </button>
        </div>
    </Dialog>
  );
}

function DailyRecapSection() {
  const { t } = useTranslation("settings");
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
            message: t("dailyRecap.toasts.loadFailed", {
              error: e instanceof Error ? e.message : String(e),
            }),
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
        message: t("dailyRecap.toasts.saveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-3 text-xs text-muted">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
        <div>
          <div className="text-sm font-semibold text-fg">
            {t("dailyRecap.enable.label")}
          </div>
          <p className="text-xs text-muted">
            {t("dailyRecap.enable.description")}
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
          <div className="text-sm font-semibold text-fg">{t("dailyRecap.deliverAt.label")}</div>
          <p className="text-xs text-muted">{t("dailyRecap.deliverAt.description")}</p>
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
          <div className="text-sm font-semibold text-fg">{t("dailyRecap.includeWeekends.label")}</div>
          <p className="text-xs text-muted">
            {t("dailyRecap.includeWeekends.description")}
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
