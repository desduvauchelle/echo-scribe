import React from "react";
import ReactDOM from "react-dom/client";
import ActionToast from "./ActionToast";
import "../i18n";
import { initTheme } from "../lib/theme";
import "../styles/speech-bubble.css";
import "./ActionToast.css";

initTheme({ transparentBackground: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ActionToast />
  </React.StrictMode>,
);
