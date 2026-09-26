import { describe, expect, test } from "bun:test";
import {
  findPersonByName,
  isRelabelableSpeakerKey,
  isUnnamedSpeaker,
  matchOwnerToPersonId,
  otherParticipants,
  sortDebriefs,
  unlinkedPeople,
} from "../src/lib/meetingDebrief";

const people = [
  { id: "p1", name: "Sarah Connor" },
  { id: "p2", name: "John Smith" },
  { id: "p3", name: "John Doe" },
  { id: "p4", name: "Ada" },
];

describe("matchOwnerToPersonId", () => {
  test("self pronouns and empty owners map to Me (null)", () => {
    for (const owner of ["me", "Me", " I ", "you", "YOU", null, undefined, "", "  "]) {
      expect(matchOwnerToPersonId(owner, people)).toBeNull();
    }
  });

  test("exact full-name match is case-insensitive and whitespace-tolerant", () => {
    expect(matchOwnerToPersonId("sarah connor", people)).toBe("p1");
    expect(matchOwnerToPersonId("  JOHN   SMITH ", people)).toBe("p2");
    expect(matchOwnerToPersonId("ada", people)).toBe("p4");
  });

  test("unique first-name match resolves; ambiguous one does not", () => {
    expect(matchOwnerToPersonId("Sarah", people)).toBe("p1");
    expect(matchOwnerToPersonId("John", people)).toBeNull();
  });

  test("unknown owner falls back to Me", () => {
    expect(matchOwnerToPersonId("Bob", people)).toBeNull();
    expect(matchOwnerToPersonId("Sarah", [])).toBeNull();
  });
});

describe("isUnnamedSpeaker", () => {
  test("diarization / channel labels without a person are unnamed", () => {
    for (const name of ["Speaker 1", "speaker 12", "Speaker", "Them", "Participant #2", "Guest 3", ""]) {
      expect(isUnnamedSpeaker({ person_id: null, display_name: name })).toBe(true);
    }
  });

  test("real names or linked people are named", () => {
    expect(isUnnamedSpeaker({ person_id: null, display_name: "Sarah" })).toBe(false);
    expect(isUnnamedSpeaker({ person_id: "p1", display_name: "Speaker 1" })).toBe(false);
    expect(isUnnamedSpeaker({ person_id: null, display_name: "Speakerphone Steve" })).toBe(false);
  });
});

describe("participants and people", () => {
  test("otherParticipants drops the user's own mic channel", () => {
    const ps = [{ speaker_key: "you" }, { speaker_key: "them" }, { speaker_key: "manual:p1" }];
    expect(otherParticipants(ps).map((p) => p.speaker_key)).toEqual(["them", "manual:p1"]);
  });

  test("only you/them keys are relabelable", () => {
    expect(isRelabelableSpeakerKey("them")).toBe(true);
    expect(isRelabelableSpeakerKey("you")).toBe(true);
    expect(isRelabelableSpeakerKey("manual:p1")).toBe(false);
  });

  test("unlinkedPeople hides people already in the meeting", () => {
    const out = unlinkedPeople(people, [{ person_id: "p1" }, { person_id: null }]);
    expect(out.map((p) => p.id)).toEqual(["p2", "p3", "p4"]);
  });

  test("findPersonByName is case-insensitive", () => {
    expect(findPersonByName(people, " ada ")?.id).toBe("p4");
    expect(findPersonByName(people, "nobody")).toBeUndefined();
    expect(findPersonByName(people, "  ")).toBeUndefined();
  });
});

describe("sortDebriefs", () => {
  test("newest first, bad dates last, input untouched", () => {
    const input = [
      { id: "a", startedAt: "2026-09-24T10:00:00Z" },
      { id: "b", startedAt: "garbage" },
      { id: "c", startedAt: "2026-09-25T09:00:00Z" },
    ];
    expect(sortDebriefs(input).map((d) => d.id)).toEqual(["c", "a", "b"]);
    expect(input[0].id).toBe("a");
  });
});
