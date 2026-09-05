import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getDictionaryEntries,
  getDefaultFillerWords,
  getFillerRemovalEnabled,
  getFillerWords,
  getSpokenEditingSettings,
  getTranscriptionCleanupLanguage,
  getTranscriptionSnippets,
  setFillerRemovalEnabled as apiSetFillerRemovalEnabled,
  setFillerWords as apiSetFillerWords,
  setSpokenEditingSettings,
  setTranscriptionCleanupLanguage,
  setDictionaryEntries,
  setTranscriptionSnippets,
  type DictionaryEntry,
  type SpokenEditingSettings,
  type TranscriptionSnippet,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

export default function TranscriptionSettings() {
  return (
    <div className="flex flex-col gap-6">
      <SpokenEditingCard />
      <LanguageCard />
      <DictionaryCard />
      <SnippetsCard />
      <FillerWordsCard />
    </div>
  );
}

function SpokenEditingCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SpokenEditingSettings | null>(null);
  const toasts = useToasts();

  useEffect(() => {
    void getSpokenEditingSettings()
      .then(setSettings)
      .catch(() => setSettings({
        enabled: true,
        corrections: true,
        punctuation: true,
        lists: true,
        press_enter: false,
      }));
  }, []);

  const update = async (patch: Partial<SpokenEditingSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await setSpokenEditingSettings(next);
    } catch (e) {
      setSettings(settings);
      toasts.push({
        tone: "error",
        message: t("transcriptionSettings.spokenEditing.saveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const rows: Array<{ key: keyof SpokenEditingSettings; label: string; detail: string }> = [
    { key: "corrections", label: t("transcriptionSettings.spokenEditing.corrections.label"), detail: t("transcriptionSettings.spokenEditing.corrections.detail") },
    { key: "punctuation", label: t("transcriptionSettings.spokenEditing.punctuation.label"), detail: t("transcriptionSettings.spokenEditing.punctuation.detail") },
    { key: "lists", label: t("transcriptionSettings.spokenEditing.lists.label"), detail: t("transcriptionSettings.spokenEditing.lists.detail") },
    { key: "press_enter", label: t("transcriptionSettings.spokenEditing.pressEnter.label"), detail: t("transcriptionSettings.spokenEditing.pressEnter.detail") },
  ];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <ToggleRow
        label={t("transcriptionSettings.spokenEditing.title")}
        detail={t("transcriptionSettings.spokenEditing.detail")}
        checked={settings?.enabled ?? true}
        disabled={!settings}
        onChange={(enabled) => void update({ enabled })}
      />
      <div className={settings?.enabled ? "flex flex-col gap-2 border-t border-line pt-3" : "pointer-events-none flex flex-col gap-2 border-t border-line pt-3 opacity-50"}>
        {rows.map((row) => (
          <ToggleRow
            key={row.key}
            label={row.label}
            detail={row.detail}
            checked={settings?.[row.key] ?? false}
            disabled={!settings || !settings.enabled}
            onChange={(value) => void update({ [row.key]: value })}
          />
        ))}
      </div>
      <p className="text-[11px] text-muted">
        {t("transcriptionSettings.spokenEditing.cancelHint")}
      </p>
    </div>
  );
}

function LanguageCard() {
  const { t } = useTranslation();
  const [language, setLanguage] = useState("auto");
  const toasts = useToasts();
  useEffect(() => {
    void getTranscriptionCleanupLanguage().then(setLanguage).catch(() => {});
  }, []);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-4">
      <div className="text-sm font-semibold text-fg">{t("transcriptionSettings.language.title")}</div>
      <p className="text-xs text-muted">
        {t("transcriptionSettings.language.description")}
      </p>
      <select
        value={language}
        onChange={async (event) => {
          const previous = language;
          const next = event.target.value;
          setLanguage(next);
          try {
            await setTranscriptionCleanupLanguage(next);
          } catch (e) {
            setLanguage(previous);
            toasts.push({ tone: "error", message: t("transcriptionSettings.language.saveFailed", { error: e instanceof Error ? e.message : String(e) }) });
          }
        }}
        className="w-fit rounded border border-line bg-canvas px-2 py-1.5 text-sm"
      >
        <option value="auto">{t("transcriptionSettings.language.options.auto")}</option>
        <option value="en">{t("transcriptionSettings.language.options.en")}</option>
        <option value="es">{t("transcriptionSettings.language.options.es")}</option>
        <option value="fr">{t("transcriptionSettings.language.options.fr")}</option>
        <option value="de">{t("transcriptionSettings.language.options.de")}</option>
        <option value="pt">{t("transcriptionSettings.language.options.pt")}</option>
        <option value="it">{t("transcriptionSettings.language.options.it")}</option>
        <option value="nl">{t("transcriptionSettings.language.options.nl")}</option>
        <option value="pl">{t("transcriptionSettings.language.options.pl")}</option>
      </select>
      <p className="text-[11px] text-muted">{t("transcriptionSettings.language.footnote")}</p>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm font-medium text-fg">{props.label}</span>
        <span className="block text-xs text-muted">{props.detail}</span>
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="h-4 w-4 shrink-0 cursor-pointer accent-accent"
      />
    </label>
  );
}

function DictionaryCard() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null);
  const [spokenForm, setSpokenForm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [search, setSearch] = useState("");
  const toasts = useToasts();

  useEffect(() => {
    void getDictionaryEntries().then(setEntries).catch(() => setEntries([]));
  }, []);

  const persist = async (next: DictionaryEntry[]) => {
    const previous = entries;
    setEntries(next);
    try {
      await setDictionaryEntries(next);
    } catch (e) {
      setEntries(previous);
      toasts.push({
        tone: "error",
        message: t("transcriptionSettings.dictionary.saveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const add = () => {
    const spoken = spokenForm.trim();
    const output = replacement.trim();
    if (!spoken || !output || !entries) return;
    const next = entries.filter((entry) => entry.spoken_form.toLocaleLowerCase() !== spoken.toLocaleLowerCase());
    void persist([...next, { spoken_form: spoken, replacement: output, language: "auto" }]);
    setSpokenForm("");
    setReplacement("");
  };

  const visible = (entries ?? []).filter((entry) =>
    `${entry.spoken_form} ${entry.replacement}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-fg">{t("transcriptionSettings.dictionary.title")}</div>
          <p className="text-xs text-muted">{t("transcriptionSettings.dictionary.description")}</p>
        </div>
        <div className="flex shrink-0 gap-2 text-xs">
          <button type="button" onClick={() => downloadJson("tucky-dictionary.json", entries ?? [])} className="text-muted hover:text-fg">{t("transcriptionSettings.dictionary.exportJson")}</button>
          <label className="cursor-pointer text-muted hover:text-fg">{t("transcriptionSettings.dictionary.importJson")}<input type="file" accept="application/json,.json" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void readJsonFile<DictionaryEntry[]>(file).then((value) => {
              if (!Array.isArray(value) || value.some((item) => !item.spoken_form || typeof item.replacement !== "string")) throw new Error(t("transcriptionSettings.dictionary.invalidFile"));
              return persist(value.map((item) => ({ ...item, language: item.language || "auto" })));
            }).catch((e) => toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) }));
            event.target.value = "";
          }} /></label>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <input value={spokenForm} onChange={(e) => setSpokenForm(e.target.value)} placeholder={t("transcriptionSettings.dictionary.spokenPlaceholder")} className="rounded border border-line bg-canvas px-2 py-1.5 text-sm" />
        <input value={replacement} onChange={(e) => setReplacement(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder={t("transcriptionSettings.dictionary.replacementPlaceholder")} className="rounded border border-line bg-canvas px-2 py-1.5 text-sm" />
        <button type="button" onClick={add} disabled={!spokenForm.trim() || !replacement.trim()} className="rounded bg-accent px-3 py-1.5 text-sm text-canvas disabled:opacity-40">{t("transcriptionSettings.dictionary.add")}</button>
      </div>
      {(entries?.length ?? 0) > 4 && <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("transcriptionSettings.dictionary.searchPlaceholder")} className="rounded border border-line bg-canvas px-2 py-1.5 text-sm" />}
      <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
        {visible.map((entry) => (
          <div key={`${entry.language}:${entry.spoken_form}`} className="flex items-center justify-between gap-3 rounded border border-line px-2 py-1.5 text-sm">
            <span className="min-w-0"><span className="text-muted">{entry.spoken_form}</span> <span className="text-muted">→</span> <span className="font-medium text-fg">{entry.replacement}</span></span>
            <button type="button" onClick={() => void persist((entries ?? []).filter((item) => item !== entry))} className="text-xs text-muted hover:text-danger">{t("transcriptionSettings.dictionary.remove")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SnippetsCard() {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useState<TranscriptionSnippet[] | null>(null);
  const [trigger, setTrigger] = useState("");
  const [expansion, setExpansion] = useState("");
  const toasts = useToasts();
  useEffect(() => { void getTranscriptionSnippets().then(setSnippets).catch(() => setSnippets([])); }, []);

  const persist = async (next: TranscriptionSnippet[]) => {
    const previous = snippets;
    setSnippets(next);
    try { await setTranscriptionSnippets(next); }
    catch (e) {
      setSnippets(previous);
      toasts.push({ tone: "error", message: t("transcriptionSettings.snippets.saveFailed", { error: e instanceof Error ? e.message : String(e) }) });
    }
  };
  const conflict = (snippets ?? []).some((item) => item.trigger.toLocaleLowerCase() === trigger.trim().toLocaleLowerCase());
  const add = () => {
    if (!trigger.trim() || !expansion || !snippets || conflict) return;
    void persist([...snippets, { trigger: trigger.trim(), expansion, language: "auto" }]);
    setTrigger(""); setExpansion("");
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <div className="flex items-start justify-between gap-3">
        <div><div className="text-sm font-semibold text-fg">{t("transcriptionSettings.snippets.title")}</div><p className="text-xs text-muted">{t("transcriptionSettings.snippets.description")}</p></div>
        <div className="flex shrink-0 gap-2 text-xs">
          <button type="button" onClick={() => downloadJson("tucky-snippets.json", snippets ?? [])} className="text-muted hover:text-fg">{t("transcriptionSettings.snippets.exportJson")}</button>
          <label className="cursor-pointer text-muted hover:text-fg">{t("transcriptionSettings.snippets.importJson")}<input type="file" accept="application/json,.json" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void readJsonFile<TranscriptionSnippet[]>(file).then((value) => {
              if (!Array.isArray(value) || value.some((item) => !item.trigger || typeof item.expansion !== "string")) throw new Error(t("transcriptionSettings.snippets.invalidFile"));
              return persist(value.map((item) => ({ ...item, language: item.language || "auto" })));
            }).catch((e) => toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) }));
            event.target.value = "";
          }} /></label>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_2fr_auto] gap-2">
        <input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder={t("transcriptionSettings.snippets.triggerPlaceholder")} className="rounded border border-line bg-canvas px-2 py-1.5 text-sm" />
        <input value={expansion} onChange={(e) => setExpansion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder={t("transcriptionSettings.snippets.expansionPlaceholder")} className="rounded border border-line bg-canvas px-2 py-1.5 text-sm" />
        <button type="button" onClick={add} disabled={!trigger.trim() || !expansion || conflict} className="rounded bg-accent px-3 py-1.5 text-sm text-canvas disabled:opacity-40">{t("transcriptionSettings.snippets.add")}</button>
      </div>
      {conflict && <p className="text-xs text-warning">{t("transcriptionSettings.snippets.conflict")}</p>}
      <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
        {(snippets ?? []).map((snippet) => (
          <div key={`${snippet.language}:${snippet.trigger}`} className="flex items-start justify-between gap-3 rounded border border-line px-2 py-1.5 text-sm">
            <span className="min-w-0"><span className="text-muted">{snippet.trigger}</span> <span className="text-muted">→</span> <span className="whitespace-pre-wrap text-fg">{snippet.expansion}</span></span>
            <button type="button" onClick={() => void persist((snippets ?? []).filter((item) => item !== snippet))} className="text-xs text-muted hover:text-danger">{t("transcriptionSettings.snippets.remove")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function FillerWordsCard() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [en, w] = await Promise.all([
          getFillerRemovalEnabled(),
          getFillerWords(),
        ]);
        if (!cancelled) {
          setEnabled(en);
          setWords(w);
        }
      } catch {
        if (!cancelled) {
          setEnabled(true);
          setWords([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistEnabled = async (next: boolean) => {
    setEnabled(next);
    try {
      await apiSetFillerRemovalEnabled(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("transcriptionSettings.fillerWords.updateFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const persistWords = async (next: string[]) => {
    setWords(next);
    try {
      await apiSetFillerWords(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("transcriptionSettings.fillerWords.saveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const restoreDefaults = async () => {
    try {
      const defaults = await getDefaultFillerWords();
      await persistWords(defaults);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("transcriptionSettings.fillerWords.restoreFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <label className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-fg">
            {t("transcriptionSettings.fillerWords.title")}
          </div>
          <p className="text-xs text-muted">
            {t("transcriptionSettings.fillerWords.description")}
          </p>
        </div>
        <input
          type="checkbox"
          disabled={enabled === null}
          checked={enabled ?? true}
          onChange={(e) => void persistEnabled(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-accent"
        />
      </label>

      <div className={enabled ? "" : "pointer-events-none opacity-50"}>
        <ChipListCard
          inline
          disabled={!enabled}
          title={t("transcriptionSettings.fillerWords.chipList.title")}
          subtitle={t("transcriptionSettings.fillerWords.chipList.subtitle")}
          placeholder={t("transcriptionSettings.fillerWords.chipList.placeholder")}
          words={words}
          onChange={(w) => void persistWords(w)}
          validate={(w) => /^[A-Za-z][A-Za-z' ]*$/.test(w.trim())}
          rightAction={{
            label: t("transcriptionSettings.fillerWords.chipList.restoreDefaults"),
            onClick: () => void restoreDefaults(),
          }}
        />
      </div>
    </div>
  );
}

function ChipListCard(props: {
  title: string;
  subtitle: string;
  placeholder: string;
  words: string[] | null;
  onChange: (next: string[]) => void;
  validate?: (word: string) => boolean;
  inline?: boolean;
  /** Disables every interactive control (used when the parent toggle is off). */
  disabled?: boolean;
  rightAction?: { label: string; onClick: () => void };
}) {
  const { t } = useTranslation();
  const { title, subtitle, placeholder, words, onChange, validate, inline, disabled, rightAction } = props;
  const [input, setInput] = useState("");

  const add = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (validate && !validate(trimmed)) return;
    if ((words ?? []).some((w) => w.toLowerCase() === trimmed.toLowerCase())) {
      setInput("");
      return;
    }
    onChange([...(words ?? []), trimmed]);
    setInput("");
  };

  const remove = (w: string) => {
    onChange((words ?? []).filter((x) => x !== w));
  };

  const wrapperClass = inline
    ? "flex flex-col gap-3"
    : "flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4";

  return (
    <div className={wrapperClass}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-fg">{title}</div>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        {rightAction ? (
          <button
            type="button"
            onClick={rightAction.onClick}
            disabled={disabled}
            className="shrink-0 rounded border border-line px-2 py-1 text-xs text-muted hover:bg-elevated"
          >
            {rightAction.label}
          </button>
        ) : null}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={disabled}
          className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || !input.trim() || (!!validate && !validate(input.trim()))}
          className="rounded-md bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/25 disabled:opacity-40"
        >
          {t("transcriptionSettings.chipList.add")}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(words ?? []).length === 0 ? (
          <p className="text-xs text-muted">
            {words === null ? t("transcriptionSettings.chipList.loading") : t("transcriptionSettings.chipList.empty")}
          </p>
        ) : (
          (words ?? []).map((w) => (
            <span
              key={w}
              className="inline-flex items-center gap-1.5 rounded-full bg-elevated px-2.5 py-0.5 text-xs text-fg"
            >
              {w}
              <button
                type="button"
                onClick={() => remove(w)}
                disabled={disabled}
                className="text-faint hover:text-fg"
                aria-label={t("transcriptionSettings.chipList.removeAria", { word: w })}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function readJsonFile<T>(file: File): Promise<T> {
  return JSON.parse(await file.text()) as T;
}
