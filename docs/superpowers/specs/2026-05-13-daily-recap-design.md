# Daily Recap — Design

**Status:** Draft
**Date:** 2026-05-13
**Author:** Brainstormed with Claude

## Problem

Echo Scribe captures aggressively (meetings, notes, dictations) but produces
artifacts that never get reused. The user has stopped opening the meeting list,
the note browser, the chat-with-notes feature. Only the dictation hotkey gets
daily use, because it has an *immediate destination* — text appears where the
user is already typing.

The product needs to push captured content back into the user's day rather than
wait passively for retrieval. The smallest, most testable shape of that push is
a **morning recap of yesterday**: a notification at a user-configured time, a
new in-app view that shows what happened, and on-demand regeneration of today
so far.

## Goals

- Deliver one daily summary per active day, generated locally, surfaced as a
  macOS notification that opens to a rich in-app view.
- Cover the three streams the user already produces: meetings, notes,
  dictations.
- Stay silent on quiet days (no notification, no clutter).
- Lay groundwork for phase-2 follow-up actions (action-item checkboxes,
  draft-email buttons) without building them yet.

## Non-goals

- Action items, follow-up email drafting, calendar integration, reminders —
  explicitly future work.
- Long-term storage policy for dictations (retention, redaction, purge
  schedules). Out of scope; handled as a separate "storage management" feature
  if it ever becomes a problem.
- Remote-LLM support. The whole product is local-only; daily summaries stay
  local-only.
- A way to chat against a specific day. Future work.

## User experience

### Trigger model

- **Default trigger:** a Tokio-scheduled task fires at the user-configured
  "deliver at" time each morning (default 8:00am local) and generates a
  summary of *yesterday*.
- **On-demand trigger:** a hotkey (binding TBD during implementation) and a
  "Generate now" button in the Daily view both invoke the same pipeline with
  `date = today`. If the most recent summary for the requested date is less
  than 10 minutes old, the cached result is returned instantly; otherwise we
  regenerate.
- **Weekend behavior:** weekends are skipped by default; a settings toggle
  opts back in.
- **Multi-day gap:** when Echo Scribe runs after several days of inactivity,
  the scheduler backfills any missing days in the last 7 days — each as its
  own `daily_summaries` row, with empty days correctly marked
  `skipped_empty`. Only **one notification** fires, for the most recent
  non-empty day. The user can browse the rest via the history strip. This
  avoids a notification flood after a vacation and keeps the data model a
  clean one-row-per-date.

### Notification

Native macOS notification via `tauri-plugin-notification` (already a
dependency).

- **Title:** "Your Wednesday recap" (day-of-week derived from the summary date)
- **Body:** Two lines — counts (`3 meetings · 7 notes · 4 things to follow up
  on`) on line 1, and the first sentence of the narrative on line 2.
- **Click:** opens the Echo Scribe main window to the Daily view, scoped to
  the summary's date.
- **No action buttons in v1.** They are the natural hook for phase 2.

### Daily view

A new top-level section in `src/views/Main.tsx`, added as a `MainSection`
variant `{ kind: "daily"; date: string }` and rendered alongside the existing
sections (Activity, Tasks, Search, Chat, Dashboard, Meetings).

Layout, top to bottom:

1. **Date header** with prev/next-day arrows (also bound to keyboard ←/→)
2. **Narrative paragraph** (2–3 sentences, slightly larger type, no heading)
3. **Structured sections**, each collapsible, each omitted entirely if empty:
   - **Meetings** — one card per meeting (title, attendees if known, 2-bullet
     outcome). Click → the existing meeting detail view.
   - **Focus work** — inferred bullets grouped by app, derived from dictation
     `capture_context` clusters.
   - **Notes** — themed bullets. Click → the source item.
   - **Things that came up** — commitments and open questions. This is the
     section we grow in phase 2 with checkboxes and "draft follow-up"
     buttons.
4. **Footer** — `Generated at 8:03am · Regenerate` link (calls the on-demand
   path; useful both as a power-user escape valve and as a debugging hook).

A thin left-column **history strip** lists recent days, most recent at top,
with a 60-char preview of each day's narrative. Empty/skipped days appear as
greyed-out, unclickable entries so the user can see the rhythm of their week
without those days creating click targets.

### Daily view states

- **`generated`:** the layout above.
- **`skipped_empty`:** the page renders the date header and the line "Nothing
  recorded on this day." No CTA. Accurate, not a failure.
- **No row yet for today (before the morning fire):** "Today's recap will
  generate tomorrow morning." plus a "Generate now" button that calls the
  on-demand path.
- **`failed`:** "Couldn't generate this recap." plus a "Retry" button and a
  link to view recent log lines (using whatever logging surface the rest of
  the app uses).

### Settings

New section in the existing Settings page titled "Daily Recap":

1. **Toggle:** "Generate a daily recap each morning" (default: on)
2. **Time picker:** "Deliver at" — hour selector, local timezone (default
   08:00)
3. **Toggle:** "Include weekends" (default: off)

No per-section toggles, no model selection, no retention settings. Keep the
surface small.

### First-run framing

On first visit to the Daily view, a one-time dismissable banner reads: "This
recap looks at your meetings, notes, and dictations — all stored locally on
this Mac." One sentence. Surfacing this matters because the user has never
seen their dictation transcripts displayed back to them before; an empty
banner avoids a "wait, you stored all that?" moment.

If macOS notification permission is missing when the scheduler first
attempts to fire, the Daily view shows a permission banner with an "Open
System Settings" button. Follows the same pattern as the existing
`PermissionWarningBanner` component.

## Architecture

### Data model

**No changes to existing tables.** The collector reads from:

- `meetings` — fields `id`, `started_at`, `ended_at`, `suggested_title`,
  `summary_json`. Meeting summaries are already generated and stored by
  `meeting/synthesizer.rs`; the collector never re-summarizes transcripts.
- `items WHERE source = 'voice_at_cursor'` — dictations. Fields `id`,
  `content`, `captured_at`, `capture_context` (frontmost app, populated by
  `input/focus.rs::capture_context`).
- `items WHERE source = 'log_capture'` — notes.

**One new table** for the summary output:

```sql
CREATE TABLE IF NOT EXISTS daily_summaries (
  date                    TEXT PRIMARY KEY,    -- "YYYY-MM-DD" in local TZ
  generated_at            TEXT NOT NULL,       -- ISO-8601
  status                  TEXT NOT NULL,       -- 'generated' | 'skipped_empty' | 'failed'
  narrative               TEXT NOT NULL DEFAULT '',
  sections_json           TEXT NOT NULL DEFAULT '{}',
  source_meeting_ids_json TEXT NOT NULL DEFAULT '[]',
  source_item_ids_json    TEXT NOT NULL DEFAULT '[]',
  model_version           TEXT NOT NULL,       -- "{llm_model_id}@{prompt_hash_8}"
  input_token_count       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_generated_at
  ON daily_summaries(generated_at DESC);
```

Storing `skipped_empty` and `failed` rows (not just `generated`) lets the UI
distinguish "no summary because nothing happened" from "no summary because
generation hasn't run yet" from "no summary because it crashed," and lets the
on-demand path avoid repeatedly retrying genuinely empty days.

Schema migration is added to `src-tauri/src/db/schema.rs` as a numbered
migration following the existing pattern (e.g. `migration_v7_adds_daily_summaries`).

### Module layout

New Rust module `src-tauri/src/daily_summary/` with three files plus `mod.rs`:

- **`collector.rs`** — `pub fn collect(conn: &Connection, date: NaiveDate,
  tz: &Tz) -> Result<DailySummaryInput, Error>`. Pure SQL plus grouping
  logic. Defines `DailySummaryInput { date, meetings, dictations_by_app,
  notes }` and the empty-day check `pub fn is_empty(input:
  &DailySummaryInput) -> bool` (returns true when meetings, notes, and
  dictations are all empty *or* when total signal is below a threshold —
  starting threshold: zero meetings, zero notes, and fewer than 3
  dictations).
- **`generator.rs`** — `pub fn generate(llm: &Llm, input:
  &DailySummaryInput) -> Result<DailySummaryOutput, Error>`. Holds the
  prompt template as a `const &str`, builds the prompt, calls
  `Llm::generate(GenerateRequest { ... })` (the existing engine API), parses
  the JSON response, validates the schema, returns
  `DailySummaryOutput { narrative, sections, source_meeting_ids,
  source_item_ids }`. Exposes `PROMPT_VERSION: &str` as the first 8 chars of
  a SHA-256 of the prompt template, used for `model_version`.
- **`scheduler.rs`** — Tokio task spawned at app start from `lib.rs`. Holds
  the `next_fire_time(now, settings) -> DateTime<Local>` pure function
  (unit-tested). On each fire, calls `run_with_backfill`, which: (1) looks
  up the last 7 dates and finds any that lack a `daily_summaries` row, (2)
  generates each missing day in chronological order, (3) fires a single
  macOS notification for the most recent day that resulted in
  `status='generated'` (none, if every day was skipped or failed). Listens
  for wake-from-sleep via `NSWorkspace.didWakeNotification` (objc2-app-kit
  is already a dependency) and on every foreground transition; both
  re-anchor the next fire time and trigger the same backfill check.
  Generation is idempotent on `daily_summaries.date` (primary key) so
  re-firing never produces duplicates.

The top-level `mod.rs` exposes a single orchestration entry point used by
both the scheduler and the on-demand command:

```rust
pub fn generate_for_date(
  conn: &Connection,
  llm: &Llm,
  date: NaiveDate,
  tz: &Tz,
) -> Result<DailySummaryStatus, Error>;
```

### Generation flow

1. `collector::collect(conn, date, tz)` returns an input bundle.
2. If `collector::is_empty(&input)`:
   - Insert a row with `status='skipped_empty'`, empty narrative, empty
     sections. No notification. Return `Skipped`.
3. Else, `generator::generate(llm, &input)`:
   - On `Ok`: insert a row with `status='generated'`, full content.
     Fire notification (only when invoked from the scheduler; on-demand
     calls do not notify). Return `Generated { summary }`.
   - On `Err` (LLM error, JSON parse failure, schema validation failure):
     insert a row with `status='failed'`, empty narrative. No notification.
     Log the error. Return `Failed { reason }`.

`ON CONFLICT (date) DO UPDATE` is used so re-running the pipeline for a
given date replaces the previous row in place. This is what makes
regeneration safe and makes wake-from-sleep idempotent.

### Tauri commands

Two new commands in `src-tauri/src/commands.rs`, both `#[tauri::command]`:

- `daily_summary_get(date: String) -> Option<DailySummary>` — looks up a row
  by date, returns the structured payload for the UI.
- `daily_summary_regenerate(date: String) -> Result<DailySummary, String>`
  — calls `generate_for_date` for the given date (regardless of cache
  age) and returns the resulting row. Used by the "Generate now" /
  "Regenerate" / "Retry" buttons.
- `daily_summary_list_recent(limit: u32) -> Vec<DailySummaryListItem>` —
  feeds the history strip; each item carries `date`, `status`, and the
  60-char narrative preview.

### LLM pipeline detail

Echo Scribe ships `gemma-4-e2b-it-q4_k_m` via `llama-cpp-2` (already loaded
for meeting synthesis). Daily summaries reuse the same `Llm` engine — no
new model download, no second model in memory.

**Prompt structure** (single-shot, no tools, no chain-of-thought):

1. **System framing.** "You are summarizing one day of one person's work.
   Be honest about the shape of the day. Do not inflate. Omit any section
   that has no real content."
2. **Output schema.** Strict JSON. Top-level keys:
   `{ "narrative": string, "sections": { "meetings": [...],
   "focus_work": [...], "notes": [...], "things_that_came_up": [...] } }`.
   Each section item is `{ "text": string, "source_id": string | null }`.
   Empty arrays explicitly allowed; the renderer omits the heading.
3. **Input bundle**, in this order:
   - Date and day-of-week
   - Meetings (title, time range, attendees if known, `summary_json`
     content if present, *not* the full transcript)
   - Notes (text + capture timestamp)
   - Dictations, grouped by source app. Each group capped at ~20 entries;
     overflow replaced with "+N more dictations into <app>". Each entry
     gets a stable short ID (`d12`) so the model can attach it as
     `source_id`.
4. **Style guidance, last.** Explicit instruction for the
   `things_that_came_up` section: "List commitments the person made, open
   questions they raised, and things they said they'd follow up on. Quote
   concise phrases when useful. If there are none, return an empty array."

**Context window budget.** `collector` enforces a soft token budget (~6k
tokens for input). When exceeded, items are dropped in this order:
oldest dictations → notes (truncated last, never dropped) → meetings always
included via their existing `summary_json` rather than transcripts.

**Source attribution.** Each input item is given a stable short ID
(`m1`/`m2` for meetings, `n1`/`n2` for notes, `d1`/`d2` for dictations).
The model is asked to include the relevant tag as `source_id` on each
section item. The renderer maps tags back to actual DB IDs for
click-through. Missing or unresolvable `source_id` is degraded gracefully:
the bullet renders without a link, no error. We log the
tag-resolution success rate as an internal counter so we can tell whether
the model is getting better or worse over time.

**Model + prompt versioning.** Store `model_version` as
`"{llm_model_id}@{prompt_hash_8}"` (e.g.
`"gemma-4-e2b-it-q4_k_m@a3f9c2e1"`). Iterating the prompt template
naturally changes the hash, so old summaries are clearly marked as having
been generated under the old version. No migrations needed.

## Testing

- **`collector.rs` unit tests** are the load-bearing safety net. Fixtures
  for: empty day, light day (1 meeting only), heavy day (50+ dictations),
  multi-day gap, weekend, dictations with `capture_context = NULL`,
  dictations from many apps. Each fixture asserts the resulting
  `DailySummaryInput` shape and the result of `is_empty`.
- **Empty-day check unit test** — verifies the scheduler will never waste
  an LLM call on a row that ends up as `skipped_empty`.
- **Prompt assembly snapshot test** — feed a deterministic input bundle,
  snapshot the assembled prompt string, assert key invariants (date
  present, schema present, dictation cap applied, short IDs assigned).
  Intentional prompt changes update the snapshot.
- **Schema parser unit tests** — feed known-bad LLM outputs (truncated
  JSON, missing `narrative`, wrong types for `sections.meetings[].text`,
  unknown extra fields) and assert clean `Err` returns. The caller writes
  `status='failed'` rather than panicking.
- **`next_fire_time` pure-function unit tests** — covers timezone edges,
  DST transitions, the case where `now > today's fire time` (next fire is
  tomorrow), the case where `now < today's fire time` (next fire is
  today).
- **Integration smoke (manual, documented in the spec)** — generate
  against a known day in a dev DB, eyeball narrative + each section,
  verify source-link clicks land on the right item. The LLM output isn't
  deterministic enough for assertion-based testing.
- **No end-to-end scheduler test.** Too flaky. The scheduler's logic is
  unit-tested via the pure `next_fire_time`; Tokio sleeps are trusted.

## Risks

1. **Local-model quality may not clear the bar.** Cross-document synthesis
   over a full day is harder than single-meeting summarization, and
   `gemma-4-e2b-it-q4_k_m` is a small model (~2B effective). If the daily
   summary feels like AI slop after a week of dogfooding, the design
   dead-ends. **Mitigation:** the on-demand button is a forcing function
   for honest evaluation — if the user stops reaching for it, the model
   isn't good enough and we revisit (a larger Gemma variant, a different
   architecture, or a different summarization shape).
2. **Source tag drops will frustrate.** Bullets without click-through feel
   broken. **Mitigation:** renderer never errors on missing tags; tag
   resolution rate is logged so we can tell if it's degrading.
3. **Scheduler reliability across sleep/wake.** Tokio timers fire on
   wall-clock-minus-sleep-time; on a MacBook that sleeps overnight, the
   8am timer can fire at the wrong moment. **Mitigation:** re-anchor on
   `NSWorkspace.didWakeNotification` and on every app foreground.
   Generation is idempotent on `date` primary key so accidental re-fires
   are no-ops.
4. **First-time surprise at dictation visibility.** The user has never
   seen their dictation transcripts displayed back to them. **Mitigation:**
   one-line first-run banner in the Daily view.
5. **Notification permission missing.** macOS silently drops notifications
   if Echo Scribe lacks permission. **Mitigation:** check permission on
   first scheduler tick; surface a banner in the Daily view if missing.

## Phase-2 hooks left in place

- `things_that_came_up` is the obvious section to grow with action-item
  checkboxes and a "draft follow-up" button. The schema already stores
  `source_id` per bullet so each action can deep-link back to the meeting
  or note that produced it.
- `source_meeting_ids_json` / `source_item_ids_json` make it trivial to
  add "chat against this day" later — the chat surface just needs to be
  scoped to the cited sources.
- Notification action buttons ("Mark done", "Draft reply") fit naturally
  on top of the existing structure.

## Open implementation details to confirm while writing the plan

- Exact migration number and placement in `db/schema.rs`.
- Whether the daily-summary on-demand hotkey should be a new global
  binding or a button only available inside the Daily view in v1. Default
  position: button-only in v1, global binding deferred until we know the
  feature gets used.
- Settings storage — confirm the existing `tauri-plugin-store` is the
  right home for the three new settings, or whether they belong on the
  Rust `settings` struct.
- Whether `meetings.suggested_title` plus `summary_json` is sufficient
  meeting context for the prompt or whether we should also include a
  small slice of transcript for very short meetings whose summary may be
  thin.
