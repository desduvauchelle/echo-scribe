import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Pointer tail for notice windows stacked by `notice_column.rs`. Only the card
 * nearest Tucky / the recording pill draws a tail; `x` is its center in px
 * from the card's left edge (0 = let the CSS default decide).
 */
export type BubbleTail = { side: "bottom" | "none"; x: number };

const DEFAULT_TAIL: BubbleTail = { side: "bottom", x: 0 };

export function useBubbleTail(): BubbleTail {
  const [tail, setTail] = useState<BubbleTail>(DEFAULT_TAIL);
  useEffect(() => {
    let disposed = false;
    const label = getCurrentWindow().label;
    void invoke<BubbleTail>("bubble_tail")
      .then((value) => { if (!disposed) setTail(value); })
      .catch(() => {});
    const unlisten = listen<BubbleTail & { label: string }>("bubble-tail", ({ payload }) => {
      if (payload.label === label) setTail({ side: payload.side, x: payload.x });
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
  return tail;
}

export function tailClass(tail: BubbleTail): string {
  return tail.side === "none" ? " tail-none" : "";
}

export function tailStyle(tail: BubbleTail): CSSProperties | undefined {
  return tail.x > 0 ? ({ "--tail-x": `${tail.x}px` } as CSSProperties) : undefined;
}

/** Hide this notice window and let the column close the gap it leaves. */
export function hideNotice(): Promise<void> {
  return invoke<void>("notice_hide").catch(() => getCurrentWindow().hide());
}
