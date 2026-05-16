# Meeting Context Enrichment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich meeting synthesis with calendar event title + attendees by adding a Swift `echo-scribe-calmatch` sidecar that queries EventKit, plus a new permission, a new DB column, and a UI panel for inspecting / overriding the match.

**Source spec:** `docs/superpowers/specs/2026-05-15-meeting-context-enrichment-design.md`

**Existing patterns this plan follows:**
- Sidecar packaging: mirror `src-tauri/syscap/main.swift` build script invoked from `build.rs`. Output bundled binary `echo-scribe-calmatch`.
- Permissions: `permissions.rs` already exposes mic/accessibility/screen recording with non-prompting `*_authorized()` plus prompting `prompt_*()` helpers. Add `calendars_authorized()` + `prompt_calendars()`. Frontend `PermissionsStatus` in `api.ts` mirrors backend.
- DB migrations: append-only `MIGRATIONS` array in `db/schema.rs`. Latest is v8 (`daily_summaries`); we add v9 for `meetings.calendar_match_json`.
- Context plumbing: `MeetingStartContext` (added 2026-05-15) is the carrier. Add a `calendar_match: Option<CalendarMatch>` field there. `synthesize()` and `build_meeting_synthesis_prompt()` are already context-aware.

---

## File map

**Create:**
- `src-tauri/calmatch/main.swift` — Swift sidecar querying EventKit
- `src-tauri/calmatch/Package.swift` — SwiftPM manifest (or extend existing build script)
- `src-tauri/src/calendar/mod.rs` — Rust client: spawn sidecar + parse JSON + score
- `src/views/meeting/CalendarMatchPanel.tsx` — meeting detail UI

**Modify:**
- `src-tauri/build.rs` — compile calmatch sidecar alongside syscap
- `src-tauri/tauri.conf.json` — register `echo-scribe-calmatch` as externalBin
- `src-tauri/Info.plist` (or equivalent in `tauri.conf.json`) — add `NSCalendarsFullAccessUsageDescription`
- `src-tauri/src/permissions.rs` — add `calendars_authorized()` + `prompt_calendars()` + extend `PermissionsStatus`
- `src-tauri/src/db/schema.rs` — append migration v9 (`ALTER TABLE meetings ADD COLUMN calendar_match_json TEXT`)
- `src-tauri/src/db/meetings.rs` — round-trip `calendar_match_json` on `MeetingRow`
- `src-tauri/src/meeting/mod.rs` — extend `MeetingStartContext` with `calendar_match`; spawn calmatch at start + stop; persist match JSON in `stop()`
- `src-tauri/src/llm/prompt.rs` — render calendar match block in `build_start_context_block`
- `src-tauri/src/commands.rs` — add `pick_calendar_match` command (override + retry_summary)
- `src/lib/api.ts` — types for `CalendarMatch`, command bindings, extend `PermissionsStatus`
- `src/views/Onboarding.tsx` — optional row for Calendar permission
- `src/views/settings/PermissionsSection.tsx` — Calendar row
- `src/views/meeting/MeetingDetailView.tsx` — render `CalendarMatchPanel`

---

## Task 1: Swift calmatch sidecar — skeleton + permission probe

**Files:**
- Create: `src-tauri/calmatch/main.swift`
- Modify: `src-tauri/build.rs`, `src-tauri/tauri.conf.json`

- [ ] **Step 1: Write the failing test**
  Add a shell test under `src-tauri/calmatch/test.sh` that builds the
  binary and runs `echo-scribe-calmatch --probe` expecting JSON
  `{"authorization": "<status>"}` on stdout.
- [ ] **Step 2: Author `main.swift`**
  Parse argv: `--probe` (return status JSON), `--request-access` (call
  `requestFullAccessToEvents`, exit 0/1), or `match` mode (default).
  Use Foundation's `JSONEncoder` for output.
- [ ] **Step 3: Wire build**
  Mirror the existing `syscap/build.swift` invocation in `build.rs`.
  Output binary path matches the platform triple naming Tauri expects.
- [ ] **Step 4: Register in `tauri.conf.json`**
  Add `echo-scribe-calmatch` to `bundle.externalBin`.
- [ ] **Step 5: Run the test**
  Build succeeds, binary exists in target dir, probe returns JSON.

## Task 2: Calendar permission — backend

**Files:**
- Modify: `src-tauri/src/permissions.rs`, `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add Info.plist key**
  `NSCalendarsFullAccessUsageDescription` = "Echo Scribe matches your
  meetings to calendar events to enrich summaries with attendees and
  topic. The data never leaves your Mac."
- [ ] **Step 2: Extend `PermissionsStatus`**
  Add `calendars: bool` field. Update `status()` to populate it.
- [ ] **Step 3: Implement `calendars_authorized()`**
  Call `EKEventStore.authorizationStatus(for: .event)` via objc2 bindings
  if available, otherwise shell out to the calmatch sidecar `--probe`
  and parse stdout. Prefer the latter — avoids pulling EventKit symbols
  into the main binary.
- [ ] **Step 4: Implement `prompt_calendars()`**
  Spawn sidecar with `--request-access`. Block ≤ 30 s on the prompt
  result. Return resulting authorization status.
- [ ] **Step 5: Tests**
  Mock the sidecar binary with a fixture script (under
  `src-tauri/tests/fixtures/calmatch-stub.sh`) that emits canned JSON.
  Assert `status()` reflects the stub. Skip on non-macOS.

## Task 3: Calendar permission — frontend

**Files:**
- Modify: `src/lib/api.ts`, `src/views/Onboarding.tsx`,
  `src/views/settings/PermissionsSection.tsx`

- [ ] **Step 1: Extend TS `PermissionsStatus`**
  Add `calendars: boolean`. Bind a `prompt_calendars` command.
- [ ] **Step 2: Onboarding row**
  Add a row below the existing optional rows. Label: "Calendar
  (optional) — match meetings to your invites for richer summaries."
- [ ] **Step 3: Settings row**
  Same row pattern as accessibility, with a "Re-prompt" button.
- [ ] **Step 4: First-meeting banner**
  Add a `meeting-calendar-banner-dismissed` settings key. On meeting
  start, if `calendars=false` and the banner hasn't been dismissed,
  emit a Tauri event the main window handles with a toast.

## Task 4: Sidecar match mode — EventKit query + scoring

**Files:**
- Modify: `src-tauri/calmatch/main.swift`

- [ ] **Step 1: Write the failing test**
  Add a Swift unit test (or shell test invoking the binary with
  fixture env vars that swap in a fake `EKEventStore`) that asserts
  the sidecar returns ranked matches for overlapping events.
- [ ] **Step 2: Implement `match` mode**
  Read `iso_start`, `iso_end`, optional `conf_hint` from stdin (one
  JSON request per spawn). Build `NSPredicate` via
  `predicateForEvents(withStart:end:calendars:nil)`. Map each event
  to the JSON shape from the spec, including organizer + attendees
  with `participantRole` and `isCurrentUser` flags.
- [ ] **Step 3: Scoring**
  Implement `overlap_ratio`, `conf_url_match`, `start_distance` per
  the spec. Sort descending; emit top 3 as `candidates` plus the top
  pick as `match`.
- [ ] **Step 4: Pass test**

## Task 5: Rust calendar client + scoring threshold

**Files:**
- Create: `src-tauri/src/calendar/mod.rs`
- Modify: `src-tauri/src/lib.rs` (register module)

- [ ] **Step 1: Write the failing test**
  Unit tests against a `MockSidecar` trait: given a canned JSON
  response, `match_meeting(start, end, hint)` returns the parsed
  `CalendarMatch` if `score >= 0.3`, else `None`.
- [ ] **Step 2: Define types**
  `CalendarMatch { title, organizer, attendees, starts_at, ends_at,
  notes, calendar_name, conferencing_url, match_score, match_reason,
  candidates }`. `Attendee { name, email, self_, role }`.
- [ ] **Step 3: Implement `match_meeting`**
  Spawn the bundled sidecar via `tauri::api::process::Command::new_sidecar`,
  write request JSON to stdin, read one line stdout, parse, threshold,
  return.
- [ ] **Step 4: Timeout**
  Wrap the spawn in a 2 s tokio timeout. On expiry, kill the child
  and return `None` with a `tracing::warn!`.
- [ ] **Step 5: Pass tests**

## Task 6: Schema migration v9 + DB round-trip

**Files:**
- Modify: `src-tauri/src/db/schema.rs`, `src-tauri/src/db/meetings.rs`

- [ ] **Step 1: Write the failing test**
  In `db/schema.rs` tests, assert applying v9 adds the column and
  that v8→v9 upgrade on a populated fixture preserves prior rows.
- [ ] **Step 2: Append v9 migration**
  `ALTER TABLE meetings ADD COLUMN calendar_match_json TEXT;`
- [ ] **Step 3: Extend `MeetingRow`**
  Add `pub calendar_match_json: Option<String>`. Update
  `insert_meeting`, `get_meeting`, `list_meetings`, `row_to_meeting`,
  `finalize_meeting`.
- [ ] **Step 4: Pass tests**

## Task 7: Wire calmatch into meeting lifecycle

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs`

- [ ] **Step 1: Write the failing test**
  Unit test: `synthesize()` receives a `MeetingStartContext` whose
  `calendar_match` is `Some(...)` and the rendered prompt block
  contains the event title + attendees. (Test lives in
  `llm::prompt` tests — leverage the existing pattern.)
- [ ] **Step 2: Extend `MeetingStartContext`**
  Add `pub calendar_match: Option<crate::calendar::CalendarMatch>`.
  Default = `None`.
- [ ] **Step 3: Call `match_meeting` in `start()`**
  After `FocusContext` capture, await
  `calendar::match_meeting(now, now + 30min, conf_hint)`. Store
  result on `ActiveMeeting.calendar_match`.
- [ ] **Step 4: Refine in `stop()`**
  Re-call `match_meeting` with the actual `started_at`/`ended_at`
  window. If the refined match disagrees with the start-time match,
  prefer the higher score. Serialize the chosen match into
  `calendar_match_json` for persistence.
- [ ] **Step 5: Plumb through synthesize**
  Update `MeetingStartContext` construction in `stop()` to include
  the resolved match. Same for `retry_summary` — but it reads the
  persisted JSON via `MeetingRow.calendar_match_json` rather than
  re-spawning the sidecar.
- [ ] **Step 6: Pass test**

## Task 8: Prompt rendering

**Files:**
- Modify: `src-tauri/src/llm/prompt.rs`

- [ ] **Step 1: Write the failing test**
  Confirm a `MeetingStartContext` with `calendar_match: Some(...)`
  produces a `Calendar match (confidence 0.92):` block in the user
  prompt, including organizer + attendees.
- [ ] **Step 2: Extend `build_start_context_block`**
  Render the new block. Use "low confidence" prefix when
  `match_score < 0.6`.
- [ ] **Step 3: Pass test**

## Task 9: UI — meeting detail panel

**Files:**
- Create: `src/views/meeting/CalendarMatchPanel.tsx`
- Modify: `src/views/meeting/MeetingDetailView.tsx`,
  `src/lib/api.ts`

- [ ] **Step 1: TS types**
  Mirror `CalendarMatch` from Rust.
- [ ] **Step 2: Panel component**
  Render title, organizer chip, attendee chips, notes (collapsible).
  Show "Wrong match?" affordance with the candidates list.
- [ ] **Step 3: Override command**
  Add `pick_calendar_match` Tauri command. Args: `meeting_id`,
  `match: Option<CalendarMatch>`. Persists, calls `retry_summary`.
- [ ] **Step 4: Wire into detail view**
  Mount above the summary; hide entirely when match is `None`.

## Task 10: Smoke test + manual QA checklist

**Files:**
- Create: `docs/superpowers/plans/manual-tests-calendar-match.md`

- [ ] Real Google Meet with single overlapping invite → match shows
  correct attendees in the synthesis prompt.
- [ ] Real Zoom call with two back-to-back invites → both candidates
  surfaced; user can flip.
- [ ] Ad-hoc Zoom (no invite) → no match, no banner spam, synthesis
  still produces a valid summary.
- [ ] Calendar permission denied at onboarding → meeting still
  records + synthesizes; banner appears once on first meeting.
- [ ] Calendar permission granted mid-day → next meeting picks up
  matches without an app restart.
- [ ] `retry_summary` after editing the event upstream → uses the
  snapshot, not the live edit (documented behavior).
