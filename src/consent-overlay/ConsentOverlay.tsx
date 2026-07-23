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
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  // Latest payload in a ref so the once-bound window focus/blur handlers can
  // check whether the overlay is still showing before re-arming the timer.
  const payloadRef = useRef<ConsentPayload | null>(null);
  payloadRef.current = payload;

  const clearDismissTimer = () => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  // (Re)arm the auto-dismiss timeout. Paused while the user is hovering or
  // focusing the overlay (WCAG 2.2.1 — timing adjustable) and re-armed with
  // the full window on mouseleave/blur.
  const startDismissTimer = () => {
    clearDismissTimer();
    dismissTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      // Tell Rust side to hide window after fade.
      window.setTimeout(() => {
        setPayload(null);
      }, 200);
    }, AUTO_DISMISS_MS);
  };

  useEffect(() => {
    const unlistenPromise = listen<ConsentPayload>("show-consent", (event) => {
      setPayload(event.payload);
      // Trigger fade-in on the next frame; move focus to the primary action
      // so keyboard users can respond immediately.
      requestAnimationFrame(() => {
        setIsVisible(true);
        primaryButtonRef.current?.focus();
      });
      // Reset auto-dismiss timer.
      startDismissTimer();
    });
    // Pause the auto-dismiss while the window itself has keyboard focus, and
    // re-arm the full window when it loses it (mirrors the hover handlers on
    // the root element below).
    const onWindowFocus = () => clearDismissTimer();
    const onWindowBlur = () => {
      if (payloadRef.current) startDismissTimer();
    };
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      unlistenPromise.then((fn) => fn());
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      clearDismissTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (decision: "once" | "always" | "never") => {
    if (!payload) return;
    clearDismissTimer();
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
      void invoke("hide_consent_overlay").catch(() => {});
    }, 200);
  };

  if (!payload) return null;

  return (
    <div
      className={`consent-overlay${isVisible ? " visible" : ""}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      aria-describedby="consent-subtitle"
      onMouseEnter={clearDismissTimer}
      onMouseLeave={() => {
        if (payloadRef.current) startDismissTimer();
      }}
    >
      <div>
        <div className="consent-title" id="consent-title">
          {payload.app_name} detected
        </div>
        <div className="consent-subtitle" id="consent-subtitle">
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
          ref={primaryButtonRef}
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
