import React from "react";
import ReactDOM from "react-dom/client";
import SetupWindow from "./SetupWindow";
import { initTheme } from "../lib/theme";
import "../styles/globals.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SetupWindow />
  </React.StrictMode>,
);
