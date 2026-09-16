import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus } from "lucide-react";
import { pickReferenceFolders, referenceFolderStatus, revealProjectReference, type Project, type ProjectFolder } from "../lib/api";

export default function ProjectReferences({ project, folders, onChange, disabled, onBusyChange }: {
  project: Project | null; folders: ProjectFolder[]; onChange: (folders: ProjectFolder[]) => void;
  disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setStatus({});
    void referenceFolderStatus(folders).then((results) => {
      if (!cancelled) setStatus(Object.fromEntries(results.map((r) => [r.id, r.available])));
    }).catch(() => { if (!cancelled) setError(t("projectReferences.statusFailed")); });
    return () => { cancelled = true; };
  }, [folders, t]);

  const choose = async (replacing?: string) => {
    setError(null); setPicking(true); onBusyChange(true);
    try {
      const selected = await pickReferenceFolders();
      if (!selected.length) return;
      if (replacing && selected.length !== 1) { setError(t("projectReferences.chooseOne")); return; }
      const next = replacing
        ? folders.map((f) => f.id === replacing ? { ...selected[0], id: f.id } : f)
        : [...folders, ...selected];
      const unique = next.filter((f, i) => next.findIndex((other) => other.path === f.path) === i);
      if (unique.length > 12) { setError(t("projectReferences.limit")); return; }
      onChange(unique);
    } catch { setError(t("projectReferences.chooseFailed")); }
    finally { setPicking(false); onBusyChange(false); }
  };
  return <section aria-label={t("projectReferences.heading")} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3">
    <div>
      <h4 className="text-sm font-semibold text-fg">{t("projectReferences.heading")}</h4>
      <p className="mt-1 text-xs text-muted">{t("projectReferences.hint")}</p>
    </div>
    {folders.length > 0 && <ul className="flex flex-col gap-2">
      {folders.map((folder) => {
        const name = folder.path.split(/[\\/]/).filter(Boolean).pop() ?? folder.path;
        const saved = project?.reference_folders?.some((f) => f.id === folder.id && f.path === folder.path);
        return <li key={folder.id} className="min-w-0 rounded-md border border-line bg-surface p-3">
          <div className="flex min-w-0 items-start gap-2">
            <FolderOpen size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium text-fg">{name}</p>
              <p className="break-all text-xs text-muted">{folder.path}</p>
              <p className={`mt-1 text-xs ${status[folder.id] === false ? "text-danger" : "text-muted"}`}>
                {status[folder.id] === false ? t("projectReferences.unavailable") : status[folder.id] === true ? t("projectReferences.readOnly") : t("projectReferences.checking")}
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {saved && project && <button type="button" disabled={disabled || picking || status[folder.id] === false}
              className="rounded border border-line px-2 py-1.5 hover:bg-elevated disabled:opacity-50"
              onClick={() => void revealProjectReference(project.id, folder.id).catch(() => setError(t("projectReferences.revealFailed")))}>{t("projectReferences.reveal")}</button>}
            <button type="button" disabled={disabled || picking} className="rounded border border-line px-2 py-1.5 hover:bg-elevated disabled:opacity-50"
              onClick={() => void choose(folder.id)}>{t("projectReferences.reconnect")}</button>
            <button type="button" disabled={disabled || picking} className="rounded border border-line px-2 py-1.5 hover:bg-elevated disabled:opacity-50"
              aria-label={t("projectReferences.removeNamed", { name })} onClick={() => onChange(folders.filter((f) => f.id !== folder.id))}>{t("projectReferences.remove")}</button>
          </div>
        </li>;
      })}
    </ul>}
    <button type="button" disabled={disabled || picking || folders.length >= 12} onClick={() => void choose()}
      className="inline-flex self-start items-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs hover:bg-elevated disabled:opacity-50">
      <Plus size={14} aria-hidden="true" />{picking ? t("projectReferences.choosing") : t("projectReferences.add")}
    </button>
    <p className="text-xs text-muted">{t("projectReferences.formats")}</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
