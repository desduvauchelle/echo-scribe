import React from "react";
import ReactDOM from "react-dom/client";
import ConsentOverlay from "./ConsentOverlay";
import "../i18n";
import { initTheme } from "../lib/theme";
import "../styles/speech-bubble.css";

initTheme({ transparentBackground: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConsentOverlay />
  </React.StrictMode>,
);
