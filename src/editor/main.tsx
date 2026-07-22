import React from "react";
import ReactDOM from "react-dom/client";
import EditorWindow from "./EditorWindow";
import { ToastProvider } from "../components/ToastProvider";
import { initTheme } from "../lib/theme";
import "../styles/globals.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <EditorWindow />
    </ToastProvider>
  </React.StrictMode>,
);
