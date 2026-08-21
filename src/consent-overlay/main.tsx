import React from "react";
import ReactDOM from "react-dom/client";
import ConsentOverlay from "./ConsentOverlay";
import "../i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConsentOverlay />
  </React.StrictMode>,
);
