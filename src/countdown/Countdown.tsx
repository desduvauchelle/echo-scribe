import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelCountdown, finishCountdown } from "../lib/api";
import { currentTick, secondsSequence } from "../lib/countdown";

type StartPayload = { seconds: number };

const TICK_MS = 1000;

/**
 * Small frameless, transparent, always-on-top overlay shown centered on the
 * target display before a recording starts. Ticks 3→2→1 (~1s each) — this
 * page is the SINGLE clock for the countdown's duration. When the tick
 * sequence runs out, it calls `finishCountdown()`, which the Rust side
 * forwards to the setup window as `countdown-finished`; the setup window
 * starts recording ONLY on receiving that event, never from a timer of its
 * own. (Previously the setup window ran a second, independent
 * `setTimeout` of the same nominal duration — a late Esc could race it and
 * start recording anyway. Single event-driven clock removes that race.)
 *
 * Esc calls `cancelCountdown`, which the Rust side handles by hiding this
 * window AND re-showing the setup window — this page does not need to
 * track "did the user cancel" beyond firing that one call (and not also
 * firing `finishCountdown` — see the guard below).
 */
const Countdown: React.FC = () => {
  const [sequence, setSequence] = useState<number[]>([]);
  const [ticksElapsed, setTicksElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set once this run's countdown has ended (cancelled OR finished) so a
  // stray timer callback can never fire both `cancelCountdown` and
  // `finishCountdown` for the same run.
  const endedRef = useRef(false);

  const clearTimer = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  useEffect(() => {
    let unlistenStart: (() => void) | undefined;
    let unlistenStop: (() => void) | undefined;

    (async () => {
      unlistenStart = await listen<StartPayload>("countdown-start", (event) => {
        clearTimer();
        endedRef.current = false;
        const seq = secondsSequence(event.payload?.seconds ?? 0);
        setSequence(seq);
        setTicksElapsed(0);
        if (seq.length === 0) return;
        intervalRef.current = setInterval(() => {
          setTicksElapsed((t) => t + 1);
        }, TICK_MS);
      });
      unlistenStop = await listen("countdown-stop", () => {
        clearTimer();
        endedRef.current = true;
        setSequence([]);
        setTicksElapsed(0);
      });
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        clearTimer();
        if (endedRef.current) return;
        endedRef.current = true;
        void cancelCountdown();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      unlistenStart?.();
      unlistenStop?.();
      window.removeEventListener("keydown", onKeyDown);
      clearTimer();
    };
  }, []);

  // Once ticksElapsed runs past the sequence, stop the interval and tell
  // the setup window the countdown is done — cancel-wins: if Esc already
  // fired `cancelCountdown` for this run, `endedRef` is already true and
  // `finishCountdown` must NOT also fire.
  useEffect(() => {
    if (sequence.length > 0 && ticksElapsed >= sequence.length) {
      clearTimer();
      if (endedRef.current) return;
      endedRef.current = true;
      void finishCountdown();
    }
  }, [sequence, ticksElapsed]);

  const tick = currentTick(sequence, ticksElapsed);

  if (tick === null) return <div style={styles.root} />;

  return (
    <div style={styles.root}>
      <div style={styles.number} role="timer" aria-live="assertive">
        {tick}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  number: {
    fontSize: 96,
    fontWeight: 700,
    color: "#fff",
    fontFamily: "-apple-system, system-ui, sans-serif",
    textShadow: "0 4px 24px rgba(0,0,0,0.5)",
    // Simple pill backdrop so the number reads on any wallpaper.
    background: "rgba(20, 20, 20, 0.55)",
    borderRadius: "50%",
    width: 160,
    height: 160,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};

export default Countdown;
