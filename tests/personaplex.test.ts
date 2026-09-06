import { describe, expect, test } from "bun:test";
import {
  appendTranscriptPiece,
  estimateSpmTokens,
  initialSessionState,
  micSeemsSilent,
  pushLogLine,
  reduceSessionEvent,
  resolveMicChoice,
  sessionIsActive,
  startingSessionState,
} from "../src/lib/personaplex";

describe("appendTranscriptPiece", () => {
  test("drops the leading space of the very first piece", () => {
    expect(appendTranscriptPiece("", " Hello")).toBe("Hello");
  });
  test("keeps SentencePiece word boundaries", () => {
    let t = "";
    for (const p of [" Hello", ",", " how", " are", " you", "?"]) t = appendTranscriptPiece(t, p);
    expect(t).toBe("Hello, how are you?");
  });
  test("never doubles spaces", () => {
    expect(appendTranscriptPiece("Hi ", " there")).toBe("Hi there");
  });
});

describe("reduceSessionEvent", () => {
  test("walks starting → loading → warming → ready", () => {
    let s = startingSessionState();
    s = reduceSessionEvent(s, { event: "hello", version: "0.1.0" });
    expect(s.phase).toBe("loading");
    s = reduceSessionEvent(s, { event: "loading", fraction: 0.4, status: "Loading model weights..." });
    expect(s.loadFraction).toBe(0.4);
    expect(s.loadStatus).toBe("Loading model weights...");
    s = reduceSessionEvent(s, { event: "warming" });
    expect(s.phase).toBe("warming");
    s = reduceSessionEvent(s, { event: "ready", load_secs: 9.5, warm_secs: 3.1 });
    expect(s.phase).toBe("ready");
    expect(s.loadSecs).toBe(9.5);
    expect(s.warmSecs).toBe(3.1);
  });

  test("accumulates transcript, levels and stats", () => {
    let s = { ...initialSessionState, phase: "ready" as const };
    s = reduceSessionEvent(s, { event: "text", text: " Hi" });
    s = reduceSessionEvent(s, { event: "text", text: " there" });
    expect(s.transcript).toBe("Hi there");
    s = reduceSessionEvent(s, { event: "level", mic: 0.2, agent: 0.05 });
    expect(s.micLevel).toBe(0.2);
    s = reduceSessionEvent(s, { event: "stats", step: 50, ms_per_step: 71.2, underruns: 1 });
    expect(s.step).toBe(50);
    expect(s.msPerStep).toBe(71.2);
    expect(s.underruns).toBe(1);
  });

  test("a clean stop returns to idle", () => {
    let s = { ...initialSessionState, phase: "ready" as const, micLevel: 0.3 };
    s = reduceSessionEvent(s, { event: "stopped", reason: "stop-command", steps: 120 });
    expect(s.phase).toBe("stopping");
    expect(s.micLevel).toBe(0);
    s = reduceSessionEvent(s, { event: "exited", code: 0 });
    expect(s.phase).toBe("idle");
    expect(s.error).toBeNull();
  });

  test("an error sticks through stopped/exited", () => {
    let s = { ...initialSessionState, phase: "loading" as const };
    s = reduceSessionEvent(s, { event: "error", msg: "model load failed: cache miss" });
    expect(s.phase).toBe("error");
    s = reduceSessionEvent(s, { event: "stopped", reason: "error" });
    s = reduceSessionEvent(s, { event: "exited", code: 2 });
    expect(s.phase).toBe("error");
    expect(s.error).toContain("cache miss");
    expect(s.exitCode).toBe(2);
  });

  test("a crash without an error event still surfaces", () => {
    let s = { ...initialSessionState, phase: "ready" as const };
    s = reduceSessionEvent(s, { event: "exited", code: 139 });
    expect(s.phase).toBe("error");
    expect(s.error).toContain("139");
  });

  test("ignores cosmetic events", () => {
    const s = { ...initialSessionState, phase: "ready" as const };
    expect(reduceSessionEvent(s, { event: "stderr", line: "x" })).toBe(s);
    expect(reduceSessionEvent(s, { event: "log", level: "info", msg: "x" })).toBe(s);
  });
});

describe("helpers", () => {
  test("sessionIsActive", () => {
    expect(sessionIsActive("idle")).toBe(false);
    expect(sessionIsActive("error")).toBe(false);
    expect(sessionIsActive("ready")).toBe(true);
    expect(sessionIsActive("stopping")).toBe(true);
  });
  test("pushLogLine caps the buffer", () => {
    let lines: string[] = [];
    for (let i = 0; i < 10; i++) lines = pushLogLine(lines, `l${i}`, 4);
    expect(lines).toEqual(["l6", "l7", "l8", "l9"]);
  });
});

describe("diagnostics", () => {
  test("ready records prompt tokens; stats track mic silence and lag", () => {
    let s = reduceSessionEvent(startingSessionState(), { event: "ready", prompt_tokens: 212 });
    expect(s.promptTokens).toBe(212);
    expect(micSeemsSilent(s)).toBe(false);
    for (let i = 0; i < 3; i++) {
      s = reduceSessionEvent(s, { event: "stats", step: 25 * (i + 1), ms_per_step: 80, mic_peak: 0.001, mic_active_pct: 0, mic_buffer_ms: 640, queued_frames: 9 });
    }
    expect(s.silentWindows).toBe(3);
    expect(micSeemsSilent(s)).toBe(true);
    expect(s.micBufferMs).toBe(640);
    expect(s.queuedFrames).toBe(9);
    s = reduceSessionEvent(s, { event: "stats", step: 100, ms_per_step: 80, mic_peak: 0.2, mic_active_pct: 40 });
    expect(s.silentWindows).toBe(0);
    expect(micSeemsSilent(s)).toBe(false);
  });
  test("estimateSpmTokens mirrors the backend heuristic", () => {
    expect(estimateSpmTokens("")).toBe(0);
    expect(estimateSpmTokens("a".repeat(35))).toBe(10);
  });
});

describe("microphone choice", () => {
  test("ready records the live mic name", () => {
    const s = reduceSessionEvent(startingSessionState(), { event: "ready", mic: "Scarlett 2i2" });
    expect(s.micName).toBe("Scarlett 2i2");
    expect(reduceSessionEvent(startingSessionState(), { event: "ready" }).micName).toBeNull();
  });
  test("resolveMicChoice maps the three modes", () => {
    expect(resolveMicChoice("default", "AirPods")).toBeNull();
    expect(resolveMicChoice("dictation", "AirPods")).toBe("AirPods");
    expect(resolveMicChoice("dictation", null)).toBeNull();
    expect(resolveMicChoice({ uid: "BuiltInMicrophoneDevice" }, "AirPods")).toBe("BuiltInMicrophoneDevice");
  });
});
