import { useEffect } from "react";
import { flushSync } from "react-dom";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { frontendLog } from "./api";

type Field = HTMLInputElement | HTMLTextAreaElement;
type Target = { el: Field; start: number; end: number; value: string } | { el: HTMLElement; range: Range };
function snapshot(): Target | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly || el.selectionStart === null || el.selectionEnd === null) return null;
    return { el, start: el.selectionStart, end: el.selectionEnd, value: el.value };
  }
  const selection = window.getSelection();
  if (el instanceof HTMLElement && el.isContentEditable && selection?.rangeCount)
    return { el, range: selection.getRangeAt(0).cloneRange() };
  return null;
}

/** Explicit delivery to the DOM target captured before the recording overlay opens. */
export function useOwnInputDictation() {
  useEffect(() => {
    let target: Target | null = null;
    let captureId: string | null = null;
    let cancelled = false;
    const subscriptions: UnlistenFn[] = [];
    const handled = new Set<string>();
    void (async () => {
      const capture = await listen<string | null>("voice:self_capture", ({ payload }) => {
        target = snapshot();
        captureId = payload;
        if (payload) void emit(`voice:self_captured:${payload}`, !!target).catch((e) => frontendLog("error", `self capture acknowledgement: ${String(e)}`));
      });
      if (cancelled) { capture(); return; }
      subscriptions.push(capture);
      const insert = await listen<{ id: string; text: string; expires_at: number; press_enter: boolean }>("voice:self_insert", ({ payload }) => {
        if (handled.has(payload.id) || Date.now() > payload.expires_at || (captureId !== null && captureId !== payload.id)) return;
        handled.add(payload.id);
        if (handled.size > 64) handled.delete(handled.values().next().value!);
        const captured = target;
        target = null;
        let delivered = false;
        try {
          if (captured?.el.isConnected && captured.el.getClientRects().length > 0 && !captured.el.closest('[inert], [aria-hidden="true"]')) {
            const el = captured.el;
            if ("start" in captured) {
              const field = captured.el as Field;
              if (!field.disabled && !field.readOnly && field.value === captured.value) {
                const value = field.value.slice(0, captured.start) + payload.text + field.value.slice(captured.end);
                const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
                field.focus({ preventScroll: true });
                field.setSelectionRange(captured.start + payload.text.length, captured.start + payload.text.length);
                flushSync(() => field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload.text })));
                delivered = field.value === value;
              }
            } else if (el.isContentEditable) {
              el.focus({ preventScroll: true });
              const selection = window.getSelection();
              selection?.removeAllRanges(); selection?.addRange(captured.range);
              delivered = document.execCommand("insertText", false, payload.text);
            }
            if (delivered) {
              el.dispatchEvent(new CustomEvent("echo:dictation-inserted", { bubbles: true }));
              if (payload.press_enter) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            }
          }
        } catch (e) { frontendLog("error", `self dictation: ${String(e)}`); }
        void emit(`voice:self_ack:${payload.id}`, delivered).catch((e) => frontendLog("error", `self dictation acknowledgement: ${String(e)}`));
      });
      if (cancelled) insert(); else subscriptions.push(insert);
    })().catch((e) => frontendLog("error", `self dictation listeners: ${String(e)}`));
    return () => { cancelled = true; subscriptions.forEach((fn) => fn()); };
  }, []);
}
