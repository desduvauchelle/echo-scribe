import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelCountdown } from "../lib/api";
import { currentTick, secondsSequence } from "../lib/countdown";

type StartPayload = { seconds: number };

const TICK_MS = 1000;

/**
 * Small frameless, transparent, always-on-top overlay shown centered on the
 * target display before a recording starts. Ticks 3→2→1 (~1s each) then
 * emits nothing further — the setup window (which owns the actual
 * `startScreenRecording` call) is driven by its own local `setTimeout`
 * chain / promise, NOT by an event from this page, so this page's only
 * responsibilities are: render the current number, and let Esc cancel.
 *
 * Esc calls `cancelCountdown`, which the Rust side handles by hiding this
 * window AND re-showing the setup window — this page does not need to
 * track "did the user cancel" beyond firing that one call.
 */
const Countdown: React.FC = () => {
  const [sequence, setSequence] = useState<number[]>([]);
  const [ticksElapsed, setTicksElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        setSequence([]);
        setTicksElapsed(0);
      });
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        clearTimer();
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

  // Once ticksElapsed runs past the sequence, stop the interval — the
  // display goes blank and the setup window's own timer (which started in
  // lockstep) is expected to call startScreenRecording right around now.
  useEffect(() => {
    if (sequence.length > 0 && ticksElapsed >= sequence.length) {
      clearTimer();
    }
  }, [sequence, ticksElapsed]);

  const tick = currentTick(sequence, ticksElapsed);

  if (tick === null) return <div style={styles.root} />;

  return (
    <div style={styles.root}>
      <div style={styles.number}>{tick}</div>
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
