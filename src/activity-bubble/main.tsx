import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { initTheme } from "../lib/theme";
import "../i18n";
import "../styles/speech-bubble.css";
import "./style.css";
import { tailClass, tailStyle, useBubbleTail } from "../lib/bubbleTail";

type Activity = { mode: "recording" | "log-recording" | "action-recording" | "transcribing" | "processing" | "meeting"; label?: string };

initTheme({ transparentBackground: true });

function ActivityBubble() {
  const { t } = useTranslation("windows");
  const [activity, setActivity] = useState<Activity | null>(null);
  const tail = useBubbleTail();
  useEffect(() => {
    const shown = listen<Activity>("show-activity-bubble", ({ payload }) => setActivity(payload));
    return () => {
      void shown.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  if (!activity) return null;
  const label = activity.mode === "log-recording" ? t("overlay.takingNotes")
    : activity.mode === "transcribing" ? t("overlay.transcribing")
    : activity.mode === "processing" ? activity.label || t("overlay.processingDefault")
    : activity.mode === "meeting" ? t("overlay.recordingMeeting")
    : t("overlay.iconRecordingAlt");
  return <aside className={`activity-bubble${tailClass(tail)}`} style={tailStyle(tail)} role="status" aria-live="polite">
    <span className="activity-bubble-eyebrow">Tucky</span>
    <strong>{label}</strong>
    <span className="activity-bubble-dots" aria-hidden="true"><i /><i /><i /></span>
  </aside>;
}

createRoot(document.getElementById("root")!).render(<ActivityBubble />);
