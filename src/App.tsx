import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
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
import { useVoicePasteFocus } from "./lib/voicePasteFocus";

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
  const [meetingPrompt, setMeetingPrompt] = useState<{
    bundle_id: string;
    app_name: string;
  } | null>(null);
  const toasts = useToasts();

  // Re-focus the last-used text input before the backend pastes, so
  // dictating into our own chat input works (the recording overlay
  // momentarily steals first-responder).
  useVoicePasteFocus();

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

  // Surface "meetings-recovered" events as a one-time toast.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<{ ids: string[] }>(
        "meetings-recovered",
        (event) => {
          const n = event.payload.ids.length;
          if (n > 0) {
            toasts.push({
              tone: "info",
              message: `${n} unfinished meeting${n > 1 ? "s" : ""} recovered. View them in Meetings.`,
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

  // Surface "meeting-detected" events from the backend detector with an
  // in-app three-button prompt (Always / Just once / Never). The prompt
  // dismisses on choice, calling the meeting_consent command.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<{ bundle_id: string; app_name: string }>(
        "meeting-detected",
        (event) => {
          setMeetingPrompt(event.payload);
        },
      );
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

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

  const overlay = (
    <>
      <LogCaptureOverlay />
      {meetingPrompt ? (
        <MeetingDetectedPrompt
          bundleId={meetingPrompt.bundle_id}
          appName={meetingPrompt.app_name}
          onDecision={async (decision) => {
            try {
              await invoke("meeting_consent", {
                bundleId: meetingPrompt.bundle_id,
                appName: meetingPrompt.app_name,
                decision,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              toasts.push({ tone: "error", message: `Couldn't record consent: ${msg}` });
            }
            setMeetingPrompt(null);
          }}
        />
      ) : null}
    </>
  );

  if (view === "checking") {
    return (
      <>
        {dragBar}
        <div className="flex h-full items-center justify-center bg-canvas text-sm text-muted">
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

function MeetingDetectedPrompt({
  bundleId: _bundleId,
  appName,
  onDecision,
}: {
  bundleId: string;
  appName: string;
  onDecision: (d: "always" | "once" | "never") => void;
}) {
  return (
    <div className="meeting-detected-prompt fixed bottom-6 right-6 z-50 max-w-sm rounded-lg bg-surface p-4 shadow-lg ring-1 ring-border">
      <div className="text-sm font-medium">{appName} meeting detected</div>
      <div className="mt-1 text-xs text-muted">
        Record this meeting locally? Audio stays on your machine.
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white"
          onClick={() => onDecision("once")}
        >
          Just once
        </button>
        <button
          className="rounded-md bg-surface-2 px-3 py-1.5 text-xs"
          onClick={() => onDecision("always")}
        >
          Always for {appName}
        </button>
        <button
          className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-muted"
          onClick={() => onDecision("never")}
        >
          Never
        </button>
      </div>
    </div>
  );
}
