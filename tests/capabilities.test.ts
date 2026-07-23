import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPS, uiGates } from "../src/lib/capabilities";
import type { PlatformCapabilities } from "../src/lib/api";

const windowsCaps: PlatformCapabilities = {
  direct_voice_capture: true,
  local_database: true,
  meeting_auto_detect: false,
  system_audio_capture: false,
  calendar_matching: false,
  screen_recording: false,
  bundle_self_update: false,
};

const macCaps: PlatformCapabilities = {
  direct_voice_capture: true,
  local_database: true,
  meeting_auto_detect: true,
  system_audio_capture: true,
  calendar_matching: true,
  screen_recording: true,
  bundle_self_update: true,
};

describe("uiGates", () => {
  test("Windows caps hide macOS-only surfaces but keep dictation", () => {
    const g = uiGates(windowsCaps);
    expect(g.showDictation).toBe(true);
    expect(g.showMeetingsNav).toBe(false);
    expect(g.showRecordingsNav).toBe(false);
    expect(g.showSelfUpdate).toBe(false);
    expect(g.showSystemAudio).toBe(false);
    expect(g.showCalendar).toBe(false);
  });

  test("macOS caps show everything", () => {
    const g = uiGates(macCaps);
    expect(g.showDictation).toBe(true);
    expect(g.showMeetingsNav).toBe(true);
    expect(g.showRecordingsNav).toBe(true);
    expect(g.showSelfUpdate).toBe(true);
  });

  test("DEFAULT_CAPS is conservative (nothing but local_database)", () => {
    expect(DEFAULT_CAPS.local_database).toBe(true);
    expect(DEFAULT_CAPS.direct_voice_capture).toBe(false);
    expect(DEFAULT_CAPS.screen_recording).toBe(false);
    expect(uiGates(DEFAULT_CAPS).showMeetingsNav).toBe(false);
  });
});

// A stale saved section must not render a gated view. The route guard uses the
// same gate flags, so assert the flags a Windows build would see.
describe("route gating flags", () => {
  test("Windows hides meetings + recordings routes", () => {
    const g = uiGates(windowsCaps);
    expect(g.showMeetingsNav).toBe(false);
    expect(g.showRecordingsNav).toBe(false);
  });
});
