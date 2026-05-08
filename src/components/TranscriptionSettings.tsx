import { useEffect, useState } from "react";
import {
  getCustomWords,
  getDefaultFillerWords,
  getFillerRemovalEnabled,
  getFillerWords,
  setCustomWords as apiSetCustomWords,
  setFillerRemovalEnabled as apiSetFillerRemovalEnabled,
  setFillerWords as apiSetFillerWords,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

export default function TranscriptionSettings() {
  return (
    <div className="flex flex-col gap-6">
      <CustomWordsCard />
      <FillerWordsCard />
    </div>
  );
}

function CustomWordsCard() {
  const [words, setWords] = useState<string[] | null>(null);
  const toasts = useToasts();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const w = await getCustomWords();
        if (!cancelled) setWords(w);
      } catch {
        if (!cancelled) setWords([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (next: string[]) => {
    setWords(next);
    try {
      await apiSetCustomWords(next);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't save custom words: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <ChipListCard
      title="Custom words"
      subtitle="Names or terms the speech model gets wrong. Tokens close to these (off by 1-2 letters) get auto-corrected."
      placeholder="Add a word"
      words={words}
      onChange={(w) => void persist(w)}
      validate={(w) => /^[A-Za-z]+$/.test(w)}
    />
  );
}

function FillerWordsCard() {
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
        message: `Couldn't update filler removal: ${e instanceof Error ? e.message : String(e)}`,
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
        message: `Couldn't save filler words: ${e instanceof Error ? e.message : String(e)}`,
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
        message: `Couldn't restore defaults: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <label className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-fg">
            Remove filler words
          </div>
          <p className="text-xs text-muted">
            Strip "uh", "um", "you know", and similar from every transcript.
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
          title="Filler list"
          subtitle="Edit the list. Multi-word phrases like 'you know' work."
          placeholder="Add a filler"
          words={words}
          onChange={(w) => void persistWords(w)}
          validate={(w) => /^[A-Za-z][A-Za-z' ]*$/.test(w.trim())}
          rightAction={{
            label: "Restore defaults",
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
  rightAction?: { label: string; onClick: () => void };
}) {
  const { title, subtitle, placeholder, words, onChange, validate, inline, rightAction } = props;
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
          className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={!input.trim() || (!!validate && !validate(input.trim()))}
          className="rounded-md bg-danger/15 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/15 disabled:opacity-40"
        >
          Add
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(words ?? []).length === 0 ? (
          <p className="text-xs text-faint">
            {words === null ? "Loading…" : "No entries yet."}
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
                className="text-faint hover:text-fg"
                aria-label={`Remove ${w}`}
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
