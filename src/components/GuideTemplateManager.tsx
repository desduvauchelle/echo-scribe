import { useCallback, useEffect, useState } from "react";
import {
  listGuideTemplates,
  createGuideTemplate,
  updateGuideTemplate,
  deleteGuideTemplate,
  listGuideInsightConfigs,
  setGuideInsightConfig,
  type GuideInsightConfig,
  type GuideTemplate,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

type Draft = { name: string; description: string; goal: string; notes: string };

const EMPTY: Draft = { name: "", description: "", goal: "", notes: "" };

export default function GuideTemplateManager() {
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

  const startEdit = (t: GuideTemplate) => {
    setCreating(false);
    setEditingId(t.id);
    setDraft({ name: t.name, description: t.description, goal: t.goal, notes: t.notes });
  };

  const cancel = () => {
    setCreating(false);
    setEditingId(null);
    setDraft(EMPTY);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toasts.push({ tone: "error", message: "Template name is required." });
      return;
    }
    try {
      if (creating) {
        await createGuideTemplate(draft.name, draft.description, draft.goal, draft.notes);
      } else if (editingId) {
        await updateGuideTemplate(
          editingId,
          draft.name,
          draft.description,
          draft.goal,
          draft.notes,
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
        placeholder="Name (e.g. Customer discovery)"
        aria-label="Template name"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Short description"
        aria-label="Description"
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <textarea
        className="min-h-[48px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Goal — what should this conversation achieve?"
        aria-label="Goal"
        value={draft.goal}
        onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
      />
      <textarea
        className="min-h-[96px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Notes — questions to ask, talking points, context"
        aria-label="Notes"
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover"
          onClick={() => void save()}
        >
          Save
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
          onClick={cancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Optionally run a rubric or conversation-signal check after each meeting. These checks use
        meeting transcripts only, stay separate from the main recap, and require exact quoted
        evidence for positive conclusions.
      </p>
      {items.length === 0 && !creating && (
        <p className="text-xs text-muted">No guide templates yet.</p>
      )}
      {items.map((t) =>
        editingId === t.id ? (
          <div key={t.id}>{editor}</div>
        ) : (
          <div key={t.id} className="rounded-md border border-line bg-surface px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">{t.name}</div>
                {t.description && (
                  <div className="truncate text-xs text-muted">{t.description}</div>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className="rounded border border-line px-2 py-0.5 text-xs hover:bg-elevated"
                  onClick={() => startEdit(t)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="rounded border border-line px-2 py-0.5 text-xs hover:bg-danger/15 hover:text-danger"
                  onClick={() => void remove(t.id)}
                >
                  Delete
                </button>
              </div>
            </div>
            {(() => {
              const config = configFor(t);
              return (
                <div className="mt-2 border-t border-line pt-2">
                  <label className="flex items-center gap-2 text-xs text-fg">
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(event) =>
                        void saveInsightConfig(t, { enabled: event.target.checked })
                      }
                    />
                    Track after meetings
                  </label>
                  {config.enabled && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-[11px] text-muted">
                        Measure
                        <select
                          className="rounded border border-line bg-canvas px-2 py-1 text-xs text-fg"
                          value={config.insight_kind}
                          onChange={(event) =>
                            void saveInsightConfig(t, {
                              insight_kind: event.target.value as GuideInsightConfig["insight_kind"],
                            })
                          }
                        >
                          <option value="rubric">Rubric performance</option>
                          <option value="signals">Conversation signals</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-[11px] text-muted">
                        Analyze
                        <select
                          className="rounded border border-line bg-canvas px-2 py-1 text-xs text-fg"
                          value={config.subject_scope}
                          onChange={(event) =>
                            void saveInsightConfig(t, {
                              subject_scope: event.target.value as GuideInsightConfig["subject_scope"],
                            })
                          }
                        >
                          <option value="you">My speech</option>
                          <option value="them">Other side</option>
                          <option value="interaction">The interaction</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-fg sm:col-span-2">
                        <input
                          type="checkbox"
                          checked={config.show_in_daily_recap}
                          onChange={(event) =>
                            void saveInsightConfig(t, {
                              show_in_daily_recap: event.target.checked,
                            })
                          }
                        />
                        Show results in Daily recap
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
          + New template
        </button>
      )}
    </div>
  );
}
