import React from "react";
import ReactDOM from "react-dom/client";
import MeetingStartToast from "./MeetingStartToast";
import "../i18n";
import "./MeetingStartToast.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MeetingStartToast />
  </React.StrictMode>,
);
