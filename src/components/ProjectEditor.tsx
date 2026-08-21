import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createProject,
  exportProjectBackfill,
  pickExportFolder,
  updateProject,
  type Project,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

type Props = {
  /** When null, the editor is in create mode. */
  project: Project | null;
  onSaved: (p: Project) => void;
  onDeleteRequest?: (project: Project) => void;
  onCancel: () => void;
};

const COLOR_PALETTE: Array<{ value: string; nameKey: string }> = [
  { value: "#ef4444", nameKey: "red" },
  { value: "#f97316", nameKey: "orange" },
  { value: "#eab308", nameKey: "yellow" },
  { value: "#22c55e", nameKey: "green" },
  { value: "#06b6d4", nameKey: "cyan" },
  { value: "#3b82f6", nameKey: "blue" },
  { value: "#8b5cf6", nameKey: "violet" },
  { value: "#ec4899", nameKey: "pink" },
];

export default function ProjectEditor({
  project,
  onSaved,
  onDeleteRequest,
  onCancel,
}: Props) {
  const { t } = useTranslation();
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
  const [backfilling, setBackfilling] = useState(false);

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
      toasts.push({ tone: "error", message: t("projectEditor.nameRequired") });
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
        message: t("projectEditor.saveFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
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
        message: t("projectEditor.folderPickerFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  };

  const handleBackfill = async () => {
    if (!project) return;
    if (!exportFolder) {
      toasts.push({
        tone: "error",
        message: t("projectEditor.pickFolderFirst"),
      });
      return;
    }
    setBackfilling(true);
    try {
      const n = await exportProjectBackfill(project.id);
      toasts.push({
        tone: "success",
        message: t("projectEditor.backfillSuccess", { count: n, folder: exportFolder }),
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: t("projectEditor.backfillFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg">
          {isEdit ? t("projectEditor.editHeading") : t("projectEditor.newHeading")}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
        >
          {t("projectEditor.close")}
        </button>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("projectEditor.nameLabel")}
        <div className="flex gap-2">
          <input
            type="text"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
            placeholder="📁"
            maxLength={4}
            className="w-12 rounded-md border border-line bg-canvas px-2 py-1 text-center text-sm focus:border-accent focus:outline-none"
            aria-label={t("projectEditor.emojiAriaLabel")}
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("projectEditor.namePlaceholder")}
            className="flex-1 rounded-md border border-line bg-canvas px-3 py-1 text-sm focus:border-accent focus:outline-none"
          />
        </div>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("projectEditor.descriptionLabel")}
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("projectEditor.descriptionPlaceholder")}
          rows={3}
          className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
        <span className="text-[10px] text-faint">
          {t("projectEditor.descriptionHint")}
        </span>
      </label>

      <div className="flex flex-col gap-1 text-xs text-muted">
        {t("projectEditor.keywordsLabel")}
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
                aria-label={t("projectEditor.removeItemAriaLabel", { item: kw })}
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
            placeholder={keywords.length === 0 ? t("projectEditor.keywordsPlaceholder") : ""}
            aria-label={t("projectEditor.keywordsLabel")}
            className="flex-1 min-w-24 bg-transparent text-sm focus:outline-none"
          />
        </div>
        <span className="text-[10px] text-faint">
          {t("projectEditor.keywordsHint")}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <div>
          <h4 className="text-xs font-semibold text-fg">{t("projectEditor.routingHeading")}</h4>
        </div>
        <RoutingChipEditor
          label={t("projectEditor.aliasesLabel")}
          values={aliases}
          onChange={setAliases}
          placeholder={t("projectEditor.aliasesPlaceholder")}
          lowercase
        />
        <RoutingChipEditor
          label={t("projectEditor.appHintsLabel")}
          values={appHints}
          onChange={setAppHints}
          placeholder={t("projectEditor.appHintsPlaceholder")}
        />
        <RoutingChipEditor
          label={t("projectEditor.urlHintsLabel")}
          values={urlHints}
          onChange={setUrlHints}
          placeholder={t("projectEditor.urlHintsPlaceholder")}
          lowercase
        />
        <RoutingChipEditor
          label={t("projectEditor.windowHintsLabel")}
          values={windowHints}
          onChange={setWindowHints}
          placeholder={t("projectEditor.windowHintsPlaceholder")}
          lowercase
        />
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("projectEditor.positiveExamplesLabel")}
          <textarea
            value={positiveExamplesText}
            onChange={(e) => setPositiveExamplesText(e.target.value)}
            rows={3}
            placeholder={t("projectEditor.positiveExamplesPlaceholder")}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("projectEditor.negativeExamplesLabel")}
          <textarea
            value={negativeExamplesText}
            onChange={(e) => setNegativeExamplesText(e.target.value)}
            rows={2}
            placeholder={t("projectEditor.negativeExamplesPlaceholder")}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted">
        {t("projectEditor.colorLabel")}
        <div className="flex items-center gap-2">
          {COLOR_PALETTE.map((c) => (
            <button
              type="button"
              key={c.value}
              onClick={() => setColor(c.value === color ? null : c.value)}
              className={`h-6 w-6 rounded-full border-2 ${c.value === color ? "border-fg" : "border-transparent"}`}
              style={{ backgroundColor: c.value }}
              aria-pressed={c.value === color}
              aria-label={t(`projectEditor.colorNames.${c.nameKey}`)}
            />
          ))}
          <input
            type="text"
            value={color ?? ""}
            onChange={(e) => setColor(e.target.value || null)}
            placeholder="#hex"
            aria-label={t("projectEditor.customColorAriaLabel")}
            className="w-20 rounded-md border border-line bg-canvas px-2 py-1 text-xs focus:border-accent focus:outline-none"
          />
          {color && (
            <button
              type="button"
              onClick={() => setColor(null)}
              className="text-xs text-faint hover:text-danger"
            >
              {t("projectEditor.clearButton")}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted">
        {t("projectEditor.exportFolderLabel")}
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
                {t("projectEditor.changeFolderButton")}
              </button>
              <button
                type="button"
                onClick={() => setExportFolder(null)}
                className="text-xs text-faint hover:text-danger"
              >
                {t("projectEditor.clearButton")}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void handlePickFolder()}
              className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated"
            >
              {t("projectEditor.chooseFolderButton")}
            </button>
          )}
        </div>
        <span className="text-[10px] text-faint">
          {t("projectEditor.exportFolderHint")}
        </span>
        {isEdit && exportFolder && (
          <button
            type="button"
            onClick={() => void handleBackfill()}
            disabled={backfilling || saving}
            className="self-start mt-1 rounded-md border border-line px-2 py-1 text-[11px] hover:bg-elevated disabled:opacity-50"
          >
            {backfilling ? t("projectEditor.exporting") : t("projectEditor.reexportButton")}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <div>
          {isEdit && (
            <button
              type="button"
              onClick={() => project && onDeleteRequest?.(project)}
              disabled={saving}
              className="rounded-md border border-danger/40 px-3 py-1 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              {t("projectEditor.deleteButton")}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elevated"
          >
            {t("projectEditor.cancelButton")}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
          >
            {saving
              ? t("projectEditor.saving")
              : isEdit
                ? t("projectEditor.saveButton")
                : t("projectEditor.createButton")}
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
  const { t } = useTranslation();
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
              aria-label={t("projectEditor.removeItemAriaLabel", { item: value })}
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
          aria-label={label}
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
  const { t } = useTranslation();
  if (!project) {
    return (
      <span className={`text-xs text-faint ${className}`}>{t("projectEditor.unassigned")}</span>
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
