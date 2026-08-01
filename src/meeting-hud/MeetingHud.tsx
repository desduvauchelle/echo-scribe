import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  attachGuide,
  detachGuide,
  getActiveMeetingWorkspace,
  getActiveGuides,
  getLiveTranscript,
  guideSetMode,
  guideTriggerNow,
  listGuideTemplates,
  listSummaryTemplates,
  saveHudFrame,
  setMeetingPreferences,
  setMeetingSpeakerLabel,
  updateMeetingNotes,
  type GuideInit,
  type GuideKeyPoint,
  type GuideTemplate,
  type GuideUpdate,
  type SummaryTemplate,
  type TranscriptSegment,
} from "../lib/api";

type GuideSession = {
  sessionId: string;
  slot: number;
  templateName: string;
  goal: string;
  kind?: string;
  mode: "auto" | "on_demand";
  keyPoints: GuideKeyPoint[];
  updatedAt?: string;
  collapsed: boolean;
};

type Card = {
  key: string;
  sessionId: string;
  slot: number;
  templateName: string;
  suggestions: string[];
  at: number;
};

const MAX_CARDS = 50;

function statusMarker(s: string, kind?: string): string {
  if (s === "covered") return "✓";
  if (s === "partial") return "…";
  // Tracker points are notes, not to-dos: a plain bullet, not an empty box.
  return kind === "tracker" ? "•" : "○";
}

function relativeAge(t: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

export default function MeetingHud() {
  const [sessions, setSessions] = useState<Record<string, GuideSession>>({});
  const [cards, setCards] = useState<Card[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [summaryTemplates, setSummaryTemplates] = useState<SummaryTemplate[]>([]);
  const [summaryTemplateId, setSummaryTemplateId] = useState<string | null>(null);
  const [transparencyAck, setTransparencyAck] = useState(false);
  const [consentMessage, setConsentMessage] = useState("I’m using EchoScribe to take private notes and create a local summary of this conversation. Is that okay?");
  const [speakerLabels, setSpeakerLabels] = useState({ you: "You", them: "Them" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templates, setTemplates] = useState<GuideTemplate[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const cardSeq = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const notesReady = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const backfillTranscript = useCallback(() => {
    getLiveTranscript()
      .then(setSegments)
      .catch(() => {/* no active meeting — leave empty */});
  }, []);

  const backfillGuides = useCallback(() => {
    getActiveGuides()
      .then((list) => {
        setSessions((prev) => {
          const next = { ...prev };
          for (const g of list) {
            next[g.sessionId] = {
              sessionId: g.sessionId,
              slot: g.slot,
              templateName: g.templateName,
              goal: g.goal,
              kind: g.kind,
              mode: g.mode,
              keyPoints: prev[g.sessionId]?.keyPoints ?? [],
              collapsed: prev[g.sessionId]?.collapsed ?? false,
            };
          }
          return next;
        });
      })
      .catch(() => {/* no active meeting */});
  }, []);

  const backfillWorkspace = useCallback(() => {
    Promise.all([getActiveMeetingWorkspace(), listSummaryTemplates()])
      .then(([workspace, availableTemplates]) => {
        setSummaryTemplates(availableTemplates);
        if (!workspace) return;
        setMeetingId(workspace.id);
        setNotes(workspace.notes);
        setSavedNotes(workspace.notes);
        setSummaryTemplateId(workspace.preferences?.summary_template_id ?? "builtin-general");
        setTransparencyAck(workspace.preferences?.transparency_ack ?? false);
        setConsentMessage(workspace.preferences?.consent_message ?? "I’m using EchoScribe to take private notes and create a local summary of this conversation. Is that okay?");
        const nextLabels = { you: "You", them: "Them" };
        for (const participant of workspace.participants) {
          if (participant.speaker_key === "you" || participant.speaker_key === "them") {
            nextLabels[participant.speaker_key] = participant.display_name;
          }
        }
        setSpeakerLabels(nextLabels);
        notesReady.current = true;
      })
      .catch(() => {/* no active meeting */});
  }, []);

  useEffect(() => {
    if (!meetingId || !notesReady.current || notes === savedNotes) return;
    const timer = setTimeout(() => {
      updateMeetingNotes(meetingId, notes)
        .then(() => setSavedNotes(notes))
        .catch(() => showToast("Couldn't save meeting notes."));
    }, 500);
    return () => clearTimeout(timer);
  }, [meetingId, notes, savedNotes, showToast]);

  const savePreferences = useCallback((nextTemplate: string | null, nextAck: boolean, nextMessage: string) => {
    if (!meetingId) return;
    setMeetingPreferences(meetingId, nextTemplate, nextAck, nextMessage)
      .catch(() => showToast("Couldn't save meeting preferences."));
  }, [meetingId, showToast]);

  // Event wiring.
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<GuideInit>("guide-init", (e) => {
        setSessions((prev) => ({
          ...prev,
          [e.payload.sessionId]: {
            sessionId: e.payload.sessionId,
            slot: e.payload.slot,
            templateName: e.payload.templateName,
            goal: e.payload.goal,
            kind: e.payload.kind,
            mode: e.payload.mode,
            keyPoints: [],
            collapsed: false,
          },
        }));
      }),
      listen<GuideUpdate>("guide-update", (e) => {
        const p = e.payload;
        setSessions((prev) => {
          const existing = prev[p.sessionId];
          return {
            ...prev,
            [p.sessionId]: {
              sessionId: p.sessionId,
              slot: p.slot,
              templateName: p.templateName ?? existing?.templateName ?? "Guide",
              goal: p.goal ?? existing?.goal ?? "",
              kind: p.kind ?? existing?.kind,
              mode: p.mode,
              keyPoints: p.keyPoints,
              updatedAt: p.updatedAt,
              collapsed: existing?.collapsed ?? false,
            },
          };
        });
        if (p.suggestions.length > 0) {
          setCards((prev) =>
            [
              {
                key: `c${cardSeq.current++}`,
                sessionId: p.sessionId,
                slot: p.slot,
                templateName: p.templateName ?? "Guide",
                suggestions: p.suggestions,
                at: Date.now(),
              },
              ...prev,
            ].slice(0, MAX_CARDS),
          );
        }
      }),
      listen<{ sessionId: string }>("guide-detached", (e) => {
        setSessions((prev) => {
          const next = { ...prev };
          delete next[e.payload.sessionId];
          return next;
        });
      }),
      listen<{ meetingId: string; segment: TranscriptSegment }>("meeting-segment", (e) => {
        setSegments((prev) => [...prev, e.payload.segment]);
      }),
      listen<{ focus: string }>("hud-focus", (e) => {
        if (e.payload.focus === "transcript") {
          setShowTranscript(true);
          backfillTranscript();
        } else if (e.payload.focus === "notes") {
          setShowNotes(true);
          backfillWorkspace();
        } else if (e.payload.focus === "guides") {
          setPickerOpen(true);
          backfillGuides();
          listGuideTemplates().then(setTemplates).catch(() => setTemplates([]));
        }
      }),
      listen("meeting-started", () => {
        setSessions({});
        setCards([]);
        setSegments([]);
        setPickerOpen(false);
        setMeetingId(null);
        setNotes("");
        setSavedNotes("");
        notesReady.current = false;
        setTimeout(backfillWorkspace, 100);
      }),
      // Meeting moved past recording → HUD no longer meaningful; backend
      // hides the window, we clear the state for the next meeting.
      listen<{ id: string; status: string }>("meeting-status", (e) => {
        if (["transcribing", "summarizing", "complete"].includes(e.payload.status)) {
          setSessions({});
          setCards([]);
          setSegments([]);
          setPickerOpen(false);
        }
      }),
    ];
    backfillTranscript();
    backfillGuides();
    backfillWorkspace();
    return () => {
      unlisteners.forEach((p) => p.then((u) => u()));
    };
  }, [backfillTranscript, backfillGuides, backfillWorkspace]);

  // Persist the window frame (debounced) whenever the user moves/resizes.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queueSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const sf = await win.scaleFactor();
          const pos = await win.outerPosition();
          const size = await win.innerSize();
          await saveHudFrame(pos.x / sf, pos.y / sf, size.width / sf, size.height / sf);
        } catch {
          /* window closing — ignore */
        }
      }, 500);
    };
    const unlisteners = [win.onMoved(queueSave), win.onResized(queueSave)];
    return () => {
      unlisteners.forEach((p) => p.then((u) => u()));
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Staleness tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Transcript stick-to-bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [segments, showTranscript]);

  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const sessionList = Object.values(sessions).sort((a, b) => a.slot - b.slot);
  const atCap = sessionList.length >= 2;

  const onAttach = useCallback(
    async (templateId: string) => {
      try {
        await attachGuide(templateId);
        setPickerOpen(false);
      } catch (err) {
        const msg = String(err);
        const friendly =
          msg.includes("Two guides") || msg.includes("No meeting")
            ? msg
            : "Couldn't add guide. See Settings → Diagnostics → logs.";
        showToast(friendly);
      }
    },
    [showToast],
  );

  const onDetach = useCallback(async (sessionId: string) => {
    try {
      await detachGuide(sessionId);
    } catch {
      /* already gone */
    }
  }, []);

  const onToggleMode = useCallback(async (s: GuideSession) => {
    const next = s.mode === "auto" ? "on_demand" : "auto";
    try {
      await guideSetMode(s.sessionId, next);
      setSessions((prev) => {
        const cur = prev[s.sessionId];
        return cur ? { ...prev, [s.sessionId]: { ...cur, mode: next } } : prev;
      });
    } catch {
      /* swallow */
    }
  }, []);

  const onOpenPicker = useCallback(() => {
    setPickerOpen((open) => !open);
    listGuideTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  return (
    <div className="hud">
      <header data-tauri-drag-region>
        <span className="label" data-tauri-drag-region>MEETING HUD</span>
        <span className="controls">
          <button
            className={showNotes ? "active" : ""}
            onClick={() => {
              setShowNotes((v) => !v);
              if (!showNotes) backfillWorkspace();
            }}
            title="Toggle live notes"
            aria-label="Toggle live notes"
            aria-pressed={showNotes}
          >
            <span aria-hidden="true">✎</span>
          </button>
          <button
            className={showTranscript ? "active" : ""}
            onClick={() => {
              setShowTranscript((v) => !v);
              if (!showTranscript) backfillTranscript();
            }}
            title="Toggle live transcript"
            aria-label="Toggle live transcript"
            aria-pressed={showTranscript}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <button
            onClick={() => getCurrentWindow().hide()}
            title="Hide (meeting keeps recording)"
            aria-label="Hide window (meeting keeps recording)"
          >
            <span aria-hidden="true">─</span>
          </button>
        </span>
      </header>

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}

      <div className="body">
        <section className="guides">
          {sessionList.map((s) => (
            <div key={s.sessionId} className={`guide slot${s.slot}`}>
              <div className="guide-head">
                <button
                  className="chip"
                  onClick={() =>
                    setSessions((prev) => ({
                      ...prev,
                      [s.sessionId]: { ...s, collapsed: !s.collapsed },
                    }))
                  }
                  title={s.collapsed ? "Expand" : "Collapse"}
                >
                  {s.templateName}
                </button>
                <span className="guide-controls">
                  {s.mode === "auto" ? (
                    <button className="mode" onClick={() => onToggleMode(s)}>Auto</button>
                  ) : (
                    <>
                      <button className="mode" onClick={() => guideTriggerNow(s.sessionId).catch(() => {})}>
                        Guide me now
                      </button>
                      <button className="mode" onClick={() => onToggleMode(s)}>On-demand</button>
                    </>
                  )}
                  <button
                    className="end"
                    onClick={() => onDetach(s.sessionId)}
                    title="End this guide"
                    aria-label="End this guide"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </span>
              </div>
              {!s.collapsed && (
                <>
                  {s.goal && <div className="goal">{s.goal}</div>}
                  {s.keyPoints.length === 0 ? (
                    <div className="waiting">
                      <span className="spinner" aria-hidden="true" />
                      <span>
                        {s.kind === "tracker"
                          ? "Listening… notes appear after ~20–30s of speech."
                          : "Listening… first guidance arrives after ~20–30s of speech."}
                      </span>
                    </div>
                  ) : (
                    s.keyPoints.map((p) => (
                      <div key={p.id} className={`point ${p.status}`}>
                        <span className="marker">{statusMarker(p.status, s.kind)}</span>
                        <span>{p.label}</span>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          ))}

          <div className="add-guide">
            <button className="add" onClick={onOpenPicker} disabled={atCap}>
              + Add guide
            </button>
            {atCap && <span className="cap-note">two guides max — close one to add another</span>}
            {pickerOpen && !atCap && (
              <div className="picker">
                {templates.length === 0 && <div className="empty">No templates yet.</div>}
                {templates.map((t) => (
                  <button key={t.id} className="picker-item" onClick={() => onAttach(t.id)}>
                    <span className="picker-name">{t.name}</span>
                    {t.description && <span className="picker-desc">{t.description}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="feed" aria-live="polite">
          {cards.length === 0 ? (
            <div className="empty">Guidance cards appear here — newest on top.</div>
          ) : (
            cards.map((c) => (
              <div key={c.key} className={`card slot${c.slot}`}>
                <div className="card-head">
                  <span className="chip">{c.templateName}</span>
                  <span className="age">{relativeAge(c.at, now)}</span>
                </div>
                {c.suggestions.map((s, i) => (
                  <div key={i} className="suggest">{s}</div>
                ))}
              </div>
            ))
          )}
        </section>

        {showTranscript && (
          <section className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
            <div className="speaker-labels">
              {(["you", "them"] as const).map((speaker) => (
                <label key={speaker}>
                  <span>{speaker === "you" ? "Mic" : "Call"}</span>
                  <input
                    value={speakerLabels[speaker]}
                    onChange={(e) => setSpeakerLabels((current) => ({ ...current, [speaker]: e.target.value }))}
                    onBlur={() => {
                      if (meetingId && speakerLabels[speaker].trim()) {
                        setMeetingSpeakerLabel(meetingId, speaker, speakerLabels[speaker].trim()).catch(() => showToast("Couldn't save speaker label."));
                      }
                    }}
                    aria-label={`${speaker} speaker label`}
                  />
                </label>
              ))}
            </div>
            {segments.length === 0 ? (
              <div className="empty">Transcript appears here as speech is transcribed.</div>
            ) : (
              segments.map((seg, i) => (
                <div key={i} className={`line ${seg.speaker}`}>
                  <span className="speaker">{speakerLabels[seg.speaker]}</span>
                  <span>{seg.text}</span>
                </div>
              ))
            )}
          </section>
        )}

        {showNotes && (
          <section className="live-notes">
            <div className="notes-toolbar">
              <label>
                <span>Summary format</span>
                <select
                  value={summaryTemplateId ?? ""}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    setSummaryTemplateId(next);
                    savePreferences(next, transparencyAck, consentMessage);
                  }}
                >
                  {summaryTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
              </label>
              <span className="save-state">{notes === savedNotes ? "Saved" : "Saving…"}</span>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={'Type notes that should guide the summary…\n\n- Key point\n- [ ] Follow up'}
              aria-label="Live meeting notes"
            />
            <div className="transparency">
              <label className="ack">
                <input
                  type="checkbox"
                  checked={transparencyAck}
                  onChange={(e) => {
                    setTransparencyAck(e.target.checked);
                    savePreferences(summaryTemplateId, e.target.checked, consentMessage);
                  }}
                />
                Participant informed
              </label>
              <button onClick={() => navigator.clipboard.writeText(consentMessage).then(() => showToast("Consent message copied."))}>Copy notice</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
