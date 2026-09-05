import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Circle, Mic, Sparkles, Trophy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { frontendLog, getLogCaptureBinding, getVoiceAtCursorBinding, listLlmModels, listSpeechModels, permissionsStatus } from "../lib/api";
import { formatBindingLabel } from "../lib/displayText";
import { CATEGORIES, LESSONS, MILESTONES, learningSteps, nextTip, winId, type LessonId } from "../lib/learning";
import { useLearning } from "./LearningContext";
import SpeechSetupStatus from "./SpeechSetupStatus";
import { useSpeechSetup } from "../lib/speechSetup";

type Props = { onLesson: (id?: LessonId) => void };
const button = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:opacity-40";
const quiet = "rounded-md px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-fg";

export function LearningCard({ onLesson }: Props) {
  const { t } = useTranslation("main");
  const { state, busy, error, update, refresh } = useLearning();
  const steps = learningSteps(state);
  const completed = steps.filter(Boolean).length;
  const tip = completed === 3 || state.hidden ? nextTip(state, Date.now()) : undefined;
  const win = state.celebrations ? state.pending[0] : undefined;
  if (busy) return null;
  const showSteps = !state.hidden;
  if (!showSteps && !tip && !win) return null;
  return <section aria-label={t("learning.title")} className="my-3 rounded-xl border border-line bg-surface p-4">
    {win ? <div className="flex items-start gap-3" role="status">
      <div className="echo-win-icon rounded-xl bg-accent-soft p-3 text-accent"><Trophy size={24} /></div>
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold">{t("learning.win", { count: win.count, category: t(`learning.categories.${win.category}`) })}</p>
        <p className="mt-1 text-sm text-muted">{t(`learning.cheers.${win.count}`)}</p>
        <button className={quiet + " mt-2"} onClick={() => onLesson()}>{t("learning.seeWins")} <ChevronRight size={12} className="inline" /></button>
      </div>
      <button aria-label={t("learning.dismissWin")} className={quiet} onClick={() => update((s) => ({ ...s, pending: s.pending.filter((p) => winId(p) !== winId(win)) }))}><X size={16} /></button>
    </div> : showSteps ? <>
      <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-accent" />{t("learning.gettingStarted")}</h2><div className="flex items-center gap-2"><span className="text-xs text-muted">{t("learning.progress", { count: completed })}</span><button className={quiet} onClick={() => update((s) => ({ ...s, hidden: true }))}>{t("learning.hide")}</button></div></div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">{(["dictate", "capture", "retrieve"] as LessonId[]).map((id, i) => <button key={id} onClick={() => onLesson(id)} className="flex items-center gap-2 text-xs text-muted hover:text-fg">{steps[i] ? <Check size={14} className="text-success" /> : <Circle size={12} />} {t(`learning.lessons.${id}.title`)}</button>)}</div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">{t(completed === 3 ? "learning.coreDone" : "learning.nextSmallWin")}</p><button className={button} onClick={() => onLesson(completed === 3 ? undefined : (["dictate", "capture", "retrieve"] as LessonId[])[steps.findIndex((done) => !done)])}>{t(completed === 3 ? "learning.explore" : "learning.continue")}<ArrowRight size={14} /></button></div>
      {error && <button className={quiet + " mt-2 text-warning"} onClick={refresh}>{t("learning.refreshError")}</button>}
    </> : tip ? <>
      <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-medium uppercase tracking-wider text-accent">{t("learning.oneMore")}</p><h2 className="mt-1 text-sm font-semibold">{t(`learning.lessons.${tip.id}.title`)}</h2><p className="mt-1 text-sm text-muted">{t(`learning.lessons.${tip.id}.summary`)}</p></div><BookOpen size={18} className="shrink-0 text-faint" /></div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={button} onClick={() => { update((s) => ({ ...s, dismissed: [...s.dismissed, tip.id], lastTipAt: Date.now() })); onLesson(tip.id); }}>{t("learning.tryIt")}</button>
        <button className={quiet} onClick={() => update((s) => ({ ...s, snoozed: { ...s.snoozed, [tip.id]: Date.now() + 3 * 86400000 }, lastTipAt: Date.now() }))}>{t("learning.later")}</button>
        <button className={quiet} onClick={() => update((s) => ({ ...s, dismissed: [...s.dismissed, tip.id], lastTipAt: Date.now() }))}>{t("learning.dismissTip")}</button>
      </div>
    </> : null}
  </section>;
}

export function LearnView({ lesson, onLesson, onAction }: Props & { lesson?: LessonId; onAction: (id: LessonId | "setup-ai" | "setup-voice") => void }) {
  const { t } = useTranslation("main");
  const { t: common } = useTranslation();
  const { state, update } = useLearning();
  const [binding, setBinding] = useState("");
  const [logBinding, setLogBinding] = useState("");
  const [ready, setReady] = useState(false);
  const [ai, setAi] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [practiced, setPracticed] = useState(false);
  const speech = useSpeechSetup();
  const input = useRef<HTMLTextAreaElement>(null);
  const success = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (practiced && lesson === "dictate") success.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [practiced, lesson]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getVoiceAtCursorBinding(), getLogCaptureBinding(), permissionsStatus(), listSpeechModels(), listLlmModels()]).then(([voice, log, perms, models, llms]) => {
      if (cancelled) return;
      setBinding(formatBindingLabel(common, voice)); setLogBinding(formatBindingLabel(common, log));
      setReady(perms.microphone && perms.accessibility && models.some((m) => m.active && m.downloaded));
      setAi(llms.some((m) => m.active && m.downloaded)); setLoaded(true);
    }).catch((e) => { frontendLog("error", `learning: readiness failed: ${String(e)}`); if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [lesson, common, speech.phase]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const inserted = () => { setPracticed(true); update((s) => ({ ...s, practiced: true })); };
    el.addEventListener("echo:dictation-inserted", inserted);
    return () => el.removeEventListener("echo:dictation-inserted", inserted);
  }, [lesson, loaded, update]);
  const needsAi = lesson && ["capture", "chat", "daily", "templates", "people"].includes(lesson);
  return <div className="h-full overflow-y-auto p-6 text-fg">
    <div className="mx-auto max-w-3xl">
      <SpeechSetupStatus />
      {lesson ? <>
        <button className={quiet + " mb-5 flex items-center gap-1"} onClick={() => onLesson()}><ArrowLeft size={14} />{t("learning.title")}</button>
        <p className="text-xs font-medium text-accent">{t("learning.minute")}</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t(`learning.lessons.${lesson}.title`)}</h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{t(`learning.lessons.${lesson}.body`, { binding, logBinding })}</p>
        {lesson === "dictate" ? <div className="mt-6 rounded-xl border border-line bg-surface p-5">
          {practiced && <div ref={success} className={`echo-practice-success relative mb-5 overflow-hidden rounded-xl border border-accent/30 bg-accent-soft p-5 ${state.celebrations ? "echo-practice-animate" : ""}`}>
            {state.celebrations && <div className="echo-practice-confetti pointer-events-none absolute inset-0" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <i key={i} style={{ "--x": `${(i % 8 - 3.5) * 44}px`, "--y": `${-45 - (i % 5) * 18}px`, "--turn": `${(i % 2 ? 1 : -1) * (120 + i * 19)}deg`, "--delay": `${i % 4 * 35}ms`, backgroundColor: ["#239b7a", "#e9ac42", "#a78bfa", "#ec7997", "#55bccc"][i % 5] } as CSSProperties} />)}</div>}
            <div className="relative flex items-start gap-3" role="status">
              <span className="echo-practice-badge rounded-full bg-accent p-3 text-canvas"><Sparkles size={24} aria-hidden="true" /></span>
              <div><p className="text-xl font-semibold tracking-tight">{t("learning.practiceSuccessTitle")}</p><p className="mt-1 text-sm">{t("learning.practiceSuccess")}</p></div>
            </div>
            <p className="relative mt-4 text-sm text-muted">{t("learning.practiceNextHint")}</p>
            <div className="relative mt-3 flex flex-wrap items-center gap-3">
              <button className={button} onClick={() => onLesson("capture")}>{t("learning.practiceNext")}<ArrowRight size={16} aria-hidden="true" /></button>
              <button className={quiet} onClick={() => onLesson()}>{t("learning.practiceExplore")}</button>
            </div>
          </div>}
          <label htmlFor="dictation-practice" className="mb-2 block text-sm font-medium">{t("learning.practiceLabel")}</label>
          <p className="mb-3 text-sm text-muted">{t("learning.practiceHint", { binding: binding || "…" })}</p>
          <textarea ref={input} id="dictation-practice" value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={t("learning.practicePlaceholder")} className="w-full resize-y rounded-lg border border-line bg-canvas p-3 text-sm focus:border-accent focus:outline-none" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {ready ? <button className={button} onClick={() => input.current?.focus()}><Mic size={14} />{t("learning.focusPractice")}</button> : <button className={button} disabled={!loaded} onClick={() => onAction("setup-voice")}>{t("learning.finishSetup")}</button>}
            <span className="text-xs text-muted">{t("learning.practiceSaved")}</span>
          </div>
        </div> : <div className="mt-6 rounded-xl border border-line bg-surface p-5">
          {needsAi && loaded && !ai ? <><p className="mb-3 text-sm text-muted">{t("learning.aiNeeded")}</p><button className={button} onClick={() => onAction("setup-ai")}>{t("learning.setupAi")}</button></> :
            lesson === "capture" ? <><p className="text-sm font-medium">{t("learning.captureTry", { logBinding: logBinding || "…" })}</p><p className="mt-2 text-sm text-muted">{t("learning.captureExample")}</p><button className={quiet + " mt-3"} onClick={() => onAction("capture")}>{t("learning.openCaptureSettings")}</button></> :
              <button className={button} onClick={() => onAction(lesson)}>{t(`learning.lessons.${lesson}.action`)}<ArrowRight size={14} /></button>}
        </div>}
      </> : <>
        <h2 className="text-2xl font-semibold tracking-tight">{t("learning.title")}</h2>
        <p className="mt-2 text-sm text-muted">{t("learning.subtitle")}</p>
        <div className="mt-6 grid items-start gap-4 sm:grid-cols-2">
          {["voice", "memory", "meetings", "recordings", "power"].map((group) => <section key={group} className="rounded-xl border border-line bg-surface p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{t(`learning.groups.${group}`)}</h3>
            {LESSONS.filter((l) => l.group === group).map((l) => <button key={l.id} onClick={() => onLesson(l.id)} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-elevated"><span><span className="block text-sm font-medium">{t(`learning.lessons.${l.id}.title`)}</span><span className="mt-1 block text-xs leading-relaxed text-muted">{t(`learning.lessons.${l.id}.summary`)}</span></span><ChevronRight size={14} className="shrink-0 text-faint" /></button>)}
          </section>)}
        </div>
        <section className="mt-6 rounded-xl border border-line bg-surface p-5" aria-label={t("learning.wins")}>
          <h3 className="flex items-center gap-2 text-base font-semibold"><Trophy size={18} className="text-accent" />{t("learning.wins")}</h3>
          <p className="mt-1 text-xs text-muted">{t("learning.winsHint")}</p>
          <div className="mt-4 space-y-4">{CATEGORIES.map((category) => <div key={category}><div className="mb-2 flex justify-between text-xs"><span>{t(`learning.categories.${category}`)}</span><span className="text-muted">{t("learning.count", { count: state.counts[category] })}</span></div><div className="flex gap-2">{MILESTONES.map((count) => <span key={count} className={`flex flex-1 items-center justify-center gap-1 rounded-lg border py-2 text-xs ${state.earned.includes(winId({ category, count })) ? "border-accent/30 bg-accent-soft text-accent" : "border-line text-faint"}`} aria-label={t("learning.milestone", { count, status: t(state.earned.includes(winId({ category, count })) ? "learning.earned" : "learning.ahead") })}>{state.earned.includes(winId({ category, count })) && <Check size={12} />}{count}</span>)}</div></div>)}</div>
        </section>
        <div className="mt-5 flex flex-wrap gap-4 text-xs text-muted">
          <label className="flex items-center gap-2"><input type="checkbox" checked={state.tips} onChange={(e) => update((s) => ({ ...s, tips: e.target.checked }))} />{t("learning.tipsToggle")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={state.celebrations} onChange={(e) => update((s) => ({ ...s, celebrations: e.target.checked, pending: e.target.checked ? s.pending : [] }))} />{t("learning.celebrationsToggle")}</label>
          <button className={quiet} onClick={() => update((s) => ({ ...s, hidden: false }))}>{t("learning.showSteps")}</button>
        </div>
        <p className="mt-4 text-xs text-faint">{t("learning.local")}</p>
      </>}
    </div>
  </div>;
}
