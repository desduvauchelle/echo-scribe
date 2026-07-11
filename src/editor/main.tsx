import React from "react";
import ReactDOM from "react-dom/client";
import EditorWindow from "./EditorWindow";
import { ToastProvider } from "../components/ToastProvider";
import "../styles/globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <EditorWindow />
    </ToastProvider>
  </React.StrictMode>,
);
