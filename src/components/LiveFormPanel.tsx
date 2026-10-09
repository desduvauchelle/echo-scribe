import { useState } from "react";
import { Pencil, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formProgress, formTimestamp, type FormConfig, type FormAnswer } from "../lib/liveForm";
import "./LiveFormPanel.css";

export default function LiveFormPanel({ config, answers, onSave }: { config: FormConfig; answers: FormAnswer[]; onSave?: (id: string, value: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const progress = formProgress(config, answers);
  const save = async (id: string) => { if (!onSave || saving) return; setSaving(true); setError(""); try { await onSave(id, draft); setEditing(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); } };
  return <div className="live-form">
    <div className="form-progress" aria-live="polite"><span>{t("liveForm.label")}</span><span>{t("liveForm.progress", progress)}{progress.review > 0 ? ` · ${t("liveForm.reviewCount", { count: progress.review })}` : ""}</span></div>
    <div className="form-track" aria-hidden="true"><span style={{ width: `${100 * progress.filled / Math.max(1, progress.total)}%` }} /></div>
    {config.fields.map(field => {
      const answer = answers.find(a => a.id === field.id);
      const status = answer?.status ?? "waiting";
      return <div className="form-field" key={field.id}>
        <div className="form-field-head"><span className="form-field-name">{field.name}{field.required ? " *" : ""}</span><div className="form-actions"><span className={`form-status ${status}`}>{t(`liveForm.status.${status}`)}</span>
          {config.show_evidence && answer?.quote && <button type="button" className="form-icon" title={t("liveForm.viewSource")} aria-label={t("liveForm.sourceFor", { name: field.name })} aria-expanded={source === field.id} onClick={() => setSource(source === field.id ? null : field.id)}><Quote size={14} aria-hidden="true" /></button>}
          {onSave && <button type="button" className="form-icon" title={t("liveForm.editAnswer")} aria-label={t("liveForm.editField", { name: field.name })} aria-expanded={editing === field.id} onClick={() => { setEditing(editing === field.id ? null : field.id); setDraft(answer?.value ?? ""); setError(""); }}><Pencil size={14} aria-hidden="true" /></button>}
        </div></div>
        <div className={`form-value ${answer?.value ? "" : "empty"}`}>{answer?.value || t(answer?.status === "manual" ? "liveForm.cleared" : "liveForm.waiting")}</div>
        {source === field.id && answer?.quote && <blockquote className="form-source"><span>{t(`liveForm.speakers.${answer.speaker}`, { defaultValue: answer.speaker })} · {formTimestamp(answer.start_ms)}</span><p>“{answer.quote}”</p></blockquote>}
        {editing === field.id && <form className="form-edit" onSubmit={e => { e.preventDefault(); void save(field.id); }}>
          <label><span className="sr-only">{t("liveForm.editField", { name: field.name })}</span>{field.format === "choice" ? <select autoFocus value={draft} onChange={e => setDraft(e.target.value)}><option value="">{t("liveForm.clearAnswer")}</option>{field.choices.map(choice => <option key={choice}>{choice}</option>)}</select> : field.format === "long" ? <textarea autoFocus value={draft} maxLength={1000} onChange={e => setDraft(e.target.value)} /> : <input autoFocus type={field.format === "email" || field.format === "date" || field.format === "number" ? field.format : "text"} step={field.format === "number" ? "any" : undefined} value={draft} maxLength={1000} onChange={e => setDraft(e.target.value)} />}</label>
          <div className="form-edit-controls"><button type="submit" disabled={saving}>{t(saving ? "liveForm.saving" : "liveForm.saveEdit")}</button><button type="button" disabled={saving} onClick={() => setEditing(null)}>{t("liveForm.cancel")}</button></div>
          {error && <p role="alert" className="form-error">{error}</p>}
        </form>}
      </div>;
    })}
    <p className="form-footnote">{progress.requiredComplete ? t("liveForm.requiredComplete") : t("liveForm.listening")}{config.protect_manual && onSave ? ` · ${t("liveForm.manualProtected")}` : ""}</p>
  </div>;
}
