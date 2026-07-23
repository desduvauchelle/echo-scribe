import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelLogCapture,
  confirmLogCapture,
  type Classification,
  type LogCaptureClassificationReady,
} from "../lib/api";

type Stage =
  | { kind: "hidden" }
  | { kind: "recording" }
  | {
      kind: "ready";
      transcript: string;
      classification: Classification | null;
      error?: string;
    };

type EditState = {
  content: string;
  itemKind: "note" | "task";
  projectId: string | null;
  newProjectName: string;
  tagsInput: string;
  deadlineIso: string;
};

function defaultEditState(
  transcript: string,
  cls: Classification | null,
): EditState {
  return {
    content: transcript,
    itemKind: cls?.kind ?? "note",
    projectId: cls?.project_id ?? null,
    newProjectName: cls?.new_project_name ?? "",
    tagsInput: cls?.tags?.join(", ") ?? "",
    deadlineIso: cls?.deadline_iso ?? "",
  };
}

export default function LogCaptureOverlay() {
  const [stage, setStage] = useState<Stage>({ kind: "hidden" });
  const [edit, setEdit] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to backend events.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const u1 = await listen("log_capture:recording_started", () => {
        if (cancelled) return;
        setError(null);
        setStage({ kind: "recording" });
      });
      const u2 = await listen<LogCaptureClassificationReady>(
        "log_capture:classification_ready",
        (event) => {
          if (cancelled) return;
          const { transcript, classification, error: clsError } =
            event.payload;
          setEdit(defaultEditState(transcript, classification));
          setStage({
            kind: "ready",
            transcript,
            classification,
            error: clsError,
          });
        },
      );
      const u3 = await listen("log_capture:cancelled", () => {
        if (cancelled) return;
        setStage({ kind: "hidden" });
        setEdit(null);
      });
      const u4 = await listen("log_capture:auto_filed", () => {
        if (cancelled) return;
        setStage({ kind: "hidden" });
        setEdit(null);
      });
      if (cancelled) {
        u1();
        u2();
        u3();
        u4();
      } else {
        unlisteners.push(u1, u2, u3, u4);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  if (stage.kind === "hidden") return null;

  const onSave = async () => {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      const tags = edit.tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await confirmLogCapture({
        content: edit.content,
        kind: edit.itemKind,
        project_id: edit.projectId && !edit.newProjectName ? edit.projectId : null,
        new_project_name: edit.newProjectName.trim() || null,
        tags,
        deadline_iso:
          edit.itemKind === "task" && edit.deadlineIso.trim()
            ? edit.deadlineIso.trim()
            : null,
      });
      setStage({ kind: "hidden" });
      setEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelLogCapture();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStage({ kind: "hidden" });
      setEdit(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="log-capture-title"
    >
      <div className="w-full max-w-[520px] rounded-xl border border-line bg-surface p-6 text-fg shadow-2xl">
        {stage.kind === "recording" ? (
          <div>
            <h2
              id="log-capture-title"
              className="text-lg font-semibold tracking-tight"
            >
              Log capture
            </h2>
            <p className="mt-2 text-sm text-muted" role="status">
              Recording — release the shortcut to stop.
            </p>
            <div
              className="mt-4 flex items-center gap-2 text-xs text-muted"
              role="status"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-danger motion-reduce:animate-none"
              />
              Listening…
            </div>
          </div>
        ) : edit ? (
          <div className="flex flex-col gap-4">
            <div>
              <h2
                id="log-capture-title"
                className="text-lg font-semibold tracking-tight"
              >
                Review capture
              </h2>
              {stage.error ? (
                <p className="mt-1 text-xs text-warning">
                  Classifier hint unavailable: {stage.error}
                </p>
              ) : stage.classification && stage.classification.confidence < 0.75 ? (
                <p className="mt-1 text-xs text-warning">
                  Low confidence ({Math.round(stage.classification.confidence * 100)}%) —
                  please double-check the project and kind below.
                </p>
              ) : stage.classification && stage.classification.new_project_name ? (
                <p className="mt-1 text-xs text-warning">
                  Suggesting a new project — confirm the name below before saving.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted">
                  Classifier suggested fields below — adjust as needed.
                </p>
              )}
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Transcript</span>
              <textarea
                rows={4}
                autoFocus
                value={edit.content}
                onChange={(e) =>
                  setEdit({ ...edit, content: e.target.value })
                }
                className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
            </label>

            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Kind</span>
                <select
                  value={edit.itemKind}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      itemKind: e.target.value as "note" | "task",
                    })
                  }
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
                >
                  <option value="note">Note</option>
                  <option value="task">Task</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">
                  Deadline {edit.itemKind === "note" ? "(tasks only)" : ""}
                </span>
                <input
                  type="text"
                  placeholder="2026-05-10T17:00:00Z"
                  disabled={edit.itemKind === "note"}
                  value={edit.deadlineIso}
                  onChange={(e) =>
                    setEdit({ ...edit, deadlineIso: e.target.value })
                  }
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">
                New project (overrides existing)
              </span>
              <input
                type="text"
                placeholder="Leave empty to keep existing project"
                value={edit.newProjectName}
                onChange={(e) =>
                  setEdit({ ...edit, newProjectName: e.target.value })
                }
                className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
              {edit.projectId && !edit.newProjectName ? (
                <span className="mt-1 text-xs text-muted">
                  Existing project id: {edit.projectId}
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Tags (comma separated)</span>
              <input
                type="text"
                value={edit.tagsInput}
                onChange={(e) =>
                  setEdit({ ...edit, tagsInput: e.target.value })
                }
                className="rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
            </label>

            {error ? (
              <p className="text-xs text-danger">{error}</p>
            ) : null}

            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDiscard()}
                className="rounded border border-line px-3 py-1 text-xs hover:bg-elevated disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={busy || !edit.content.trim()}
                onClick={() => void onSave()}
                className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
