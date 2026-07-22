import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  getThemePref,
  setThemePref,
  THEME_STORAGE_KEY,
  type ThemePref,
} from "../lib/theme";

const ORDER: ThemePref[] = ["auto", "light", "dark"];

const LABEL: Record<ThemePref, string> = {
  auto: "Auto (match system)",
  light: "Light",
  dark: "Dark",
};

const ICON: Record<ThemePref, typeof Monitor> = {
  auto: Monitor,
  light: Sun,
  dark: Moon,
};

/** Icon button cycling the theme preference: auto → light → dark. */
export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);

  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setPref(getThemePref());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
  const Icon = ICON[pref];

  return (
    <button
      type="button"
      onClick={() => {
        setThemePref(next);
        setPref(next);
      }}
      className="flex shrink-0 cursor-pointer items-center justify-center rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg"
      title={`Theme: ${LABEL[pref]} — click for ${LABEL[next].toLowerCase()}`}
      aria-label={`Theme: ${LABEL[pref]}`}
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}
