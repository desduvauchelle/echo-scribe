import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type MeetingToastPayload = {
  app_name: string | null;
};

const AUTO_DISMISS_MS = 6_000;
const EXIT_MS = 260;

export default function MeetingStartToast() {
  const { t } = useTranslation("windows");
  const [appName, setAppName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    dismissTimer.current = null;
    hideTimer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    setExiting(true);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      setExiting(false);
      void getCurrentWindow().hide();
    }, EXIT_MS);
  }, [clearTimers]);

  const scheduleDismiss = useCallback(
    (delay = AUTO_DISMISS_MS) => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(dismiss, delay);
    },
    [dismiss],
  );

  useEffect(() => {
    let disposed = false;
    let unlistenShow: UnlistenFn | undefined;
    let unlistenHide: UnlistenFn | undefined;

    void listen<MeetingToastPayload>("show-meeting-toast", (event) => {
      clearTimers();
      setAppName(event.payload.app_name);
      setActionError(null);
      setExiting(false);
      setVisible(true);
      scheduleDismiss();
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlistenShow = stopListening;
    });
    void listen("hide-meeting-toast", () => {
      clearTimers();
      setVisible(false);
      setExiting(false);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlistenHide = stopListening;
    });

    return () => {
      disposed = true;
      unlistenShow?.();
      unlistenHide?.();
      clearTimers();
    };
  }, [clearTimers, scheduleDismiss]);

  const openNotes = async () => {
    try {
      await invoke("show_meeting_hud", { focus: "notes" });
      dismiss();
    } catch {
      setActionError(t("meetingToast.couldntOpenNotes"));
      scheduleDismiss(3_000);
    }
  };

  const stopMeeting = async () => {
    try {
      await invoke("stop_meeting");
      dismiss();
    } catch {
      setActionError(t("meetingToast.couldntStopRecording"));
      scheduleDismiss(3_000);
    }
  };

  return (
    <div className="meeting-toast-stage">
      <section
        className={`meeting-toast${visible ? " is-visible" : ""}${exiting ? " is-exiting" : ""}`}
        aria-label={t("meetingToast.ariaLabel")}
        onMouseEnter={clearTimers}
        onMouseLeave={() => scheduleDismiss(1_500)}
      >
        <div className="meeting-toast-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className="meeting-toast-copy" role="status" aria-live="polite">
          <strong>{t("meetingToast.takingNotes")}</strong>
          <span className={actionError ? "is-error" : undefined}>
            {actionError ??
              (appName
                ? t("meetingToast.recordingApp", { appName })
                : t("meetingToast.recordingStarted"))}
          </span>
        </div>

        <button className="meeting-toast-open" type="button" onClick={openNotes}>
          {t("meetingToast.openNotes")}
        </button>
        <button
          className="meeting-toast-icon meeting-toast-stop"
          type="button"
          onClick={stopMeeting}
          title={t("meetingToast.stopMeeting")}
          aria-label={t("meetingToast.stopMeeting")}
        >
          <span aria-hidden="true" />
        </button>
        <button
          className="meeting-toast-icon meeting-toast-close"
          type="button"
          onClick={dismiss}
          title={t("meetingToast.dismiss")}
          aria-label={t("meetingToast.dismissNotification")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </section>
    </div>
  );
}
