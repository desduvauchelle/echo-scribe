import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { submitAreaPickerResult } from "../lib/api";
import {
  dragToLocalRect,
  isDragRectSignificant,
  localRectToGlobal,
  type Point,
  type Rect,
} from "../lib/areaPicker";

type StartPayload = {
  display_id: number;
  origin_x: number;
  origin_y: number;
  width: number;
  height: number;
};

/**
 * Full-screen, transparent, always-on-top overlay for dragging out a capture
 * region. Shown by Rust (`overlay::show_area_picker`) sized+positioned to
 * exactly cover the target display; see `src/lib/areaPicker.ts` for the
 * coordinate-space contract this page relies on (CSS px here == the
 * display's local point space). THIS page — not Rust — adds the display's
 * global origin to the local drag rect, via `localRectToGlobal`, using the
 * origin/size it receives in the `area-picker-start` payload.
 *
 * Interaction: mousedown starts a drag, mousemove updates a live dimmed
 * selection + "W×H" readout near the cursor, mouseup confirms and reports
 * the GLOBAL rect back to Rust. Esc cancels at any point (whether or not a
 * drag is in progress). Both confirm and cancel go through
 * `submitAreaPickerResult`, which the Rust side uses to unconditionally hide
 * this window — so there is no path that can leave the picker stranded
 * on-screen.
 */
const AreaPicker: React.FC = () => {
  const [display, setDisplay] = useState<StartPayload | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  // Mirrors dragStart/dragCurrent in a ref so the Esc keydown handler (bound
  // once) always reads the latest drag state without re-binding per frame.
  const draggingRef = useRef(false);

  useEffect(() => {
    let unlistenStart: (() => void) | undefined;
    (async () => {
      unlistenStart = await listen<StartPayload>("area-picker-start", (event) => {
        setDisplay(event.payload);
        setDragStart(null);
        setDragCurrent(null);
        draggingRef.current = false;
      });
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void submitAreaPickerResult(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      unlistenStart?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left-click only
    const p = { x: e.clientX, y: e.clientY };
    setDragStart(p);
    setDragCurrent(p);
    draggingRef.current = true;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    setDragCurrent({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    if (!draggingRef.current || !dragStart || !dragCurrent || !display) {
      draggingRef.current = false;
      return;
    }
    draggingRef.current = false;
    const local = dragToLocalRect(dragStart, dragCurrent);
    if (!isDragRectSignificant(local)) {
      // Treat a click-without-drag as "try again", not a cancel — the
      // overlay stays up so the user can immediately redo the drag.
      setDragStart(null);
      setDragCurrent(null);
      return;
    }
    const globalRect = localRectToGlobal(
      local,
      { x: display.origin_x, y: display.origin_y },
      { width: display.width, height: display.height },
    );
    void submitAreaPickerResult(globalRect);
  };

  const local: Rect | null =
    dragStart && dragCurrent ? dragToLocalRect(dragStart, dragCurrent) : null;

  return (
    <div
      style={styles.root}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {local ? (
        <>
          {/* The selection box's own box-shadow (a 9999px spread) dims
              everything OUTSIDE the box, leaving the box itself clear — a
              single element does both jobs, so there is no separate
              full-surface backdrop stacking with it. */}
          <div
            style={{
              ...styles.selection,
              left: local.x,
              top: local.y,
              width: local.w,
              height: local.h,
            }}
          />
          <div
            style={{
              ...styles.readout,
              left: local.x + local.w / 2,
              top: Math.max(4, local.y - 28),
            }}
          >
            {Math.round(local.w)}×{Math.round(local.h)}
          </div>
        </>
      ) : (
        <>
          {/* No selection yet: dim the whole surface uniformly. */}
          <div style={styles.backdrop} />
          <div style={styles.hint}>Drag to select a region · Esc to cancel</div>
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  backdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.35)",
  },
  selection: {
    position: "absolute",
    border: "2px solid #22d3ee",
    boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.35)",
    background: "rgba(34, 211, 238, 0.08)",
    pointerEvents: "none",
  },
  readout: {
    position: "absolute",
    transform: "translate(-50%, -100%)",
    background: "rgba(20, 20, 20, 0.85)",
    color: "#fff",
    padding: "3px 8px",
    borderRadius: 6,
    fontSize: 12,
    fontFamily: "-apple-system, system-ui, sans-serif",
    fontWeight: 600,
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  hint: {
    position: "absolute",
    top: 24,
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(20, 20, 20, 0.75)",
    color: "rgba(255,255,255,0.85)",
    padding: "6px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "-apple-system, system-ui, sans-serif",
    pointerEvents: "none",
  },
};

export default AreaPicker;
