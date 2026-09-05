// Pure state for the PersonaPlex beta page (Settings → Beta). i18n-free and
// DOM-free so `bun test` can exercise the event → state mapping without
// rendering anything.

import type { PersonaplexEvent } from "./api";

export type PersonaplexPhase =
  | "idle"
  | "starting"
  | "loading"
  | "warming"
  | "ready"
  | "stopping"
  | "error";

export type PersonaplexSessionState = {
  phase: PersonaplexPhase;
  loadFraction: number;
  loadStatus: string;
  transcript: string;
  micLevel: number;
  agentLevel: number;
  step: number;
  msPerStep: number | null;
  underruns: number;
  loadSecs: number | null;
  warmSecs: number | null;
  error: string | null;
  stopReason: string | null;
  exitCode: number | null;
};

export const initialSessionState: PersonaplexSessionState = {
  phase: "idle",
  loadFraction: 0,
  loadStatus: "",
  transcript: "",
  micLevel: 0,
  agentLevel: 0,
  step: 0,
  msPerStep: null,
  underruns: 0,
  loadSecs: null,
  warmSecs: null,
  error: null,
  stopReason: null,
  exitCode: null,
};

/** Fresh state for a session that was just requested (keeps nothing). */
export function startingSessionState(): PersonaplexSessionState {
  return { ...initialSessionState, phase: "starting" };
}

/** Append one SentencePiece piece. Pieces carry their own leading space
 *  ("▁hello" → " hello"), so this is concatenation plus tidy-ups: no leading
 *  space at the very start, no doubled spaces. */
export function appendTranscriptPiece(transcript: string, piece: string): string {
  if (!piece) return transcript;
  if (transcript.length === 0) return piece.replace(/^\s+/, "");
  if (transcript.endsWith(" ") && piece.startsWith(" ")) {
    return transcript + piece.replace(/^\s+/, "");
  }
  return transcript + piece;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Fold one sidecar event into the session state. Unknown / cosmetic events
 *  (`log`, `stderr`, `hello`) leave the state untouched. */
export function reduceSessionEvent(
  state: PersonaplexSessionState,
  ev: PersonaplexEvent,
): PersonaplexSessionState {
  switch (ev.event) {
    case "hello":
      return state.phase === "starting" ? { ...state, phase: "loading" } : state;
    case "loading":
      return {
        ...state,
        phase: state.phase === "error" ? state.phase : "loading",
        loadFraction: Math.min(1, Math.max(0, num(ev.fraction))),
        loadStatus: str(ev.status),
      };
    case "warming":
      return { ...state, phase: "warming", loadFraction: 1 };
    case "ready":
      return {
        ...state,
        phase: "ready",
        loadFraction: 1,
        loadSecs: num(ev.load_secs, 0),
        warmSecs: num(ev.warm_secs, 0),
      };
    case "text":
      return {
        ...state,
        transcript: appendTranscriptPiece(state.transcript, str(ev.text)),
      };
    case "level":
      return { ...state, micLevel: num(ev.mic), agentLevel: num(ev.agent) };
    case "stats":
      return {
        ...state,
        step: num(ev.step),
        msPerStep: num(ev.ms_per_step, 0),
        underruns: num(ev.underruns),
      };
    case "error":
      return { ...state, phase: "error", error: str(ev.msg) || "unknown error" };
    case "stopped":
      return {
        ...state,
        stopReason: str(ev.reason) || null,
        phase: state.phase === "error" ? "error" : "stopping",
        micLevel: 0,
        agentLevel: 0,
      };
    case "exited": {
      const code = typeof ev.code === "number" ? ev.code : null;
      const failed = state.phase === "error" || (code !== null && code !== 0);
      return {
        ...state,
        phase: failed ? "error" : "idle",
        exitCode: code,
        micLevel: 0,
        agentLevel: 0,
        error:
          failed && !state.error
            ? `sidecar exited with code ${code ?? "?"}`
            : state.error,
      };
    }
    default:
      return state;
  }
}

/** True while a Stop button makes sense (process is alive or winding down). */
export function sessionIsActive(phase: PersonaplexPhase): boolean {
  return (
    phase === "starting" ||
    phase === "loading" ||
    phase === "warming" ||
    phase === "ready" ||
    phase === "stopping"
  );
}

/** Persona prompt presets. These are MODEL inputs (PersonaPlex is English
 *  only), not UI copy — deliberately untranslated. */
export const PERSONA_PRESETS: { id: string; label: string; prompt: string }[] = [
  {
    id: "assistant",
    label: "Assistant",
    prompt:
      "You are a helpful assistant. Answer questions clearly and concisely. Listen carefully to what the user says, then respond directly to their question or request. Stay on topic. Be concise.",
  },
  {
    id: "casual",
    label: "Casual chat",
    prompt:
      "You enjoy having a good conversation. Be warm, curious and playful. Keep your replies short and ask follow-up questions.",
  },
  {
    id: "support",
    label: "Customer support",
    prompt:
      "You are a customer service representative for a software company. Be polite, professional and helpful. Ask clarifying questions when needed and keep every answer short.",
  },
];

/** 80 ms per step is the real-time budget (12.5 Hz frames). */
export const REALTIME_BUDGET_MS = 80;

/** Keep the last `max` lines of a growing log. */
export function pushLogLine(lines: string[], line: string, max = 300): string[] {
  const next = lines.length >= max ? lines.slice(lines.length - max + 1) : lines.slice();
  next.push(line);
  return next;
}
