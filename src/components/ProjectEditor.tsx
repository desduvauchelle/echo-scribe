import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  countItemsForProject,
  createProject,
  deleteProject,
  exportProjectBackfill,
  pickExportFolder,
  updateProject,
  type Project,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

type Props = {
  /** When null, the editor is in create mode. */
  project: Project | null;
  /** All other projects, used as reassignment targets on delete. */
  allProjects: Project[];
  onSaved: (p: Project) => void;
  onDeleted?: () => void;
  onCancel: () => void;
};

const COLOR_PALETTE = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
];

export default function ProjectEditor({
  project,
  allProjects,
  onSaved,
  onDeleted,
  onCancel,
}: Props) {
  const toasts = useToasts();
  const isEdit = project !== null;

  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [emoji, setEmoji] = useState(project?.emoji ?? "");
  const [color, setColor] = useState<string | null>(project?.color ?? null);
  const [keywordsInput, setKeywordsInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>(project?.keywords ?? []);
  const [aliases, setAliases] = useState<string[]>(project?.routing_aliases ?? []);
  const [appHints, setAppHints] = useState<string[]>(project?.routing_app_hints ?? []);
  const [urlHints, setUrlHints] = useState<string[]>(project?.routing_url_hints ?? []);
  const [windowHints, setWindowHints] = useState<string[]>(project?.routing_window_hints ?? []);
  const [positiveExamplesText, setPositiveExamplesText] = useState(
    (project?.routing_positive_examples ?? []).join("\n"),
  );
  const [negativeExamplesText, setNegativeExamplesText] = useState(
    (project?.routing_negative_examples ?? []).join("\n"),
  );
  const [exportFolder, setExportFolder] = useState<string | null>(
    project?.export_folder ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [itemCount, setItemCount] = useState<number | null>(null);

  useEffect(() => {
    if (!project) {
      setItemCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const n = await countItemsForProject(project.id);
        if (!cancelled) setItemCount(n);
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project]);

  const addKeyword = (raw: string) => {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return;
    if (keywords.includes(normalized)) return;
    setKeywords([...keywords, normalized]);
    setKeywordsInput("");
  };

  const removeKeyword = (kw: string) => {
    setKeywords(keywords.filter((k) => k !== kw));
  };

  const handleKeywordsKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(keywordsInput);
    } else if (
      e.key === "Backspace" &&
      keywordsInput === "" &&
      keywords.length > 0
    ) {
      removeKeyword(keywords[keywords.length - 1]);
    }
  };

  const lines = (text: string) =>
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toasts.push({ tone: "error", message: "Project name is required." });
      return;
    }
    // Flush any unsubmitted keyword in the input.
    const pendingKw = keywordsInput.trim().toLowerCase();
    const finalKeywords =
      pendingKw && !keywords.includes(pendingKw)
        ? [...keywords, pendingKw]
        : keywords;

    setSaving(true);
    try {
      if (isEdit && project) {
        const updated = await updateProject(project.id, {
          name: trimmedName,
          description: description.trim() || null,
          keywords: finalKeywords,
          color: color || null,
          emoji: emoji.trim() || null,
          export_folder: exportFolder || null,
          routing_aliases: aliases,
          routing_app_hints: appHints,
          routing_url_hints: urlHints,
          routing_window_hints: windowHints,
          routing_positive_examples: lines(positiveExamplesText),
          routing_negative_examples: lines(negativeExamplesText),
        });
        onSaved(updated);
      } else {
        const created = await createProject({
          name: trimmedName,
          description: description.trim() || undefined,
          keywords: finalKeywords,
          color: color || undefined,
          emoji: emoji.trim() || undefined,
          routing_aliases: aliases,
          routing_app_hints: appHints,
          routing_url_hints: urlHints,
          routing_window_hints: windowHints,
          routing_positive_examples: lines(positiveExamplesText),
          routing_negative_examples: lines(negativeExamplesText),
        });
        // Create endpoint doesn't accept export_folder; if one was chosen,
        // immediately patch the new project to set it.
        if (exportFolder) {
          const patched = await updateProject(created.id, {
            export_folder: exportFolder,
          });
          onSaved(patched);
        } else {
          onSaved(created);
        }
      }
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Save failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePickFolder = async () => {
    try {
      const chosen = await pickExportFolder();
      if (chosen) setExportFolder(chosen);
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Folder picker failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const handleBackfill = async () => {
    if (!project) return;
    if (!exportFolder) {
      toasts.push({
        tone: "error",
        message: "Pick an export folder first.",
      });
      return;
    }
    setBackfilling(true);
    try {
      const n = await exportProjectBackfill(project.id);
      toasts.push({
        tone: "success",
        message: `Exported ${n} file${n === 1 ? "" : "s"} to ${exportFolder}.`,
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Backfill failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBackfilling(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    const otherActive = allProjects.filter(
      (p) => p.id !== project.id && !p.archived_at,
    );
    const count = itemCount ?? 0;

    let reassignTo: string | null = null;
    if (count > 0 && otherActive.length > 0) {
      // Native confirm can't ask for a selection; surface the count and
      // ask the user via a follow-up prompt. For now, ask binary: reassign
      // to the FIRST other active project, or detach. A future iteration
      // could open a custom modal with a dropdown; this keeps Phase 1 lean.
      const target = otherActive[0];
      const choice = await ask(
        `Delete "${project.name}"? It has ${count} item${count === 1 ? "" : "s"}.\n\n` +
          `Click OK to reassign them to "${target.name}".\nClick Cancel to detach (items become unassigned).`,
        { title: "Delete project", kind: "warning" },
      );
      reassignTo = choice ? target.id : null;
      const confirmed = await ask(
        reassignTo
          ? `Confirm: delete "${project.name}" and move ${count} item${count === 1 ? "" : "s"} to "${target.name}"?`
          : `Confirm: delete "${project.name}" and detach ${count} item${count === 1 ? "" : "s"}?`,
        { title: "Delete project", kind: "warning" },
      );
      if (!confirmed) return;
    } else {
      const confirmed = await ask(
        count > 0
          ? `Delete "${project.name}"? Its ${count} item${count === 1 ? "" : "s"} will become unassigned.`
          : `Delete "${project.name}"?`,
        { title: "Delete project", kind: "warning" },
      );
      if (!confirmed) return;
    }

    setDeleting(true);
    try {
      await deleteProject(project.id, reassignTo);
      onDeleted?.();
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg">
          {isEdit ? "Edit project" : "New project"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
        >
          Close
        </button>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Name
        <div className="flex gap-2">
          <input
            type="text"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
            placeholder="📁"
            maxLength={4}
            className="w-12 rounded-md border border-line bg-canvas px-2 py-1 text-center text-sm focus:border-accent focus:outline-none"
            aria-label="Emoji"
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Sales"
            className="flex-1 rounded-md border border-line bg-canvas px-3 py-1 text-sm focus:border-accent focus:outline-none"
          />
        </div>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this project is about. Helps the classifier route captures here."
          rows={3}
          className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
        <span className="text-[10px] text-faint">
          Used by the classifier to decide whether new captures belong here.
        </span>
      </label>

      <div className="flex flex-col gap-1 text-xs text-muted">
        Keywords
        <div className="flex flex-wrap gap-1 rounded-md border border-line bg-canvas px-2 py-1.5">
          {keywords.map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-xs text-fg"
            >
              {kw}
              <button
                type="button"
                onClick={() => removeKeyword(kw)}
                className="text-faint hover:text-danger"
                aria-label={`Remove ${kw}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={keywordsInput}
            onChange={(e) => setKeywordsInput(e.target.value)}
            onKeyDown={handleKeywordsKey}
            onBlur={() => keywordsInput.trim() && addKeyword(keywordsInput)}
            placeholder={keywords.length === 0 ? "Type and press Enter" : ""}
            className="flex-1 min-w-24 bg-transparent text-sm focus:outline-none"
          />
        </div>
        <span className="text-[10px] text-faint">
          Topical hints (names, acronyms, codenames). Lowercase, deduped.
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <div>
          <h4 className="text-xs font-semibold text-fg">Routing</h4>
        </div>
        <RoutingChipEditor
          label="Aliases"
          values={aliases}
          onChange={setAliases}
          placeholder="livecase, hbsp, case simulation"
          lowercase
        />
        <RoutingChipEditor
          label="App hints"
          values={appHints}
          onChange={setAppHints}
          placeholder="Code, Google Chrome"
        />
        <RoutingChipEditor
          label="URL hints"
          values={urlHints}
          onChange={setUrlHints}
          placeholder="hbsp.harvard.edu, github.com/desduvauchelle/echo-scribe"
          lowercase
        />
        <RoutingChipEditor
          label="Window hints"
          values={windowHints}
          onChange={setWindowHints}
          placeholder="echo-scribe, livecaseplus"
          lowercase
        />
        <label className="flex flex-col gap-1 text-xs text-muted">
          Positive examples
          <textarea
            value={positiveExamplesText}
            onChange={(e) => setPositiveExamplesText(e.target.value)}
            rows={3}
            placeholder="One capture example per line"
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Negative examples
          <textarea
            value={negativeExamplesText}
            onChange={(e) => setNegativeExamplesText(e.target.value)}
            rows={2}
            placeholder="Phrases that should not route here"
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted">
        Color
        <div className="flex items-center gap-2">
          {COLOR_PALETTE.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setColor(c === color ? null : c)}
              className={`h-6 w-6 rounded-full border-2 ${c === color ? "border-fg" : "border-transparent"}`}
              style={{ backgroundColor: c }}
              aria-label={`Color ${c}`}
            />
          ))}
          <input
            type="text"
            value={color ?? ""}
            onChange={(e) => setColor(e.target.value || null)}
            placeholder="#hex"
            className="w-20 rounded-md border border-line bg-canvas px-2 py-1 text-xs focus:border-accent focus:outline-none"
          />
          {color && (
            <button
              type="button"
              onClick={() => setColor(null)}
              className="text-xs text-faint hover:text-danger"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted">
        Export folder
        <div className="flex items-center gap-2">
          {exportFolder ? (
            <>
              <span
                className="flex-1 truncate rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-fg"
                title={exportFolder}
              >
                {exportFolder}
              </span>
              <button
                type="button"
                onClick={() => void handlePickFolder()}
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elevated"
              >
                Change…
              </button>
              <button
                type="button"
                onClick={() => setExportFolder(null)}
                className="text-xs text-faint hover:text-danger"
              >
                Clear
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void handlePickFolder()}
              className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated"
            >
              Choose folder…
            </button>
          )}
        </div>
        <span className="text-[10px] text-faint">
          High-confidence items routed to this project are exported as markdown
          here. Notes / tasks / transcriptions go into subfolders by kind.
        </span>
        {isEdit && exportFolder && (
          <button
            type="button"
            onClick={() => void handleBackfill()}
            disabled={backfilling || saving}
            className="self-start mt-1 rounded-md border border-line px-2 py-1 text-[11px] hover:bg-elevated disabled:opacity-50"
          >
            {backfilling ? "Exporting…" : "Re-export all existing items"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <div>
          {isEdit && (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleting || saving}
              className="rounded-md border border-danger/40 px-3 py-1 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete project"}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoutingChipEditor({
  label,
  values,
  onChange,
  placeholder,
  lowercase = false,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  lowercase?: boolean;
}) {
  const [input, setInput] = useState("");

  const normalize = (raw: string) => {
    const trimmed = raw.trim();
    return lowercase ? trimmed.toLowerCase() : trimmed;
  };
  const add = (raw: string) => {
    const next = normalize(raw);
    if (!next || values.includes(next)) return;
    onChange([...values, next]);
    setInput("");
  };
  const remove = (value: string) => onChange(values.filter((v) => v !== value));

  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <div className="flex flex-wrap gap-1 rounded-md border border-line bg-canvas px-2 py-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-xs text-fg"
          >
            {value}
            <button
              type="button"
              onClick={() => remove(value)}
              className="text-faint hover:text-danger"
              aria-label={`Remove ${value}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(input);
            } else if (e.key === "Backspace" && input === "" && values.length > 0) {
              remove(values[values.length - 1]);
            }
          }}
          onBlur={() => input.trim() && add(input)}
          placeholder={values.length === 0 ? placeholder : ""}
          className="flex-1 min-w-32 bg-transparent text-sm focus:outline-none"
        />
      </div>
    </div>
  );
}

/** Reusable badge showing a project's emoji + colored dot + name. Used wherever
 *  a project chip appears (item cards, filters, etc.). */
export function ProjectBadge({
  project,
  className = "",
}: {
  project: Pick<Project, "name" | "color" | "emoji"> | null;
  className?: string;
}) {
  if (!project) {
    return (
      <span className={`text-xs text-faint ${className}`}>Unassigned</span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${className}`}>
      {project.emoji && <span>{project.emoji}</span>}
      {project.color && !project.emoji && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: project.color }}
        />
      )}
      <span className="truncate">{project.name}</span>
    </span>
  );
}
