import type { WindowSource } from "../lib/api";

// Source enumeration currently provides app names, not bundle identifiers.
const browserName = /^(google chrome|chrome|chromium|safari|firefox|microsoft edge|edge|brave browser|brave|arc|dia|opera|opera gx|vivaldi|orion|zen|zen browser)(?: (?:beta|dev|canary|nightly|developer edition|technology preview))?$/i;

export function groupWindows(windows: WindowSource[], search: string) {
  const apps = new Map<string, WindowSource[]>();
  for (const window of windows) {
    const group = apps.get(window.app) ?? [];
    group.push(window);
    apps.set(window.app, group);
  }
  const query = search.trim().toLocaleLowerCase();
  return [...apps].map(([app, sources]) => ({
    app,
    total: sources.length,
    grouped: sources.length >= 3,
    defaultExpanded: browserName.test(app.trim()),
    windows: sources.filter((window) =>
      !query || app.toLocaleLowerCase().includes(query) || window.title.toLocaleLowerCase().includes(query),
    ),
  })).filter((group) => group.windows.length > 0);
}
