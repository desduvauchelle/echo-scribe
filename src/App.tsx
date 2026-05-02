import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  permissionsStatus,
  startPipeline,
  type PermissionsStatus,
} from "./lib/api";
import Onboarding from "./views/Onboarding";
import Main from "./views/Main";
import Settings from "./views/Settings";

type View = "checking" | "onboarding" | "main" | "settings";

type Toast = { id: number; message: string };

export default function App() {
  const [view, setView] = useState<View>("checking");
  const [initialStatus, setInitialStatus] = useState<PermissionsStatus>({
    microphone: false,
    accessibility: false,
  });
  // Bumped each time the binding might have changed, so Main re-fetches.
  const [mainKey, setMainKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Subscribe to backend ASR errors and surface them as ephemeral toasts so
  // the user gets feedback when transcription fails (otherwise releasing the
  // shortcut just appears to do nothing).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<string>("asr:error", (event) => {
        const id = Date.now() + Math.random();
        setToasts((prev) => [...prev, { id, message: event.payload }]);
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 6000);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const dismissToast = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  const toastStack = (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[400px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2 rounded-md border border-red-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 shadow-lg transition-opacity"
        >
          <span className="mt-0.5 text-red-400">!</span>
          <span className="flex-1 whitespace-pre-wrap break-words">
            {t.message}
          </span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="ml-2 text-neutral-400 hover:text-neutral-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );

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
            // If the speech model isn't ready yet, route to onboarding so the
            // user can pick & download one. Other errors also fall through to
            // onboarding rather than crashing — the user can re-check there.
            const msg = e instanceof Error ? e.message : String(e);
            if (cancelled) return;
            if (msg.includes("speech model not ready")) {
              setView("onboarding");
            } else {
              // start_pipeline is otherwise idempotent; if it failed for an
              // unknown reason, prefer to land in onboarding so the user has
              // controls to recover.
              setView("onboarding");
            }
          }
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
      onMouseDown={() => void getCurrentWindow().startDragging()}
      className="fixed inset-x-0 top-0 z-50 h-8 cursor-move"
    />
  );

  if (view === "checking") {
    return (
      <>
        {dragBar}
        <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-400">
          Checking…
        </div>
        {toastStack}
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
        {toastStack}
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
        {toastStack}
      </>
    );
  }

  return (
    <>
      {dragBar}
      <Main key={mainKey} onOpenSettings={() => setView("settings")} />
      {toastStack}
    </>
  );
}
