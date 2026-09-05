import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { frontendLog, getDashboardStats, isMeetingActive, isScreenRecording } from "../lib/api";
import { countsFromStats, initialLearning, observeCounts, type LearningState } from "../lib/learning";

const KEY = "echo.learning.v1";
function read(): LearningState {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value?.version === 1 && value.counts && Array.isArray(value.earned) && Array.isArray(value.pending))
      return { ...initialLearning(), ...value };
  } catch (e) { frontendLog("warn", `learning: could not restore progress: ${String(e)}`); }
  return initialLearning();
}
type Context = { state: LearningState; busy: boolean; error: boolean; update: (fn: (s: LearningState) => LearningState) => void; refresh: () => void };
const LearningContext = createContext<Context | null>(null);
export function useLearning() { const ctx = useContext(LearningContext); if (!ctx) throw new Error("Learning provider missing"); return ctx; }
export function LearningProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(read);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const captureBusy = useRef(false);
  const processing = useRef(false);
  const inFlight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  const update = useCallback((fn: (s: LearningState) => LearningState) => {
    setState((previous) => {
      const next = fn(previous);
      try { localStorage.setItem(KEY, JSON.stringify(next)); }
      catch (e) { frontendLog("error", `learning: could not save progress: ${String(e)}`); }
      return next;
    });
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    try {
      const [stats, meeting, recording] = await Promise.all([getDashboardStats(), isMeetingActive(), isScreenRecording()]);
      if (!alive.current) return;
      const active = meeting || recording;
      setBusy(captureBusy.current || processing.current || active);
      update((s) => observeCounts(s, countsFromStats(stats)));
      setError(false);
    } catch (e) {
      if (alive.current) setError(true);
      frontendLog("warn", `learning: activity refresh failed: ${String(e)}`);
    } finally {
      inFlight.current = false;
      if (again.current && alive.current) { again.current = false; void refresh(); }
    }
  }, [update]);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const unsubs: (() => void)[] = [];
    const attach = async (event: string, fn: () => void) => {
      const off = await listen(event, fn);
      if (cancelled) off(); else unsubs.push(off);
    };
    void Promise.all([
      (async () => {
        const off = await listen<boolean>("pipeline:busy", ({ payload }) => {
          captureBusy.current = payload; processing.current = payload;
          if (payload) setBusy(true); else void refresh();
        });
        if (cancelled) off(); else unsubs.push(off);
      })(),
      ...["item:created", "app:refresh", "meeting-started", "meeting-status", "meeting-complete", "screenrec-changed"].map((event) => attach(event, () => { void refresh(); })),
      attach("log_capture:recording_started", () => { captureBusy.current = true; setBusy(true); }),
      attach("voice:recording_started", () => { captureBusy.current = true; processing.current = true; setBusy(true); }),
      attach("voice:recording_stopped", () => { captureBusy.current = false; }),
      ...["voice:paste_dispatched", "voice:paste_failed", "voice:recording_cancelled", "asr:error", "recorder:start_failed", "log_capture:cancelled", "log_capture:classification_ready", "log_capture:auto_filed"].map((event) => attach(event, () => { captureBusy.current = false; processing.current = false; void refresh(); })),
    ]).catch((e) => frontendLog("error", `learning: listeners failed: ${String(e)}`));
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; alive.current = false; unsubs.forEach((fn) => fn()); clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [refresh]);
  return <LearningContext.Provider value={{ state, busy, error, update, refresh: () => void refresh() }}>{children}</LearningContext.Provider>;
}
