import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renameProject, type Project } from "../lib/api";

/** The toolbar name supports double-click, Enter/F2, Enter/blur to save,
 * and Escape to cancel. A ref prevents Enter followed by blur saving twice. */
export default function EditableProjectName({ project, onSaved }: {
  project: Project; onSaved: (name: string) => void;
}) {
  const { t } = useTranslation("main");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const begin = () => { setValue(project.name); setError(null); cancelled.current = false; setEditing(true); };
  const save = async () => {
    if (pending.current || cancelled.current) return;
    const name = value.trim();
    if (!name || name === project.name) { setEditing(false); return; }
    pending.current = true; setSaving(true); setError(null);
    try { await renameProject(project.id, name); onSaved(name); setEditing(false); }
    catch { setError(t("projectPage.renameFailed")); }
    finally { pending.current = false; setSaving(false); }
  };
  return <div className="min-w-0">
    {editing ? <input autoFocus aria-label={t("projectPage.nameLabel")} value={value} disabled={saving}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); void save(); }
        if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; setEditing(false); setError(null); }
      }}
      className="h-7 w-full min-w-0 rounded border border-accent bg-canvas px-2 text-sm font-semibold outline-none" />
      : <h1 className="min-w-0 truncate text-[12px] font-semibold leading-tight">
        <button type="button" className="block max-w-full truncate rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          title={t("projectPage.renameHint")} onDoubleClick={begin}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === "F2" || event.key === " ") { event.preventDefault(); begin(); } }}>
          {project.name}
        </button>
      </h1>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
