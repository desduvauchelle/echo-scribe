import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

type ActionToastPayload = {
  /** ActionCommand.action_type, e.g. "stay_awake", "launch_app". */
  kind: string;
  /** Human confirmation line from execute_action. */
  message: string;
};

const AUTO_DISMISS_MS = 5_000;
const EXIT_MS = 240;

/** Per-action icon + accent + short title. Falls back to a green check. */
const KINDS: Record<string, { title: string; accent: string; icon: ReactElement }> = {
  stay_awake: {
    title: "Staying awake",
    accent: "#FF9F0A",
    icon: (
      // coffee cup
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 8h1a3 3 0 0 1 0 6h-1" />
        <path d="M3 8h14v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z" />
        <path d="M7 2v2M11 2v2M15 2v2" />
      </svg>
    ),
  },
  stop_stay_awake: {
    title: "Back to normal sleep",
    accent: "#8E8E93",
    icon: (
      // moon
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    ),
  },
  launch_app: {
    title: "App launched",
    accent: "#0A84FF",
    icon: (
      // arrow up-right in a square
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M9 15l6-6M10.5 9H15v4.5" />
      </svg>
    ),
  },
  open_url: {
    title: "Opened in browser",
    accent: "#0A84FF",
    icon: (
      // globe
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18" />
      </svg>
    ),
  },
  draft_email: {
    title: "Email drafted",
    accent: "#BF5AF2",
    icon: (
      // envelope
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </svg>
    ),
  },
  stop_meeting: {
    title: "Meeting stopped",
    accent: "#21B0CF",
    icon: (
      // two people
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
        <circle cx="17" cy="9" r="2.6" />
        <path d="M14.8 14.6a4.8 4.8 0 0 1 6.2 4.6" />
      </svg>
    ),
  },
};

const COUNTER_KINDS = new Set(["increment_counter", "reset_counter", "show_counter"]);

function kindMeta(kind: string) {
  if (COUNTER_KINDS.has(kind)) {
    return {
      title: "Counter",
      accent: "#8E8E93",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3L7 21M17 3l-2 18M4 8.5h17M3 15.5h17" />
        </svg>
      ),
    };
  }
  return (
    KINDS[kind] ?? {
      title: "Done",
      accent: "#30D158",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 12.5l5 5 10-11" />
        </svg>
      ),
    }
  );
}

export default function ActionToast() {
  const [payload, setPayload] = useState<ActionToastPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    dismissTimer.current = null;
    hideTimer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    setExiting(true);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      setExiting(false);
      void getCurrentWindow()
        .hide()
        .catch(() => {});
    }, EXIT_MS);
  }, [clearTimers]);

  const scheduleDismiss = useCallback(
    (delay = AUTO_DISMISS_MS) => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(dismiss, delay);
    },
    [dismiss],
  );

  const show = useCallback(
    (next: ActionToastPayload) => {
      clearTimers();
      setPayload(next);
      setExiting(false);
      setVisible(true);
      scheduleDismiss();
    },
    [clearTimers, scheduleDismiss],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<ActionToastPayload>("show-action-toast", (event) => {
      show(event.payload);
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {
        // Outside Tauri (plain browser preview) there is no event bridge.
      });

    if (import.meta.env.DEV) {
      // Manual trigger for browser-only previews:
      //   __actionToastPreview("stay_awake", "Keeping your Mac awake for 2 hours")
      (window as any).__actionToastPreview = (kind: string, message: string) =>
        show({ kind, message });
    }

    return () => {
      disposed = true;
      unlisten?.();
      clearTimers();
    };
  }, [clearTimers, show]);

  const meta = kindMeta(payload?.kind ?? "");

  return (
    <div className="action-toast-stage">
      <section
        className={`action-toast${visible ? " is-visible" : ""}${exiting ? " is-exiting" : ""}`}
        aria-label="Voice action executed"
        onMouseEnter={clearTimers}
        onMouseLeave={() => scheduleDismiss(1_500)}
      >
        <div className="action-toast-mark" style={{ background: meta.accent }} aria-hidden="true">
          {meta.icon}
        </div>

        <div className="action-toast-copy" role="status" aria-live="polite">
          <strong>{meta.title}</strong>
          <span>{payload?.message ?? ""}</span>
        </div>

        <button
          className="action-toast-close"
          type="button"
          onClick={dismiss}
          title="Dismiss"
          aria-label="Dismiss notification"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </section>
    </div>
  );
}
