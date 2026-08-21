import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGE_NATIVE_NAMES,
  SUPPORTED_LANGUAGES,
  getAppLanguagePref,
  setAppLanguage,
  type AppLanguagePref,
} from "../i18n";

/**
 * Interface-language picker. The preference is read synchronously from the
 * shared localStorage key (see src/i18n.ts), so there is no loading state and
 * no IPC round-trip; picking applies immediately and persists across restarts.
 *
 * The option labels are the *native* language names and are never translated;
 * the surrounding copy is translated through the `settings` namespace.
 */
export default function AppLanguagePicker() {
  const { t } = useTranslation("settings");
  const [pref, setPref] = useState<AppLanguagePref>(getAppLanguagePref);

  const onChange = (next: AppLanguagePref) => {
    setPref(next);
    setAppLanguage(next);
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas p-3">
      <div>
        <div className="text-sm font-semibold text-fg">
          {t("language.selectLabel")}
        </div>
        <p className="text-xs text-muted">{t("language.note")}</p>
      </div>
      <select
        aria-label={t("language.selectLabel")}
        value={pref}
        onChange={(e) => onChange(e.target.value as AppLanguagePref)}
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
      >
        <option value="system">{t("language.system")}</option>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>
            {LANGUAGE_NATIVE_NAMES[lang]}
          </option>
        ))}
      </select>
    </div>
  );
}
