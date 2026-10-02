import { BubbleSurface } from "../components/BubbleSurface";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { initTheme } from "../lib/theme";
import "../i18n";
import "../styles/speech-bubble.css";
import "./style.css";
import { useBubbleTail } from "../lib/bubbleTail";

type Activity = { mode: "recording" | "log-recording" | "action-recording" | "wake-recording" | "transcribing" | "processing" | "meeting"; label?: string };

initTheme({ transparentBackground: true });

function ActivityBubble() {
  const { t } = useTranslation("windows");
  const [activity, setActivity] = useState<Activity | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const tail = useBubbleTail();
  useEffect(() => {
    const shown = listen<Activity>("show-activity-bubble", ({ payload }) => { setActivity(payload); setLevels([]); });
    const meter = listen<number[]>("mic-level", ({ payload }) => setLevels(payload.slice(0, 5)));
    return () => {
      void shown.then((unlisten) => unlisten()).catch(() => {});
      void meter.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  if (!activity) return null;
  const listening = activity.mode === "wake-recording";
  const label = listening ? t("overlay.wakeListening")
    : activity.mode === "log-recording" ? t("overlay.takingNotes")
    : activity.mode === "transcribing" ? t("overlay.transcribing")
    : activity.mode === "processing" ? activity.label || t("overlay.processingDefault")
    : activity.mode === "meeting" ? t("overlay.recordingMeeting")
    : t("overlay.iconRecordingAlt");
  return <BubbleSurface as="aside" className={`activity-bubble${listening ? " activity-listening" : ""}`} tail={tail} role="status" aria-live="polite">
    <span className="activity-bubble-eyebrow">Tucky</span>
    <strong>{label}</strong>
    {listening ? <>
      <span className="activity-mic-meter" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => <i key={i} style={{ height: `${4 + Math.min(1, Math.max(0, levels[i] || 0)) * 14}px` }} />)}
      </span>
      <button className="activity-cancel" aria-label={t("overlay.cancelRecording")} onClick={() => void emit("overlay-cancel").catch(console.error)}>×</button>
    </> : <span className="activity-bubble-dots" aria-hidden="true"><i /><i /><i /></span>}
  </BubbleSurface>;
}

createRoot(document.getElementById("root")!).render(<ActivityBubble />);
