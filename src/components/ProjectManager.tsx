import { useCallback, useEffect, useState } from "react";
import {
  archiveProject,
  createProject,
  listProjects,
  renameProject,
  unarchiveProject,
  type Project,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

type Props = {
  onChanged?: () => void;
};

export default function ProjectManager({ onChanged }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
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

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createProject(name);
      setNewName("");
      await refresh();
      onChanged?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Create failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const handleRename = async (p: Project) => {
    const next = renameValue.trim();
    if (!next || next === p.name) {
      setRenamingId(null);
      return;
    }
    try {
      await renameProject(p.id, next);
      setRenamingId(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Rename failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

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
      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New project name"
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1 text-sm focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!newName.trim()}
          className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          Create
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-neutral-400">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-neutral-400">
          No projects yet. Capture a thought referencing a new project, or
          create one above.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2"
            >
              {renamingId === p.id ? (
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRename(p);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
                  autoFocus
                />
              ) : (
                <span
                  className={`flex-1 truncate text-sm ${
                    p.archived_at ? "text-neutral-500 line-through" : "text-neutral-100"
                  }`}
                >
                  {p.name}
                </span>
              )}
              <div className="flex shrink-0 gap-1">
                {renamingId === p.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleRename(p)}
                      className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingId(null)}
                      className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setRenameValue(p.name);
                        setRenamingId(p.id);
                      }}
                      className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
                    >
                      Rename
                    </button>
                    {p.archived_at ? (
                      <button
                        type="button"
                        onClick={() => void handleUnarchive(p)}
                        className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
                      >
                        Unarchive
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleArchive(p)}
                        className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-red-950 hover:text-red-200"
                      >
                        Archive
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
