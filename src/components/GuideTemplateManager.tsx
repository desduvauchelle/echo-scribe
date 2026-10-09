import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import Dialog from "./a11y/Dialog";
import { useTranslation } from "react-i18next";
import {
  listGuideTemplates,
  createGuideTemplate,
  updateGuideTemplate,
  deleteGuideTemplate,
  listGuideInsightConfigs,
  setGuideInsightConfig,
  type GuideInsightConfig,
  type GuideTemplate,
  type GuideTemplateKind,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

import LiveFormEditor from "./LiveFormEditor";
import { parseFormConfig, starterForm, type FormConfig } from "../lib/liveForm";

type Draft = {
  name: string;
  description: string;
  goal: string;
  notes: string;
  kind: GuideTemplateKind;
  form: FormConfig;
};

type InsightDraft = Omit<GuideInsightConfig, "template_id" | "updated_at">;

const DEFAULT_INSIGHT: InsightDraft = { enabled: false, show_in_daily_recap: true, insight_kind: "rubric", subject_scope: "you" };

const EMPTY: Draft = { name: "", description: "", goal: "", notes: "", kind: "checklist", form: starterForm() };

const KIND_OPTIONS: { value: GuideTemplateKind }[] = [
  { value: "checklist" },
  { value: "coach" },
  { value: "tracker" },
  { value: "form" },
];

const KIND_VALUES: GuideTemplateKind[] = KIND_OPTIONS.map((option) => option.value);

export default function GuideTemplateManager() {
  const { t } = useTranslation();
  const toasts = useToasts();
  const [items, setItems] = useState<GuideTemplate[]>([]);
  const [insightConfigs, setInsightConfigs] = useState<Record<string, GuideInsightConfig>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [draftInsight, setDraftInsight] = useState<InsightDraft>(DEFAULT_INSIGHT);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<GuideTemplate | null>(null);
  const titleId = useId();

  const refresh = useCallback(() => {
    Promise.all([listGuideTemplates(), listGuideInsightConfigs()])
      .then(([templates, configs]) => {
        setItems(templates);
        setInsightConfigs(Object.fromEntries(configs.map((config) => [config.template_id, config])));
      })
      .catch((e) =>
        toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, [toasts]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraft(EMPTY);
    setDraftInsight(DEFAULT_INSIGHT);
  };

  const startEdit = (tmpl: GuideTemplate) => {
    setCreating(false);
    setEditingId(tmpl.id);
    setDraftInsight(configFor(tmpl));
    setDraft({
      name: tmpl.name,
      description: tmpl.description,
      goal: tmpl.goal,
      notes: tmpl.kind === "form" ? "" : tmpl.notes,
      form: tmpl.kind === "form" ? parseFormConfig(tmpl.notes) ?? starterForm() : starterForm(),
      kind: KIND_VALUES.includes(tmpl.kind) ? tmpl.kind : "checklist",
    });
  };

  const cancel = () => {
    setCreating(false);
    setEditingId(null);
    setDraft(EMPTY);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toasts.push({ tone: "error", message: t("guideTemplateManager.nameRequired") });
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      let templateId = editingId;
      if (creating) {
        const created = await createGuideTemplate(
          draft.name,
          draft.description,
          draft.goal,
          draft.kind === "form" ? JSON.stringify(draft.form) : draft.notes,
          draft.kind,
        );
        templateId = created.id;
        // Keep the created ID if saving its tracking settings fails, so retry
        // updates this template instead of creating a duplicate.
        setEditingId(created.id);
        setCreating(false);
      } else if (editingId) {
        await updateGuideTemplate(
          editingId,
          draft.name,
          draft.description,
          draft.goal,
          draft.kind === "form" ? JSON.stringify(draft.form) : draft.notes,
          draft.kind,
        );
      }
      if (templateId && draft.kind !== "tracker" && draft.kind !== "form") {
        await setGuideInsightConfig({ ...draftInsight, template_id: templateId });
      }
      cancel();
      refresh();
    } catch (e) {
      refresh();
      toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (saving) return;
    setSaving(true);
    try {
      await deleteGuideTemplate(id);
      if (editingId === id) cancel();
      setPendingDelete(null);
      refresh();
    } catch (e) {
      toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const configFor = (template: GuideTemplate): GuideInsightConfig =>
    insightConfigs[template.id] ?? {
      template_id: template.id,
      enabled: false,
      show_in_daily_recap: true,
      insight_kind: template.id === "builtin-emotional-signals" ? "signals" : "rubric",
      subject_scope: template.id === "builtin-emotional-signals" ? "interaction" : "you",
      updated_at: "",
    };

  const editor = (
    <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4 disabled:opacity-70">
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("guideTemplateManager.nameAriaLabel")}
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t("guideTemplateManager.namePlaceholder")}
        aria-label={t("guideTemplateManager.nameAriaLabel")}
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("guideTemplateManager.descriptionAriaLabel")}
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t("guideTemplateManager.descriptionPlaceholder")}
        aria-label={t("guideTemplateManager.descriptionAriaLabel")}
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      </label>
      <h3 className="border-t border-line pt-4 text-sm font-semibold">{t("guideTemplateManager.duringMeeting")}</h3>
      <label className="flex flex-col gap-1 text-[11px] text-muted">
        {t("guideTemplateManager.guideStyleLabel")}
        <select
          className="rounded-md border border-line bg-canvas px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none"
          aria-label={t("guideTemplateManager.guideStyleLabel")}
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as GuideTemplateKind })}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(`guideTemplateManager.kind.${option.value}.label`)}
            </option>
          ))}
        </select>
        <span>{t(`guideTemplateManager.kind.${draft.kind}.hint`)}</span>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("guideTemplateManager.goalAriaLabel")}
      <textarea
        className="min-h-[48px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t("guideTemplateManager.goalPlaceholder")}
        aria-label={t("guideTemplateManager.goalAriaLabel")}
        value={draft.goal}
        onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
      />
      </label>
      {draft.kind === "form" ? <LiveFormEditor value={draft.form} onChange={form => setDraft({ ...draft, form })} /> : <label className="flex flex-col gap-1 text-xs text-muted">{t("guideTemplateManager.notesAriaLabel")}<textarea
        className="min-h-[96px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t(`guideTemplateManager.kind.${draft.kind}.notesPlaceholder`)}
        aria-label={t("guideTemplateManager.notesAriaLabel")}
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
      /></label>}
      {draft.kind !== "tracker" && draft.kind !== "form" && (
        <section className="space-y-3 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">{t("guideTemplateManager.afterMeeting")}</h3>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draftInsight.enabled} onChange={event => setDraftInsight({ ...draftInsight, enabled: event.target.checked })} />
            {t("guideTemplateManager.trackAfterMeetings")}
          </label>
          <p className="text-xs leading-relaxed text-muted">{t("guideTemplateManager.description")}</p>
          {draftInsight.enabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted">
                {t("guideTemplateManager.measureLabel")}
                <select className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-fg" value={draftInsight.insight_kind} onChange={event => setDraftInsight({ ...draftInsight, insight_kind: event.target.value as GuideInsightConfig["insight_kind"] })}>
                  <option value="rubric">{t("guideTemplateManager.rubricPerformance")}</option>
                  <option value="signals">{t("guideTemplateManager.conversationSignals")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                {t("guideTemplateManager.analyzeLabel")}
                <select className="rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-fg" value={draftInsight.subject_scope} onChange={event => setDraftInsight({ ...draftInsight, subject_scope: event.target.value as GuideInsightConfig["subject_scope"] })}>
                  <option value="you">{t("guideTemplateManager.mySpeech")}</option>
                  <option value="them">{t("guideTemplateManager.otherSide")}</option>
                  <option value="interaction">{t("guideTemplateManager.theInteraction")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input type="checkbox" checked={draftInsight.show_in_daily_recap} onChange={event => setDraftInsight({ ...draftInsight, show_in_daily_recap: event.target.checked })} />
                {t("guideTemplateManager.showResultsInDailyRecap")}
              </label>
            </div>
          )}
        </section>
      )}
    </fieldset>
  );

  const modal = !pendingDelete && (creating || editingId) && createPortal(
    <Dialog onClose={cancel} dismissible={!saving} labelledBy={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6"
      panelClassName="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-2xl">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">{t(creating ? "guideTemplateManager.createTitle" : "guideTemplateManager.editTitle")}</h2>
        <button type="button" onClick={cancel} disabled={saving} aria-label={t("guideTemplateManager.closeEditor")} className="rounded-md p-1.5 hover:bg-elevated disabled:opacity-50"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto px-5 py-4">{editor}</div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
        {editingId && !creating && <button
          type="button"
          className="mr-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/15 disabled:opacity-50"
          disabled={saving}
          onClick={() => setPendingDelete(items.find(item => item.id === editingId) ?? null)}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("guideTemplateManager.deleteTemplate")}
        </button>}
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          disabled={saving}
          onClick={() => void save()}
        >
          {t(saving ? "guideTemplateManager.savingButton" : "guideTemplateManager.saveButton")}
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
          disabled={saving}
          onClick={cancel}
        >
          {t("guideTemplateManager.cancelButton")}
        </button>
      </footer>
    </Dialog>, document.body,
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        {t("guideTemplateManager.listDescription")}
      </p>
      {items.length === 0 && !creating && (
        <p className="text-xs text-muted">{t("guideTemplateManager.emptyState")}</p>
      )}
      {items.map((tmpl) => (
          <div key={tmpl.id} className="rounded-md border border-line bg-surface px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-fg">{tmpl.name}</span>
                  <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-muted">
                    {t(
                      `guideTemplateManager.kind.${KIND_VALUES.includes(tmpl.kind) ? tmpl.kind : "checklist"}.label`,
                    )}
                  </span>
                </div>
                {tmpl.description && (
                  <div className="truncate text-xs text-muted">{tmpl.description}</div>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                  onClick={() => startEdit(tmpl)}
                >
                  {t("guideTemplateManager.editButton")}
                </button>
                <button
                  type="button"
                  className="rounded border border-line px-2 py-0.5 text-xs hover:bg-danger/15 hover:text-danger"
                  onClick={() => setPendingDelete(tmpl)}
                >
                  {t("guideTemplateManager.deleteButton")}
                </button>
              </div>
            </div>
          </div>
      ))}
      {modal}
      {pendingDelete && createPortal(
        <Dialog alert onClose={() => setPendingDelete(null)} dismissible={!saving}
          label={t("guideTemplateManager.deleteTitle")}
          panelClassName="w-full max-w-md rounded-xl border border-line bg-surface p-5 text-fg shadow-2xl">
          <h2 className="text-base font-semibold">{t("guideTemplateManager.deleteTitle")}</h2>
          <p className="mt-3 text-sm text-muted">{t("guideTemplateManager.deleteConfirmation", { name: pendingDelete.name })}</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={() => setPendingDelete(null)}
              className="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-elevated disabled:opacity-50">
              {t("guideTemplateManager.cancelButton")}
            </button>
            <button type="button" disabled={saving} onClick={() => void remove(pendingDelete.id)}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {t(saving ? "guideTemplateManager.deletingButton" : "guideTemplateManager.deleteTemplate")}
            </button>
          </div>
        </Dialog>, document.body,
      )}
      <button
          type="button"
          className="self-start rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
          onClick={startCreate}
        >
          {t("guideTemplateManager.newTemplateButton")}
      </button>
    </div>
  );
}
