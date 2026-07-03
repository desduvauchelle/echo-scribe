# Meeting HUD: live transcript, mid-meeting guides, dual templates

**Date:** 2026-07-03
**Status:** Approved (design review with Denis, 2026-07-03)

## Problem

During a recorded meeting the only on-screen surfaces are:

- The **meeting pill** (`recording_overlay`, 172×36): shows "Recording · {app}" and a stop button. Nothing else.
- The **guide HUD** (`guide_overlay`, fixed 280×280, non-resizable): shows one template's key points + latest suggestions. Each `guide-update` **replaces** the previous content — there is no history.

Structural limitations:

1. A guide can only start **with** a new meeting (`start_guided_session`). Once a meeting is recording, there is no way to attach guidance.
2. Exactly **one** guide engine per meeting (`ActiveMeeting.guide_engine: Option<GuidanceEngine>`).
3. The pipeline's `SegmentObserver` is installed only when a template is attached, and is captured at `spawn_drain` time — segments are invisible to the UI in unguided meetings.
4. The guide HUD's "×" (`guide_end`) stops the **entire meeting**, which is surprising.
5. No live transcript view exists at all.
6. No built-in templates ship with the app.

## Goals

- From the meeting pill, open a live transcript and launch guided templates **mid-meeting**.
- Make the guide window **resizable** and give guidance a **card history**: newest card on top, older cards underneath.
- Support **two** guided templates running simultaneously.
- Ship **five default templates**: Sales conversation, Customer discovery, Clear communication, De-escalate / avoid arguments, Leadership presence.
- Live transcript works for **any** recording meeting, guided or not.

## Non-goals

- Persisting guidance cards to the meeting record (cards stay transient, as today).
- More than two concurrent guides.
- Changing the synthesis/summary pipeline or the guidance prompt itself.
- Multi-monitor placement logic beyond what exists today.

## Design decisions (from review)

- **One Meeting HUD window** hosting transcript + guides + launcher (not separate windows).
- **Merged card feed** for dual templates: pinned compact checklist per template on top, one chronological feed of template-tagged cards below (not per-template sections, not tabs).

## Architecture

### 1. Segment fan-out (backend)

The pipeline observer becomes **always installed** at meeting start (guided or not). It forwards each stitched `Segment` to a dispatcher owned by the active meeting:

- **Transcript history**: append to `Arc<Mutex<Vec<Segment>>>` on `ActiveMeeting`; emit a `meeting-segment` Tauri event `{meetingId, speaker, text, t0, t1}` (app-wide emit, HUD listens).
- **Guide engines**: `ActiveMeeting.guide_engine: Option<GuidanceEngine>` becomes `Arc<std::sync::Mutex<Vec<GuidanceEngine>>>` (**cap 2**). The observer closure captures this Arc and iterates the engines attached *at dispatch time* — this is what enables mid-meeting attach without touching `spawn_drain`.

New command `get_live_transcript() -> Vec<SegmentDto>` returns the history snapshot so the HUD backfills when opened mid-meeting.

### 2. Guide session lifecycle (backend)

- `GuidanceEngine` gains a `session_id: String` (uuid) and a `slot: u8` (0/1, drives the template's chip color in the UI).
- **New** `attach_guide(template_id) -> session_id`:
  - Errors with a friendly message if no meeting is active or 2 guides are already attached.
  - Seeds the new engine's rolling window from the transcript history tail (most recent `ROLLING_BYTES` ≈ 4 KB) so its first cycle has context.
  - In Auto mode, fires a cycle immediately after attach.
  - Appends the template snapshot to the meeting row (see §5).
  - Shows the HUD (if hidden) and emits `guide-init` with `{sessionId, slot, templateName, goal, mode}`.
- `start_guided_session(template_id)` is kept and now composes: start meeting → `attach_guide`.
- **New** `detach_guide(session_id)`: removes that engine from the list. The meeting keeps recording. Emits `guide-detached {sessionId}`.
- `guide_set_mode(session_id, mode)` and `guide_trigger_now(session_id)` gain the `session_id` parameter.
- `guide_end` (stop-the-whole-meeting) is **removed**; the HUD's per-guide "×" calls `detach_guide`. Stopping the meeting remains on the pill (and `stop_meeting`).
- `guide-update` payload gains `sessionId` and `slot`. Each successful cycle = one **card** (`suggestions` + timestamp); `keyPoints` update that session's pinned checklist.
- **LLM contention**: each engine keeps its own skip-if-busy `in_flight` gate; the LLM engine's internal lock serializes calls across engines. Worst case with two Auto guides: two short Gemma calls per segment batch. The per-session staleness label communicates lag. No global gate is added.

### 3. Meeting HUD window

Reuse the existing **`guide_overlay` window label** (avoids editing `capabilities/default.json`, and therefore avoids a TCC-reset reinstall) but rebuild it as the Meeting HUD:

- `resizable(true)`, min size 300×240, default 340×440. Borderless, transparent, always-on-top, drag by header — unchanged flags otherwise.
- **Position/size memory**: on show, restore the user's last size/position for this app run instead of snapping back to bottom-center on every `show_guide_overlay` (first show still uses the computed above-pill position). Persistence across app restarts is in-memory only (session-scoped) — no settings churn.
- Window content moves from `src/guide-overlay/` to `src/meeting-hud/` (new Vite entry; the window's `WebviewUrl` changes — this is not a capabilities change).

Frontend layout (top → bottom):

1. **Header** (drag region): "MEETING · {app name}" + close button (hides HUD; meeting continues).
2. **Guides area**: per active guide (≤2), a compact pinned section: color-coded template chip, key-point checklist (✓ / … / ○), Auto/On-demand toggle, "Guide me now" (on-demand), "×" detach. Collapsible per section.
3. **"+ Add guide"** picker: lists all templates; disabled with an inline note when 2 guides are active.
4. **Card feed** (merged): newest card on top; each card shows its template chip, relative timestamp, and the cycle's suggestions. Bounded to the most recent 50 cards. Cards from detached guides remain in the feed.
5. **Transcript pane**: toggleable section; speaker-tagged lines ("You"/"Them"); auto-scroll with stick-to-bottom that pauses when the user scrolls up; backfilled via `get_live_transcript` on open.

HUD self-hides when the meeting leaves `recording` status (existing `meeting-status` listener behavior).

### 4. Meeting pill

In meeting mode only, the pill gains two icon buttons beside stop: **Transcript** and **Guide**. Both invoke a new `show_meeting_hud(focus)` command (`focus: "transcript" | "guides"`); the HUD opens with the corresponding section visible (transcript expanded vs. template picker open). Pill width grows from 172 to ~230 logical px in meeting mode (the Rust-side constant becomes mode-aware; non-meeting modes keep 172).

### 5. Meeting row: `guide_template_json`

The column now stores a JSON **array** of template snapshots (one per attached guide, appended at attach time). Readers must accept both the legacy single-object form (existing rows) and the new array form. No schema migration needed (TEXT column, format change only).

### 6. Default templates

Seeded at startup with fixed IDs, guarded by a one-time settings flag (`builtin_templates_seeded_v1`) so user deletions and edits stick. Fully editable/deletable like user templates.

| ID | Name | Goal (summary) |
|----|------|----------------|
| `builtin-sales` | Sales conversation | Understand their problem, budget, timeline, and decision process; advance to a concrete next step. |
| `builtin-discovery` | Customer discovery | Learn their current workflow, pains, and workarounds without pitching; validate the problem before the solution. |
| `builtin-communication` | Clear communication | Keep statements short and concrete; check understanding; close loops explicitly. |
| `builtin-deescalate` | De-escalate / avoid arguments | Acknowledge before countering; name emotions; find the shared goal; slow the pace. |
| `builtin-leadership` | Leadership presence | Listen more than you speak; ask before telling; give credit specifically; commit to clear owners and dates. |

Each ships with `notes` containing 5–8 key prompts/behaviors (drafted in the implementation plan; editable by the user afterwards).

### 7. Diagnostics (per project standards)

- `tracing` with `target: "guide"` on attach/detach/seed/cycle failures; `target: "hud"` on window create/show/resize-restore. Log results of fallible ops (e.g. "attached guide {session_id} template={name}", "attach rejected: cap reached").
- Friendly UI errors: attach failure → inline toast in the HUD ("Couldn't start guide. See Settings → Diagnostics → logs."); cap reached → inline note on the picker; never a silent no-op.
- `meeting-segment` emit failures are logged at `warn`, not surfaced (transcript self-heals on next segment).

## Testing

Rust unit tests:

- Dispatcher fans segments out to 0/1/2 engines; engines attached mid-stream receive only subsequent segments.
- `attach_guide` cap-2 enforcement and no-active-meeting error.
- Rolling-window seeding from history tail (byte bound respected).
- `guide_template_json` reader accepts legacy object and new array.
- Builtin seeding: idempotent, respects the settings flag, survives user deletion.
- `detach_guide` removes the right engine and leaves the meeting running.

Frontend: `tsc` type-check passes; existing suite stays green (`cd src-tauri && cargo test --lib`).

## Rollout / build notes

- No `Info.plist`, entitlements, or capabilities changes → **skip-TCC reinstall** applies.
- New Vite HTML entry for `src/meeting-hud/` (update `vite.config`).
- `guide_end` command removal is internal-only (frontend is the sole caller; updated in the same change).
