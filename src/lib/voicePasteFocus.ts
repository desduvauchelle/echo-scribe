import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type EditableEl = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

function isTextEditable(el: EventTarget | null): el is EditableEl {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    // Only true text-input flavors. Buttons, checkboxes, etc. are not pasteable.
    const type = (el.type || "text").toLowerCase();
    return ["text", "search", "url", "email", "tel", "password", "number"].includes(
      type,
    );
  }
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Tracks the most recently focused text-editable element in the main window
 * and re-focuses it (with selection restored) when the backend emits
 * `voice:paste_pending`.
 *
 * Why: when the user dictates while Echo Scribe itself is the frontmost app,
 * opening the recording overlay (a sibling Tauri window in the same process)
 * drops first-responder off whatever text field they were in. The backend
 * re-activates the previously-frontmost app before pasting, but for the
 * same-app case that activate-call is a no-op and we still need to put
 * focus back on the original text field. Selection range is also restored
 * so the synthesized Cmd+V inserts at the original caret position rather
 * than overwriting whatever was selected by accident.
 */
export function useVoicePasteFocus() {
  useEffect(() => {
    let lastEl: EditableEl | null = null;
    let lastSelStart: number | null = null;
    let lastSelEnd: number | null = null;

    const onFocusIn = (e: FocusEvent) => {
      if (isTextEditable(e.target)) {
        lastEl = e.target;
      }
    };
    // Capture selection on every keystroke / click so we paste at the
    // current caret rather than the focus-time caret.
    const onSelectionChange = () => {
      const active = document.activeElement;
      if (!isTextEditable(active)) return;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        lastSelStart = active.selectionStart;
        lastSelEnd = active.selectionEnd;
      } else {
        lastSelStart = null;
        lastSelEnd = null;
      }
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("selectionchange", onSelectionChange);

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen("voice:paste_pending", () => {
        const el = lastEl;
        if (!el) return;
        if (!el.isConnected) {
          lastEl = null;
          return;
        }
        try {
          el.focus({ preventScroll: true });
          if (
            (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
            lastSelStart !== null &&
            lastSelEnd !== null
          ) {
            // Some <input type=number> doesn't support setSelectionRange — guard.
            try {
              el.setSelectionRange(lastSelStart, lastSelEnd);
            } catch {
              // ignore
            }
          }
        } catch {
          // best-effort
        }
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);
}
