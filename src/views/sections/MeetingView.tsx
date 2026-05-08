import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getMeeting,
  updateMeetingNotes,
  renameMeeting,
  deleteMeeting,
  retryMeetingSummary,
  retryMeetingChunks,
  type MeetingRow,
  type StoredTranscript,
  type StoredSummary,
  type Segment,
} from "../../lib/api";

type Props = { meetingId: string; onClose: () => void };

/** Numeric rank for meeting status — prevents stale refreshes from
 *  regressing the displayed status badge. */
const STATUS_RANK: Record<string, number> = {
  recording: 0,
  transcribing: 1,
  summarizing: 2,
  complete: 3,
  failed: 3,
  recovered: 3,
};

export function MeetingView({ meetingId, onClose }: Props) {
  const [row, setRow] = useState<MeetingRow | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  const refresh = async () => {
    const r = await getMeeting(meetingId);
    if (!r) { setRow(null); return; }
    // Monotonic guard: never regress the displayed status.
    setRow((prev) => {
      if (
        prev &&
        (STATUS_RANK[r.status] ?? 0) < (STATUS_RANK[prev.status] ?? 0)
      ) {
        return { ...r, status: prev.status };
      }
      return r;
    });
    setNotesDraft(r.user_notes ?? "");
  };

  useEffect(() => {
    void refresh();
  }, [meetingId]);

  useEffect(() => {
    let unsubStatus: (() => void) | null = null;
    let unsubComplete: (() => void) | null = null;
    void listen("meeting-status", () => {
      void refresh();
    }).then((fn) => (unsubStatus = fn));
    void listen("meeting-complete", () => {
      void refresh();
    }).then((fn) => (unsubComplete = fn));
    return () => {
      unsubStatus?.();
      unsubComplete?.();
    };
  }, [meetingId]);

  if (!row) return <div className="p-6 text-sm text-muted">Loading…</div>;

  const transcript: StoredTranscript | null = row.transcript_json
    ? (JSON.parse(row.transcript_json) as StoredTranscript)
    : null;
  const summary: StoredSummary | null = row.summary_json
    ? (JSON.parse(row.summary_json) as StoredSummary)
    : null;

  const durationMin = row.duration_ms ? Math.round(row.duration_ms / 60000) : 0;
  const startedDate = new Date(row.started_at).toLocaleString();
  const title = editingTitle
    ? titleDraft
    : row.detected_app_name
      ? `Meeting with ${row.detected_app_name}`
      : "Untitled meeting";

  const handleRename = async () => {
    await renameMeeting(meetingId, titleDraft);
    setEditingTitle(false);
    void refresh();
  };

  return (
    <div className="meeting-view flex flex-col gap-4 p-6 overflow-y-auto">
      <header className="flex flex-col gap-2">
        {editingTitle ? (
          <input
            className="w-full rounded-md bg-surface-2 px-3 py-2 text-base"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
              if (e.key === "Escape") setEditingTitle(false);
            }}
            autoFocus
          />
        ) : (
          <h1
            className="cursor-text text-xl font-semibold"
            onClick={() => {
              setTitleDraft(title);
              setEditingTitle(true);
            }}
          >
            {title}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{row.detected_app_name ?? "Manual"}</span>
          <span>·</span>
          <span>{startedDate}</span>
          <span>·</span>
          <span>{durationMin}m</span>
          <span className={`status-${row.status} rounded-full bg-surface-2 px-2 py-0.5`}>
            {row.status}
          </span>
        </div>
      </header>

      {summary?.summary?.length ? (
        <section className="rounded-lg bg-surface-2 p-4">
          <h2 className="mb-2 text-sm font-semibold">Summary</h2>
          <ul className="list-inside list-disc text-sm">
            {summary.summary.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </section>
      ) : row.status === "complete" && summary === null ? (
        <section className="rounded-lg bg-surface-2 p-4 text-sm text-muted">
          Summary generation failed.{" "}
          <button
            className="underline"
            onClick={async () => {
              await retryMeetingSummary(meetingId);
              void refresh();
            }}
          >
            Retry
          </button>
        </section>
      ) : null}

      {summary?.action_items?.length ? (
        <section className="rounded-lg bg-surface-2 p-4">
          <h2 className="mb-2 text-sm font-semibold">Action items</h2>
          <ul className="text-sm">
            {summary.action_items.map((a, i) => (
              <li key={i} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" />
                <span>
                  {a.text} <em className="text-xs text-muted">({a.owner})</em>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg bg-surface-2 p-4">
        <h2 className="mb-2 text-sm font-semibold">Notes</h2>
        <textarea
          className="w-full rounded-md bg-canvas px-3 py-2 text-sm"
          rows={4}
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={() => {
            void updateMeetingNotes(meetingId, notesDraft);
          }}
          placeholder="Add your own notes…"
        />
      </section>

      {transcript?.segments?.length ? (
        <section className="rounded-lg bg-surface-2 p-4">
          <h2 className="mb-2 text-sm font-semibold">Transcript</h2>
          <div className="flex flex-col gap-2 text-sm">
            {transcript.segments.map((s: Segment, i: number) => (
              <div
                key={i}
                className={`segment ${s.speaker} grid grid-cols-[60px_60px_1fr] gap-2`}
              >
                <div className="text-xs text-muted">{formatMs(s.start_ms)}</div>
                <div className="text-xs font-medium">
                  {s.speaker === "you" ? "You" : "Them"}
                </div>
                <div>{s.text}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {row.failed_chunk_count > 0 ? (
        <div className="rounded-md bg-yellow-100 p-3 text-sm text-yellow-900">
          {row.failed_chunk_count} audio segment
          {row.failed_chunk_count > 1 ? "s" : ""} failed to transcribe.{" "}
          <button
            className="underline"
            onClick={async () => {
              await retryMeetingChunks(meetingId);
              void refresh();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      <footer className="mt-4">
        <button
          className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted hover:text-error"
          onClick={async () => {
            await deleteMeeting(meetingId);
            onClose();
          }}
        >
          Delete meeting
        </button>
      </footer>
    </div>
  );
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
