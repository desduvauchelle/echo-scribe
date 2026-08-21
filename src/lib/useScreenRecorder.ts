import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
    } catch (e) {
      // The backend logs the full technical detail (syscap sidecar). Surface
      // only a short, human message here. The zero-frame stop path returns a
      // purpose-built friendly message (stop_screen_recording_inner in
      // commands.rs) — show that one verbatim instead of the generic fallback.
      // That one arrives already-composed from Rust, so it stays English until
      // the backend learns the app language (see the i18n notes in CLAUDE.md).
      const msg = String(e);
      toasts.push({
        tone: "error",
        message: msg.startsWith("Nothing was captured")
          ? msg
          : active
            ? t("screenRecordButton.stopFailed")
            : t("screenRecordButton.startFailed"),
      });
    } finally {
      setBusy(false);
    }
  }, [active, busy, refreshActive, toasts, t]);

  return { active, busy, toggle };
}
