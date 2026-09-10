import React from "react";
import ReactDOM from "react-dom/client";
import MeetingHud from "./MeetingHud";
import "../i18n";
import { initTheme } from "../lib/theme";
import "../styles/globals.css";
import "./MeetingHud.css";

document.documentElement.dataset.appView = "meeting-hud";
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MeetingHud />
  </React.StrictMode>,
);
