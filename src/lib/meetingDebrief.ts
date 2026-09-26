// Pure helpers for the post-meeting debrief card (src/components/MeetingDebrief.tsx).
// Kept i18n-free and React-free so they can be unit-tested under bun:test.

import type { MeetingDebrief, MeetingParticipant, Person } from "./api";

/** Owner names that mean "the user themselves" → assignee null ("Me"). */
const SELF_NAMES = new Set(["me", "you", "i", "myself", "self"]);

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pre-fill for a suggestion's assignee picker.
 *
 * - "me" / "you" / "I" (any case) or no owner → null (= Me)
 * - exact case-insensitive full-name match → that person's id
 * - otherwise a unique first-name match ("sarah" → "Sarah Connor") → that id
 * - anything else → null (= Me); the user can still change it.
 */
export function matchOwnerToPersonId(
  ownerName: string | null | undefined,
  people: Pick<Person, "id" | "name">[],
): string | null {
  if (!ownerName) return null;
  const owner = norm(ownerName);
  if (!owner || SELF_NAMES.has(owner)) return null;

  const exact = people.find((p) => norm(p.name) === owner);
  if (exact) return exact.id;

  const byFirst = people.filter((p) => norm(p.name).split(" ")[0] === owner);
  if (byFirst.length === 1) return byFirst[0].id;
  return null;
}

const UNNAMED_LABEL = /^(speaker|participant|guest|them|caller|unknown)(\s*#?\s*\d+)?$/i;

/** True for a participant that is just a diarization/channel label
 *  ("Speaker 1", "Them") with no linked person. */
export function isUnnamedSpeaker(
  p: Pick<MeetingParticipant, "person_id" | "display_name">,
): boolean {
  if (p.person_id) return false;
  const name = p.display_name.trim();
  return name === "" || UNNAMED_LABEL.test(name);
}

/** The user's own mic channel isn't "someone they talked with". */
export function otherParticipants<T extends { speaker_key: string }>(
  participants: T[],
): T[] {
  return participants.filter((p) => p.speaker_key !== "you");
}

/** Only the legacy channel keys can be relabelled via set_meeting_speaker_label. */
export function isRelabelableSpeakerKey(key: string): key is "you" | "them" {
  return key === "you" || key === "them";
}

/** People not already linked to one of the participants. */
export function unlinkedPeople<P extends Pick<Person, "id">>(
  people: P[],
  participants: Pick<MeetingParticipant, "person_id">[],
): P[] {
  const linked = new Set(participants.map((p) => p.person_id).filter(Boolean));
  return people.filter((p) => !linked.has(p.id));
}

/** Newest meeting first; unparseable dates sink to the bottom. */
export function sortDebriefs<D extends Pick<MeetingDebrief, "startedAt">>(debriefs: D[]): D[] {
  const t = (d: D) => {
    const ms = Date.parse(d.startedAt);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return [...debriefs].sort((a, b) => t(b) - t(a));
}

/** Case-insensitive name lookup, used before creating a duplicate person. */
export function findPersonByName<P extends Pick<Person, "name">>(
  people: P[],
  name: string,
): P | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return people.find((p) => norm(p.name) === n);
}
