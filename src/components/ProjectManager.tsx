import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  archiveProject,
  deleteProject,
  getProjectDeleteImpact,
  listProjects,
  unarchiveProject,
  type Project,
  type ProjectDeleteImpact,
} from "../lib/api";
import Dialog from "./a11y/Dialog";
import { useToasts } from "./ToastProvider";
import ProjectEditor, { ProjectBadge } from "./ProjectEditor";

type Props = {
  onChanged?: () => void;
};

type EditTarget = { mode: "create" } | { mode: "edit"; project: Project } | null;

export default function ProjectManager({ onChanged }: Props) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditTarget>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteImpact, setDeleteImpact] =
    useState<ProjectDeleteImpact | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const toasts = useToasts();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ps = await listProjects(true);
      setProjects(ps);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("projectManager.loadFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setLoading(false);
    }
  }, [toasts, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!deleteTarget) {
      setDeleteImpact(null);
      setDeleteError(null);
      return;
    }

    let cancelled = false;
    setDeleteImpact(null);
    setDeleteError(null);
    void getProjectDeleteImpact(deleteTarget.id)
      .then((impact) => {
        if (!cancelled) setDeleteImpact(impact);
      })
      .catch((error) => {
        if (!cancelled) {
          setDeleteError(
            t("projectManager.checkLinkedContentFailed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deleteTarget, t]);

  const handleArchive = async (p: Project) => {
    try {
      await archiveProject(p.id);
      await refresh();
      onChanged?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("projectManager.archiveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
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
        message: t("projectManager.unarchiveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const handleDelete = async (deleteRelated: boolean) => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteProject(target.id, { deleteRelated });
      setDeleteTarget(null);
      setEdit(null);
      await refresh();
      onChanged?.();
      toasts.push({
        tone: "success",
        message: deleteRelated
          ? t("projectManager.deleteSuccessWithContent", { name: target.name })
          : t("projectManager.deleteSuccessUnassigned", { name: target.name }),
      });
    } catch (error) {
      setDeleteError(
        t("projectManager.deleteFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {edit ? (
        <ProjectEditor
          project={edit.mode === "edit" ? edit.project : null}
          onSaved={async () => {
            setEdit(null);
            await refresh();
            onChanged?.();
          }}
          onDeleteRequest={setDeleteTarget}
          onCancel={() => setEdit(null)}
        />
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setEdit({ mode: "create" })}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          >
            {t("projectManager.newProjectButton")}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted">{t("projectManager.loading")}</p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-muted">
          {t("projectManager.emptyState")}
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
                className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left ${
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
                  {t("projectManager.editButton")}
                </button>
                {p.archived_at ? (
                  <button
                    type="button"
                    onClick={() => void handleUnarchive(p)}
                    className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                  >
                    {t("projectManager.unarchiveButton")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleArchive(p)}
                    className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                  >
                    {t("projectManager.archiveButton")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDeleteTarget(p)}
                  aria-label={t("projectManager.deleteAriaLabel", { name: p.name })}
                  className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-0.5 text-xs text-danger hover:bg-danger/10"
                >
                  <Trash2 size={11} aria-hidden="true" />
                  {t("projectManager.deleteButton")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleteTarget && (
        <Dialog
          alert
          labelledBy="delete-project-title"
          dismissible={!deleteBusy}
          onClose={() => setDeleteTarget(null)}
          panelClassName="w-full max-w-lg rounded-xl border border-line bg-surface p-5 shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-full bg-danger/10 p-2 text-danger">
              <AlertTriangle size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h3
                id="delete-project-title"
                className="text-base font-semibold text-fg"
              >
                {t("projectManager.deleteDialogTitle", { name: deleteTarget.name })}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                {t("projectManager.deleteDialogDescription")}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-muted">
            {deleteImpact ? (
              <LinkedContentSummary impact={deleteImpact} />
            ) : deleteError ? (
              <span>{deleteError}</span>
            ) : (
              <span>{t("projectManager.checkingLinkedContent")}</span>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              autoFocus
              disabled={deleteBusy}
              onClick={() => void handleDelete(false)}
              className="rounded-lg border border-line px-4 py-3 text-left hover:bg-elevated disabled:opacity-50"
            >
              <span className="block text-sm font-semibold text-fg">
                {t("projectManager.deleteOnlyTitle")}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                {t("projectManager.deleteOnlyDescription")}
              </span>
            </button>
            <button
              type="button"
              disabled={deleteBusy || !deleteImpact}
              onClick={() => void handleDelete(true)}
              className="rounded-lg border border-danger/50 px-4 py-3 text-left hover:bg-danger/10 disabled:opacity-50"
            >
              <span className="block text-sm font-semibold text-danger">
                {t("projectManager.deleteWithContentTitle")}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                {t("projectManager.deleteWithContentDescription")}
              </span>
            </button>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            {t("projectManager.exportedFilesNote")}
          </p>

          {deleteError && deleteImpact && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {deleteError}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={deleteBusy}
              onClick={() => setDeleteTarget(null)}
              className="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-elevated disabled:opacity-50"
            >
              {deleteBusy ? t("projectManager.deleting") : t("projectManager.cancelButton")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function LinkedContentSummary({ impact }: { impact: ProjectDeleteImpact }) {
  const { t } = useTranslation();
  const details = [
    ["meetings", impact.meetings],
    ["notes", impact.notes],
    ["tasks", impact.tasks],
    ["transcriptions", impact.transcriptions],
    ["recordings", impact.recordings],
    ["chats", impact.chats],
    ["artifacts", impact.artifacts],
  ] as const;
  const populated = details
    .filter(([, count]) => count > 0)
    .map(([key, count]) => t(`projectManager.linkedItems.${key}`, { count }));

  if (populated.length === 0 && impact.items === 0) {
    return <span>{t("projectManager.noLinkedContent")}</span>;
  }

  const knownItems =
    impact.meetings + impact.notes + impact.tasks + impact.transcriptions;
  if (impact.items > knownItems) {
    const other = impact.items - knownItems;
    populated.unshift(t("projectManager.linkedItems.otherCaptures", { count: other }));
  }

  return (
    <span>
      {t("projectManager.linkedContentPrefix")}{" "}
      <strong className="font-semibold text-fg">{populated.join(", ")}</strong>.
    </span>
  );
}
