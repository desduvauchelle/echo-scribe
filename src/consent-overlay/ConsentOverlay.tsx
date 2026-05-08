import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useRef, useState } from "react";
import "./ConsentOverlay.css";

type ConsentPayload = { bundle_id: string; app_name: string };

const AUTO_DISMISS_MS = 30_000;

const ConsentOverlay: React.FC = () => {
  const [payload, setPayload] = useState<ConsentPayload | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unlistenPromise = listen<ConsentPayload>("show-consent", (event) => {
      setPayload(event.payload);
      // Trigger fade-in on the next frame.
      requestAnimationFrame(() => setIsVisible(true));
      // Reset auto-dismiss timer.
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
      dismissTimerRef.current = window.setTimeout(() => {
        setIsVisible(false);
        // Tell Rust side to hide window after fade.
        window.setTimeout(() => {
          setPayload(null);
        }, 200);
      }, AUTO_DISMISS_MS);
    });
    return () => {
      unlistenPromise.then((fn) => fn());
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const decide = async (decision: "once" | "always" | "never") => {
    if (!payload) return;
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setIsVisible(false);
    try {
      await invoke("meeting_consent", {
        bundleId: payload.bundle_id,
        appName: payload.app_name,
        decision,
      });
    } catch (e) {
      console.error("meeting_consent failed", e);
    }
    // Hide the overlay window itself once the decision is dispatched.
    window.setTimeout(() => {
      setPayload(null);
      void invoke("hide_consent_overlay").catch(() => {
        // Command may not exist yet; the Rust side hides the window in
        // task 7 via the dispatcher. Best-effort.
      });
    }, 200);
  };

  if (!payload) return null;

  return (
    <div className={`consent-overlay${isVisible ? " visible" : ""}`}>
      <div>
        <div className="consent-title">{payload.app_name} detected</div>
        <div className="consent-subtitle">
          Record this meeting? Audio stays on your device.
        </div>
      </div>
      <div className="consent-actions">
        <button
          className="consent-btn consent-btn-muted"
          onClick={() => decide("never")}
        >
          Don't record
        </button>
        <button
          className="consent-btn consent-btn-secondary"
          onClick={() => decide("always")}
        >
          Always
        </button>
        <button
          className="consent-btn consent-btn-primary"
          onClick={() => decide("once")}
        >
          Record
        </button>
      </div>
    </div>
  );
};

export default ConsentOverlay;
