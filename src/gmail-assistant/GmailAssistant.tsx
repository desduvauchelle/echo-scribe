import { useEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import Markdown from "../components/Markdown";
import { useOwnInputDictation } from "../lib/ownInputDictation";
import { gmailAssistantState, gmailRunAssistant, gmailStopAssistant, gmailUpdateDraft, gmailSaveDraft, gmailSendDraft, gmailOpenDraft, gmailOpenThread,
  type GmailDraft, type GmailFields, type GmailReport, type GmailFocus } from "../lib/api";

const fieldClass = "w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";
const buttonClass = "rounded-md border border-line px-3 py-2 text-sm hover:bg-elevated focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const emptyFields: GmailFields = { to: "", cc: "", subject: "", body: "" };

export default function GmailAssistant() {
  useOwnInputDictation();
  const [report, setReport] = useState<GmailReport | null>(null);
  const [draft, setDraft] = useState<GmailDraft | null>(null);
  const [fields, setFields] = useState<GmailFields>(emptyFields);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const latest = useRef({ draft, fields, busy, capturing });
  latest.current = { draft, fields, busy, capturing };
  const saving = useRef(false);
  const changeVersion = useRef(0);
  const acceptDraft = (d: GmailDraft) => { setDraft(d); setFields(d.fields); setConfirmSend(false); };
  const focusSnapshot = (): GmailFocus | null => {
    const current = latest.current;
    if (!current.draft || current.draft.status !== "review" || current.busy || saving.current) return null;
    const active = document.activeElement;
    const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0) : window.getSelection()?.toString();
    return { draft_id: current.draft.id, revision: current.draft.revision, fields: current.fields, selection: selection || null };
  };
  useEffect(() => {
    let disposed = false, received = false;
    const subscriptions: UnlistenFn[] = [];
    const subscribe = async <T,>(event: string, handler: (payload: T) => void) => {
      const fn = await listen<T>(event, ({ payload }) => { if (!disposed) handler(payload); });
      if (disposed) fn(); else subscriptions.push(fn);
    };
    void Promise.all([
      subscribe<GmailReport>("gmail:report", (r) => {
        received = true; setReport(r); setBusy(r.status === "running"); setCapturing(false);
        if (r.draft) acceptDraft(r.draft);
      }),
      subscribe<GmailDraft>("gmail:draft", (d) => { if (!saving.current) acceptDraft(d); }),
      subscribe<string>("gmail:capture", (id) => {
        const snapshot = focusSnapshot();
        setCapturing(true); setConfirmSend(false);
        void emit(`gmail:captured:${id}`, snapshot).catch((e) => { setCapturing(false); setError(String(e)); });
      }),
      subscribe("voice:recording_cancelled", () => setCapturing(false)),
      subscribe("voice:recording_stopped", () => setCapturing(false)),
      subscribe("gmail:accounts-changed", () => { received = false; void reload(); }),
    ]).catch((e) => setError(String(e)));
    const reload = async () => {
      try {
        const state = await gmailAssistantState();
        if (disposed || received) return;
        setReport(state.report); setBusy(state.busy);
        if (state.draft) acceptDraft(state.draft); else { setDraft(null); setFields(emptyFields); }
      } catch (e) { if (!disposed) setError(String(e)); }
    };
    void reload();
    return () => { disposed = true; subscriptions.forEach((fn) => fn()); };
  }, []);

  const persist = async (): Promise<GmailDraft | null> => {
    const current = latest.current;
    if (!current.draft) return null;
    if (JSON.stringify(current.fields) === JSON.stringify(current.draft.fields)) return current.draft;
    if (saving.current) throw new Error("Wait for the current draft edit to save.");
    saving.current = true;
    const version = changeVersion.current;
    try {
      const saved = await gmailUpdateDraft(current.draft.id, current.draft.revision, current.fields);
      setDraft(saved);
      // Never replace a more recent keystroke with an earlier autosave response.
      if (version === changeVersion.current) setFields(saved.fields);
      return saved;
    } finally { saving.current = false; }
  };
  // Local autosave only. Remote saves require the Save to Gmail button.
  useEffect(() => {
    if (!draft || busy || capturing || draft.status !== "review" || JSON.stringify(fields) === JSON.stringify(draft.fields)) return;
    const timer = setTimeout(() => {
      if (!latest.current.busy && !latest.current.capturing && !saving.current) void persist().catch((e) => setError(String(e)));
    }, 700);
    return () => clearTimeout(timer);
  }, [fields, draft, busy, capturing]);

  const submit = async () => {
    if (!request.trim() || busy || capturing || saving.current) return;
    const snapshot = focusSnapshot();
    setBusy(true); setError(null); setMessage(null); setConfirmSend(false);
    try {
      const result = await gmailRunAssistant(request.trim(), snapshot);
      setReport(result); if (result.draft) acceptDraft(result.draft); setRequest("");
    } catch (e) { setError(String(e)); } finally { setBusy(false); setCapturing(false); }
  };
  const remoteWrite = async (send: boolean) => {
    if (busy || capturing || saving.current) return;
    setBusy(true); setError(null); setMessage(null); setConfirmSend(false);
    try {
      const current = await persist(); if (!current) return;
      const updated = await (send ? gmailSendDraft : gmailSaveDraft)(current.id, current.revision);
      acceptDraft(updated); setMessage(send ? "Email sent." : "Draft saved to Gmail.");
    } catch (e) { setError(String(e)); const state = await gmailAssistantState().catch(() => null); if (state?.draft) acceptDraft(state.draft); }
    finally { setBusy(false); }
  };
  const change = (key: keyof GmailFields, value: string) => {
    changeVersion.current++; setFields((prev) => ({ ...prev, [key]: value })); setConfirmSend(false); setMessage(null); setError(null);
  };
  const locked = busy || capturing || (!!draft && draft.status !== "review");
  const unresolved = draft && ["sending", "saving", "write_unknown"].includes(draft.status);
  return <main className="flex min-h-screen flex-col bg-canvas text-fg">
    <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-4">
      <div><h1 className="text-base font-semibold">Email assistant</h1><p className="mt-1 text-xs text-muted">Search conversations. Prepare a reply. Review it here.</p></div>
      {(busy && report?.status === "running") && <button className={buttonClass} onClick={() => void gmailStopAssistant().catch((e) => setError(String(e)))}>Stop</button>}
    </header>
    <div className="mx-auto w-full max-w-4xl space-y-5 p-5">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-2">
        <label htmlFor="email-request" className="text-sm font-medium">{draft?.status === "review" ? "Ask Tucky to edit this draft" : "Ask Tucky about email"}</label>
        <textarea id="email-request" className={fieldClass} value={request} disabled={busy || capturing} onChange={(e) => setRequest(e.target.value)} maxLength={4000} rows={2} placeholder="Find Alex’s latest email about the proposal and draft a reply." />
        <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-xs text-muted">{capturing ? "Listening…" : busy ? "Tucky is working…" : "Use your Control dictation shortcut while this window is focused."}</p>
          <button type="submit" disabled={busy || capturing || !request.trim()} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50">Ask Tucky</button></div>
      </form>
      {error && <p role="alert" className="rounded-lg border border-danger p-3 text-sm text-danger">{error}</p>}
      {message && <p role="status" className="text-sm text-accent">{message}</p>}
      {report?.answer && <section aria-label="Tucky’s answer" className="rounded-lg border border-line bg-surface p-4 text-sm"><Markdown>{report.answer}</Markdown></section>}
      {report?.sources && report.sources.length > 0 && <details className="rounded-lg border border-line bg-surface p-3 text-xs">
        <summary className="cursor-pointer font-medium">Email sources consulted ({report.sources.length})</summary>
        <ul className="mt-3 space-y-2">{report.sources.map((s) => <li key={`${s.account_id}:${s.thread_id}`} className="break-words"><button className="text-left font-semibold underline underline-offset-2" onClick={() => void gmailOpenThread(s.account_id, s.thread_id).catch((e) => setError(String(e)))}>{s.subject || "(No subject)"}</button><p className="text-muted">{s.from} · {s.date} · {s.account}</p></li>)}</ul>
      </details>}
      {draft && <section aria-label="Email draft" className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="border-b border-line px-4 py-3"><h2 className="text-sm font-semibold">{draft.reply_to ? "Reply for review" : "Email for review"}</h2>
          <p className="mt-1 break-all text-xs text-muted">From: <span className="font-medium text-fg">{draft.from}</span></p>
          <p className="mt-1 text-xs text-muted">{draft.status === "sent" ? "Sent" : draft.saved_revision === draft.revision ? "This version is saved in Gmail" : "Local draft"}</p></div>
        {draft.reply_to && <details open className="border-b border-line bg-canvas/60 px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold">Replying to: {draft.reply_to.subject || "(No subject)"}</summary>
          <p className="mt-2 break-words text-xs text-muted">{draft.reply_to.from} · {draft.reply_to.date}</p>
          <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm">{draft.reply_to.body || draft.reply_to.snippet}</p>
          {draft.reply_to.partial && <p className="mt-2 text-xs text-muted">Partial email excerpt. Attachments are not included.</p>}
          <button className="mt-2 text-xs font-medium text-accent underline underline-offset-2" onClick={() => void gmailOpenThread(draft.account_id, draft.reply_to!.thread_id).catch((e) => setError(String(e)))}>Open original conversation in Gmail</button>
        </details>}
        <div className="space-y-3 p-4">
          {(["to", "cc", "subject"] as const).map((key) => <div key={key} className="grid gap-1 sm:grid-cols-[60px_1fr] sm:items-center">
            <label htmlFor={`draft-${key}`} className="text-xs font-medium">{{ to: "To", cc: "Cc", subject: "Subject" }[key]}</label>
            <input id={`draft-${key}`} className={fieldClass} value={fields[key]} disabled={locked || (key === "subject" && !!draft.reply_to)} onChange={(e) => change(key, e.target.value)} maxLength={key === "subject" ? 1000 : 2000} />
          </div>)}
          <label htmlFor="draft-body" className="block text-xs font-medium">Message</label>
          <textarea id="draft-body" className={`${fieldClass} min-h-56 resize-y`} rows={10} value={fields.body} disabled={locked} onChange={(e) => change("body", e.target.value)} maxLength={64000} />
          <p className="text-xs text-muted">Say “Tucky, make this shorter” to edit with the draft and original email as context. Ordinary dictation inserts text at your cursor.</p>
          {unresolved && <p role="alert" className="rounded-md bg-canvas p-3 text-sm">The previous save or send has an unresolved result. Check Gmail Drafts and Sent before preparing another email. Tucky will not automatically retry it.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {(draft.gmail_id || unresolved) && <button className={buttonClass} onClick={() => void gmailOpenDraft(draft.id).catch((e) => setError(String(e)))}>Open Gmail</button>}
            {draft.status === "review" && <><button className={buttonClass} disabled={locked} onClick={() => void remoteWrite(false)}>Save to Gmail</button>
              <button className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50" disabled={locked || !fields.to.trim() || !fields.body.trim()} onClick={() => setConfirmSend(true)}>Send…</button></>}
          </div>
          {confirmSend && <div role="region" aria-label="Confirm email send" className="space-y-3 rounded-lg border border-accent bg-canvas p-4">
            <p className="break-words text-sm">Send this email from <strong>{draft.from}</strong> to <strong>{fields.to}</strong>{fields.cc ? `, copying ${fields.cc}` : ""}?</p>
            <p className="break-words text-xs text-muted">{fields.subject}</p>
            <div className="flex justify-end gap-2"><button className={buttonClass} onClick={() => setConfirmSend(false)}>Keep editing</button><button disabled={locked} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50" onClick={() => void remoteWrite(true)}>Send email</button></div>
          </div>}
        </div>
      </section>}
      {!draft && !report && <p className="py-8 text-center text-sm text-muted">Connect a Gmail account in Settings → Gmail, then ask Tucky to find an email or write a draft.</p>}
    </div>
  </main>;
}
