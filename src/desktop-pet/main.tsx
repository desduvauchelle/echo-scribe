import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./pet.css";
import { petOutline } from "./outline";

function DesktopPet() {
  const [listening, setListening] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
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
  return <main title="Drag to move. Right-click to hide. Change size in Settings or the right-click menu."
    onContextMenu={event => {
      event.preventDefault();
      if (isTauri()) void invoke("desktop_pet_context_menu").catch(console.error);
    }}>
    <svg ref={svg} viewBox="180 100 900 1080" role="img" aria-label={listening ? "Tucky is listening" : "Tucky squirrel desktop pet"}
      onPointerDown={event => {
        if (event.button === 0 && isTauri()) {
          event.preventDefault();
          void getCurrentWindow().startDragging().catch(console.error);
        }
      }}>
      <defs>
        {/* Silhouette follows the original artwork; no replacement mascot. */}
        <clipPath id="silhouette"><path d={petOutline} /></clipPath>
        {[470, 788].map(cx => <clipPath id={`eye-${cx}`} key={cx}><ellipse cx={cx} cy="505" rx="69" ry="87" /></clipPath>)}
      </defs>
      <g className="pet-body">
        <image href="/mascot/pet-original.png" width="1254" height="1254" clipPath="url(#silhouette)" />
        {[470, 788].map(cx => <g key={cx} clipPath={`url(#eye-${cx})`}>
          <ellipse cx={cx} cy="505" rx="69" ry="87" fill="#fffdfa" />
          <g className="pupil">
            <ellipse cx={cx + 9} cy="522" rx="51" ry="67" fill="#35210c" />
            <ellipse cx={cx - 1} cy="493" rx="17" ry="21" fill="white" />
          </g>
        </g>)}
        <g className={`headphones ${listening ? "headphones-on" : ""}`} aria-hidden="true">
          <path d="M 270 490 C 230 -15 1030 -15 990 490" fill="none" stroke="#302a20" strokeWidth="55" strokeLinecap="round" />
          <path d="M 270 450 C 255 55 1005 55 990 450" fill="none" stroke="#718055" strokeWidth="24" strokeLinecap="round" />
          <rect x="221" y="428" width="110" height="208" rx="47" fill="#302a20" />
          <rect x="240" y="448" width="57" height="164" rx="25" fill="#718055" />
          <rect x="929" y="428" width="110" height="208" rx="47" fill="#302a20" />
          <rect x="963" y="448" width="57" height="164" rx="25" fill="#718055" />
        </g>
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
  </main>;
}

createRoot(document.getElementById("root")!).render(<DesktopPet />);
