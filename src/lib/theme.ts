// Theme preference handling. "auto" follows the OS via prefers-color-scheme;
// "light"/"dark" force it. The resolved value lands on <html data-theme="...">
// which globals.css keys off. Stored in localStorage (shared by every window:
// main, editor, screenrec-setup); "storage" events keep already-open windows
// in sync. Each window entry must call initTheme() once at startup.

export type ThemePref = "auto" | "light" | "dark";

export const THEME_STORAGE_KEY = "echoScribe.themePref";

const LIGHT_CANVAS = "#f2f5f4";
const DARK_CANVAS = "#080e0d";

// Kept as a single module-level reference: an unreferenced MediaQueryList can
// be garbage-collected along with its "change" listener, silently breaking
// auto-mode tracking of OS theme changes.
let systemLightQuery: MediaQueryList | null = null;
const systemLight = (): MediaQueryList => {
  if (!systemLightQuery) {
    systemLightQuery = window.matchMedia("(prefers-color-scheme: light)");
  }
  return systemLightQuery;
};

export function getThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  } catch {
    // localStorage unavailable — treat as auto
  }
  return "auto";
}

function apply(pref: ThemePref): void {
  const resolved =
    pref === "auto" ? (systemLight().matches ? "light" : "dark") : pref;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // The pre-mount background in each window's index.html is set before CSS
  // loads; keep it in step when the theme changes at runtime.
  root.style.backgroundColor = resolved === "light" ? LIGHT_CANVAS : DARK_CANVAS;
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Non-fatal: the theme still applies for this window's lifetime
  }
  apply(pref);
}

/** Apply the stored preference and track OS + cross-window changes. */
export function initTheme(): void {
  apply(getThemePref());
  systemLight().addEventListener("change", () => {
    if (getThemePref() === "auto") apply("auto");
  });
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_STORAGE_KEY) apply(getThemePref());
  });
}
