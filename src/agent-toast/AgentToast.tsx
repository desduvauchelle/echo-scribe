import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hideNotice, tailClass, tailStyle, useBubbleTail } from "../lib/bubbleTail";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectAssistantReport } from "../lib/api";

const DONE_DISMISS_MS = 8_000;
const FAILED_DISMISS_MS = 14_000;
const EXIT_MS = 220;

/** "Created task in ‘Tucky’: Call Sam" → a task card instead of a plain line. */
const ITEM_CHANGE = /^(Created|Updated) (task|note) in ‘(.+?)’: ([\s\S]+)$/;

type Parsed =
  | { type: "item"; verb: string; kind: "task" | "note"; project: string; content: string }
  | { type: "text"; text: string };

function parseChange(change: string): Parsed {
  const m = ITEM_CHANGE.exec(change);
  if (!m) return { type: "text", text: change };
  return { type: "item", verb: m[1], kind: m[2] as "task" | "note", project: m[3], content: m[4].trim() };
}

/** Strip Markdown noise from the model's answer for a one-glance preview. */
function plain(markdown: string): string {
  return markdown
    .replace(/\n\nReferences consulted:.*$/s, "")
    .replace(/\[(\d+)\]/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default function AgentToast() {
  const { t } = useTranslation("windows");
  const [report, setReport] = useState<ProjectAssistantReport | null>(null);
  const tail = useBubbleTail();
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = report?.status === "running";

  const clearTimers = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    dismissTimer.current = null;
    hideTimer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    setExiting(true);
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      setExiting(false);
      void hideNotice();
    }, EXIT_MS);
  }, [clearTimers]);

  const scheduleDismiss = useCallback((r: ProjectAssistantReport | null, delay?: number) => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    if (!r || r.status === "running") return;
    const ms = delay ?? (r.status === "done" ? DONE_DISMISS_MS : FAILED_DISMISS_MS);
    dismissTimer.current = setTimeout(dismiss, ms);
  }, [dismiss]);

  useEffect(() => {
    let disposed = false;
    const showReport = (payload: ProjectAssistantReport) => {
      if (disposed) return;
      clearTimers();
      setReport(payload);
      setExiting(false);
      setVisible(true);
      scheduleDismiss(payload);
    };
    const unlisten = listen<ProjectAssistantReport>("agent-toast:report", ({ payload }) => showReport(payload));
    if (import.meta.env.DEV) {
      (window as any).__agentToastPreview = showReport;
    }
    return () => {
      disposed = true;
      clearTimers();
      if (import.meta.env.DEV) delete (window as any).__agentToastPreview;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [clearTimers, scheduleDismiss]);

  // Let the native window hug the card; Rust keeps the bottom edge anchored
  // just above the recording pill.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = () => {
      const stage = getComputedStyle(el.parentElement!);
      void invoke("resize_agent_toast", { height: Math.ceil(el.offsetHeight + parseFloat(stage.paddingTop) + parseFloat(stage.paddingBottom)) }).catch(() => {});
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const openApp = () => {
    dismiss();
    void invoke("open_project_assistant_report").catch(() => {});
  };

  const changes = (report?.changes ?? []).map(parseChange);
  const status = report?.status ?? "running";
  const title = running
    ? t("agentToast.working")
    : status === "done"
      ? t("agentToast.done")
      : status === "stopped"
        ? t("agentToast.stopped")
        : changes.length > 0 ? t("agentToast.partial") : t("agentToast.failed");
  const tone = running ? "running" : status === "done" ? "done" : changes.length > 0 ? "partial" : "failed";
  // Changes speak for themselves; show the answer only when nothing changed
  // (a question, a clarification, or an error explanation).
  const answer = !running && changes.length === 0 && report?.answer ? plain(report.answer) : "";

  return (
    <div className="agent-toast-stage">
      <section
        ref={cardRef}
        className={`agent-toast is-${tone}${visible ? " is-visible" : ""}${exiting ? " is-exiting" : ""}${tailClass(tail)}`}
        style={tailStyle(tail)}
        aria-label={t("agentToast.ariaLabel")}
        onMouseEnter={() => { if (dismissTimer.current) clearTimeout(dismissTimer.current); }}
        onMouseLeave={() => scheduleDismiss(report, 2_000)}
      >
        <div className="agent-toast-head" role="status" aria-live="polite">
          <span className="agent-toast-mark" aria-hidden="true">
            {running ? <span className="agent-toast-spinner" /> : tone === "failed" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 7v6M12 17h.01" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            )}
          </span>
          <strong>{title}</strong>
          <div className="agent-toast-actions">
            {!running && (
              <button type="button" className="agent-toast-open" onClick={openApp}>{t("agentToast.open")}</button>
            )}
            <button type="button" className="agent-toast-close" onClick={dismiss} title={t("agentToast.dismiss")} aria-label={t("agentToast.dismiss")}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {report?.request && (running || changes.length === 0) && (
          <p className="agent-toast-request">“{report.request}”</p>
        )}

        {changes.length > 0 && (
          <ul className="agent-toast-changes">
            {changes.slice(0, 4).map((c, i) => c.type === "item" ? (
              <li key={i} className="agent-toast-item">
                <span className={`agent-toast-item-icon is-${c.kind}`} aria-hidden="true">
                  {c.kind === "task" ? (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2.5" y="2.5" width="11" height="11" rx="3" /></svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 5h8M4 8h8M4 11h5" /></svg>
                  )}
                </span>
                <span className="agent-toast-item-body">
                  <span className="agent-toast-item-content">{c.content}</span>
                  <span className="agent-toast-item-meta">
                    {t(c.kind === "task" ? "agentToast.task" : "agentToast.note")} · # {c.project}
                  </span>
                </span>
              </li>
            ) : (
              <li key={i} className="agent-toast-line">{c.text}</li>
            ))}
          </ul>
        )}

        {answer && <p className="agent-toast-answer">{answer}</p>}
      </section>
    </div>
  );
}
