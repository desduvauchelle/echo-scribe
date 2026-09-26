import React from "react";
import ReactDOM from "react-dom/client";
import MeetingStartToast from "./MeetingStartToast";
import "../i18n";
import { initTheme } from "../lib/theme";
import "../styles/speech-bubble.css";
import "./MeetingStartToast.css";

initTheme({ transparentBackground: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MeetingStartToast />
  </React.StrictMode>,
);
