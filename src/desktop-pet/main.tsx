import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./pet.css";
import { TuckyArtwork } from "./TuckyArtwork";
import { listen } from "@tauri-apps/api/event";

const states = {
  idle: ["Standby", "Ready when you are. A blink, a sniff, and a curious gaze."],
  listening: ["Listening", "Headphones on, pen in paw. Tucky is taking notes."],
  thinking: ["Thinking", "A finger to his chin while Tucky considers your words."],
  paused: ["Paused", "Headphones stay on; the meter is quiet."],
  attention: ["Needs attention", "A raised eyebrow and a small paw gesture, then stillness."],
  saved: ["Saved", "Tucky puts a piece of paper into his pouch."],
  completed: ["Task completed", "Done! Tucky tears the finished task into two pieces."],
  cancelled: ["Cancelled", "A quiet blink, then back to standby."],
  failed: ["Failed", "A concerned expression, then a request for attention."],
} as const;
type PetAnimation = keyof typeof states;
const temporaryStates = new Set<PetAnimation>(["saved", "completed", "cancelled", "failed"]);

function DesktopPet() {
  const [listening, setListening] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const [reaction, setReaction] = useState<{ kind: PetAnimation; id: number }>({ kind: "idle", id: 0 });
  const preview = !isTauri() && new URLSearchParams(location.search).has("preview");
  const react = (kind: PetAnimation) => setReaction(previous => ({ kind, id: previous.id + 1 }));
  useEffect(() => {
    if (!temporaryStates.has(reaction.kind)) return;
    const timeout = setTimeout(() => setReaction(previous => ({ ...previous, kind: previous.kind === "failed" ? "attention" : "idle" })), 2200);
    return () => clearTimeout(timeout);
  }, [reaction]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const subscribe = async (event: string, callback: (event: { payload: unknown }) => void) => {
      const unlisten = await listen(event, callback);
      if (disposed) unlisten(); else cleanups.push(unlisten);
    };
    void Promise.all([
      subscribe("log_capture:auto_filed", () => react("saved")),
      subscribe("voice:paste_dispatched", () => react("saved")),
      subscribe("meeting-complete", () => react("saved")),
      subscribe("voice:recording_stopped", () => react("thinking")),
      subscribe("show-overlay", ({ payload }) => {
        const mode = typeof payload === "string" ? payload : (payload as { mode?: string } | null)?.mode;
        if (mode === "transcribing" || mode === "processing") react("thinking");
      }),
      subscribe("hide-overlay", () => setReaction(previous => previous.kind === "thinking" ? { kind: "idle", id: previous.id + 1 } : previous)),
      ...["voice:recording_started", "log_capture:recording_started"].map(event => subscribe(event, () => react("idle"))),
      ...["voice:paste_failed", "asr:error", "recorder:start_failed", "edit:failed", "format:failed"].map(event => subscribe(event, () => react("failed"))),
      ...["voice:recording_cancelled", "log_capture:cancelled"].map(event => subscribe(event, () => react("cancelled"))),
    ]).catch(console.error);
    return () => { disposed = true; cleanups.forEach(cleanup => cleanup()); };
  }, []);
  const mode: PetAnimation = listening ? "listening" : reaction.kind;
  const headphones = listening || mode === "paused";
  const [earTwitch, setEarTwitch] = useState<"left" | "right" | null>(null);
  useEffect(() => {
    setEarTwitch(null);
    if (mode !== "idle") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout>;
    let settle: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (!reduced.matches && !document.hidden) {
          setEarTwitch(Math.random() < 0.5 ? "left" : "right");
          settle = setTimeout(() => setEarTwitch(null), 650);
        }
        schedule();
      }, 6000 + Math.random() * 10000);
    };
    schedule();
    return () => { clearTimeout(timer); clearTimeout(settle); };
  }, [mode]);
  const previousListening = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const look = (x: number, y: number) => {
      const bounds = svg.current?.getBoundingClientRect();
      if (!bounds || reduced.matches) return;
      const dx = x - bounds.left - bounds.width / 2;
      const dy = y - bounds.top - bounds.height * 0.4;
      const distance = Math.max(100, Math.hypot(dx, dy));
      svg.current?.style.setProperty("--eye-x", `${dx / distance * 22}px`);
      svg.current?.style.setProperty("--eye-y", `${dy / distance * 17}px`);
    };
    const poll = async () => {
      try {
        const state = await invoke<{ pointer: [number, number] | null; listening: boolean; levels: number[] }>("desktop_pet_state");
        if (!stopped) {
          setListening(state.listening);
          if (state.listening && !previousListening.current) react("idle");
          previousListening.current = state.listening;
          setLevels(previous => previous.map((v, i) => {
            const next = state.listening ? Math.max(0, Math.min(1, state.levels?.[i] || 0)) : 0;
            return next === 0 ? 0 : v * 0.7 + next * 0.3;
          }));
          if (state.pointer) look(...state.pointer);
        }
      } catch {
        // Leave the original forward gaze if the platform cannot read the cursor.
      }
      if (!stopped) timer = setTimeout(poll, 80);
    };
    const move = (event: PointerEvent) => look(event.clientX, event.clientY);
    if (isTauri()) void poll();
    else window.addEventListener("pointermove", move);
    const reset = () => {
      svg.current?.style.setProperty("--eye-x", "0px");
      svg.current?.style.setProperty("--eye-y", "0px");
    };
    reduced.addEventListener("change", reset);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      reduced.removeEventListener("change", reset);
    };
  }, []);
  return <><main className={preview ? "preview-mode" : undefined} title="Drag to move. Right-click to hide. Change size in Settings or the right-click menu."
    onContextMenu={event => {
      event.preventDefault();
      if (isTauri()) void invoke("desktop_pet_context_menu").catch(console.error);
    }}>
    <svg ref={svg} data-ear-twitch={mode === "idle" ? earTwitch : undefined} viewBox="180 100 900 1080" role="img" aria-label={`Tucky: ${states[mode][0]}`}
      onPointerDown={event => {
        if (event.button === 0 && isTauri()) {
          event.preventDefault();
          void getCurrentWindow().startDragging().catch(console.error);
        }
      }}>
      <defs>
        {[470, 788].map(cx => <clipPath id={`eye-${cx}`} key={cx}><ellipse cx={cx} cy="509" rx="69" ry="94" /></clipPath>)}
      </defs>
      <g className={`pet-body reaction-${mode}`} key={reaction.id}>
        <TuckyArtwork />
        <g className={`headphones ${headphones ? "headphones-on" : ""}`} aria-hidden="true">
          <path d="M 345 330 C 315 60 940 60 910 330" fill="none" stroke="#302a20" strokeWidth="55" strokeLinecap="round" />
          <path d="M 345 310 C 335 100 920 100 910 310" fill="none" stroke="#718055" strokeWidth="24" strokeLinecap="round" />
          <rect x="293" y="282" width="100" height="158" rx="42" fill="#302a20" />
          <rect x="309" y="298" width="55" height="126" rx="25" fill="#718055" />
          <rect x="860" y="282" width="100" height="158" rx="42" fill="#302a20" />
          <rect x="889" y="298" width="55" height="126" rx="25" fill="#718055" />
        </g>
      </g>
      <g className={`pet-indicator indicator-${mode}`} aria-hidden="true">
        {mode === "paused" && <><circle cx="958" cy="1000" r="60" fill="#fff0d5" stroke="#718055" strokeWidth="10"/><path d="M940 974V1026M976 974V1026" stroke="#4c5640" strokeWidth="14" strokeLinecap="round"/></>}
        {(mode === "attention" || mode === "failed") && <><circle cx="958" cy="1000" r="60" fill="#fff0d5" stroke="#ae7133" strokeWidth="10"/><path d="M958 967V1003M958 1026V1028" stroke="#805321" strokeWidth="13" strokeLinecap="round"/></>}
        {mode === "thinking" && [0, 1, 2].map(i => <circle className="thinking-dot" key={i} cx={575+i*50} cy="114" r="11" fill="#718055" style={{animationDelay: `${i*180}ms`}}/>)}
      </g>
    </svg>
    <div className="pet-meter-slot">
      {listening && <div className="pet-meter" role="meter" aria-label="Microphone input"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.max(...levels) * 100)}>
        {levels.map((v, i) => <span key={i} style={{
          height: `${Math.min(14, 2 + Math.pow(v, 0.7) * 12)}px`,
          opacity: Math.max(0.25, Math.min(1, v * 1.7)),
        }} />)}
      </div>}
    </div>
  </main>{preview && <section className="pet-preview" aria-label="Animation preview">
    <header><strong aria-live="polite">{states[mode][0]}</strong><p>{states[mode][1]}</p></header>
    <nav aria-label="Choose a state">{(Object.keys(states) as PetAnimation[]).map(kind => <button key={kind} aria-pressed={mode === kind} onClick={() => {
      setListening(kind === "listening");
      setLevels(Array(16).fill(0));
      react(kind === "listening" ? "idle" : kind);
    }}>{states[kind][0]}</button>)}</nav>
    <small>Reactions return to standby. Failed settles into needs attention. Listening uses a quiet meter in this preview.</small>
  </section>}</>;

}

createRoot(document.getElementById("root")!).render(<DesktopPet />);
