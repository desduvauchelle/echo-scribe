import { useCallback, useEffect, useState } from "react";
import {
  archiveProject,
  listProjects,
  unarchiveProject,
  type Project,
} from "../lib/api";
import { useToasts } from "./ToastProvider";
import ProjectEditor, { ProjectBadge } from "./ProjectEditor";

type Props = {
  onChanged?: () => void;
};

type EditTarget = { mode: "create" } | { mode: "edit"; project: Project } | null;

export default function ProjectManager({ onChanged }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditTarget>(null);
  const toasts = useToasts();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ps = await listProjects(true);
      setProjects(ps);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Couldn't load projects: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setLoading(false);
    }
  }, [toasts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleArchive = async (p: Project) => {
    try {
      await archiveProject(p.id);
      await refresh();
      onChanged?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Archive failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const handleUnarchive = async (p: Project) => {
    try {
      await unarchiveProject(p.id);
      await refresh();
      onChanged?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Unarchive failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {edit ? (
        <ProjectEditor
          project={edit.mode === "edit" ? edit.project : null}
          allProjects={projects}
          onSaved={async () => {
            setEdit(null);
            await refresh();
            onChanged?.();
          }}
          onDeleted={async () => {
            setEdit(null);
            await refresh();
            onChanged?.();
          }}
          onCancel={() => setEdit(null)}
        />
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setEdit({ mode: "create" })}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          >
            New project
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-muted">
          No projects yet. Capture a thought referencing a new project, or
          create one above.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <li
              key={p.id}
              className="flex items-start justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2"
            >
              <button
                type="button"
                onClick={() => setEdit({ mode: "edit", project: p })}
                className={`flex flex-1 flex-col items-start gap-0.5 text-left ${
                  p.archived_at ? "opacity-60" : ""
                }`}
              >
                <ProjectBadge
                  project={p}
                  className={p.archived_at ? "line-through" : "font-medium"}
                />
                {p.description && (
                  <span className="line-clamp-1 text-[11px] text-muted">
                    {p.description}
                  </span>
                )}
                {p.keywords.length > 0 && (
                  <span className="flex flex-wrap gap-1 pt-0.5">
                    {p.keywords.slice(0, 6).map((kw) => (
                      <span
                        key={kw}
                        className="rounded-full bg-elevated px-1.5 py-0 text-[10px] text-faint"
                      >
                        {kw}
                      </span>
                    ))}
                  </span>
                )}
              </button>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => setEdit({ mode: "edit", project: p })}
                  className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                >
                  Edit
                </button>
                {p.archived_at ? (
                  <button
                    type="button"
                    onClick={() => void handleUnarchive(p)}
                    className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                  >
                    Unarchive
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleArchive(p)}
                    className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                  >
                    Archive
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
