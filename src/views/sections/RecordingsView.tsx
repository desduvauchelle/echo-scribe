import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isScreenRecording,
  openScreenrecSetup,
  stopScreenRecording,
  listRecordings,
  deleteRecording,
  renameRecording,
  revealRecording,
  transcribeRecording,
  exportRecording,
  type RecordingRow,
} from "../../lib/api";

function displayName(r: RecordingRow): string {
  return r.title?.trim() || r.source_label || "Recording";
}

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

type ExportVariant = { quality: string; path: string; size: number };

function parseExports(json: string): ExportVariant[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ExportVariant[]) : [];
  } catch {
    return [];
  }
}

export function RecordingsView() {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<RecordingRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);

  const refresh = useCallback(async () => {
    const next = await listRecordings();
    setRows(next);
    setSelected((cur) => (cur ? next.find((r) => r.id === cur.id) ?? cur : cur));
    setRecording(await isScreenRecording());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for screenrec-changed events (emitted by Rust on start/stop,
  // whether triggered from the setup window or tray) to keep button state
  // and list in sync without polling.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("screenrec-changed", () => {
      void refresh();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; pct: number }>("transcribe-progress", (e) => {
      if (selected && e.payload.id === selected.id) setProgress(e.payload.pct);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [selected]);

  const onToggle = useCallback(async () => {
    setBusy(true);
    try {
      setError(null);
      if (recording) {
        await stopScreenRecording();
        await refresh();
      } else {
        // Open the setup window so the user can pick source/audio before
        // recording starts. The actual start is triggered from that window;
        // screenrec-changed will fire and refresh() when recording begins.
        await openScreenrecSetup();
      }
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

  const startRename = useCallback(() => {
    if (!selected) return;
    setNameInput(displayName(selected));
    setRenaming(true);
  }, [selected]);

  const saveRename = useCallback(async () => {
    if (!selected) return;
    const next = nameInput.trim();
    if (!next || next === displayName(selected)) {
      setRenaming(false);
      return;
    }
    try {
      await renameRecording(selected.id, next);
      setRenaming(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [selected, nameInput, refresh]);

  const onTranscribe = useCallback(async () => {
    if (!selected) return;
    setTranscribing(true);
    setProgress(0);
    setError(null);
    try {
      await transcribeRecording(selected.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }, [selected, refresh]);

  const [exporting, setExporting] = useState<string | null>(null);

  const onExport = useCallback(
    async (id: string, quality: "1080" | "720" | "480") => {
      setExporting(quality);
      setError(null);
      try {
        await exportRecording(id, quality);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setExporting(null);
      }
    },
    [refresh],
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
                onClick={() => {
                  setSelected(r);
                  setRenaming(false);
                  setProgress(0);
                }}
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
                    {displayName(r)}
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
              {renaming ? (
                <div className="mb-3 flex items-center gap-2">
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename();
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[15px] font-semibold outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => void saveRename()}
                    className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setRenaming(false)}
                    className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                    {displayName(selected)}
                  </h2>
                  <button
                    onClick={startRename}
                    className="shrink-0 rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface"
                  >
                    Rename
                  </button>
                </div>
              )}
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
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-muted">Export:</span>
                {(["1080", "720", "480"] as const).map((q) => (
                  <button
                    key={q}
                    onClick={() => void onExport(selected.id, q)}
                    disabled={exporting !== null}
                    className="rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
                  >
                    {exporting === q ? `${q}p…` : `${q}p`}
                  </button>
                ))}
                {parseExports(selected.exports).length > 0 ? (
                  <span className="text-[12px] text-muted">
                    Done:{" "}
                    {parseExports(selected.exports)
                      .map((e) => `${e.quality}p (${fmtSize(e.size)})`)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
              <div className="mt-6 border-t border-line pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold">Transcript</h3>
                  {selected.transcript?.trim() ? (
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(selected.transcript ?? "");
                      }}
                      className="rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-surface"
                    >
                      Copy
                    </button>
                  ) : null}
                </div>
                {selected.transcript !== null ? (
                  selected.transcript.trim() ? (
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                      {selected.transcript}
                    </p>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] text-muted">No speech detected.</span>
                      <button
                        onClick={() => void onTranscribe()}
                        disabled={transcribing}
                        className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
                      >
                        Re-generate
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    onClick={() => void onTranscribe()}
                    disabled={transcribing}
                    className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                  >
                    {transcribing ? `Transcribing… ${progress}%` : "Generate transcript"}
                  </button>
                )}
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
