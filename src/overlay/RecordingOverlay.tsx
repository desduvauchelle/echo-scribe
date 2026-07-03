import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
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

const TrayIcon: React.FC<{ src: string; alt: string }> = ({ src, alt }) => (
  <img
    src={src}
    alt={alt}
    width={16}
    height={16}
    draggable={false}
    style={{ display: "block", width: 16, height: 16 }}
  />
);

const TranscriptIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M2 2.5h8M2 5h8M2 7.5h5"
      stroke="#d4eeff"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

const GuideIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M6 1.5l1.2 2.8L10 5.5 7.2 6.7 6 9.5 4.8 6.7 2 5.5l2.8-1.2L6 1.5Z"
      fill="#ffe5ee"
    />
  </svg>
);

const CancelIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path
      d="M3.17 3.17a.5.5 0 0 1 .7 0L6 5.29l2.13-2.12a.5.5 0 0 1 .7.7L6.71 6l2.12 2.13a.5.5 0 0 1-.7.7L6 6.71 3.87 8.83a.5.5 0 0 1-.7-.7L5.29 6 3.17 3.87a.5.5 0 0 1 0-.7Z"
      fill="#ffe5ee"
    />
  </svg>
);

const RecordingOverlay: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [meetingAppName, setMeetingAppName] = useState<string | null>(null);
  const [processingLabel, setProcessingLabel] = useState<string>("Processing…");
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", (event) => {
        const payload = event.payload;
        if (typeof payload === "string") {
          setState(payload as OverlayState);
          setMeetingAppName(null);
        } else if (payload && typeof payload === "object" && "mode" in payload) {
          const obj = payload as MeetingOverlayPayload | ProcessingOverlayPayload;
          if (obj.mode === "processing") {
            const proc = obj as ProcessingOverlayPayload;
            setState("processing");
            setProcessingLabel(proc.label || "Processing…");
          } else {
            const meeting = obj as MeetingOverlayPayload;
            setState(meeting.mode);
            setMeetingAppName(meeting.app_name);
          }
        }
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];

        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3;
        });

        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed.slice(0, 9));
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
      };
    };

    setupEventListeners();
  }, []);

  const isRecording = state === "recording" || state === "log-recording" || state === "action-recording";
  const isMeeting = state === "meeting";
  const isProcessing = state === "processing";

  const getIcon = () => {
    // Mirror the tray icons so the menu-bar glyph and the overlay glyph
    // are always the same. Mode-discrimination (log/action) is conveyed via
    // the CSS pill gradient (`log-mode`, `action-mode` classes), not the icon.
    if (state === "processing")
      return <TrayIcon src="/icons/tray_thinking.png" alt="Thinking" />;
    if (state === "transcribing")
      return <TrayIcon src="/icons/tray_transcribing.png" alt="Transcribing" />;
    // Recording (any mode) and meeting → listening icon.
    return <TrayIcon src="/icons/tray_recording.png" alt="Recording" />;
  };

  return (
    <div className={`recording-overlay ${isVisible ? "fade-in" : ""} ${state === "log-recording" ? "log-mode" : ""} ${isMeeting ? "meeting-mode" : ""} ${state === "action-recording" ? "action-mode" : ""} ${isProcessing ? "processing-mode" : ""}`}>
      <div className="overlay-left">{getIcon()}</div>

      <div className="overlay-middle">
        {isRecording && (
          <div className="bars-container">
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
          <div className="status-text">Transcribing…</div>
        )}
        {isProcessing && (
          <div className="status-text">{processingLabel}</div>
        )}
        {isMeeting && (
          <div className="status-text">
            {meetingAppName ? `Recording · ${meetingAppName}` : "Recording meeting"}
          </div>
        )}
      </div>

      <div className="overlay-right">
        {isRecording && (
          <button
            className="cancel-button"
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
              title="Live transcript"
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
              title="Guided templates"
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
              title="Stop meeting"
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
