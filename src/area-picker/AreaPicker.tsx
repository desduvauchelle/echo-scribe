import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { submitAreaPickerResult } from "../lib/api";
import {
  dragToLocalRect,
  globalRectToLocal,
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

/** `area-picker-frame`: the confirmed GLOBAL rect plus the display geometry
 *  needed to map it back into this page's local px (see `globalRectToLocal`). */
type FramePayload = StartPayload & { rect: [number, number, number, number] };

/** `pick`: interactive drag/keyboard selection. `frame`: passive marker of
 *  the confirmed area (Rust makes the window click-through in this mode). */
type Mode = "pick" | "frame";

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
 * `submitAreaPickerResult`; on cancel Rust hides this window, on confirm it
 * switches the SAME window into frame mode (`area-picker-frame`, below) —
 * either way there is no path that can leave an interactive picker stranded
 * on-screen.
 *
 * Frame mode (`area-picker-frame` event, `overlay::show_area_frame`): after
 * a confirm, and for the whole recording, this page keeps drawing the
 * confirmed rect as a clear cut-out in a grey translucent wash so the user
 * can see exactly what is captured. The window is click-through and
 * unfocused in this mode, so no mouse/keyboard handling applies; the next
 * `area-picker-start` flips it back to pick mode.
 */
/** Default keyboard-selection rect: centered, half the surface in each
 *  dimension. Created on the first arrow-key press (no mouse needed). */
const defaultKeyboardRect = (): Rect => {
  const w = Math.round(window.innerWidth / 2);
  const h = Math.round(window.innerHeight / 2);
  return {
    x: Math.round((window.innerWidth - w) / 2),
    y: Math.round((window.innerHeight - h) / 2),
    w,
    h,
  };
};

const KB_STEP_PX = 20;

/** Grey translucent wash over everything that is NOT captured (both the
 *  live drag and the passive post-confirm frame). Neutral grey rather than
 *  black so the dimmed part reads as "greyed out", not "blacked out". */
const DIM_WASH = "rgba(60, 60, 60, 0.45)";

const AreaPicker: React.FC = () => {
  const { t } = useTranslation("windows");
  const [display, setDisplay] = useState<StartPayload | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  // Keyboard-driven selection rect (arrow keys move, Shift+arrows resize,
  // Enter confirms). Cleared when a mouse drag starts.
  const [kbRect, setKbRect] = useState<Rect | null>(null);
  const [mode, setMode] = useState<Mode>("pick");
  // Confirmed rect, in local px, drawn while in frame mode.
  const [frameRect, setFrameRect] = useState<Rect | null>(null);
  const modeRef = useRef<Mode>("pick");
  modeRef.current = mode;
  // Mirrors dragStart/dragCurrent in a ref so the Esc keydown handler (bound
  // once) always reads the latest drag state without re-binding per frame.
  const draggingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Mirror display/kbRect in refs so the keydown handler (bound once) reads
  // the latest values without re-binding.
  const displayRef = useRef<StartPayload | null>(null);
  const kbRectRef = useRef<Rect | null>(null);
  displayRef.current = display;
  kbRectRef.current = kbRect;

  useEffect(() => {
    // Focus the root so keyboard interaction works without a preceding click.
    rootRef.current?.focus();

    let unlistenStart: (() => void) | undefined;
    let unlistenFrame: (() => void) | undefined;
    (async () => {
      unlistenStart = await listen<StartPayload>("area-picker-start", (event) => {
        setDisplay(event.payload);
        setMode("pick");
        setFrameRect(null);
        setDragStart(null);
        setDragCurrent(null);
        setKbRect(null);
        draggingRef.current = false;
        rootRef.current?.focus();
      });
      unlistenFrame = await listen<FramePayload>("area-picker-frame", (event) => {
        const p = event.payload;
        setDisplay(p);
        setMode("frame");
        setFrameRect(
          globalRectToLocal(
            p.rect,
            { x: p.origin_x, y: p.origin_y },
            { width: p.width, height: p.height },
          ),
        );
        setDragStart(null);
        setDragCurrent(null);
        setKbRect(null);
        draggingRef.current = false;
      });
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      // Frame mode is passive: the window shouldn't have focus, but if a key
      // does land here it must not cancel/confirm anything.
      if (modeRef.current === "frame") return;
      if (e.key === "Escape") {
        e.preventDefault();
        void submitAreaPickerResult(null);
        return;
      }
      // Keyboard selection: arrow keys move the rect (Shift+arrows resize),
      // Enter confirms — the same commit path mouseup uses.
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown"
      ) {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? -KB_STEP_PX : e.key === "ArrowRight" ? KB_STEP_PX : 0;
        const dy = e.key === "ArrowUp" ? -KB_STEP_PX : e.key === "ArrowDown" ? KB_STEP_PX : 0;
        setKbRect((prev) => {
          const base = prev ?? defaultKeyboardRect();
          const maxW = window.innerWidth;
          const maxH = window.innerHeight;
          if (e.shiftKey) {
            // Resize from the top-left anchor, floored at a usable minimum.
            const w = Math.min(Math.max(base.w + dx, 40), maxW - base.x);
            const h = Math.min(Math.max(base.h + dy, 40), maxH - base.y);
            return { ...base, w, h };
          }
          const x = Math.min(Math.max(base.x + dx, 0), maxW - base.w);
          const y = Math.min(Math.max(base.y + dy, 0), maxH - base.h);
          return { ...base, x, y };
        });
        return;
      }
      if (e.key === "Enter") {
        const rect = kbRectRef.current;
        const disp = displayRef.current;
        if (!rect || !disp) return;
        e.preventDefault();
        const globalRect = localRectToGlobal(
          rect,
          { x: disp.origin_x, y: disp.origin_y },
          { width: disp.width, height: disp.height },
        );
        void submitAreaPickerResult(globalRect);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      unlistenStart?.();
      unlistenFrame?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Crosshair only while picking; in frame mode the window is click-through
  // so the cursor belongs to whatever is underneath.
  useEffect(() => {
    document.body.style.cursor = mode === "pick" ? "crosshair" : "default";
  }, [mode]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (modeRef.current === "frame") return;
    if (e.button !== 0) return; // left-click only
    const p = { x: e.clientX, y: e.clientY };
    setDragStart(p);
    setDragCurrent(p);
    setKbRect(null); // mouse takes over from any keyboard selection
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

  // Active selection: a live mouse drag wins; otherwise the keyboard rect.
  const local: Rect | null =
    dragStart && dragCurrent ? dragToLocalRect(dragStart, dragCurrent) : kbRect;

  if (mode === "frame") {
    return (
      <div ref={rootRef} tabIndex={-1} style={styles.root} data-mode="frame">
        {frameRect && frameRect.w > 0 && frameRect.h > 0 && (
          /* Same one-element trick as the live selection below: the frame's
             own box-shadow washes everything OUTSIDE it grey, the inside stays
             fully clear (no tint) so the captured region reads as "normally
             lit". */
          <div
            style={{
              ...styles.frame,
              left: frameRect.x,
              top: frameRect.y,
              width: frameRect.w,
              height: frameRect.h,
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      style={styles.root}
      data-mode="pick"
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
          <div style={styles.hint}>
            <div>{t("areaPicker.dragHint")}</div>
            <div style={styles.hintSub}>{t("areaPicker.keyboardHint")}</div>
          </div>
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
    background: DIM_WASH,
  },
  selection: {
    position: "absolute",
    border: "2px solid #22d3ee",
    boxShadow: `0 0 0 9999px ${DIM_WASH}`,
    // No fill: the region being captured must look exactly like the screen
    // underneath, so the dim/clear contrast is the whole signal.
    background: "transparent",
    pointerEvents: "none",
  },
  frame: {
    position: "absolute",
    // Lighter border + wash than the live selection: this stays up for the
    // whole recording, so it should mark the region without shouting.
    border: "2px solid rgba(34, 211, 238, 0.9)",
    boxShadow: `0 0 0 9999px ${DIM_WASH}`,
    background: "transparent",
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
  hintSub: {
    marginTop: 2,
    fontSize: 11,
    color: "rgba(255,255,255,0.65)",
    textAlign: "center",
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
