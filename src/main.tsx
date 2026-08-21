import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Side-effect: resolves + applies the user's language before React mounts.
import "./i18n";
import { frontendLog } from "./lib/api";
import { initTheme } from "./lib/theme";
import "./styles/globals.css";

// Route uncaught webview errors into the daily backend log so crashes in
// the release app (no devtools) stay diagnosable. frontendLog swallows its
// own failures, so this can never cascade.
window.addEventListener("error", (event) => {
  frontendLog(
    "error",
    `uncaught: ${event.message} @ ${event.filename ?? "?"}:${event.lineno ?? 0}:${event.colno ?? 0}`,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error
      ? `${event.reason.message}\n${event.reason.stack ?? ""}`
      : String(event.reason);
  frontendLog("error", `unhandled rejection: ${reason}`);
});

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
