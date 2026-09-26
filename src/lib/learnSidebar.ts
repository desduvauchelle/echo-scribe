// "Learn Tucky" sidebar entry visibility. A pure presentation preference, so
// it lives in localStorage (like the theme) rather than the settings store.
// Reads/writes are try/catch'd: a blocked store just means "shown".
import { useSyncExternalStore } from "react";

export const LEARN_SIDEBAR_HIDDEN_KEY = "echoScribe.learnSidebarHidden";
const CHANGE_EVENT = "echo:learn-sidebar-changed";

export function isLearnSidebarHidden(): boolean {
  try {
    return localStorage.getItem(LEARN_SIDEBAR_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLearnSidebarHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(LEARN_SIDEBAR_HIDDEN_KEY, "1");
    else localStorage.removeItem(LEARN_SIDEBAR_HIDDEN_KEY);
  } catch {
    /* Optional presentation preference; applies for this session only. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === LEARN_SIDEBAR_HIDDEN_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Live value; updates across components (same-window event) and windows
 *  ("storage" event). */
export function useLearnSidebarHidden(): boolean {
  return useSyncExternalStore(subscribe, isLearnSidebarHidden, () => false);
}
