import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Check,
  ClipboardCheck,
  Plus,
  UserPlus,
  X,
} from "lucide-react";
import {
  acceptMeetingTaskSuggestion,
  addMeetingParticipant,
  completeMeetingDebrief,
  dismissMeetingTaskSuggestion,
  listPendingDebriefs,
  listPeople,
  removeMeetingParticipant,
  savePerson,
  setMeetingProject,
  setMeetingSpeakerLabel,
  type MeetingDebrief,
  type MeetingParticipant,
  type Person,
  type Project,
  type TaskSuggestion,
} from "../lib/api";
import {
  findPersonByName,
  isRelabelableSpeakerKey,
  isUnnamedSpeaker,
  matchOwnerToPersonId,
  otherParticipants,
  sortDebriefs,
  unlinkedPeople,
} from "../lib/meetingDebrief";
import { meetingDuration } from "../lib/meetingDisplay";
import { useActivityPanel } from "./ActivityPanelContext";
import { useToasts } from "./ToastProvider";
import Menu from "./a11y/Menu";

/** How long an accepted row shows its "Added" confirmation before leaving. */
const ADDED_LINGER_MS = 1400;

/**
 * Post-meeting debrief: one highlighted card per finished meeting awaiting
 * review. The user confirms the project and people and picks which suggested
 * follow-ups become tasks. Nothing is created automatically — every task comes
 * from an explicit "Add task" click. Renders nothing when no debriefs pend.
 */
export default function MeetingDebriefSection({ projects }: { projects: Map<string, Project> }) {
  const { t } = useTranslation("main");
  const { push: pushToast } = useToasts();
  const [debriefs, setDebriefs] = useState<MeetingDebrief[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  // Meetings the user just closed; hidden immediately even if a refetch that
  // raced the close still lists them.
  const closed = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [pending, known] = await Promise.all([listPendingDebriefs(), listPeople()]);
      setDebriefs(sortDebriefs(pending.filter((d) => !closed.current.has(d.meetingId))));
      setPeople(known);
    } catch (e) {
      // Background load (not user-triggered): log only, keep the dashboard quiet.
      console.error("[meeting-debrief] failed to load pending debriefs", e);
    }
  }, []);

  useEffect(() => {
    void load();
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const handler = () => {
        if (!cancelled) void load();
      };
      try {
        const subs = await Promise.all([
          listen("meeting-debrief-updated", handler),
          listen("meeting-complete", handler),
        ]);
        if (cancelled) subs.forEach((u) => u());
        else unlisteners.push(...subs);
      } catch (e) {
        console.error("[meeting-debrief] failed to subscribe to events", e);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [load]);

  const removeCard = useCallback((meetingId: string) => {
    closed.current.add(meetingId);
    setDebriefs((cur) => cur.filter((d) => d.meetingId !== meetingId));
  }, []);

  // Close the whole section: every pending debrief is marked dismissed.
  const dismissAll = async () => {
    const ids = debriefs.map((d) => d.meetingId);
    ids.forEach((id) => closed.current.add(id));
    setDebriefs([]);
    const results = await Promise.allSettled(ids.map((id) => completeMeetingDebrief(id, "dismissed")));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.error("[meeting-debrief] dismiss all failed", { ids, failed });
      ids.forEach((id) => closed.current.delete(id));
      pushToast({ tone: "error", message: t("dashboard.debrief.errors.complete") });
      void load();
    }
  };

  if (debriefs.length === 0) return null;

  return (
    <section className="echo-meeting-debrief py-3" aria-labelledby="debrief-heading">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-accent">
            {t("dashboard.debrief.label")}
          </p>
          <h2 id="debrief-heading" className="mt-0.5 text-[14px] font-semibold text-fg">
            {t("dashboard.debrief.title")}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void dismissAll()}
          aria-label={t("dashboard.debrief.dismissAll")}
          title={t("dashboard.debrief.dismissAll")}
          className="rounded-md p-1 text-faint transition-colors hover:bg-elevated/60 hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {debriefs.map((d) => (
          <DebriefCard
            key={d.meetingId}
            debrief={d}
            people={people}
            projects={projects}
            onPeopleChange={setPeople}
            onRefresh={load}
            onClosed={removeCard}
          />
        ))}
      </div>
    </section>
  );
}

type RowState = {
  suggestion: TaskSuggestion;
  text: string;
  assignee: string | null;
  phase: "idle" | "busy" | "added";
};

function DebriefCard({
  debrief,
  people,
  projects,
  onPeopleChange,
  onRefresh,
  onClosed,
}: {
  debrief: MeetingDebrief;
  people: Person[];
  projects: Map<string, Project>;
  onPeopleChange: (people: Person[]) => void;
  onRefresh: () => Promise<void>;
  onClosed: (meetingId: string) => void;
}) {
  const { t, i18n } = useTranslation("main");
  const { push: pushToast } = useToasts();
  const { openItem } = useActivityPanel();
  const { meetingId } = debrief;
  const headingId = `debrief-${meetingId}-title`;

  const [projectId, setProjectId] = useState<string | null>(debrief.projectId);
  useEffect(() => setProjectId(debrief.projectId), [debrief.projectId]);

  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const participants = otherParticipants(debrief.participants).filter(
    (p) => !hiddenKeys.has(p.speaker_key),
  );

  // Suggestion rows: seeded from the debrief, keeping local edits. Rows the
  // backend no longer lists drop out, except accepted rows still showing
  // their "Added" confirmation.
  const [rows, setRows] = useState<RowState[]>([]);
  const [gone, setGone] = useState<Set<string>>(new Set());
  useEffect(() => {
    setRows((cur) => {
      const byId = new Map(cur.map((r) => [r.suggestion.id, r]));
      const next: RowState[] = debrief.suggestions.map(
        (s) =>
          byId.get(s.id) ?? {
            suggestion: s,
            text: s.text,
            assignee: matchOwnerToPersonId(s.ownerName, people),
            phase: "idle",
          },
      );
      const listed = new Set(debrief.suggestions.map((s) => s.id));
      for (const r of cur) if (r.phase === "added" && !listed.has(r.suggestion.id)) next.push(r);
      return next;
    });
    // people intentionally omitted: pre-fill once; don't clobber user choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debrief.suggestions]);
  const visibleRows = rows.filter((r) => !gone.has(r.suggestion.id));

  const patchRow = (id: string, patch: Partial<RowState>) =>
    setRows((cur) => cur.map((r) => (r.suggestion.id === id ? { ...r, ...patch } : r)));

  const fail = (message: string, e: unknown, context: string) => {
    console.error(`[meeting-debrief] ${context}`, { meetingId, error: e });
    pushToast({ tone: "error", message });
  };

  const changeProject = async (next: string | null) => {
    const prev = projectId;
    setProjectId(next);
    try {
      await setMeetingProject(meetingId, next);
    } catch (e) {
      setProjectId(prev);
      fail(t("dashboard.debrief.errors.project"), e, "set_meeting_project failed");
    }
  };

  const removeParticipant = async (p: MeetingParticipant) => {
    setHiddenKeys((cur) => new Set(cur).add(p.speaker_key));
    try {
      await removeMeetingParticipant(meetingId, p.speaker_key);
      await onRefresh();
    } catch (e) {
      setHiddenKeys((cur) => {
        const n = new Set(cur);
        n.delete(p.speaker_key);
        return n;
      });
      fail(t("dashboard.debrief.errors.people"), e, "remove_meeting_participant failed");
    }
  };

  const addPerson = async (person: Person) => {
    try {
      await addMeetingParticipant(meetingId, person.id);
      await onRefresh();
    } catch (e) {
      fail(t("dashboard.debrief.errors.people"), e, "add_meeting_participant failed");
    }
  };

  const createAndAddPerson = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = findPersonByName(people, trimmed);
    if (existing) return addPerson(existing);
    try {
      const person = await savePerson({ name: trimmed, notes: "" });
      onPeopleChange([...people, person]);
      await addPerson(person);
    } catch (e) {
      fail(t("dashboard.debrief.errors.people"), e, "save_person failed");
    }
  };

  const linkSpeaker = async (p: MeetingParticipant, personId: string) => {
    const person = people.find((c) => c.id === personId);
    if (!person || !isRelabelableSpeakerKey(p.speaker_key)) return;
    try {
      await setMeetingSpeakerLabel(meetingId, p.speaker_key, person.name, person.id);
      await onRefresh();
    } catch (e) {
      fail(t("dashboard.debrief.errors.people"), e, "set_meeting_speaker_label failed");
    }
  };

  const accept = async (row: RowState) => {
    const text = row.text.trim();
    if (!text) return;
    const id = row.suggestion.id;
    patchRow(id, { phase: "busy" });
    try {
      await acceptMeetingTaskSuggestion({
        suggestionId: id,
        text,
        assigneePersonId: row.assignee,
        projectId,
        deadline: null,
      });
      patchRow(id, { phase: "added" });
      window.setTimeout(() => setGone((cur) => new Set(cur).add(id)), ADDED_LINGER_MS);
    } catch (e) {
      patchRow(id, { phase: "idle" });
      fail(t("dashboard.debrief.errors.task"), e, "accept_meeting_task_suggestion failed");
    }
  };

  const skip = async (row: RowState) => {
    const id = row.suggestion.id;
    setGone((cur) => new Set(cur).add(id));
    try {
      await dismissMeetingTaskSuggestion(id);
    } catch (e) {
      setGone((cur) => {
        const n = new Set(cur);
        n.delete(id);
        return n;
      });
      fail(t("dashboard.debrief.errors.skip"), e, "dismiss_meeting_task_suggestion failed");
    }
  };

  const [closing, setClosing] = useState(false);
  const close = async (status: "done" | "dismissed") => {
    setClosing(true);
    try {
      await completeMeetingDebrief(meetingId, status);
      onClosed(meetingId);
    } catch (e) {
      setClosing(false);
      fail(t("dashboard.debrief.errors.complete"), e, `complete_meeting_debrief(${status}) failed`);
    }
  };

  const liveProjects = useMemo(
    () => [...projects.values()].filter((p) => !p.archived_at || p.id === projectId),
    [projects, projectId],
  );

  const when = useMemo(() => {
    const d = new Date(debrief.startedAt);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(i18n.language, { weekday: "short", hour: "numeric", minute: "2-digit" });
  }, [debrief.startedAt, i18n.language]);
  const meta = [when, debrief.durationMs ? meetingDuration(debrief.durationMs) : ""]
    .filter(Boolean)
    .join(" · ");

  const fieldLabel = "w-16 shrink-0 pt-1 text-[11px] font-medium text-muted";
  const selectCls =
    "min-w-0 rounded-md border border-line bg-canvas px-2 py-1 text-[12px] text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring";

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl border border-accent/35 bg-accent-soft px-4 py-3 shadow-[inset_3px_0_0_var(--color-accent)]"
    >
      <header className="flex items-start gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <ClipboardCheck size={15} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-[13px] font-semibold text-fg">
            {debrief.title}
          </h3>
          {meta ? <p className="mt-0.5 text-[11px] tabular-nums text-muted">{meta}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => openItem(meetingId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {t("dashboard.debrief.openMeeting")}
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </header>

      <div className="mt-3 flex flex-col gap-2.5">
        <div className="flex items-start gap-2">
          <label htmlFor={`${headingId}-project`} className={fieldLabel}>
            {t("dashboard.debrief.project")}
          </label>
          <select
            id={`${headingId}-project`}
            value={projectId ?? ""}
            onChange={(e) => void changeProject(e.target.value || null)}
            className={`${selectCls} max-w-[260px]`}
          >
            <option value="">{t("dashboard.debrief.noProject")}</option>
            {liveProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji ? `${p.emoji} ` : ""}
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start gap-2">
          <span className={fieldLabel} id={`${headingId}-people`}>
            {t("dashboard.debrief.people")}
          </span>
          <ul
            aria-labelledby={`${headingId}-people`}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          >
            {participants.length === 0 ? (
              <li className="py-1 text-[11px] text-faint">{t("dashboard.debrief.noPeople")}</li>
            ) : null}
            {participants.map((p) => (
              <ParticipantChip
                key={p.speaker_key}
                participant={p}
                people={people}
                onRemove={() => void removeParticipant(p)}
                onLink={(personId) => void linkSpeaker(p, personId)}
              />
            ))}
            <li>
              <AddPersonMenu
                people={unlinkedPeople(people, participants)}
                onPick={(p) => void addPerson(p)}
                onCreate={(name) => void createAndAddPerson(name)}
              />
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-3 border-t border-accent/20 pt-2.5">
        <p className="mb-1.5 text-[11px] font-medium text-muted">{t("dashboard.debrief.followUps")}</p>
        {debrief.suggestions.length === 0 ? (
          <p className="text-[12px] text-faint">{t("dashboard.debrief.noFollowUps")}</p>
        ) : visibleRows.length === 0 ? (
          <p className="text-[12px] text-faint">{t("dashboard.debrief.allHandled")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {visibleRows.map((row) => (
              <SuggestionRow
                key={row.suggestion.id}
                row={row}
                people={people}
                onText={(text) => patchRow(row.suggestion.id, { text })}
                onAssignee={(assignee) => patchRow(row.suggestion.id, { assignee })}
                onAccept={() => void accept(row)}
                onSkip={() => void skip(row)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={closing}
          onClick={() => void close("dismissed")}
          className="rounded-md px-2.5 py-1 text-xs text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
        >
          {t("dashboard.debrief.dismiss")}
        </button>
        <button
          type="button"
          disabled={closing}
          onClick={() => void close("done")}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={12} strokeWidth={2.5} aria-hidden="true" />
          {t("dashboard.debrief.done")}
        </button>
      </footer>
    </article>
  );
}

function ParticipantChip({
  participant,
  people,
  onRemove,
  onLink,
}: {
  participant: MeetingParticipant;
  people: Person[];
  onRemove: () => void;
  onLink: (personId: string) => void;
}) {
  const { t } = useTranslation("main");
  const unnamed = isUnnamedSpeaker(participant);
  const name = participant.display_name.trim() || t("dashboard.debrief.unknownSpeaker");
  const canLink = unnamed && isRelabelableSpeakerKey(participant.speaker_key) && people.length > 0;

  return (
    <li
      className={`inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-[12px] ${
        unnamed
          ? "border-dashed border-line-strong text-muted"
          : "border-line bg-canvas text-fg"
      }`}
    >
      <span className="truncate">{name}</span>
      {canLink ? (
        <select
          aria-label={t("dashboard.debrief.whoIsThis", { name })}
          value=""
          onChange={(e) => e.target.value && onLink(e.target.value)}
          className="max-w-[120px] rounded border-0 bg-transparent text-[11px] text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <option value="">{t("dashboard.debrief.linkSpeaker")}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("dashboard.debrief.removePerson", { name })}
        className="grid h-4 w-4 place-items-center rounded-full text-faint hover:bg-elevated hover:text-fg"
      >
        <X size={10} aria-hidden="true" />
      </button>
    </li>
  );
}

function AddPersonMenu({
  people,
  onPick,
  onCreate,
}: {
  people: Person[];
  onPick: (person: Person) => void;
  onCreate: (name: string) => void;
}) {
  const { t } = useTranslation("main");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  const exact = q ? people.some((p) => p.name.trim().toLowerCase() === q) : true;

  const finish = () => {
    setOpen(false);
    setQuery("");
  };
  const entry =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none";

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      renderTrigger={(props) => (
        <button
          {...props}
          aria-haspopup="dialog"
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-accent/50 px-2.5 py-0.5 text-[12px] text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <UserPlus size={12} aria-hidden="true" />
          {t("dashboard.debrief.addPerson")}
        </button>
      )}
    >
      <div
        role="dialog"
        aria-label={t("dashboard.debrief.addPerson")}
        className="absolute left-0 top-full z-50 mt-1 w-[230px] overflow-hidden rounded-md border border-line bg-canvas shadow-lg"
      >
        <div className="border-b border-line p-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (matches.length === 1) onPick(matches[0]);
              else if (q && !exact) onCreate(query);
              else return;
              finish();
            }}
            placeholder={t("dashboard.debrief.searchPeople")}
            aria-label={t("dashboard.debrief.searchPeople")}
            className="w-full rounded border border-line bg-surface px-2 py-1 text-[12px] text-fg placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          />
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className={entry}
              onClick={() => {
                onPick(p);
                finish();
              }}
            >
              <span className="truncate">{p.name}</span>
            </button>
          ))}
          {matches.length === 0 && exact ? (
            <p className="px-3 py-1.5 text-[11px] text-faint">{t("dashboard.debrief.noMatches")}</p>
          ) : null}
          {q && !exact ? (
            <button
              type="button"
              className={`${entry} text-accent`}
              onClick={() => {
                onCreate(query);
                finish();
              }}
            >
              <Plus size={12} aria-hidden="true" />
              <span className="truncate">{t("dashboard.debrief.createPerson", { name: query.trim() })}</span>
            </button>
          ) : null}
        </div>
      </div>
    </Menu>
  );
}

function SuggestionRow({
  row,
  people,
  onText,
  onAssignee,
  onAccept,
  onSkip,
}: {
  row: RowState;
  people: Person[];
  onText: (text: string) => void;
  onAssignee: (personId: string | null) => void;
  onAccept: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation("main");
  const added = row.phase === "added";
  const busy = row.phase === "busy";

  if (added) {
    return (
      <li
        className="echo-debrief-added flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-success"
        role="status"
      >
        <Check size={13} strokeWidth={2.5} aria-hidden="true" />
        <span className="font-medium">{t("dashboard.debrief.added")}</span>
        <span className="min-w-0 truncate text-muted">{row.text}</span>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-canvas/70 px-2 py-1.5 sm:flex-nowrap">
      <input
        value={row.text}
        disabled={busy}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAccept();
          }
        }}
        aria-label={t("dashboard.debrief.taskText")}
        className="min-w-0 flex-1 basis-full rounded border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-fg hover:border-line focus-visible:border-line-strong focus-visible:outline-none sm:basis-auto"
      />
      <select
        value={row.assignee ?? ""}
        disabled={busy}
        onChange={(e) => onAssignee(e.target.value || null)}
        aria-label={t("dashboard.debrief.assignee")}
        className="max-w-[140px] rounded-md border border-line bg-canvas px-1.5 py-1 text-[11px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <option value="">{t("dashboard.debrief.me")}</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onAccept}
        disabled={busy || !row.text.trim()}
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={11} strokeWidth={2.5} aria-hidden="true" />
        {t("dashboard.debrief.addTask")}
      </button>
      <button
        type="button"
        onClick={onSkip}
        disabled={busy}
        className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
      >
        {t("dashboard.debrief.skip")}
      </button>
    </li>
  );
}
