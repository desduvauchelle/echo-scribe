import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";

type OverlayState =
  | "recording"
  | "log-recording"
  | "transcribing"
  | "meeting"
  | "action-recording"
  | "processing";

type MeetingOverlayPayload = { mode: "meeting"; app_name: string | null };
type ProcessingOverlayPayload = { mode: "processing"; label: string };

const TranscriptIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M2 2.5h8M2 5h8M2 7.5h5"
      stroke="#c9d8c9"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

const GuideIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M6 1.5l1.2 2.8L10 5.5 7.2 6.7 6 9.5 4.8 6.7 2 5.5l2.8-1.2L6 1.5Z"
      fill="#fbf6ea"
    />
  </svg>
);

const CancelIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M3.17 3.17a.5.5 0 0 1 .7 0L6 5.29l2.13-2.12a.5.5 0 0 1 .7.7L6.71 6l2.12 2.13a.5.5 0 0 1-.7.7L6 6.71 3.87 8.83a.5.5 0 0 1-.7-.7L5.29 6 3.17 3.87a.5.5 0 0 1 0-.7Z"
      fill="#fbf6ea"
    />
  </svg>
);

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation("windows");
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [meetingAppName, setMeetingAppName] = useState<string | null>(null);
  const [processingLabel, setProcessingLabel] = useState<string>(() =>
    t("overlay.processingDefault"),
  );
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const subscribe: typeof listen = async (...args) => {
      const unlisten = await listen(...args);
      if (disposed) unlisten();
      else cleanups.push(unlisten);
      return unlisten;
    };
    const setupEventListeners = async () => {
      await subscribe("show-overlay", (event) => {
        const payload = event.payload;
        if (typeof payload === "string") {
          setState(payload as OverlayState);
          setMeetingAppName(null);
        } else if (payload && typeof payload === "object" && "mode" in payload) {
          const obj = payload as MeetingOverlayPayload | ProcessingOverlayPayload;
          if (obj.mode === "processing") {
            const proc = obj as ProcessingOverlayPayload;
            setState("processing");
            setProcessingLabel(proc.label || t("overlay.processingDefault"));
          } else {
            const meeting = obj as MeetingOverlayPayload;
            setState(meeting.mode);
            setMeetingAppName(meeting.app_name);
          }
        }
        setIsVisible(true);
      });

      await subscribe("hide-overlay", () => {
        setIsVisible(false);
      });

      await subscribe<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];

        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3;
        });

        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed.slice(0, 9));
      });

    };

    void setupEventListeners().catch(console.error);
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  const isRecording = state === "recording" || state === "log-recording" || state === "action-recording";
  const isMeeting = state === "meeting";
  const isProcessing = state === "processing";

  const face = isMeeting ? "meeting" : isProcessing || state === "transcribing" ? "thinking" : "listening";
  const drag = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().startDragging().catch(console.error);
  };

  return (
    <div onMouseDown={drag} className={`recording-overlay ${isVisible ? "fade-in" : ""} ${state === "log-recording" ? "log-mode" : ""} ${isMeeting ? "meeting-mode" : ""} ${state === "action-recording" ? "action-mode" : ""} ${isProcessing ? "processing-mode" : ""}`}>
      <div className={`overlay-left face-${face}`}>
        <img className="tucky-face" src={`/mascot/${face}.png`} alt="Tucky" draggable={false} />
        <span className="activity-dot" aria-hidden="true" />
      </div>

      <div className="overlay-middle">
        <span className="companion-name" aria-hidden="true">Tucky</span>
        {isRecording && <span className="sr-only" role="status">{t("overlay.iconRecordingAlt")}</span>}
        {isRecording && (
          <div className="bars-container" aria-hidden="true">
            {levels.map((v, i) => (
              <div
                key={i}
                className="bar"
                style={{
                  height: `${Math.min(20, 4 + Math.pow(v, 0.7) * 16)}px`,
                  transition: "height 60ms ease-out, opacity 120ms ease-out",
                  opacity: Math.max(0.2, v * 1.7),
                }}
              />
            ))}
          </div>
        )}
        {state === "transcribing" && (
          <div className="status-text" role="status" aria-live="polite">
            {t("overlay.transcribing")}
          </div>
        )}
        {isProcessing && (
          <div className="status-text" role="status" aria-live="polite">
            {processingLabel}
          </div>
        )}
        {isMeeting && (
          <div className="status-text" role="status" aria-live="polite">
            {meetingAppName
              ? t("overlay.recordingMeetingWithApp", { appName: meetingAppName })
              : t("overlay.recordingMeeting")}
          </div>
        )}
      </div>

      <div className="overlay-right">
        {isRecording && (
          <button
            className="cancel-button"
            aria-label={t("overlay.cancelRecording")}
            onClick={() => {
              import("@tauri-apps/api/event").then(({ emit }) =>
                emit("overlay-cancel"),
              );
            }}
          >
            <CancelIcon />
          </button>
        )}
        {isMeeting && (
          <>
            <button
              className="hud-button"
              onClick={() => {
                import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("show_meeting_hud", { focus: "transcript" }).catch(() => {}),
                );
              }}
              aria-label={t("overlay.liveTranscript")}
              title={t("overlay.liveTranscript")}
            >
              <TranscriptIcon />
            </button>
            <button
              className="hud-button"
              onClick={() => {
                import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("show_meeting_hud", { focus: "guides" }).catch(() => {}),
                );
              }}
              aria-label={t("overlay.guidedTemplates")}
              title={t("overlay.guidedTemplates")}
            >
              <GuideIcon />
            </button>
            <button
              className="cancel-button"
              onClick={() => {
                import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("stop_meeting").catch(() => {}),
                );
              }}
              aria-label={t("overlay.stopMeeting")}
              title={t("overlay.stopMeeting")}
            >
              <CancelIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;
