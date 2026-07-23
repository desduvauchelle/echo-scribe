# Sidebar "Record" Button — Manual Meeting Capture

**Date:** 2026-07-22
**Status:** Design — approved, awaiting spec review
**Owner:** Denis

## Goal

Add a prominent, always-available **Record** button to the Main sidebar that starts/stops
a full capture (system audio + mic) and logs it as a meeting — so a quick "record
everything and brain-dump" is one click away instead of buried in the Meetings tab.

## Framing (decided)

Reuse the **existing manual meeting recorder** — not a new capture engine or a new data
type. Each recording is a normal meeting: auto-transcribed, summarized, action items, and
editable notes, exactly as today. The Record button is a new *surface* on existing
machinery.

## Non-goals

- No new capture pipeline (reuse `start_meeting_manual` / `stop_meeting`).
- No live/timestamped notes UI while recording — notes happen after, via the existing
  `NotesSection` in the Activity panel (`updateMeetingNotes`). The button is purely
  start/stop.
- No tray item, global hotkey, or floating widget (sidebar only for now).
- No Windows support in this change (system audio is macOS-only; see Platform).

## Current state (grounding)

- `start_meeting_manual` (`commands.rs:2697`) starts a `MeetingManager` recording
  (system audio via the `syscap` sidecar + mic) and spawns an end-monitor that auto-stops
  on mic silence. `stop_meeting` / `is_meeting_active` exist. TS bindings:
  `startMeetingManual` / `stopMeeting` / `isMeetingActive` (`api.ts`).
- `MeetingsView` already has this as an inline start/stop toggle: local `active` / `busy`
  state, an `onToggle` calling start/stop, `refreshActive()` via `isMeetingActive()`, and
  listeners on the backend events `meeting-started` / `meeting-status`.
- A `RecordingOverlay` already appears during an active meeting and can `stop_meeting`.
- So starting from a new sidebar button and stopping from the Meetings toggle or the
  overlay must all stay in sync — they already share one backend truth (`is_meeting_active`
  + the `meeting-started`/`meeting-status` events).

## Design

### 1. Shared hook: `useMeetingRecorder()`

New file `src/lib/useMeetingRecorder.ts`. Owns the recorder's UI state so the sidebar
button and the Meetings tab share one source of truth (DRY):

- State: `active: boolean`, `busy: boolean`.
- On mount: `isMeetingActive()` → `active`.
- Listens to `meeting-started` and `meeting-status`; on either, re-reads `isMeetingActive()`.
- `toggle()`: if `active` → `stopMeeting()`, else `startMeetingManual()`; guards on `busy`;
  on error, pushes a **friendly** toast (via `useToasts()`) — never raw error text — and
  logs nothing sensitive. Re-reads active state in a `finally`.
- Returns `{ active, busy, toggle }`.

The elapsed-time display is intentionally omitted in v1 (the app doesn't expose the active
meeting's start time from `is_meeting_active`, which returns only a bool). The recording
state is shown as a pulsing indicator instead (see below). Adding a real timer later means
surfacing `started_at` for the active meeting — out of scope here.

### 2. Sidebar button: `SidebarRecordButton.tsx`

New file `src/components/SidebarRecordButton.tsx`. Thin presentational component:

- Consumes `useMeetingRecorder()` and the capability gate (below).
- Renders `null` when the gate is false (Windows).
- Idle: a "Record" button (dot icon).
- Active: a "Stop" button with a pulsing red dot and a "Recording…" label.
- Disabled while `busy`. `onClick` → `toggle()`.

Mounted in `src/views/Main.tsx` in the sidebar footer group (the same `mt-auto` block that
holds Settings/theme, where the removed dictation button used to sit — but this is a
deliberate, styled control, not that button).

### 3. Capability gate

Add to the pure `uiGates` selector (`src/lib/capabilities.ts`):
`showMeetingRecord: caps.system_audio_capture`. True on macOS, false on Windows, so the
button is hidden on Windows — consistent with the whole Meetings feature being gated off
there. Well-named and consumed by the button (no dead gate).

### 4. MeetingsView refactor (DRY)

Refactor `MeetingsView` to consume `useMeetingRecorder()` for `{ active, busy, toggle }`,
replacing its inline `active`/`busy`/`onToggle`/`refreshActive` for the *recorder* state.
`MeetingsView` keeps its own row-refresh logic (its `refreshRows` on the same events is
separate concern). Net: one recorder-state implementation, two consumers, still in sync.

## Platform

macOS-only. `system_audio_capture` is false on Windows and the `syscap` sidecar isn't
bundled there, so the button is hidden on Windows via the gate. No Windows behavior change.

## Error handling & diagnostics

- `toggle()` failures (e.g., Screen-Recording permission not granted → the canonical
  `syscap` "Failed to find any displays or windows to capture") surface as a short toast
  ("Couldn't start recording — check Screen Recording permission in Settings → Diagnostics")
  while the backend logs the full technical detail (existing `MeetingManager` logging).
- No secrets involved; nothing new to redact.

## Testing

- **Pure logic (`bun:test`, in `tests/`):** the toggle-decision helper — factor the
  "active → stop, else start" choice into a tiny pure function (e.g.
  `nextRecorderAction(active): "start" | "stop"`) in `useMeetingRecorder.ts` (or a sibling
  pure module) and test it; plus a `uiGates` test that `showMeetingRecord` follows
  `system_audio_capture` (Windows false / macOS true).
- **Components/hook:** thin `.tsx`/hook untested by render per repo convention; verified by
  `bun run build` (tsc).
- **Backend:** unchanged; already tested.

## Risks

- **Hook/MeetingsView refactor regression:** MeetingsView's existing toggle is load-bearing;
  the refactor must preserve its behavior (start/stop still works, rows still refresh on
  events). Mitigation: keep MeetingsView's row-refresh effect intact; only its recorder
  state moves to the hook. Manual check: start from sidebar → Meetings toggle shows active;
  stop from Meetings → sidebar returns to idle.
- **State-sync edge:** if `meeting-started`/`meeting-status` events don't fire in some path,
  the mount-time `isMeetingActive()` poll still corrects state when either view remounts.
