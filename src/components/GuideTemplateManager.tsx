import { useCallback, useEffect, useState } from "react";
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

type Draft = {
  name: string;
  description: string;
  goal: string;
  notes: string;
  kind: GuideTemplateKind;
};

const EMPTY: Draft = { name: "", description: "", goal: "", notes: "", kind: "checklist" };

const KIND_OPTIONS: { value: GuideTemplateKind }[] = [
  { value: "checklist" },
  { value: "coach" },
  { value: "tracker" },
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
  };

  const startEdit = (tmpl: GuideTemplate) => {
    setCreating(false);
    setEditingId(tmpl.id);
    setDraft({
      name: tmpl.name,
      description: tmpl.description,
      goal: tmpl.goal,
      notes: tmpl.notes,
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
    try {
      if (creating) {
        await createGuideTemplate(
          draft.name,
          draft.description,
          draft.goal,
          draft.notes,
          draft.kind,
        );
      } else if (editingId) {
        await updateGuideTemplate(
          editingId,
          draft.name,
          draft.description,
          draft.goal,
          draft.notes,
          draft.kind,
        );
      }
      cancel();
      refresh();
    } catch (e) {
      toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteGuideTemplate(id);
      refresh();
    } catch (e) {
      toasts.push({ tone: "error", message: e instanceof Error ? e.message : String(e) });
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

  const saveInsightConfig = async (
    template: GuideTemplate,
    patch: Partial<Omit<GuideInsightConfig, "template_id" | "updated_at">>,
  ) => {
    const next = { ...configFor(template), ...patch };
    setInsightConfigs((current) => ({ ...current, [template.id]: next }));
    try {
      const saved = await setGuideInsightConfig(next);
      setInsightConfigs((current) => ({ ...current, [template.id]: saved }));
    } catch (error) {
      refresh();
      toasts.push({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const editor = (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3">
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t("guideTemplateManager.namePlaceholder")}
        aria-label={t("guideTemplateManager.nameAriaLabel")}
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t("guideTemplateManager.descriptionPlaceholder")}
        aria-label={t("guideTemplateManager.descriptionAriaLabel")}
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
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
      <textarea
        className="min-h-[48px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t("guideTemplateManager.goalPlaceholder")}
        aria-label={t("guideTemplateManager.goalAriaLabel")}
        value={draft.goal}
        onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
      />
      <textarea
        className="min-h-[96px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder={t(`guideTemplateManager.kind.${draft.kind}.notesPlaceholder`)}
        aria-label={t("guideTemplateManager.notesAriaLabel")}
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          onClick={() => void save()}
        >
          {t("guideTemplateManager.saveButton")}
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
          onClick={cancel}
        >
          {t("guideTemplateManager.cancelButton")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        {t("guideTemplateManager.description")}
      </p>
      {items.length === 0 && !creating && (
        <p className="text-xs text-muted">{t("guideTemplateManager.emptyState")}</p>
      )}
      {items.map((tmpl) =>
        editingId === tmpl.id ? (
          <div key={tmpl.id}>{editor}</div>
        ) : (
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
                  onClick={() => void remove(tmpl.id)}
                >
                  {t("guideTemplateManager.deleteButton")}
                </button>
              </div>
            </div>
            {(() => {
              // Trackers produce live notes, not a gradable rubric — the
              // post-meeting insight review doesn't apply to them.
              if (tmpl.kind === "tracker") return null;
              const config = configFor(tmpl);
              return (
                <div className="mt-2 border-t border-line pt-2">
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(event) =>
                        void saveInsightConfig(tmpl, { enabled: event.target.checked })
                      }
                    />
                    {t("guideTemplateManager.trackAfterMeetings")}
                  </label>
                  {config.enabled && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-[11px] text-muted">
                        {t("guideTemplateManager.measureLabel")}
                        <select
                          className="rounded border border-line bg-canvas px-2 py-1 text-xs text-fg"
                          value={config.insight_kind}
                          onChange={(event) =>
                            void saveInsightConfig(tmpl, {
                              insight_kind: event.target.value as GuideInsightConfig["insight_kind"],
                            })
                          }
                        >
                          <option value="rubric">{t("guideTemplateManager.rubricPerformance")}</option>
                          <option value="signals">{t("guideTemplateManager.conversationSignals")}</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-[11px] text-muted">
                        {t("guideTemplateManager.analyzeLabel")}
                        <select
                          className="rounded border border-line bg-canvas px-2 py-1 text-xs text-fg"
                          value={config.subject_scope}
                          onChange={(event) =>
                            void saveInsightConfig(tmpl, {
                              subject_scope: event.target.value as GuideInsightConfig["subject_scope"],
                            })
                          }
                        >
                          <option value="you">{t("guideTemplateManager.mySpeech")}</option>
                          <option value="them">{t("guideTemplateManager.otherSide")}</option>
                          <option value="interaction">{t("guideTemplateManager.theInteraction")}</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-fg sm:col-span-2">
                        <input
                          type="checkbox"
                          checked={config.show_in_daily_recap}
                          onChange={(event) =>
                            void saveInsightConfig(tmpl, {
                              show_in_daily_recap: event.target.checked,
                            })
                          }
                        />
                        {t("guideTemplateManager.showResultsInDailyRecap")}
                      </label>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ),
      )}
      {creating ? (
        editor
      ) : (
        <button
          type="button"
          className="self-start rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
          onClick={startCreate}
        >
          {t("guideTemplateManager.newTemplateButton")}
        </button>
      )}
    </div>
  );
}
