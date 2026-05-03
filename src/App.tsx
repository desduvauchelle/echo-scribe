import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getOnboardingCompleted,
  listSpeechModels,
  permissionsStatus,
  startPipeline,
  undoLogCapture,
  type LogCaptureAutoFiled,
  type LogCaptureClassificationReady,
  type PermissionsStatus,
} from "./lib/api";
import Onboarding from "./views/Onboarding";
import Main from "./views/Main";
import Settings from "./views/Settings";
import LogCaptureOverlay from "./views/LogCaptureOverlay";
import PermissionWarningBanner from "./components/PermissionWarningBanner";
import { ToastProvider, useToasts } from "./components/ToastProvider";
import UpdateBanner from "./components/UpdateBanner";

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
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
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

  // Friendly toast when log-capture fires without an active LLM. The
  // overlay still works (manual fields) but the user benefits from a
  // pointer to Settings → LLM model.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<LogCaptureClassificationReady>(
        "log_capture:classification_ready",
        (event) => {
          const err = event.payload.error;
          if (err && err.toLowerCase().includes("no llm model")) {
            toasts.push({
              tone: "info",
              message:
                "Local AI not configured — set one in Settings to auto-classify captures.",
            });
          }
        },
      );
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [toasts]);

  // Toast-with-undo for high-confidence auto-filed captures. Backend also
  // fires an OS notification when this window isn't visible.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<LogCaptureAutoFiled>(
        "log_capture:auto_filed",
        (event) => {
          const { item_id, project_name, kind, preview } = event.payload;
          const kindLabel = kind === "task" ? "Task" : "Note";
          toasts.push({
            tone: "success",
            message: `${kindLabel} filed to ${project_name}\n${preview}`,
            durationMs: 6000,
            action: {
              label: "Undo",
              onClick: () => {
                void undoLogCapture(item_id).catch((e) => {
                  toasts.push({
                    tone: "error",
                    message: `Undo failed: ${e instanceof Error ? e.message : String(e)}`,
                  });
                });
              },
            },
          });
        },
      );
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [toasts]);

  // Tray menu can request that we navigate to Settings via an `open_settings`
  // event. The `Open Echo Scribe` menu item already handles the window-show
  // side; this just routes the React tree.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen("open_settings", () => {
        setView("settings");
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [status, completed] = await Promise.all([
          permissionsStatus(),
          getOnboardingCompleted().catch(() => false),
        ]);
        if (cancelled) return;
        setInitialStatus(status);

        if (!completed) {
          // Brand-new install (or post-reset): always go through onboarding.
          setView("onboarding");
          return;
        }

        // Onboarding flag says "done", but verify preconditions still hold.
        // If anything regressed (perm revoked, model deleted) we route back
        // to onboarding with a banner — but we DO NOT clear the
        // onboarding_completed flag, so the user only sees this banner
        // until they re-satisfy the preconditions.
        const speechReady = await listSpeechModels()
          .then((ms) => ms.some((m) => m.active && m.downloaded))
          .catch(() => false);
        if (cancelled) return;

        if (!status.microphone || !status.accessibility || !speechReady) {
          const missing: string[] = [];
          if (!status.microphone) missing.push("microphone");
          if (!status.accessibility) missing.push("accessibility");
          if (!speechReady) missing.push("speech model");
          setResumeNotice(
            `Continue setup — missing: ${missing.join(", ")}.`,
          );
          setView("onboarding");
          return;
        }

        // All good: start the pipeline. If start_pipeline still rejects
        // (race / model in flux), fall back to onboarding without resetting
        // the saved state — the picker selections are persisted backend-side
        // so the user re-enters with their previous choices intact.
        try {
          await startPipeline();
          if (cancelled) return;
          setView("main");
        } catch (e) {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          setResumeNotice(`Couldn't start pipeline: ${msg}`);
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
        <UpdateBanner />
        <Onboarding
          initialStatus={initialStatus}
          resumeNotice={resumeNotice}
          onStarted={() => {
            setResumeNotice(null);
            setView("main");
          }}
        />
        {overlay}
      </>
    );
  }

  if (view === "settings") {
    return (
      <>
        {dragBar}
        <UpdateBanner />
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
      <PermissionWarningBanner onOpenSettings={() => setView("settings")} />
      <UpdateBanner />
      <Main key={mainKey} onOpenSettings={() => setView("settings")} />
      {overlay}
    </>
  );
}
