import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Mic, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getDailyFocusNote, getMorningFocusEnabled, saveDailyFocusNote, setDailyFocusRecording, setMorningFocusEnabled, type DailyFocusNote } from "../lib/api";
import TuckyGreeting from "./TuckyGreeting";

function localDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function MorningFocus({ pulse }: { pulse?: ReactNode }) {
  const { t } = useTranslation("main");
  const [now, setNow] = useState(() => new Date());
  const day = localDay(now);
  const [note, setNote] = useState<DailyFocusNote | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [holding, setHolding] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const captureOwned = useRef(false);
  const holdSource = useRef<"pointer" | "keyboard" | null>(null);
  const recordingStarted = useRef(false);
  const releaseRequested = useRef(false);
  const stopRequested = useRef(false);

  const load = useCallback(async (date: string) => {
    try {
      const next = await getDailyFocusNote(date);
      setNote(next);
      setDraft(next?.content ?? "");
      setLoadedDay(date);
      setError(null);
    } catch (e) {
      setError(String(e));
      setLoadedDay(date);
    }
  }, []);

  useEffect(() => {
    void load(day);
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [day, load]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<DailyFocusNote>("daily-focus:changed", ({ payload }) => {
      if (payload.local_date !== day) return;
      setNote(payload.content ? payload : null);
      if (!editing) setDraft(payload.content);
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop; });
    return () => { cancelled = true; unlisten?.(); };
  }, [day, editing]);

  useEffect(() => {
    let cancelled = false;
    void getMorningFocusEnabled().then((value) => { if (!cancelled) setEnabled(value); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    let unlisten: (() => void) | undefined;
    void listen<boolean>("morning-focus:enabled-changed", ({ payload }) => setEnabled(payload))
      .then((stop) => { if (cancelled) stop(); else unlisten = stop; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const resetCapture = () => {
    captureOwned.current = false;
    holdSource.current = null;
    recordingStarted.current = false;
    releaseRequested.current = false;
    stopRequested.current = false;
    setHolding(false);
    setRecording(false);
  };

  const stopCapture = async () => {
    if (!captureOwned.current || stopRequested.current) return;
    stopRequested.current = true;
    try {
      await setDailyFocusRecording(false);
    } catch (e) {
      resetCapture();
      setProcessing(false);
      setError(String(e));
    }
  };

  const releaseCapture = (source: "pointer" | "keyboard") => {
    if (holdSource.current !== source) return;
    holdSource.current = null;
    setHolding(false);
    setProcessing(true);
    if (recordingStarted.current) void stopCapture();
    else releaseRequested.current = true;
  };

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen("voice:recording_started", () => {
        if (!captureOwned.current) return;
        recordingStarted.current = true;
        if (releaseRequested.current) void stopCapture();
        else setRecording(true);
      }),
      listen("voice:recording_stopped", () => { if (captureOwned.current) { setRecording(false); setProcessing(true); } }),
      listen("voice:paste_failed", () => { if (captureOwned.current) { resetCapture(); setProcessing(false); setError(t("dashboard.morningFocus.dictationFailed")); } }),
      listen("voice:recording_cancelled", () => { if (captureOwned.current) { resetCapture(); setProcessing(false); } }),
      listen("asr:error", () => { if (captureOwned.current) { resetCapture(); setProcessing(false); setError(t("dashboard.morningFocus.dictationFailed")); } }),
      listen("recorder:start_failed", () => { if (captureOwned.current) { resetCapture(); setProcessing(false); setError(t("dashboard.morningFocus.dictationFailed")); } }),
      listen("hide-overlay", () => { if (captureOwned.current) { resetCapture(); setProcessing(false); } }),
    ]).then((subs) => { if (cancelled) subs.forEach((fn) => fn()); else unlisteners.push(...subs); });
    return () => { cancelled = true; unlisteners.forEach((fn) => fn()); };
  }, [t]);

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") releaseCapture("keyboard");
    };
    window.addEventListener("keyup", onKeyUp);
    return () => window.removeEventListener("keyup", onKeyUp);
  });

  const save = async (value: string) => {
    if ((!value.trim() && !note) || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDailyFocusNote(day, value);
      setNote(saved.content ? saved : null);
      setDraft(saved.content);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
      setProcessing(false);
    }
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !showEditor) return;
    const onInserted = () => { resetCapture(); void save(input.value); };
    input.addEventListener("echo:dictation-inserted", onInserted);
    return () => input.removeEventListener("echo:dictation-inserted", onInserted);
  // The listener needs the current day and save state after each render.
  });

  const startCapture = async (source: "pointer" | "keyboard") => {
    if (holdSource.current || processing || saving) return;
    holdSource.current = source;
    recordingStarted.current = false;
    releaseRequested.current = false;
    stopRequested.current = false;
    captureOwned.current = true;
    setHolding(true);
    setError(null);
    inputRef.current?.focus();
    try {
      await setDailyFocusRecording(true);
    } catch (e) {
      resetCapture();
      setProcessing(false);
      setError(String(e));
    }
  };

  const showEditor = enabled === true && loadedDay === day && (!note || editing);
  useEffect(() => {
    const input = inputRef.current;
    if (!showEditor || !input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }, [draft, showEditor]);

  const disable = async () => {
    if (holding || recording || processing || saving) return;
    try {
      await setMorningFocusEnabled(false);
      setEnabled(false);
    } catch (e) {
      setError(String(e));
    }
  };
  return <>
    <TuckyGreeting pulse={pulse} focusNote={enabled && loadedDay === day && note && !editing ? note.content : undefined}
      onEditFocusNote={() => setEditing(true)} />
    {showEditor ? <section className="morning-focus-panel" aria-labelledby="morning-focus-heading">
      <div className="morning-focus-heading">
        <div><span className="morning-focus-eyebrow">{t("dashboard.morningFocus.eyebrow")}</span>
          <h2 id="morning-focus-heading">{t("dashboard.morningFocus.question")}</h2></div>
        <div className="morning-focus-heading-actions">
          {note ? <button type="button" onClick={() => { setDraft(note.content); setEditing(false); }} className="morning-focus-cancel">{t("dashboard.morningFocus.cancel")}</button> : null}
          <button type="button" onClick={() => void disable()} disabled={holding || recording || processing || saving}
            className="morning-focus-dismiss" aria-label={t("dashboard.morningFocus.dismiss")} title={t("dashboard.morningFocus.dismiss")}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="morning-focus-composer">
        <div className="morning-focus-type">
          <label htmlFor="morning-focus-text" className="sr-only">{t("dashboard.morningFocus.orType")}</label>
          <textarea id="morning-focus-text" ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(draft); } }}
            placeholder={t("dashboard.morningFocus.placeholder")}
            maxLength={8000} rows={1} />
        </div>
        <div className="morning-focus-actions">
          <div className="morning-focus-voice">
            <button type="button" className="morning-focus-mic" disabled={processing || saving}
              aria-pressed={holding || recording} aria-label={t("dashboard.morningFocus.hold")}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                void startCapture("pointer");
              }}
              onPointerUp={() => releaseCapture("pointer")}
              onPointerCancel={() => releaseCapture("pointer")}
              onLostPointerCapture={() => releaseCapture("pointer")}
              onKeyDown={(event) => {
                if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
                event.preventDefault();
                void startCapture("keyboard");
              }}>
              {processing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
              <span className="morning-focus-mic-copy">
                <strong>{processing ? t("dashboard.morningFocus.transcribing") : holding || recording ? t("dashboard.morningFocus.release") : t("dashboard.morningFocus.hold")}</strong>
                <span>{t("dashboard.morningFocus.holdHint")}</span>
              </span>
            </button>
            <span aria-live="polite" className="morning-focus-status sr-only">{processing ? t("dashboard.morningFocus.transcribing") : null}</span>
          </div>
          <button type="button" className="morning-focus-save" onClick={() => void save(draft)} disabled={(!draft.trim() && !note) || saving || holding || recording || processing}>
            {saving ? t("dashboard.morningFocus.saving") : t("dashboard.morningFocus.save")}
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="morning-focus-error">{error}</p> : null}
    </section> : null}
  </>;
}
