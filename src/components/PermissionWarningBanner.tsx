import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listLlmModels, permissionsStatus } from "../lib/api";

type Props = {
  onOpenSettings: () => void;
  onOpenAiSettings?: () => void;
  showMeetingSetup?: boolean;
  showAiSetup?: boolean;
};

/// Polls permission status every few seconds and renders a warning card in
/// the sidebar (above the Settings button) when something has broken
/// mid-session (e.g. user revoked access from System Settings). Stays out of
/// the way when everything is green. Not a top bar: the top 2rem of the
/// window is the tauri drag region under the macOS traffic lights.
export default function PermissionWarningBanner({ onOpenSettings, onOpenAiSettings = onOpenSettings, showMeetingSetup = true, showAiSetup = true }: Props) {
  const { t } = useTranslation();
  const [missing, setMissing] = useState<string[]>([]);
  // Track whether the missing permission(s) actually break core functionality
  // (mic + a11y are required) vs. only degrade meetings (screen recording —
  // mic-only meetings still work). The banner wording adapts so we don't tell
  // the user dictation is broken when only Screen Recording is missing.
  const [coreBroken, setCoreBroken] = useState(false);
  // A missing language model used to be completely invisible: no banner, no
  // toast, while trigger words pasted literal text and captures filed
  // untagged. Surface it here, at a slower cadence than the TCC poll.
  const [llmMissing, setLlmMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const models = await listLlmModels();
        if (cancelled) return;
        setLlmMissing(!models.some((m) => m.active && m.downloaded));
      } catch {
        /* ignore — transient */
      }
    };
    void tick();
    const id = window.setInterval(tick, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await permissionsStatus();
        if (cancelled) return;
        const m: string[] = [];
        if (!s.microphone) m.push(t("permissionWarningBanner.microphone"));
        if (!s.accessibility) m.push(t("permissionWarningBanner.accessibility"));
        if (showMeetingSetup && !s.screen_recording) m.push(t("permissionWarningBanner.screenRecording"));
        setMissing(m);
        setCoreBroken(!s.microphone || !s.accessibility);
      } catch {
        /* ignore — transient */
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showMeetingSetup, t]);

  if (missing.length === 0 && !(llmMissing && showAiSetup)) return null;

  return (
    <div className="flex flex-col gap-2">
      {missing.length > 0 ? (
        <div
          role="alert"
          className="material-status-card rounded-xl border border-warning/40 p-2.5 text-xs text-warning"
        >
          <div className="font-semibold">
            {t("permissionWarningBanner.missing", { list: missing.join(" + ") })}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-warning/80">
            {coreBroken
              ? t("permissionWarningBanner.coreBroken")
              : t("permissionWarningBanner.meetingsOnly")}
          </div>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-2 w-full cursor-pointer rounded-md border border-warning/40 bg-warning/15 px-2 py-1 font-semibold text-warning transition-colors hover:bg-warning/25"
          >
            {t("permissionWarningBanner.fixInSettings")}
          </button>
        </div>
      ) : null}
      {llmMissing && showAiSetup ? (
        <div
          role="alert"
          className="material-status-card rounded-xl border border-line p-2.5 text-xs text-muted"
        >
          <div className="font-semibold text-fg">
            {t("permissionWarningBanner.llmMissingTitle")}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug">
            {t("permissionWarningBanner.llmMissingBody")}
          </div>
          <button
            type="button"
            onClick={onOpenAiSettings}
            className="mt-2 w-full cursor-pointer rounded-md border border-line bg-elevated px-2 py-1 font-semibold text-fg transition-colors hover:bg-elevated/70"
          >
            {t("permissionWarningBanner.fixInSettings")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
