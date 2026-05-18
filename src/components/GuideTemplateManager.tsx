import { useCallback, useEffect, useState } from "react";
import {
  listGuideTemplates,
  createGuideTemplate,
  updateGuideTemplate,
  deleteGuideTemplate,
  type GuideTemplate,
} from "../lib/api";
import { useToasts } from "./ToastProvider";

type Draft = { name: string; description: string; goal: string; notes: string };

const EMPTY: Draft = { name: "", description: "", goal: "", notes: "" };

export default function GuideTemplateManager() {
  const toasts = useToasts();
  const [items, setItems] = useState<GuideTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    listGuideTemplates()
      .then(setItems)
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

  const editor = (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3">
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Name (e.g. Customer discovery)"
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        className="rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Short description"
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <textarea
        className="min-h-[48px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Goal — what should this conversation achieve?"
        value={draft.goal}
        onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
      />
      <textarea
        className="min-h-[96px] rounded-md border border-line bg-canvas px-2 py-1 text-sm focus:border-accent focus:outline-none"
        placeholder="Notes — questions to ask, talking points, context"
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
      {items.length === 0 && !creating && (
        <p className="text-xs text-muted">No guide templates yet.</p>
      )}
      {items.map((t) =>
        editingId === t.id ? (
          <div key={t.id}>{editor}</div>
        ) : (
          <li
            key={t.id}
            className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2"
          >
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
          </li>
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
