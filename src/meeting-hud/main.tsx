import React from "react";
import ReactDOM from "react-dom/client";
import MeetingHud from "./MeetingHud";
import "./MeetingHud.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MeetingHud />
  </React.StrictMode>,
);
