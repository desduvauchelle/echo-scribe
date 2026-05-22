import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  isScreenRecording,
  startScreenRecording,
  stopScreenRecording,
  listRecordings,
  deleteRecording,
  revealRecording,
  type RecordingRow,
} from "../../lib/api";

function fmtDuration(ms: number | null): string {
  if (!ms) return "0:00";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function RecordingsView() {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<RecordingRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRows(await listRecordings());
    setRecording(await isScreenRecording());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      if (recording) {
        await stopScreenRecording();
      } else {
        await startScreenRecording();
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [recording, refresh]);

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await deleteRecording(id);
        if (selected?.id === id) setSelected(null);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, selected],
  );

  return (
    <div className="flex h-full flex-col bg-canvas text-fg">
      <div className="flex items-center justify-between border-b border-line px-6 py-4">
        <h1 className="text-[15px] font-semibold tracking-tight">Recordings</h1>
        <button
          onClick={onToggle}
          disabled={busy}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
            recording ? "bg-red-600 text-white" : "bg-accent text-white"
          } disabled:opacity-50`}
        >
          {recording ? "Stop recording" : "Record screen"}
        </button>
      </div>

      {error ? (
        <div className="border-b border-line bg-red-950/40 px-6 py-2 text-[12px] text-red-300">
          {error}
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        <div className="w-[320px] shrink-0 overflow-y-auto border-r border-line">
          {rows.length === 0 ? (
            <div className="p-6 text-[13px] text-muted">No recordings yet.</div>
          ) : (
            rows.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r)}
                className={`flex w-full gap-3 border-b border-line p-3 text-left hover:bg-surface ${
                  selected?.id === r.id ? "bg-surface" : ""
                }`}
              >
                {r.thumb_path ? (
                  <img
                    src={convertFileSrc(r.thumb_path)}
                    alt=""
                    className="h-12 w-20 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-12 w-20 shrink-0 rounded bg-elevated" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">
                    {r.source_label ?? "Recording"}
                  </div>
                  <div className="text-[11px] text-muted">
                    {new Date(r.created_at).toLocaleString()} ·{" "}
                    {fmtDuration(r.duration_ms)} · {fmtSize(r.size_bytes)}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto p-6">
          {selected ? (
            <>
              <video
                key={selected.id}
                src={convertFileSrc(selected.file_path)}
                controls
                className="w-full rounded-lg bg-black"
              />
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => revealRecording(selected.id)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
                >
                  Reveal in Finder
                </button>
                <button
                  onClick={() => onDelete(selected.id)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] text-red-500 hover:bg-surface"
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-[13px] text-muted">
              Select a recording to play it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
