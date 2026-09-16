import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getActionTriggerWord, getVoiceWorkflows, setVoiceWorkflows, type VoiceWorkflow } from "../lib/api";

export default function VoiceWorkflows() {
  const { t } = useTranslation("settings");
  const [items, setItems] = useState<VoiceWorkflow[]>([]);
  const [trigger, setTrigger] = useState("Tucky");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([getVoiceWorkflows(), getActionTriggerWord()]).then(([workflows, prefix]) => {
      if (active) { setItems(workflows); setTrigger(prefix); setLoading(false); }
    }).catch(() => { if (active) setError(t("workflows.loadError")); });
    return () => { active = false; };
  }, [t]);
  const update = (next: VoiceWorkflow[]) => { setItems(next); setSaved(false); setError(""); };
  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try { await setVoiceWorkflows(items.map(w => ({ ...w, phrase: w.phrase.trim(), url: w.url.trim() }))); setSaved(true); }
    catch (error) { setError(`${t("workflows.saveError")} ${String(error)}`); }
    finally { setBusy(false); }
  }
  const inputClass = "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm";
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p className="text-sm text-muted">{t("workflows.help", { trigger })}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {loading ? <p className="text-sm">{t("workflows.loading")}</p> : <>
      {items.length === 0 && <p className="text-sm text-muted">{t("workflows.empty")}</p>}
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        {items.map((item, index) => <div key={item.id} className="space-y-3 rounded-xl border border-line p-4">
          <label className="block space-y-1 text-sm" htmlFor={`phrase-${item.id}`}><span>{t("workflows.phrase")}</span>
            <input id={`phrase-${item.id}`} className={inputClass} required maxLength={120} value={item.phrase} placeholder="Pipe drive new authors" onChange={event => update(items.map(w => w.id === item.id ? { ...w, phrase: event.target.value } : w))} />
          </label>
          <label className="block space-y-1 text-sm" htmlFor={`url-${item.id}`}><span>{t("workflows.url")}</span>
            <input id={`url-${item.id}`} className={inputClass} required type="url" pattern="https?://.+" value={item.url} placeholder="https://…" onChange={event => update(items.map(w => w.id === item.id ? { ...w, url: event.target.value } : w))} />
          </label>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.enabled} onChange={event => update(items.map(w => w.id === item.id ? { ...w, enabled: event.target.checked } : w))} />{t("workflows.enabled")}</label>
            <button type="button" className="text-sm underline" aria-label={t("workflows.removeLabel", { index: index + 1 })} onClick={() => update(items.filter(w => w.id !== item.id))}>{t("workflows.remove")}</button>
          </div>
        </div>)}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="rounded-lg border border-line px-3 py-2 text-sm" disabled={items.length >= 32} onClick={() => update([...items, { id: crypto.randomUUID(), phrase: "", url: "", enabled: true }])}>{t("workflows.add")}</button>
          <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm text-white">{t(busy ? "workflows.saving" : "workflows.save")}</button>
          {saved && <span role="status" className="text-sm">{t("workflows.saved")}</span>}
        </div>
      </fieldset>
    </>}
  </form>;
}
