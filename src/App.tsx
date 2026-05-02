import { useEffect, useState } from "react";
import {
  permissionsStatus,
  startPipeline,
  type PermissionsStatus,
} from "./lib/api";
import Onboarding from "./views/Onboarding";
import Main from "./views/Main";
import Settings from "./views/Settings";

type View = "checking" | "onboarding" | "main" | "settings";

export default function App() {
  const [view, setView] = useState<View>("checking");
  const [initialStatus, setInitialStatus] = useState<PermissionsStatus>({
    microphone: false,
    accessibility: false,
  });
  // Bumped each time the binding might have changed, so Main re-fetches.
  const [mainKey, setMainKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await permissionsStatus();
        if (cancelled) return;
        setInitialStatus(status);
        if (status.microphone && status.accessibility) {
          try {
            await startPipeline();
          } catch {
            /* start_pipeline is idempotent; ignore failures here and let main render */
          }
          if (cancelled) return;
          setView("main");
        } else {
          setView("onboarding");
        }
      } catch {
        // If the probe itself fails, fall through to onboarding so the user
        // can at least see the permission rows and re-check.
        if (!cancelled) setView("onboarding");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dragBar = (
    <div
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-50 h-8"
    />
  );

  if (view === "checking") {
    return (
      <>
        {dragBar}
        <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-400">
          Checking…
        </div>
      </>
    );
  }

  if (view === "onboarding") {
    return (
      <>
        {dragBar}
        <Onboarding
          initialStatus={initialStatus}
          onStarted={() => setView("main")}
        />
      </>
    );
  }

  if (view === "settings") {
    return (
      <>
        {dragBar}
        <Settings
          onBack={() => {
            setMainKey((k) => k + 1);
            setView("main");
          }}
        />
      </>
    );
  }

  return (
    <>
      {dragBar}
      <Main key={mainKey} onOpenSettings={() => setView("settings")} />
    </>
  );
}
