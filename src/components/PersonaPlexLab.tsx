import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { Copy, FolderOpen, RefreshCw, Square, Play, Trash2, X } from "lucide-react";
import {
  personaplexBuildBriefing,
  personaplexCancelDownload,
  personaplexDeleteModel,
  personaplexDownload,
  personaplexListInputDevices,
  personaplexOpenModelFolder,
  personaplexStartChat,
  personaplexStatus,
  personaplexStopChat,
  type PersonaplexBriefing,
  type PersonaplexEvent,
  type PersonaplexInputDevice,
  type PersonaplexStatus,
} from "../lib/api";
import {
  BRIEFING_SIZES,
  BRIEFING_WARN_TOKENS,
  LAG_WARN_MS,
  PERSONA_PRESETS,
  REALTIME_BUDGET_MS,
  estimateSpmTokens,
  initialSessionState,
  micSeemsSilent,
  pushLogLine,
  reduceSessionEvent,
  resolveMicChoice,
  sessionIsActive,
  startingSessionState,
  type BriefingSizeId,
  type MicChoice,
  type PersonaplexSessionState,
} from "../lib/personaplex";
import { formatBytes } from "../lib/format";
import { useToasts } from "./ToastProvider";

const PREFS_KEY = "echoScribe.beta.personaplex";

type AudioSetup = "headphones" | "speakers";

type BriefingPrefs = {
  recap: boolean;
  tasks: boolean;
  meetings: boolean;
  projects: boolean;
  people: boolean;
  focus: string;
  condense: boolean;
  size: BriefingSizeId;
  include: boolean;
};

type Prefs = {
  voice: string;
  prompt: string;
  audio: AudioSetup;
  mic: MicChoice;
  briefing: BriefingPrefs;
};

/** `<select>` value ↔ MicChoice (uids are prefixed so they can't collide). */
const micChoiceToValue = (c: MicChoice): string =>
  c === "dictation" || c === "default" ? c : `uid:${c.uid}`;
const valueToMicChoice = (v: string): MicChoice =>
  v === "dictation" || v === "default" ? v : { uid: v.replace(/^uid:/, "") };

const DEFAULT_BRIEFING: BriefingPrefs = {
  recap: true,
  tasks: true,
  meetings: true,
  projects: true,
  people: false,
  focus: "",
  condense: false,
  size: "medium",
  include: true,
};

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    voice: "NATF2",
    prompt: PERSONA_PRESETS[0].prompt,
    audio: "headphones",
    mic: "dictation",
    briefing: DEFAULT_BRIEFING,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Prefs> & { aec?: boolean };
    const audio: AudioSetup =
      parsed.audio === "speakers" || parsed.audio === "headphones"
        ? parsed.audio
        : parsed.aec === true
          ? "speakers"
          : fallback.audio;
    const rawMic = parsed.mic as unknown;
    const mic: MicChoice =
      rawMic === "dictation" || rawMic === "default"
        ? rawMic
        : rawMic && typeof rawMic === "object" && typeof (rawMic as { uid?: unknown }).uid === "string"
          ? { uid: (rawMic as { uid: string }).uid }
          : fallback.mic;
    const b = (parsed.briefing ?? {}) as Partial<BriefingPrefs>;
    const sizeOk = BRIEFING_SIZES.some((s) => s.id === b.size);
    return {
      voice: typeof parsed.voice === "string" ? parsed.voice : fallback.voice,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : fallback.prompt,
      audio,
      mic,
      briefing: {
        ...DEFAULT_BRIEFING,
        ...b,
        focus: typeof b.focus === "string" ? b.focus : "",
        size: sizeOk ? (b.size as BriefingSizeId) : DEFAULT_BRIEFING.size,
      },
    };
  } catch {
    return fallback;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* per-viewer convenience only */
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Card({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-semibold text-fg">{title}</div>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function LevelBar({ label, level, tone }: { label: string; level: number; tone: "mic" | "agent" }) {
  const pct = Math.min(100, Math.round(level * 320));
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <span className="w-10 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
        <div
          className={`h-full transition-[width] duration-150 ${tone === "mic" ? "bg-accent" : "bg-success"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const inputCls =
  "rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-60";

export default function PersonaPlexLab() {
  const { t } = useTranslation("settings");
  const toasts = useToasts();
  const [status, setStatus] = useState<PersonaplexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ fraction: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [session, setSession] = useState<PersonaplexSessionState>(initialSessionState);
  const [startError, setStartError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [briefing, setBriefing] = useState<PersonaplexBriefing | null>(null);
  const [briefingText, setBriefingText] = useState("");
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [devices, setDevices] = useState<PersonaplexInputDevice[]>([]);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const setBriefingPrefs = (patch: Partial<BriefingPrefs>) =>
    setPrefs((p) => ({ ...p, briefing: { ...p.briefing, ...patch } }));

  const refresh = useCallback(async () => {
    try {
      const s = await personaplexStatus();
      setStatus(s);
      setStatusError(null);
      if (s.downloading) {
        setDownload((cur) =>
          cur ?? {
            fraction: s.model_size_bytes > 0 ? s.model_bytes_on_disk / s.model_size_bytes : 0,
          },
        );
      }
    } catch (e) {
      setStatusError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshDevices = useCallback(async () => {
    setDevicesBusy(true);
    try {
      setDevices(await personaplexListInputDevices());
      setDevicesError(null);
    } catch (e) {
      setDevicesError(errText(e));
    } finally {
      setDevicesBusy(false);
    }
  }, []);

  useEffect(() => {
    if (status?.sidecar_installed) void refreshDevices();
  }, [status?.sidecar_installed, refreshDevices]);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    (async () => {
      try {
        const offDownload = await listen<PersonaplexEvent>("personaplex:download", (e) => {
          const p = e.payload;
          if (p.event === "progress") {
            setDownload({ fraction: typeof p.fraction === "number" ? p.fraction : 0 });
          } else if (p.event === "stderr") {
            setLogLines((l) => pushLogLine(l, `[download] ${String(p.line)}`));
          } else if (p.event === "log" || p.event === "error") {
            setLogLines((l) =>
              pushLogLine(l, `[download:${String(p.level ?? p.event)}] ${String(p.msg)}`),
            );
          } else if (p.event === "exited") {
            setDownload(null);
            void refresh();
          }
        });
        const offSession = await listen<PersonaplexEvent>("personaplex:event", (e) => {
          const p = e.payload;
          if (p.event === "stderr") {
            setLogLines((l) => pushLogLine(l, String(p.line)));
          } else if (p.event === "log") {
            setLogLines((l) => pushLogLine(l, `[${String(p.level)}] ${String(p.msg)}`));
          } else if (p.event === "error") {
            setLogLines((l) => pushLogLine(l, `[error] ${String(p.msg)}`));
          } else if (p.event !== "level" && p.event !== "text") {
            setLogLines((l) => pushLogLine(l, `[event] ${JSON.stringify(p)}`));
          }
          setSession((s) => reduceSessionEvent(s, p));
          if (p.event === "exited") void refresh();
        });
        if (disposed) {
          offDownload();
          offSession();
        } else {
          unlisteners.push(offDownload, offSession);
        }
      } catch {
        /* no Tauri runtime (dev preview) */
      }
    })();
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, [refresh]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.transcript]);

  useEffect(() => {
    const el = logRef.current;
    if (el && showLog) el.scrollTop = el.scrollHeight;
  }, [logLines, showLog]);

  const onDownload = async () => {
    setDownloadError(null);
    setDownloadBusy(true);
    setDownload({
      fraction:
        status && status.model_size_bytes > 0
          ? Math.min(0.999, status.model_bytes_on_disk / status.model_size_bytes)
          : 0,
    });
    try {
      await personaplexDownload();
      toasts.push({ tone: "success", message: t("beta.personaplex.model.downloadedToast") });
    } catch (e) {
      setDownloadError(errText(e));
    } finally {
      setDownloadBusy(false);
      setDownload(null);
      void refresh();
    }
  };

  const onCancelDownload = async () => {
    try {
      await personaplexCancelDownload();
    } catch (e) {
      toasts.push({ tone: "error", message: errText(e) });
    }
  };

  const onDelete = async () => {
    const size = formatBytes(status?.model_bytes_on_disk ?? 0) || "0 B";
    const ok = await ask(t("beta.personaplex.model.deleteConfirm", { size }), {
      title: "PersonaPlex",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await personaplexDeleteModel();
    } catch (e) {
      toasts.push({ tone: "error", message: errText(e) });
    }
    void refresh();
  };

  const onBuildBriefing = async () => {
    setBriefingBusy(true);
    setBriefingError(null);
    const size = BRIEFING_SIZES.find((s) => s.id === prefs.briefing.size) ?? BRIEFING_SIZES[1];
    try {
      const b = await personaplexBuildBriefing({
        recap: prefs.briefing.recap,
        tasks: prefs.briefing.tasks,
        meetings: prefs.briefing.meetings,
        projects: prefs.briefing.projects,
        people: prefs.briefing.people,
        focus_query: prefs.briefing.focus,
        condense: prefs.briefing.condense,
        max_chars: size.chars,
      });
      setBriefing(b);
      setBriefingText(b.text);
    } catch (e) {
      setBriefingError(errText(e));
    } finally {
      setBriefingBusy(false);
    }
  };

  const onStart = async () => {
    setStartError(null);
    setLogLines([]);
    setSession(startingSessionState());
    const brief = prefs.briefing.include ? briefingText.trim() : "";
    try {
      await personaplexStartChat({
        voice: prefs.voice,
        prompt: prefs.prompt,
        echo_cancellation: prefs.audio === "speakers",
        briefing: brief ? brief : null,
        input_device: resolveMicChoice(prefs.mic, status?.dictation_input_device ?? null),
      });
    } catch (e) {
      const msg = errText(e);
      setStartError(msg);
      setSession((s) => ({ ...s, phase: "error", error: msg }));
    }
    void refresh();
  };

  const onStop = async () => {
    setSession((s) => (sessionIsActive(s.phase) ? { ...s, phase: "stopping" } : s));
    try {
      await personaplexStopChat();
    } catch (e) {
      toasts.push({ tone: "error", message: errText(e) });
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(session.transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toasts.push({ tone: "error", message: errText(e) });
    }
  };

  const active = sessionIsActive(session.phase);
  const canStart =
    !!status && status.sidecar_installed && status.model_downloaded && !active && !download;
  const pct = download ? Math.min(100, Math.round(download.fraction * 100)) : 0;
  const version = status?.sidecar_version;
  const briefingTokens = estimateSpmTokens(briefingText);
  const micSilent = micSeemsSilent(session);
  const lagging = session.phase === "ready" && session.micBufferMs > LAG_WARN_MS;

  return (
    <div className="flex flex-col gap-4">
      {statusError ? (
        <p className="text-xs text-warning">
          {t("beta.personaplex.statusError", { error: statusError })}
        </p>
      ) : null}

      <Card title={t("beta.personaplex.about.title")}>
        <p className="text-xs leading-relaxed text-muted">{t("beta.personaplex.about.body")}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t("beta.personaplex.about.tips")}</p>
      </Card>

      <Card title={t("beta.personaplex.runtime.title")}>
        {status?.sidecar_installed ? (
          <div className="text-xs text-muted">
            <div className="text-fg">{t("beta.personaplex.runtime.installed")}</div>
            <div className="mt-1 truncate font-mono text-[11px]" title={status.sidecar_path ?? ""}>
              {status.sidecar_path}
            </div>
            {version ? (
              <div className="mt-1 text-[11px]">
                {t("beta.personaplex.runtime.version", {
                  tag: version.speech_swift || "?",
                  commit: version.speech_swift_commit || "?",
                  built: version.built_at || "?",
                })}
              </div>
            ) : null}
            {!status.metallib_present ? (
              <div className="mt-1 text-[11px] text-warning">
                {t("beta.personaplex.runtime.metallibMissing")}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-muted">
            <div className="text-warning">{t("beta.personaplex.runtime.missing")}</div>
            <p className="mt-1">{t("beta.personaplex.runtime.missingHint")}</p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-surface p-2 font-mono text-[11px] text-fg">
              bash scripts/build-personaplex-sidecar.sh
            </pre>
            <p className="mt-2 text-[11px]">
              {t("beta.personaplex.runtime.installDir", { dir: status?.sidecar_install_dir ?? "" })}
            </p>
          </div>
        )}
      </Card>

      <Card
        title={t("beta.personaplex.model.title")}
        aside={
          <button
            type="button"
            onClick={() =>
              void personaplexOpenModelFolder().catch((e) =>
                toasts.push({ tone: "error", message: errText(e) }),
              )
            }
            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg"
          >
            <FolderOpen size={12} aria-hidden="true" />
            {t("beta.personaplex.model.openFolder")}
          </button>
        }
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1 text-xs text-muted">
            <div className="font-mono text-[11px] text-fg">
              {status?.model_id ?? "aufklarer/PersonaPlex-7B-MLX-8bit"}
            </div>
            <div className="mt-1">
              {download
                ? t("beta.personaplex.model.downloading", { pct })
                : status?.model_downloaded
                  ? t("beta.personaplex.model.downloaded", {
                      size: formatBytes(status.model_bytes_on_disk),
                    })
                  : status && status.model_bytes_on_disk > 0
                    ? t("beta.personaplex.model.partial", {
                        size: formatBytes(status.model_bytes_on_disk),
                      })
                    : t("beta.personaplex.model.notDownloaded")}
            </div>
            {download ? (
              <div
                role="progressbar"
                aria-label={t("beta.personaplex.model.downloading", { pct })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-elevated"
              >
                <div className="h-full bg-fg transition-all" style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            {downloadError ? (
              <p className="mt-2 text-xs text-danger">
                {t("beta.personaplex.model.downloadFailed", { error: downloadError })}
              </p>
            ) : null}
            <p className="mt-2 text-[11px]">
              {t("beta.personaplex.model.ramNote", {
                ram:
                  status && status.total_ram_bytes > 0 ? formatBytes(status.total_ram_bytes) : "?",
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {download ? (
              <button
                type="button"
                onClick={() => void onCancelDownload()}
                className="inline-flex items-center gap-1 rounded border border-line px-3 py-1 text-xs hover:bg-elevated"
              >
                <X size={12} aria-hidden="true" />
                {t("beta.personaplex.model.cancel")}
              </button>
            ) : status?.model_downloaded ? (
              <button
                type="button"
                disabled={active}
                onClick={() => void onDelete()}
                className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={12} aria-hidden="true" />
                {t("beta.personaplex.model.delete")}
              </button>
            ) : (
              <button
                type="button"
                disabled={downloadBusy || !status?.sidecar_installed || active}
                onClick={() => void onDownload()}
                className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status && status.model_bytes_on_disk > 0
                  ? t("beta.personaplex.model.resume")
                  : t("beta.personaplex.model.download", {
                      size: formatBytes(status?.model_size_bytes ?? 9_750_000_000),
                    })}
              </button>
            )}
          </div>
        </div>
      </Card>

      <Card title={t("beta.personaplex.briefing.title")}>
        <div className="flex flex-col gap-3 text-xs text-muted">
          <p className="leading-relaxed">{t("beta.personaplex.briefing.intro")}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {(["recap", "tasks", "meetings", "projects", "people"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={prefs.briefing[k]}
                  disabled={active}
                  onChange={(e) => setBriefingPrefs({ [k]: e.target.checked })}
                />
                {t(`beta.personaplex.briefing.include.${k}`)}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px]">
            <label className="flex flex-col gap-1">
              {t("beta.personaplex.briefing.focusLabel")}
              <input
                value={prefs.briefing.focus}
                disabled={active}
                placeholder={t("beta.personaplex.briefing.focusPlaceholder")}
                onChange={(e) => setBriefingPrefs({ focus: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              {t("beta.personaplex.briefing.size.label")}
              <select
                value={prefs.briefing.size}
                disabled={active}
                onChange={(e) => setBriefingPrefs({ size: e.target.value as BriefingSizeId })}
                className={inputCls}
              >
                {BRIEFING_SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t(`beta.personaplex.briefing.size.${s.id}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={prefs.briefing.condense}
                disabled={active}
                onChange={(e) => setBriefingPrefs({ condense: e.target.checked })}
              />
              {t("beta.personaplex.briefing.condense")}
            </label>
            <button
              type="button"
              disabled={briefingBusy || active}
              onClick={() => void onBuildBriefing()}
              className="rounded-md border border-line px-3 py-1 text-xs font-semibold text-fg hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
            >
              {briefingBusy
                ? t("beta.personaplex.briefing.building")
                : briefing
                  ? t("beta.personaplex.briefing.rebuild")
                  : t("beta.personaplex.briefing.build")}
            </button>
          </div>
          {briefingError ? (
            <p className="text-danger">
              {t("beta.personaplex.briefing.buildFailed", { error: briefingError })}
            </p>
          ) : null}
          {briefing ? (
            <div className="flex flex-col gap-2">
              {briefing.text ? (
                <>
                  <textarea
                    value={briefingText}
                    disabled={active}
                    rows={7}
                    onChange={(e) => setBriefingText(e.target.value)}
                    className={`${inputCls} resize-y font-mono text-[12px] leading-snug`}
                  />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <span>
                      {t("beta.personaplex.briefing.meta", {
                        chars: briefingText.length,
                        tokens: briefingTokens,
                      })}
                    </span>
                    {briefing.parts.map((p) => (
                      <span key={p.kind} className="rounded-full bg-elevated px-2 py-0.5">
                        {t(`beta.personaplex.briefing.include.${p.kind}` as const, {
                          defaultValue: p.kind,
                        })}{" "}
                        {p.count}
                      </span>
                    ))}
                    {briefing.condensed ? (
                      <span className="text-success">{t("beta.personaplex.briefing.condensed")}</span>
                    ) : null}
                    {briefing.truncated ? (
                      <span>{t("beta.personaplex.briefing.truncated")}</span>
                    ) : null}
                    <span>{t("beta.personaplex.briefing.editHint")}</span>
                  </div>
                  {briefingTokens > BRIEFING_WARN_TOKENS ? (
                    <p className="text-warning">{t("beta.personaplex.briefing.warn")}</p>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-fg">
                    <input
                      type="checkbox"
                      checked={prefs.briefing.include}
                      disabled={active}
                      onChange={(e) => setBriefingPrefs({ include: e.target.checked })}
                    />
                    {t("beta.personaplex.briefing.includeNext")}
                  </label>
                </>
              ) : (
                <p>{t("beta.personaplex.briefing.empty")}</p>
              )}
            </div>
          ) : null}
        </div>
      </Card>

      <Card
        title={t("beta.personaplex.session.title")}
        aside={
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
              session.phase === "ready"
                ? "bg-success/15 text-success"
                : session.phase === "error"
                  ? "bg-danger/15 text-danger"
                  : "bg-elevated text-muted"
            }`}
          >
            {t(`beta.personaplex.session.phase.${session.phase}`)}
          </span>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_1fr]">
            <div className="flex flex-col gap-2 text-xs text-muted">
              <label className="flex flex-col gap-1">
                {t("beta.personaplex.session.voice")}
                <select
                  value={prefs.voice}
                  disabled={active}
                  onChange={(e) => setPrefs((p) => ({ ...p, voice: e.target.value }))}
                  className={inputCls}
                >
                  {(status?.voices ?? [{ id: "NATF2", label: "Natural female 2" }]).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({v.id})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between">
                  {t("beta.personaplex.session.mic.label")}
                  <button
                    type="button"
                    disabled={devicesBusy || active}
                    onClick={() => void refreshDevices()}
                    title={t("beta.personaplex.session.mic.refresh")}
                    aria-label={t("beta.personaplex.session.mic.refresh")}
                    className="text-muted hover:text-fg disabled:opacity-50"
                  >
                    <RefreshCw size={11} aria-hidden="true" className={devicesBusy ? "animate-spin" : ""} />
                  </button>
                </span>
                <select
                  value={micChoiceToValue(prefs.mic)}
                  disabled={active}
                  onChange={(e) => setPrefs((p) => ({ ...p, mic: valueToMicChoice(e.target.value) }))}
                  className={inputCls}
                >
                  <option value="dictation">
                    {status?.dictation_input_device
                      ? t("beta.personaplex.session.mic.sameAsDictation", {
                          name: status.dictation_input_device,
                        })
                      : t("beta.personaplex.session.mic.sameAsDictationDefault")}
                  </option>
                  <option value="default">{t("beta.personaplex.session.mic.systemDefault")}</option>
                  {devices.map((d) => (
                    <option key={d.uid} value={`uid:${d.uid}`}>
                      {d.name}
                      {d.is_default ? ` ${t("beta.personaplex.session.mic.defaultMark")}` : ""}
                    </option>
                  ))}
                  {typeof prefs.mic === "object" && !devices.some((d) => d.uid === prefs.mic) ? (
                    <option value={`uid:${prefs.mic.uid}`}>
                      {t("beta.personaplex.session.mic.missing", { uid: prefs.mic.uid })}
                    </option>
                  ) : null}
                </select>
                {devicesError ? (
                  <span className="text-[11px] text-warning">
                    {t("beta.personaplex.session.mic.listFailed", { error: devicesError })}
                  </span>
                ) : null}
              </label>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1">{t("beta.personaplex.session.audioSetup.label")}</legend>
                {(["headphones", "speakers"] as const).map((mode) => (
                  <label key={mode} className="flex items-start gap-1.5">
                    <input
                      type="radio"
                      name="personaplex-audio-setup"
                      className="mt-0.5"
                      checked={prefs.audio === mode}
                      disabled={active}
                      onChange={() => setPrefs((p) => ({ ...p, audio: mode }))}
                    />
                    <span>
                      <span className="text-fg">
                        {t(`beta.personaplex.session.audioSetup.${mode}`)}
                      </span>
                      <span className="block text-[11px]">
                        {t(`beta.personaplex.session.audioSetup.${mode}Hint`)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted">
              <label className="flex flex-col gap-1">
                {t("beta.personaplex.session.persona")}
                <textarea
                  value={prefs.prompt}
                  disabled={active}
                  rows={5}
                  placeholder={t("beta.personaplex.session.personaPlaceholder")}
                  onChange={(e) => setPrefs((p) => ({ ...p, prompt: e.target.value }))}
                  className={`${inputCls} resize-y`}
                />
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px]">{t("beta.personaplex.session.presets")}</span>
                {PERSONA_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={active}
                    onClick={() => setPrefs((p) => ({ ...p, prompt: preset.prompt }))}
                    className="rounded-full border border-line px-2 py-0.5 text-[11px] hover:bg-elevated disabled:opacity-50"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {active ? (
              <button
                type="button"
                disabled={session.phase === "stopping"}
                onClick={() => void onStop()}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1 text-xs font-semibold hover:bg-elevated disabled:opacity-50"
              >
                <Square size={12} aria-hidden="true" />
                {session.phase === "stopping"
                  ? t("beta.personaplex.session.stopping")
                  : t("beta.personaplex.session.stop")}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canStart}
                onClick={() => void onStart()}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play size={12} aria-hidden="true" />
                {t("beta.personaplex.session.start")}
              </button>
            )}
            {!status?.sidecar_installed ? (
              <span className="text-[11px] text-muted">
                {t("beta.personaplex.session.needsSidecar")}
              </span>
            ) : !status.model_downloaded ? (
              <span className="text-[11px] text-muted">
                {t("beta.personaplex.session.needsModel")}
              </span>
            ) : null}
            {session.phase === "loading" || session.phase === "starting" ? (
              <span className="text-[11px] text-muted">
                {session.loadStatus || t("beta.personaplex.session.phase.loading")} ·{" "}
                {Math.round(session.loadFraction * 100)}%
              </span>
            ) : null}
            {session.loadSecs !== null ? (
              <span className="text-[11px] text-muted">
                {t("beta.personaplex.session.loadStats", {
                  load: session.loadSecs.toFixed(1),
                  warm: (session.warmSecs ?? 0).toFixed(1),
                })}
                {session.promptTokens !== null
                  ? ` · ${t("beta.personaplex.session.promptTokens", { tokens: session.promptTokens })}`
                  : ""}
              </span>
            ) : null}
          </div>

          {session.phase === "ready" ? (
            <p className="text-[11px] text-muted">
              {t("beta.personaplex.session.talkHint")}
              {session.micName
                ? ` ${t("beta.personaplex.session.mic.listening", { name: session.micName })}`
                : ""}
            </p>
          ) : null}
          {micSilent ? (
            <p className="text-xs text-warning">{t("beta.personaplex.session.micSilent")}</p>
          ) : null}
          {lagging ? (
            <p className="text-[11px] text-warning">
              {t("beta.personaplex.session.lag", { ms: session.micBufferMs })}
            </p>
          ) : null}

          {session.error || startError ? (
            <p className="text-xs text-danger">
              {t("beta.personaplex.session.startFailed", {
                error: session.error ?? startError,
              })}
            </p>
          ) : null}
          {session.phase === "idle" && session.stopReason ? (
            <p className="text-[11px] text-muted">
              {t("beta.personaplex.session.exited", { reason: session.stopReason })}
            </p>
          ) : null}

          {active ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <LevelBar
                label={t("beta.personaplex.session.levels.mic")}
                level={session.micLevel}
                tone="mic"
              />
              <LevelBar
                label={t("beta.personaplex.session.levels.agent")}
                level={session.agentLevel}
                tone="agent"
              />
            </div>
          ) : null}
          {session.msPerStep !== null ? (
            <p
              className={`text-[11px] ${
                session.msPerStep > REALTIME_BUDGET_MS ? "text-warning" : "text-muted"
              }`}
            >
              {t("beta.personaplex.session.stats", {
                ms: session.msPerStep.toFixed(0),
                budget: REALTIME_BUDGET_MS,
                step: session.step,
                underruns: session.underruns,
              })}
              {" · "}
              {t("beta.personaplex.session.micStats", {
                pct: session.micActivePct,
                lag: session.micBufferMs,
              })}
            </p>
          ) : null}

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted">
                {t("beta.personaplex.session.transcript")}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!session.transcript}
                  onClick={() => void onCopy()}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg disabled:opacity-50"
                >
                  <Copy size={11} aria-hidden="true" />
                  {copied
                    ? t("beta.personaplex.session.copied")
                    : t("beta.personaplex.session.copy")}
                </button>
                <button
                  type="button"
                  disabled={!session.transcript}
                  onClick={() => setSession((s) => ({ ...s, transcript: "" }))}
                  className="text-[11px] text-muted hover:text-fg disabled:opacity-50"
                >
                  {t("beta.personaplex.session.clear")}
                </button>
              </div>
            </div>
            <div
              ref={transcriptRef}
              className="mt-1 max-h-56 min-h-[6rem] overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-3 text-sm leading-relaxed text-fg"
            >
              {session.transcript || (
                <span className="text-muted">{t("beta.personaplex.session.transcriptEmpty")}</span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <div>
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className="text-xs text-muted hover:text-fg"
        >
          {showLog ? t("beta.personaplex.log.hide") : t("beta.personaplex.log.show")}
        </button>
        {showLog ? (
          <pre
            ref={logRef}
            className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-[11px] leading-snug text-muted"
          >
            {logLines.length > 0 ? logLines.join("\n") : t("beta.personaplex.log.empty")}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
