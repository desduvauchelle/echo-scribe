import React from "react";
import ReactDOM from "react-dom/client";
import AreaPicker from "./AreaPicker";
import "../i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AreaPicker />
  </React.StrictMode>,
);
