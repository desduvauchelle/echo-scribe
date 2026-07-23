import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isMeetingActive, startMeetingManual, stopMeeting } from "./api";
import { nextRecorderAction } from "./meetingRecorder";
import { useToasts } from "../components/ToastProvider";

export type MeetingRecorder = {
  /** True while a meeting is being recorded. */
  active: boolean;
  /** True while a start/stop request is in flight (button should disable). */
  busy: boolean;
  /** Start a recording if idle, stop it if active. */
  toggle: () => Promise<void>;
};

/**
 * Shared state for the manual meeting recorder. Reads the single backend truth
 * (`is_meeting_active`) on mount and stays in sync via the `meeting-*` events,
 * so any surface using this hook agrees with the Meetings tab and the recording
 * overlay. Toggling starts/stops the same recorder those surfaces use.
 */
export function useMeetingRecorder(): MeetingRecorder {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();

  const refreshActive = useCallback(async () => {
    try {
      setActive(await isMeetingActive());
    } catch {
      /* leave the last known state; a later event/remount will correct it */
    }
  }, []);

  useEffect(() => {
    void refreshActive();
    let unsubs: UnlistenFn[] = [];
    void Promise.all([
      listen("meeting-started", () => void refreshActive()),
      listen("meeting-status", () => void refreshActive()),
      listen("meeting-complete", () => void refreshActive()),
    ]).then((fns) => {
      unsubs = fns;
    });
    return () => {
      unsubs.forEach((f) => f());
    };
  }, [refreshActive]);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const action = nextRecorderAction(active);
    try {
      if (action === "stop") {
        await stopMeeting();
      } else {
        await startMeetingManual();
      }
      await refreshActive();
    } catch {
      // The backend logs the full technical detail (MeetingManager / syscap).
      // Surface only a short, human message here.
      toasts.push({
        tone: "error",
        message:
          action === "start"
            ? "Couldn't start recording. Check Screen Recording permission in Settings → Diagnostics."
            : "Couldn't stop recording. See Settings → Diagnostics → logs for details.",
      });
    } finally {
      setBusy(false);
    }
  }, [active, busy, refreshActive, toasts]);

  return { active, busy, toggle };
}
