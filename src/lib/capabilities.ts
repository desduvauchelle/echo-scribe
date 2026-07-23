import type { PlatformCapabilities } from "./api";

// Conservative defaults: assume nothing is available until the backend answers,
// so we never flash a macOS-only surface on Windows during load.
export const DEFAULT_CAPS: PlatformCapabilities = {
  direct_voice_capture: false,
  local_database: true,
  meeting_auto_detect: false,
  system_audio_capture: false,
  calendar_matching: false,
  screen_recording: false,
  bundle_self_update: false,
};

export type UiGates = {
  showMeetingsNav: boolean;
  showRecordingsNav: boolean;
  showDictation: boolean;
  showSelfUpdate: boolean;
  showSystemAudio: boolean;
  showCalendar: boolean;
};

/** Map raw platform capabilities to UI visibility decisions. Pure — the single
 *  source of truth for what shows on which platform, so gating is testable
 *  without rendering. */
export function uiGates(caps: PlatformCapabilities): UiGates {
  return {
    showMeetingsNav: caps.meeting_auto_detect,
    showRecordingsNav: caps.screen_recording,
    showDictation: caps.direct_voice_capture,
    showSelfUpdate: caps.bundle_self_update,
    showSystemAudio: caps.system_audio_capture,
    showCalendar: caps.calendar_matching,
  };
}
