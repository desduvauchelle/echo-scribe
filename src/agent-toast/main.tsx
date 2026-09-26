import React from "react";
import ReactDOM from "react-dom/client";
import AgentToast from "./AgentToast";
import "../i18n";
import { initTheme } from "../lib/theme";
import "../styles/speech-bubble.css";
import "./AgentToast.css";

initTheme({ transparentBackground: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AgentToast />
  </React.StrictMode>,
);
