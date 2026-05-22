import React from "react";
import ReactDOM from "react-dom/client";
import SetupWindow from "./SetupWindow";
import "../styles/globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SetupWindow />
  </React.StrictMode>,
);
