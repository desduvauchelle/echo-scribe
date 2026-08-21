import React from "react";
import ReactDOM from "react-dom/client";
import CameraPreview from "./CameraPreview";
import "../i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CameraPreview />
  </React.StrictMode>,
);
