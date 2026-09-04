import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
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
import { caughtOfKind, extractCaught, type CaughtKind } from "../lib/caught";
import TalkWidgets from "./TalkWidgets";

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

type HudTab = "guides" | "notes" | "caught" | "transcript";

const TABS: HudTab[] = ["guides", "notes", "caught", "transcript"];

const TAB_LABEL: Record<HudTab, string> = {
  guides: "meetingHud.tabGuides",
  notes: "meetingHud.tabNotes",
  caught: "meetingHud.tabCaught",
  transcript: "meetingHud.tabTranscript",
};

function statusMarker(s: string, kind?: string): string {
  if (s === "covered") return "✓";
  if (s === "partial") return "…";
  // Tracker points are notes, not to-dos: a plain bullet, not an empty box.
  return kind === "tracker" ? "•" : "○";
}

function relativeAge(tt: (key: string, opts?: Record<string, unknown>) => string, t: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return tt("meetingHud.justNow");
  if (sec < 60) return tt("meetingHud.secondsAgo", { sec });
  return tt("meetingHud.minutesAgo", { min: Math.floor(sec / 60) });
}

export default function MeetingHud() {
  const { t } = useTranslation("windows");
  const [sessions, setSessions] = useState<Record<string, GuideSession>>({});
  const [cards, setCards] = useState<Card[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [tab, setTab] = useState<HudTab>("guides");
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [summaryTemplates, setSummaryTemplates] = useState<SummaryTemplate[]>([]);
  const [summaryTemplateId, setSummaryTemplateId] = useState<string | null>(null);
  const [transparencyAck, setTransparencyAck] = useState(false);
  const [consentMessage, setConsentMessage] = useState(() =>
    t("meetingHud.defaultConsentMessage"),
  );
  const [speakerLabels, setSpeakerLabels] = useState(() => ({
    you: t("meetingHud.defaultYouLabel"),
    them: t("meetingHud.defaultThemLabel"),
  }));
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
        setConsentMessage(
          workspace.preferences?.consent_message ?? t("meetingHud.defaultConsentMessage"),
        );
        const nextLabels = {
          you: t("meetingHud.defaultYouLabel"),
          them: t("meetingHud.defaultThemLabel"),
        };
        for (const participant of workspace.participants) {
          if (participant.speaker_key === "you" || participant.speaker_key === "them") {
            nextLabels[participant.speaker_key] = participant.display_name;
          }
        }
        setSpeakerLabels(nextLabels);
        notesReady.current = true;
      })
      .catch(() => {/* no active meeting */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    if (!meetingId || !notesReady.current || notes === savedNotes) return;
    const timer = setTimeout(() => {
      updateMeetingNotes(meetingId, notes)
        .then(() => setSavedNotes(notes))
        .catch(() => showToast(t("meetingHud.couldntSaveNotes")));
    }, 500);
    return () => clearTimeout(timer);
  }, [meetingId, notes, savedNotes, showToast, t]);

  const savePreferences = useCallback((nextTemplate: string | null, nextAck: boolean, nextMessage: string) => {
    if (!meetingId) return;
    setMeetingPreferences(meetingId, nextTemplate, nextAck, nextMessage)
      .catch(() => showToast(t("meetingHud.couldntSavePreferences")));
  }, [meetingId, showToast, t]);

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
          setTab("transcript");
          backfillTranscript();
        } else if (e.payload.focus === "notes") {
          setTab("notes");
          backfillWorkspace();
        } else if (e.payload.focus === "guides") {
          setTab("guides");
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
  }, [segments, tab]);

  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const sessionList = Object.values(sessions).sort((a, b) => a.slot - b.slot);
  const atCap = sessionList.length >= 2;
  const caught = extractCaught(segments);

  const onSelectTab = useCallback(
    (next: HudTab) => {
      setTab(next);
      if (next === "transcript") backfillTranscript();
      if (next === "notes") backfillWorkspace();
      if (next === "guides") backfillGuides();
    },
    [backfillTranscript, backfillWorkspace, backfillGuides],
  );

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
            : t("meetingHud.couldntAddGuide");
        showToast(friendly);
      }
    },
    [showToast, t],
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
        <span className="label" data-tauri-drag-region>{t("meetingHud.label")}</span>
        <span className="controls">
          <button
            onClick={() => getCurrentWindow().hide()}
            title={t("meetingHud.hideWindow")}
            aria-label={t("meetingHud.hideWindowAriaLabel")}
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

      <TalkWidgets segments={segments} labels={speakerLabels} />

      <nav className="tabbar" role="tablist" aria-label={t("meetingHud.tabsAria")}>
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            id={`hud-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`hud-pane-${name}`}
            className={tab === name ? "active" : ""}
            onClick={() => onSelectTab(name)}
          >
            {t(TAB_LABEL[name])}
            {name === "caught" && caught.length > 0 && (
              <span className="tab-count">{caught.length}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="body">
        {tab === "guides" && (
        <section className="guides" role="tabpanel" id="hud-pane-guides" aria-labelledby="hud-tab-guides">
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
                  title={s.collapsed ? t("meetingHud.expand") : t("meetingHud.collapse")}
                >
                  {s.templateName}
                </button>
                <span className="guide-controls">
                  {s.mode === "auto" ? (
                    <button className="mode" onClick={() => onToggleMode(s)}>{t("meetingHud.auto")}</button>
                  ) : (
                    <>
                      <button className="mode" onClick={() => guideTriggerNow(s.sessionId).catch(() => {})}>
                        {t("meetingHud.guideMeNow")}
                      </button>
                      <button className="mode" onClick={() => onToggleMode(s)}>{t("meetingHud.onDemand")}</button>
                    </>
                  )}
                  <button
                    className="end"
                    onClick={() => onDetach(s.sessionId)}
                    title={t("meetingHud.endGuide")}
                    aria-label={t("meetingHud.endGuide")}
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
                          ? t("meetingHud.waitingTracker")
                          : t("meetingHud.waitingGuide")}
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
              {t("meetingHud.addGuide")}
            </button>
            {atCap && <span className="cap-note">{t("meetingHud.capNote")}</span>}
            {pickerOpen && !atCap && (
              <div className="picker">
                {templates.length === 0 && <div className="empty">{t("meetingHud.noTemplates")}</div>}
                {templates.map((template) => (
                  <button key={template.id} className="picker-item" onClick={() => onAttach(template.id)}>
                    <span className="picker-name">{template.name}</span>
                    {template.description && (
                      <span className="picker-desc">{template.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

        <div className="feed" aria-live="polite">
          {cards.length === 0 ? (
            <div className="empty">{t("meetingHud.noCards")}</div>
          ) : (
            cards.map((c) => (
              <div key={c.key} className={`card slot${c.slot}`}>
                <div className="card-head">
                  <span className="chip">{c.templateName}</span>
                  <span className="age">{relativeAge(t, c.at, now)}</span>
                </div>
                {c.suggestions.map((s, i) => (
                  <div key={i} className="suggest">{s}</div>
                ))}
              </div>
            ))
          )}
        </div>
        </section>
        )}

        {tab === "caught" && (
          <section
            className="caught"
            role="tabpanel"
            id="hud-pane-caught"
            aria-labelledby="hud-tab-caught"
          >
            {caught.length === 0 ? (
              <div className="empty">{t("meetingHud.noCaught")}</div>
            ) : (
              (["date", "number"] as CaughtKind[]).map((kind) => {
                const items = caughtOfKind(caught, kind);
                if (items.length === 0) return null;
                return (
                  <div key={kind} className="caught-group">
                    <div className="caught-heading">
                      {kind === "date" ? t("meetingHud.caughtDates") : t("meetingHud.caughtNumbers")}
                    </div>
                    <div className="chips">
                      {items.map((item) => (
                        <span
                          key={`${kind}:${item.text}`}
                          className={`chip ${item.speaker}`}
                          title={t("meetingHud.caughtSaidBy", {
                            speaker: speakerLabels[item.speaker],
                          })}
                        >
                          {item.text}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        )}

        {tab === "transcript" && (
          <section
            className="transcript"
            role="tabpanel"
            id="hud-pane-transcript"
            aria-labelledby="hud-tab-transcript"
            ref={transcriptRef}
            onScroll={onTranscriptScroll}
          >
            <div className="speaker-labels">
              {(["you", "them"] as const).map((speaker) => (
                <label key={speaker}>
                  <span>{speaker === "you" ? t("meetingHud.micLabel") : t("meetingHud.callLabel")}</span>
                  <input
                    value={speakerLabels[speaker]}
                    onChange={(e) => setSpeakerLabels((current) => ({ ...current, [speaker]: e.target.value }))}
                    onBlur={() => {
                      if (meetingId && speakerLabels[speaker].trim()) {
                        setMeetingSpeakerLabel(meetingId, speaker, speakerLabels[speaker].trim()).catch(() =>
                          showToast(t("meetingHud.couldntSaveSpeakerLabel")),
                        );
                      }
                    }}
                    aria-label={t("meetingHud.speakerAriaLabel", { speaker })}
                  />
                </label>
              ))}
            </div>
            {segments.length === 0 ? (
              <div className="empty">{t("meetingHud.noTranscript")}</div>
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

        {tab === "notes" && (
          <section
            className="live-notes"
            role="tabpanel"
            id="hud-pane-notes"
            aria-labelledby="hud-tab-notes"
          >
            <div className="notes-toolbar">
              <label>
                <span>{t("meetingHud.summaryFormat")}</span>
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
              <span className="save-state">
                {notes === savedNotes ? t("meetingHud.saved") : t("meetingHud.saving")}
              </span>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("meetingHud.notesPlaceholder")}
              aria-label={t("meetingHud.liveNotesAriaLabel")}
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
                {t("meetingHud.participantInformed")}
              </label>
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(consentMessage)
                    .then(() => showToast(t("meetingHud.consentMessageCopied")))
                }
              >
                {t("meetingHud.copyNotice")}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
