import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import "./RecordingOverlay.css";

type OverlayState = "recording" | "log-recording" | "transcribing" | "meeting";

type MeetingOverlayPayload = { mode: "meeting"; app_name: string | null };

const MicrophoneIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Z"
      fill="#ffe5ee"
    />
    <path
      d="M4 6.5a.5.5 0 0 0-1 0v1a5 5 0 0 0 4.5 4.975V14H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-1.525A5 5 0 0 0 13 7.5v-1a.5.5 0 0 0-1 0v1a4 4 0 0 1-8 0v-1Z"
      fill="#ffe5ee"
    />
  </svg>
);

const PencilIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61a.75.75 0 0 1-.37.21l-3.25.75a.75.75 0 0 1-.906-.906l.75-3.25a.75.75 0 0 1 .21-.37l8.616-8.604Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.19 6.25 9.75 4.81 3.428 11.13l-.571 2.474 2.473-.571L11.19 6.25Z"
      fill="#d4eeff"
    />
  </svg>
);

const TranscriptionIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm2 1a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1H4Zm0 3a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1H4Zm0 3a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1H4Z"
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
          const meeting = payload as MeetingOverlayPayload;
          setState(meeting.mode);
          setMeetingAppName(meeting.app_name);
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

  const isRecording = state === "recording" || state === "log-recording";
  const isMeeting = state === "meeting";

  const getIcon = () => {
    if (state === "log-recording") return <PencilIcon />;
    if (state === "recording" || state === "meeting") return <MicrophoneIcon />;
    return <TranscriptionIcon />;
  };

  return (
    <div className={`recording-overlay ${isVisible ? "fade-in" : ""} ${state === "log-recording" ? "log-mode" : ""} ${isMeeting ? "meeting-mode" : ""}`}>
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
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;
