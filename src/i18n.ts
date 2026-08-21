// Frontend i18n bootstrap. Every window entry (main, overlay, editor, the
// toasts, the screen-recording helpers …) imports this module for its
// side-effect so the whole UI resolves the user's language the same way,
// before React mounts.
//
// Layout: src/locales/<locale>/<namespace>.json. Locales are the 8 below;
// namespaces are the 6 below. Every combination exists as a file (untranslated
// ones are `{}`), and each one is imported *statically* here — no
// import.meta.glob, because `bun test` does not understand it and the pure
// TypeScript in src/lib must stay runnable under the bun test runner.
//
// English is the fallback and the source of truth: a key missing from another
// locale renders its English string instead of the raw key.
//
// IMPORTANT: import this module from window entry points and React components
// only. Nothing under src/lib that the bun tests import may pull it in — it
// touches window/navigator/localStorage at import time.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json";
import enMain from "./locales/en/main.json";
import enSettings from "./locales/en/settings.json";
import enOnboarding from "./locales/en/onboarding.json";
import enEditor from "./locales/en/editor.json";
import enWindows from "./locales/en/windows.json";

import esCommon from "./locales/es/common.json";
import esMain from "./locales/es/main.json";
import esSettings from "./locales/es/settings.json";
import esOnboarding from "./locales/es/onboarding.json";
import esEditor from "./locales/es/editor.json";
import esWindows from "./locales/es/windows.json";

import deCommon from "./locales/de/common.json";
import deMain from "./locales/de/main.json";
import deSettings from "./locales/de/settings.json";
import deOnboarding from "./locales/de/onboarding.json";
import deEditor from "./locales/de/editor.json";
import deWindows from "./locales/de/windows.json";

import frCommon from "./locales/fr/common.json";
import frMain from "./locales/fr/main.json";
import frSettings from "./locales/fr/settings.json";
import frOnboarding from "./locales/fr/onboarding.json";
import frEditor from "./locales/fr/editor.json";
import frWindows from "./locales/fr/windows.json";

import ptCommon from "./locales/pt/common.json";
import ptMain from "./locales/pt/main.json";
import ptSettings from "./locales/pt/settings.json";
import ptOnboarding from "./locales/pt/onboarding.json";
import ptEditor from "./locales/pt/editor.json";
import ptWindows from "./locales/pt/windows.json";

import itCommon from "./locales/it/common.json";
import itMain from "./locales/it/main.json";
import itSettings from "./locales/it/settings.json";
import itOnboarding from "./locales/it/onboarding.json";
import itEditor from "./locales/it/editor.json";
import itWindows from "./locales/it/windows.json";

import nlCommon from "./locales/nl/common.json";
import nlMain from "./locales/nl/main.json";
import nlSettings from "./locales/nl/settings.json";
import nlOnboarding from "./locales/nl/onboarding.json";
import nlEditor from "./locales/nl/editor.json";
import nlWindows from "./locales/nl/windows.json";

import plCommon from "./locales/pl/common.json";
import plMain from "./locales/pl/main.json";
import plSettings from "./locales/pl/settings.json";
import plOnboarding from "./locales/pl/onboarding.json";
import plEditor from "./locales/pl/editor.json";
import plWindows from "./locales/pl/windows.json";

/** Locales we ship. `en` is the fallback and the source of truth. */
export const SUPPORTED_LANGUAGES = [
  "en",
  "es",
  "de",
  "fr",
  "pt",
  "it",
  "nl",
  "pl",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** What the user picked in Settings: a concrete locale, or follow the OS. */
export type AppLanguagePref = SupportedLanguage | "system";

/** Translation namespaces, one JSON file per locale each. */
export const NAMESPACES = [
  "common",
  "main",
  "settings",
  "onboarding",
  "editor",
  "windows",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/**
 * Native language names for the Settings picker. Deliberately *not*
 * translated — a language is always listed in its own language.
 */
export const LANGUAGE_NATIVE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
  pt: "Português",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
};

/**
 * Where the choice is persisted. localStorage is this app's existing
 * cross-window UI-preference store (see src/lib/theme.ts): it is shared by
 * every window, survives restarts, and is readable *synchronously*, which is
 * what lets each window resolve its language before React mounts. Writing it
 * also fires a "storage" event in the other open windows, which is the cheap
 * live-propagation hook this module listens for below.
 */
export const APP_LANGUAGE_STORAGE_KEY = "echoScribe.appLanguage";

const resources = {
  en: {
    common: enCommon,
    main: enMain,
    settings: enSettings,
    onboarding: enOnboarding,
    editor: enEditor,
    windows: enWindows,
  },
  es: {
    common: esCommon,
    main: esMain,
    settings: esSettings,
    onboarding: esOnboarding,
    editor: esEditor,
    windows: esWindows,
  },
  de: {
    common: deCommon,
    main: deMain,
    settings: deSettings,
    onboarding: deOnboarding,
    editor: deEditor,
    windows: deWindows,
  },
  fr: {
    common: frCommon,
    main: frMain,
    settings: frSettings,
    onboarding: frOnboarding,
    editor: frEditor,
    windows: frWindows,
  },
  pt: {
    common: ptCommon,
    main: ptMain,
    settings: ptSettings,
    onboarding: ptOnboarding,
    editor: ptEditor,
    windows: ptWindows,
  },
  it: {
    common: itCommon,
    main: itMain,
    settings: itSettings,
    onboarding: itOnboarding,
    editor: itEditor,
    windows: itWindows,
  },
  nl: {
    common: nlCommon,
    main: nlMain,
    settings: nlSettings,
    onboarding: nlOnboarding,
    editor: nlEditor,
    windows: nlWindows,
  },
  pl: {
    common: plCommon,
    main: plMain,
    settings: plSettings,
    onboarding: plOnboarding,
    editor: plEditor,
    windows: plWindows,
  },
};

function isSupported(value: string | null | undefined): value is SupportedLanguage {
  return (
    !!value && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

/** The persisted preference, or "system" when nothing (valid) is stored. */
export function getAppLanguagePref(): AppLanguagePref {
  try {
    const raw = localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    if (raw === "system" || isSupported(raw)) return raw;
  } catch {
    // localStorage unavailable — fall through to "system"
  }
  return "system";
}

/** First OS-preferred language we ship, matched on the prefix ("fr-CA" → "fr"). */
function languageFromNavigator(): SupportedLanguage {
  const candidates: string[] =
    typeof navigator === "undefined"
      ? []
      : [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  for (const candidate of candidates) {
    const prefix = candidate.toLowerCase().split("-")[0];
    if (isSupported(prefix)) return prefix;
  }
  return "en";
}

/** Concrete locale to render in: explicit choice → OS language → English. */
export function resolveLanguage(
  pref: AppLanguagePref = getAppLanguagePref(),
): SupportedLanguage {
  return pref === "system" ? languageFromNavigator() : pref;
}

/**
 * Persist the user's choice and switch the UI immediately. Other already-open
 * windows pick it up through the "storage" listener below; windows opened
 * later resolve it at startup.
 */
export function setAppLanguage(lang: AppLanguagePref): void {
  try {
    localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Non-fatal: the language still applies for this window's lifetime
  }
  void i18n.changeLanguage(resolveLanguage(lang));
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(),
  fallbackLng: "en",
  supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
  ns: NAMESPACES as unknown as string[],
  defaultNS: "common",
  interpolation: {
    // React already escapes interpolated values.
    escapeValue: false,
  },
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== APP_LANGUAGE_STORAGE_KEY) return;
    void i18n.changeLanguage(resolveLanguage());
  });
}

export default i18n;
