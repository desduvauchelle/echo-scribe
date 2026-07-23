import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader } from "lucide-react";
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
  const id =
    window.__EDITOR_RECORDING_ID__ ??
    new URLSearchParams(window.location.search).get("id") ??
    null;
  const [recording, setRecording] = useState<RecordingRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("No recording id was provided to the editor window.");
      return;
    }
    let cancelled = false;
    void listRecordings()
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((r) => r.id === id);
        if (row) setRecording(row);
        else setError("Recording not found — it may have been deleted.");
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="grid h-screen place-items-center bg-canvas p-8 text-fg">
        <div className="max-w-[360px] text-center">
          <p className="text-[13px] text-danger">{error}</p>
          <button
            onClick={() => void getCurrentWindow().close()}
            className="mt-4 rounded-md border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface"
          >
            Close window
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
        <span className="sr-only">Loading recording…</span>
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
