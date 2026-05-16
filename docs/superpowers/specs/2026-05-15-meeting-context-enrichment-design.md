# Meeting Context Enrichment — Design

**Status:** Draft
**Date:** 2026-05-15
**Author:** Brainstormed with Claude

## Problem

Echo Scribe's meeting synthesis prompt currently sees only the detected app
name (e.g. "Zoom", "Google Meet") and the transcript. Two pieces of high-value
context exist outside Echo Scribe but aren't reaching the LLM:

1. **Topic / title.** Calendar invites name the meeting ("Weekly Standup —
   Acme Project Sync"). Without it, the LLM has to infer the topic from the
   first 30 seconds of small talk, which often fails.
2. **Participants.** The invite knows who's attending. Without participant
   names the LLM produces summaries that say "the user" and "the other side"
   instead of "Alice" and "Bob", and action-item ownership defaults to
   "unspecified" instead of the real assignee.

A prior change (2026-05-15) wired window title, URL, and browser tab title
into the synthesis prompt. Those help (Zoom titles often embed the meeting
name; Meet tab titles sometimes contain participant names) but are
unreliable: window titles for Zoom *Personal Meeting Rooms* don't include a
topic, and Meet tab titles rotate as participants join/leave.

The authoritative source is the user's macOS Calendar (Apple Calendar
backed by iCloud, Google, Exchange, or any other CalDAV-style provider that
exposes its events through `EventKit`).

## Goals

- Match an active meeting to the user's calendar event(s) overlapping the
  recording window, and feed the event's title, attendees, organizer, and
  notes into the synthesis prompt.
- Work across Zoom, Google Meet, Teams, WebEx, FaceTime — anything where the
  user has an invite. Match by overlapping wall-clock first, narrow by
  conferencing URL when available.
- Keep meeting capture working when no calendar match exists (ad-hoc calls,
  Calendar permission denied, no events that day) — the new pathway must be
  strictly additive to the existing context fields.
- Make the calendar match auditable: surface which event matched in the
  meeting detail UI so the user can override or correct a wrong match.

## Non-goals

- Two-way calendar writes (creating events, updating attendees).
- Reminders integration. Phase 2 candidate, not in scope here.
- Cross-platform: Windows/Linux EventKit equivalents are out of scope.
  Module compiles on non-macOS but returns an empty match.
- Participant resolution by face/voice diarization. Audio-only; participant
  names come from the calendar invite, not the call itself.

## Approach

Add a Swift sidecar (`echo-scribe-calmatch`) bundled the same way as
`echo-scribe-syscap`. The sidecar uses `EventKit` to:

1. Request `EKAuthorizationStatus.fullAccess` (macOS 14+) or fall back to
   `requestAccess(to: .event)` on older OS.
2. On stdin command `match {iso_start} {iso_end} [conf_hint]`, query
   `predicateForEvents(withStart:end:calendars:nil)` and return events that
   overlap.
3. Score each candidate event by:
   - Overlap ratio with the recording window (higher = better).
   - Conferencing URL match (event has a Zoom/Meet/Teams URL containing the
     same meeting code as the captured `browser_url`/`window_title`).
   - Distance from the recording start to the event start (events that
     started within ±5 min of recording rank highest).
4. Emit one JSON line per match request:

   ```json
   {
     "match": {
       "title": "Acme weekly sync",
       "organizer": {"name": "Alice", "email": "alice@acme.com"},
       "attendees": [
         {"name": "Bob", "email": "bob@acme.com", "self": false},
         {"name": "Carol", "email": "carol@acme.com", "self": false}
       ],
       "starts_at": "2026-05-15T16:00:00Z",
       "ends_at": "2026-05-15T16:30:00Z",
       "notes": "Standing agenda: status, blockers, demo.",
       "calendar_name": "Work",
       "conferencing_url": "https://zoom.us/j/123456789",
       "match_score": 0.92,
       "match_reason": "overlap+conf_url"
     }
   }
   ```

The Rust side:

1. Spawns the sidecar at meeting start and again at meeting stop (cheap;
   the sidecar processes one request per spawn and exits).
2. Stores the best match on `ActiveMeeting` (and persists it in a new
   `meetings.calendar_match_json` column for retry + UI display).
3. Extends `MeetingStartContext` (already exists) with a
   `calendar_match: Option<CalendarMatch>` field. The synthesis prompt
   renders it as a structured block — title, attendees, notes — that lands
   above the transcript.

## Permission flow

EventKit needs `NSCalendarsFullAccessUsageDescription` in `Info.plist` and
a runtime prompt. We extend the existing `PermissionsStatus` (currently:
mic, accessibility, screen recording) with a fourth field, `calendars`:

- `permissions.rs::calendars_authorized()` → wraps
  `EKEventStore.authorizationStatus(for: .event)`, returns
  `Some(true)` only for `fullAccess` (macOS 14+) or `authorized` (older).
- `permissions.rs::prompt_calendars()` → spawns the sidecar with
  `--request-access` flag; sidecar calls
  `EKEventStore().requestFullAccessToEvents()` which surfaces the system
  prompt. Sidecar exits with code 0 = granted, 1 = denied.

Surface the new permission in:

- Onboarding (`Onboarding.tsx`) — same row pattern as mic/accessibility,
  marked **optional**. Skip → meeting capture still works, calendar match
  silently disabled.
- Settings → Permissions section (`PermissionsSection.tsx`) — same row.
- First-meeting banner: if `permissions.calendars` is false when a meeting
  starts, emit a one-time toast: "Grant Calendar access to enrich meeting
  summaries with attendees and topic." Dismiss-once, persisted via a
  settings key.

## Data flow

```
Meeting starts
  │
  ├── FocusContext capture (existing)
  ├── Calendar permission check
  │     ├── unauthorized → MeetingStartContext.calendar_match = None
  │     └── authorized → spawn echo-scribe-calmatch
  │                        sidecar reads:
  │                          - ISO start (now)
  │                          - ISO end (now + 30 min, refined at stop)
  │                          - conf hint (browser_url / window_title)
  │                        sidecar writes one CalendarMatch line
  │                        Rust parses + stores on ActiveMeeting
  │
Meeting stops
  │
  ├── Re-spawn echo-scribe-calmatch with actual end time
  │     and persist refined match on `meetings.calendar_match_json`
  │
  └── synthesize() reads MeetingStartContext (incl. calendar_match)
        → prompt block:
            Calendar match (confidence 0.92):
            - Title: Acme weekly sync
            - Attendees: Alice (organizer), Bob, Carol
            - Notes: Standing agenda...
        → LLM produces summary with real names + topic-aware bullets
```

## Match scoring

```
score = 0.5 * overlap_ratio
      + 0.4 * (1.0 if conferencing_url_matches else 0.0)
      + 0.1 * exp(-abs(event.start - meeting.start) / 5min)
```

Threshold: best score must be ≥ 0.3 to surface; otherwise no match. Below
0.6 the synthesis prompt prefixes the block with "Calendar match (low
confidence)" so the LLM knows to treat it as a hint rather than a fact.

## Schema migration

Migration v9 adds:

```sql
ALTER TABLE meetings ADD COLUMN calendar_match_json TEXT;
```

`MeetingRow` gets a new `calendar_match_json: Option<String>` field; CRUD
in `db/meetings.rs` is updated to round-trip it. `retry_summary` reads the
column instead of re-spawning the sidecar (the event might have been
edited after recording, but the *original* match is what the user saw and
expected).

## UI

Meeting detail view (`MeetingDetailView.tsx`) gains a "Calendar match"
panel above the summary:

- Title (link to the calendar event via `x-apple-eventkit://` deeplink
  where supported; copy-only otherwise).
- Attendee chips with optional self-indicator.
- "Wrong match?" link → opens a dropdown of the next 2 ranked candidates
  + "Clear match" option. Selecting a different one rewrites
  `calendar_match_json` and re-runs synthesis (reuses the existing
  `retry_summary` path).

## Failure modes

- **Sidecar timeout.** 2 s deadline. On timeout, log + proceed with no
  match. Same pattern as `run_osascript_with_timeout` in `focus.rs`.
- **Permission denied mid-session.** `EKAuthorizationStatus` is checked
  before each spawn; downgraded grants result in no match, no crash.
- **No events overlap.** Common case for ad-hoc calls. Match is `None`;
  synthesis prompt omits the block entirely (no "no calendar match found"
  noise for the LLM).
- **Multiple back-to-back events overlap.** Pick highest score; if scores
  are within 0.1 of each other, store both and let the user disambiguate
  in the UI ("This meeting matched two events — pick one").

## Open questions

- **iCloud-only vs all sources.** EventKit returns events from every
  configured account by default. We don't filter — if a user has multiple
  calendars connected, all are eligible. Worth a settings toggle later
  ("Restrict to calendar: [dropdown]") if false-matches become a problem.
- **Recurring events.** EventKit handles expansion transparently;
  `predicateForEvents` returns each occurrence individually. No special
  handling needed.
- **Event modifications after match.** We snapshot title + attendees +
  notes at match time. If the user edits the event later (e.g. fixes a
  typo in the title), the snapshot doesn't update. Acceptable: this is
  meeting *history*, not a live calendar mirror.
