import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { FormConfig, FormField } from "../lib/liveForm";

export default function LiveFormEditor({ value, onChange }: { value: FormConfig; onChange: (next: FormConfig) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | undefined>(value.fields[0]?.id);
  const field = value.fields.find(f => f.id === selected) ?? value.fields[0];
  const inputClass = "w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-fg focus:border-accent";
  const patch = (next: Partial<FormField>) => onChange({ ...value, fields: value.fields.map(f => f.id === field?.id ? { ...f, ...next } : f) });
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">{t("liveForm.fields")}</h3><p className="text-xs text-muted">{t("liveForm.fieldsHint")}</p></div>
      <button type="button" className="flex items-center gap-1 rounded border border-line px-2 py-1 text-xs disabled:opacity-50" disabled={value.fields.length >= 12} onClick={() => {
        const id = crypto.randomUUID(); onChange({ ...value, fields: [...value.fields, { id, name: "", format: "text", instructions: "", required: false, choices: [] }] }); setSelected(id);
      }}><Plus size={14} aria-hidden="true" />{t("liveForm.addField")}</button></div>
    <div className="grid gap-3 sm:grid-cols-[minmax(110px,0.8fr)_minmax(0,1.4fr)]">
      <div className="flex flex-col gap-1" aria-label={t("liveForm.fields")}>{value.fields.map(f => <button key={f.id} type="button" className={`rounded-md px-2 py-2 text-left text-xs ${field?.id === f.id ? "bg-accent-soft text-accent" : "border border-line"}`} aria-pressed={field?.id === f.id} onClick={() => setSelected(f.id)}>{f.name || t("liveForm.newField")}</button>)}</div>
      {field && <div className="space-y-3 rounded-md border border-line bg-surface p-3">
        <div className="flex items-center justify-between"><span className="text-sm">{field.name || t("liveForm.newField")}</span><button type="button" aria-label={t("liveForm.removeField")} title={t("liveForm.removeField")} className="rounded p-1 hover:bg-danger/15" onClick={() => { onChange({ ...value, fields: value.fields.filter(f => f.id !== field.id) }); setSelected(value.fields.find(f => f.id !== field.id)?.id); }}><Trash2 size={14} /></button></div>
        <label className="block space-y-1 text-xs text-muted">{t("liveForm.fieldName")}<input className={inputClass} value={field.name} maxLength={100} onChange={e => patch({ name: e.target.value })} /></label>
        <label className="block space-y-1 text-xs text-muted">{t("liveForm.format")}<select className={inputClass} value={field.format} onChange={e => patch({ format: e.target.value as FormField["format"] })}>{(["text", "long", "email", "number", "date", "choice"] as const).map(format => <option key={format} value={format}>{t(`liveForm.formats.${format}`)}</option>)}</select></label>
        {field.format === "choice" && <label className="block space-y-1 text-xs text-muted">{t("liveForm.choices")}<textarea className={inputClass} value={field.choices.join("\n")} onChange={e => patch({ choices: e.target.value.split("\n") })} /></label>}
        <label className="block space-y-1 text-xs text-muted">{t("liveForm.listenFor")}<textarea className={`${inputClass} min-h-[80px]`} maxLength={500} value={field.instructions} onChange={e => patch({ instructions: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={field.required} onChange={e => patch({ required: e.target.checked })} />{t("liveForm.required")}</label>
      </div>}
    </div>
    <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
      <label className="block space-y-1 text-xs text-muted">{t("liveForm.whoseAnswers")}<select className={inputClass} value={value.speaker} onChange={e => onChange({ ...value, speaker: e.target.value as FormConfig["speaker"] })}>{["them", "all", "you"].map(s => <option key={s} value={s}>{t(`liveForm.speakers.${s}`)}</option>)}</select></label>
      <label className="block space-y-1 text-xs text-muted">{t("liveForm.uncertain")}<select className={inputClass} value={value.uncertainty} onChange={e => onChange({ ...value, uncertainty: e.target.value as FormConfig["uncertainty"] })}>{["review", "empty"].map(s => <option key={s} value={s}>{t(`liveForm.uncertainty.${s}`)}</option>)}</select></label>
      {(["explicit_only", "protect_manual", "show_evidence"] as const).map(key => <label key={key} className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={value[key]} onChange={e => onChange({ ...value, [key]: e.target.checked })} />{t(`liveForm.options.${key}`)}</label>)}
    </div>
  </div>;
}
