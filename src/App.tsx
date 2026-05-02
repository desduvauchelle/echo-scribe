import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  permissionsStatus,
  startPipeline,
  type PermissionsStatus,
} from "./lib/api";
import Onboarding from "./views/Onboarding";
import Main from "./views/Main";
import Settings from "./views/Settings";
import LogCaptureOverlay from "./views/LogCaptureOverlay";
import { ToastProvider, useToasts } from "./components/ToastProvider";

type View = "checking" | "onboarding" | "main" | "settings";

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

function AppShell() {
  const [view, setView] = useState<View>("checking");
  const [initialStatus, setInitialStatus] = useState<PermissionsStatus>({
    microphone: false,
    accessibility: false,
  });
  const [mainKey, setMainKey] = useState(0);
  const toasts = useToasts();

  // Surface backend ASR errors as toasts.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<string>("asr:error", (event) => {
        toasts.push({ tone: "error", message: event.payload });
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [toasts]);

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
            if (cancelled) return;
            setView("main");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (cancelled) return;
            if (msg.includes("speech model not ready")) {
              setView("onboarding");
            } else {
              setView("onboarding");
            }
          }
        } else {
          setView("onboarding");
        }
      } catch {
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
      className="drag-bar fixed inset-x-0 top-0 z-50 h-8"
    />
  );

  const overlay = <LogCaptureOverlay />;

  if (view === "checking") {
    return (
      <>
        {dragBar}
        <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-400">
          Checking…
        </div>
        {overlay}
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
        {overlay}
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
        {overlay}
      </>
    );
  }

  return (
    <>
      {dragBar}
      <Main key={mainKey} onOpenSettings={() => setView("settings")} />
      {overlay}
    </>
  );
}
