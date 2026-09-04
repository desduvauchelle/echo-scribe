import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Loader } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EditorView } from "../views/sections/EditorView";
import { listRecordings, type RecordingRow } from "../lib/api";

// The recording id is injected by open_recording_editor (commands.rs) via an
// initialization script — no query-string handling at the asset-protocol
// layer. The URLSearchParams fallback keeps the page loadable in `bun run dev`
// for quick iteration.
declare global {
  interface Window {
    __EDITOR_RECORDING_ID__?: string;
  }
}

/** Root of the dedicated editor window: resolves the recording row for the
 *  injected id and hosts EditorView full-window. Closing = the window itself
 *  (EditorView autosaves project edits, so closing any time is safe). */
export default function EditorWindow() {
  const { t } = useTranslation("editor");
  const id =
    window.__EDITOR_RECORDING_ID__ ??
    new URLSearchParams(window.location.search).get("id") ??
    null;
  const [recording, setRecording] = useState<RecordingRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError(t("window.noRecordingId"));
      return;
    }
    let cancelled = false;
    void listRecordings()
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((r) => r.id === id);
        if (row) setRecording(row);
        else setError(t("window.recordingNotFound"));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  // Auto-denoise runs in the background after a recording stops, and the editor
  // is usually opened seconds after stop — well before it finishes. When it
  // lands it DELETES `<id>.mp4` and promotes `<id>.cleaned.mp4` onto the row,
  // so a window holding the pre-denoise snapshot is left pointing at a file
  // that no longer exists: the preview <video> silently keeps playing off its
  // open handle, but Export re-fetches the path and dies with HTTP 404.
  // Re-read the row on `screenrec-changed` (the event Rust emits after the
  // swap) and hand EditorView the new paths; it keys its <video> on the source
  // URL, so the preview reloads too. Only swap when a media path actually
  // moved — this event also fires for renames/exports/recording state, and a
  // new row identity on every tick would churn EditorView's effects.
  const mediaKey = useCallback(
    (r: RecordingRow) =>
      `${r.denoised_path ?? r.file_path}|${r.webcam_path ?? ""}|${r.events_path ?? ""}`,
    [],
  );
  useEffect(() => {
    if (!id) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen("screenrec-changed", () => {
      void listRecordings()
        .then((rows) => {
          if (cancelled) return;
          const row = rows.find((r) => r.id === id);
          if (!row) return;
          setRecording((prev) =>
            prev && mediaKey(prev) === mediaKey(row) ? prev : row,
          );
        })
        // A failed refresh is not fatal: the window keeps the row it has.
        .catch((e) => console.warn("[editor] row refresh failed", e));
    }).then((fn) => {
      if (cancelled) void fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) void unlisten();
    };
  }, [id, mediaKey]);

  if (error) {
    return (
      <div className="grid h-screen place-items-center bg-canvas p-8 text-fg">
        <div className="max-w-[360px] text-center">
          <p className="text-[13px] text-danger">{error}</p>
          <button
            onClick={() => void getCurrentWindow().close()}
            className="mt-4 rounded-md border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface"
          >
            {t("window.closeWindow")}
          </button>
        </div>
      </div>
    );
  }

  if (!recording) {
    return (
      <div
        className="grid h-screen place-items-center bg-canvas text-muted"
        role="status"
      >
        <Loader size={20} className="animate-spin" aria-hidden="true" />
        <span className="sr-only">{t("window.loadingRecording")}</span>
      </div>
    );
  }

  // Same container idiom the detail pane gave the inline editor (scrollable,
  // padded), sized to the window instead of a pane.
  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-canvas p-6 text-fg">
      <EditorView
        key={recording.id}
        recording={recording}
        onBack={() => void getCurrentWindow().close()}
      />
    </div>
  );
}
