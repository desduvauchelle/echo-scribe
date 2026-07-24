import type { PlatformCapabilities } from "./api";

// Conservative defaults: assume nothing is available until the backend answers,
// so we never flash a macOS-only surface on Windows during load.
export const DEFAULT_CAPS: PlatformCapabilities = {
  direct_voice_capture: false,
  local_database: true,
  meeting_auto_detect: false,
  system_audio_capture: false,
  screen_recording: false,
  bundle_self_update: false,
};

export type UiGates = {
  showMeetingsNav: boolean;
  showRecordingsNav: boolean;
  showSelfUpdate: boolean;
  showSystemAudio: boolean;
  showDrive: boolean;
  showNativePermissions: boolean;
  showMeetingRecord: boolean;
};

/** Map raw platform capabilities to UI visibility decisions. Pure — the single
 *  source of truth for what shows on which platform, so gating is testable
 *  without rendering. */
export function uiGates(caps: PlatformCapabilities): UiGates {
  return {
    showMeetingsNav: caps.meeting_auto_detect,
    showRecordingsNav: caps.screen_recording,
    showSelfUpdate: caps.bundle_self_update,
    showSystemAudio: caps.system_audio_capture,
    // Google Drive upload targets screen recordings, so it needs the same gate.
    showDrive: caps.screen_recording,
    // No individual capability maps to "macOS TCC permissions panel" — this is
    // a macOS-only-world proxy: true iff any of the three macOS-only
    // capabilities is present, which today only happens on macOS.
    showNativePermissions:
      caps.screen_recording || caps.system_audio_capture,
    // The sidebar Record button captures system audio + mic as a meeting, so it
    // needs the same macOS-only system-audio capability (hidden on Windows).
    showMeetingRecord: caps.system_audio_capture,
  };
}
