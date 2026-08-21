import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getThemePref,
  setThemePref,
  THEME_STORAGE_KEY,
  type ThemePref,
} from "../lib/theme";

const ORDER: ThemePref[] = ["auto", "light", "dark"];

const ICON: Record<ThemePref, typeof Monitor> = {
  auto: Monitor,
  light: Sun,
  dark: Moon,
};

/** Icon button cycling the theme preference: auto → light → dark. */
export default function ThemeToggle() {
  const { t } = useTranslation();
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
  const currentLabel = t(`themeToggle.label.${pref}`);
  const nextLabel = t(`themeToggle.label.${next}`).toLowerCase();

  return (
    <button
      type="button"
      onClick={() => {
        setThemePref(next);
        setPref(next);
      }}
      className="theme-toggle-control flex shrink-0 cursor-pointer items-center justify-center text-muted hover:text-fg"
      title={t("themeToggle.title", { current: currentLabel, next: nextLabel })}
      aria-label={t("themeToggle.ariaLabel", { current: currentLabel })}
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}
