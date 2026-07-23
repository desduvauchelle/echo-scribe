import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isScreenRecording,
  openScreenrecSetup,
  stopScreenRecording,
} from "./api";
import { useToasts } from "../components/ToastProvider";

export type ScreenRecorder = {
  /** True while a screen recording is in progress. */
  active: boolean;
  /** True while a start/stop request is in flight (button should disable). */
  busy: boolean;
  /** When idle, open the source/audio setup window (the real start happens
   *  there). When active, stop the current recording. */
  toggle: () => Promise<void>;
};

/**
 * Shared state for the screen recorder. Reads the single backend truth
 * (`is_screen_recording`) on mount and stays in sync via the `screenrec-changed`
 * event, so every surface (sidebar, dashboard) agrees. Starting is a two-step
 * flow: `open_screenrec_setup` shows the picker window and the actual capture
 * begins from there — `screenrec-changed` then flips this to active.
 */
export function useScreenRecorder(): ScreenRecorder {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const refreshActive = useCallback(async () => {
    try {
      setActive(await isScreenRecording());
    } catch {
      /* leave the last known state; a later event/remount will correct it */
    }
  }, []);

  useEffect(() => {
    void refreshActive();
    let unlisten: UnlistenFn | undefined;
    void listen("screenrec-changed", () => void refreshActive()).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refreshActive]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (active) {
        await stopScreenRecording();
        // screenrec-changed fires from Rust on stop; refresh reconciles.
        await refreshActive();
      } else {
        // Opens the setup window; capture starts from there and emits
        // screenrec-changed, which flips `active` on.
        await openScreenrecSetup();
      }
    } catch {
      // The backend logs the full technical detail (syscap sidecar). Surface
      // only a short, human message here.
      toasts.push({
        tone: "error",
        message: active
          ? "Couldn't stop the screen recording. See Settings → Diagnostics → logs for details."
          : "Couldn't start screen recording. Check Screen Recording permission in Settings → Diagnostics.",
      });
    } finally {
      setBusy(false);
    }
  }, [active, busy, refreshActive, toasts]);

  return { active, busy, toggle };
}
