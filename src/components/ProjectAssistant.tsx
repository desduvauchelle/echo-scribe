import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import Dialog from "./a11y/Dialog";
import { useActivityPanel } from "./ActivityPanelContext";
import { getProjectAssistantReport, runProjectAssistant, stopProjectAssistant, revealProjectReference,
  type ProjectAssistantReport, type ProjectAssistantSource } from "../lib/api";

export default function ProjectAssistant() {
  const { t } = useTranslation();
  const { openItem } = useActivityPanel();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [report, setReport] = useState<ProjectAssistantReport | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = submitting || report?.status === "running";

  useEffect(() => {
    let disposed = false;
    let received = false;
    const unsubscribe = listen<ProjectAssistantReport>("project-assistant:report", ({ payload }) => {
      if (disposed) return;
      received = true; setReport(payload); setOpen(true);
      if (payload.status !== "running") setStopping(false);
    });
    void getProjectAssistantReport().then((saved) => {
      if (!disposed && !received && saved) { setReport(saved); if (saved.status === "running") setOpen(true); }
    }).catch(() => { /* A previous report is optional. */ });
    const show = () => { setOpen(true); setError(null); };
    window.addEventListener("project-assistant:open", show);
    return () => { disposed = true; void unsubscribe.then((fn) => fn()); window.removeEventListener("project-assistant:open", show); };
  }, []);

  const submit = async () => {
    if (busy || !request.trim()) return;
    setSubmitting(true); setError(null); setStopping(false); setReport(null);
    try { setReport(await runProjectAssistant(request.trim())); setRequest(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  };
  const showSource = async (source: ProjectAssistantSource) => {
    if (source.item_id) { setOpen(false); openItem(source.item_id); return; }
    if (source.folder_id && source.path) {
      try { await revealProjectReference(source.project_id, source.folder_id, source.path); }
      catch { setError(t("projectReferences.revealFailed")); }
    }
  };

  if (!open) return null;
  return <Dialog label={t("projectAssistant.title")} onClose={() => setOpen(false)} dismissible={!busy}
    panelClassName="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-xl">
    <div className="flex items-start justify-between gap-3 border-b border-line p-4">
      <div><h2 className="text-base font-semibold">{t("projectAssistant.title")}</h2>
        <p className="mt-1 text-xs text-muted">{t("projectAssistant.hint")}</p></div>
      {!busy && <button type="button" onClick={() => setOpen(false)} className="rounded border border-line px-3 py-1.5 text-xs hover:bg-elevated">{t("projectAssistant.close")}</button>}
    </div>
    <div className="min-h-0 overflow-y-auto p-4">
      {report && <div className="mb-4 flex flex-col gap-4">
        <p className="break-words rounded-lg bg-canvas p-3 text-sm">{report.request}</p>
        {busy && <p role="status" className="text-sm text-muted">{stopping ? t("projectAssistant.stopping") : t("projectAssistant.working")}</p>}
        {report.answer && <div className="prose prose-sm max-w-none break-words text-sm [&_p]:mb-3 [&_li]:ml-5 [&_ul]:list-disc [&_ol]:list-decimal">
          <ReactMarkdown components={{ a: ({ children }) => <span>{children}</span> }}>{report.answer}</ReactMarkdown>
        </div>}
        {report.changes.length > 0 && <section>
          <h3 className="text-xs font-semibold text-muted">{t("projectAssistant.changes")}</h3>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm">{report.changes.map((change, i) => <li key={i}>{change}</li>)}</ul>
        </section>}
        {report.sources.length > 0 && <section>
          <h3 className="text-xs font-semibold text-muted">{t("projectAssistant.references")}</h3>
          <ul className="mt-2 space-y-2">{report.sources.map((source) => <li key={source.number}>
            <button type="button" disabled={busy} onClick={() => void showSource(source)}
              className="w-full break-words rounded-md border border-line px-3 py-2 text-left text-xs hover:bg-elevated disabled:opacity-50">
              [{source.number}] {source.label}
            </button>
          </li>)}</ul>
        </section>}
      </div>}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {!busy && <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-2">
        <label htmlFor="project-assistant-request" className="text-xs font-medium">{t("projectAssistant.request")}</label>
        <textarea id="project-assistant-request" value={request} onChange={(e) => setRequest(e.target.value)} maxLength={2000} rows={3}
          placeholder={t("projectAssistant.placeholder")} className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none" />
        <p className="text-xs text-muted">{t("projectAssistant.independent")}</p>
        <button type="submit" disabled={!request.trim()} className="self-end rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50">{t("projectAssistant.ask")}</button>
      </form>}
      {busy && <button type="button" disabled={stopping} onClick={() => {
        setStopping(true); void stopProjectAssistant().catch(() => { setStopping(false); setError(t("projectAssistant.stopFailed")); });
      }} className="rounded-md border border-line px-3 py-2 text-sm hover:bg-elevated disabled:opacity-50">{t("projectAssistant.stop")}</button>}
    </div>
  </Dialog>;
}
