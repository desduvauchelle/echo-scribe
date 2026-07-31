import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sidecarSource = readFileSync(
  new URL("../src-tauri/screenrec/main.swift", import.meta.url),
  "utf8",
);

describe("screen recording system audio", () => {
  test("window recordings capture system audio through a display-wide stream", () => {
    // A desktopIndependentWindow filter limits audio to the selected app. Audio
    // spoken by macOS VoiceOver (or any other process) therefore arrives as
    // silence unless window video and system audio use separate SCStreams.
    expect(sidecarSource).toContain("var separateSystemAudioFilter: SCContentFilter?");
    expect(sidecarSource).toContain("separateSystemAudioFilter = systemAudioFilter(");
    expect(sidecarSource).toContain("cfg.capturesAudio = sysOn && separateSystemAudioFilter == nil");
    expect(sidecarSource).toContain("rec.systemAudioStream = SCStream(");
  });
});
