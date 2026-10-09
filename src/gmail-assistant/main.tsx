import React from "react";
import ReactDOM from "react-dom/client";
import GmailAssistant from "./GmailAssistant";
import "../i18n";
import { initTheme } from "../lib/theme";
import "../styles/globals.css";

initTheme();
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><GmailAssistant /></React.StrictMode>);
