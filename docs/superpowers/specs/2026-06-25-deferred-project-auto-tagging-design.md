# Deferred Project Auto-Tagging Design

## Goal

Make project assignment reliable for direct voice captures without loading the
local LLM after every dictation. Direct paste-at-cursor must stay fast; project
organization should happen later in resource-aware batches.

## Current Behavior

`VoiceAtCursor` captures are transcribed, pasted, and saved as
`source = voice_at_cursor`, `kind = transcription`, `project_id = NULL`, and
`classified_by = NULL`. They do not call the project classifier.

`LogCapture` calls the LLM classifier inline, then persists notes or tasks with
project, tags, confidence, and classifier metadata. This explains why direct
voice prompts are 100% blank while log captures are mostly assigned.

The app already lazy-loads ASR and LLM models and unloads them after a
configurable idle timeout. Immediate classification for direct voice would still
create avoidable memory spikes because a normal dictation could load ASR and
then load Gemma for classification.

## Product Requirements

- Direct dictation remains instant: transcribe, paste, save, and return to idle.
- Project tagging runs asynchronously after capture.
- The LLM loads once per batch, not once per direct voice prompt.
- If the LLM is already loaded for chat, meeting summaries, log capture, or
formatting, the app opportunistically tags up to 5 pending rows.
- Historical unassigned rows can be backfilled gradually.
- The user can teach routing rules without editing code.
- Low-confidence or ambiguous rows stay unassigned rather than being forced into
the wrong project.
- The feature must be measurable: pending counts, assigned counts, skipped
counts, confidence, attempts, and last run status are inspectable.

## Architecture

Add a deferred `ProjectTagger` subsystem with four parts:

1. A persistent queue of items that need project tagging.
2. A project routing profile stored on each project.
3. A deterministic router that uses routing profiles before the LLM.
4. A resource-aware worker that batches LLM classifications only when conditions
   are acceptable.

The coordinator stays responsible for capture latency. It only writes the
direct voice item and enqueues a tag job. The tagger owns all later assignment.

## Project Routing Profile

Projects already have `description` and `keywords`, but those fields are not
enough as a user-facing routing system. Expand project metadata into a routing
profile:

- `description`: plain-language project summary.
- `aliases`: exact phrases, acronyms, misspellings, and trigger words.
- `app_hints`: app names or bundle ids, such as `Code` or `Google Chrome`.
- `url_hints`: domains, repo paths, or URL substrings.
- `window_hints`: window title substrings, such as repo names.
- `positive_examples`: short snippets from captures that belong to the project.
- `negative_examples`: short snippets or phrases that should not route here.

Example for LiveCase:

```json
{
  "aliases": [
    "livecase",
    "life case",
    "hbsp",
    "harvard business publishing",
    "case simulation",
    "teaching note",
    "the case centre"
  ],
  "url_hints": [
    "livecase",
    "hbsp.harvard.edu"
  ],
  "window_hints": [
    "livecase",
    "livecaseplus"
  ],
  "positive_examples": [
    "update the HBSP proof section for the simulation page",
    "draft the LiveCase teaching notes template"
  ],
  "negative_examples": [
    "generic case statement in source code"
  ]
}
```

The deterministic first pass uses this profile. The code must not contain
LiveCase-specific or Website Designer-specific rules except optional seed data
created from existing project metadata.

## Routing Profile UX

Add a "Routing" area inside the existing project editor rather than creating a
separate project settings surface. The editor supports:

- Editing aliases as chips.
- Editing app, URL, and window hints as chips.
- Showing positive and negative examples as compact lists.
- Showing future correction suggestions in the same section once Phase 6 ships.

The initial implementation keeps the UI simple: editable chip lists for aliases,
app hints, URL hints, and window hints, plus compact textarea-backed lists for
positive and negative examples. Correction-based suggestions are out of scope
until Phase 6.

## Deterministic Router

Before calling the LLM, the tagger computes a score for each active project:

- Exact alias phrase in transcript: strong signal.
- Alias phrase in captured browser tab, window title, URL, or app context:
  strong signal.
- URL or window hint match: strong signal.
- Description or keyword token overlap: weak signal.
- Positive example similarity by token overlap: medium signal.
- Negative example match: penalty.

If one project has a clear winning score above threshold, assign it without the
LLM and set:

- `classified_by = "router-v1"`
- `confidence` based on score

If no project is clear, or multiple projects are close, the item remains queued
for LLM classification.

## LLM Batch Classifier

The batch worker processes pending rows in small batches, defaulting to 25 items
per run. The first implementation classifies one item per LLM call using the
existing classifier to reduce risk. Multi-item LLM prompts are out of scope for
this implementation.

The LLM prompt includes:

- Transcript.
- Capture context.
- Active project routing profiles.
- A small number of recent assigned examples per project when available.

Successful LLM assignments set:

- `project_id`
- `confidence`
- `classified_by = "ai-background"`
- tags, when returned

If the LLM returns a low confidence result, invalid project, parse failure, or
ambiguous result, the item remains unassigned and the job records the reason.

## Queue Schema

Add a table:

```sql
CREATE TABLE IF NOT EXISTS project_tag_jobs (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_tag_jobs_status_next_run
  ON project_tag_jobs(status, next_run_at);
```

Statuses:

- `pending`: ready for deterministic routing or LLM classification.
- `deferred`: not ready until `next_run_at`.
- `done`: assigned or deliberately skipped.
- `failed`: exceeded attempts or hit a permanent error.

Existing `voice_at_cursor` rows with `project_id IS NULL` are enqueued only by
an explicit backfill command in the first implementation. Automatic startup
backfill is out of scope so launch behavior stays predictable.

## Scheduling Policy

The worker wakes periodically but runs conservatively.

Default policy:

- Check every 15 minutes.
- Run at most once per hour if it would need to load the LLM.
- Run sooner if the LLM is already loaded.
- Do not run during recording, transcription, meeting processing, or another LLM
  generation.
- In Phase 4, require app-local idleness only: no recording, no transcription,
  no meeting processing, and no active LLM generation.
- Stop after the batch size or a time budget, whichever comes first.
- Let the existing LLM idle-unload mechanism evict the model after the batch.

OS-level user idle detection is out of scope for the first implementation. It can
be added later if app-local gates still create noticeable contention.

The worker logs why it skipped a run.

## Backfill

Add a command that enqueues historical unassigned rows:

- Source filter defaults to `voice_at_cursor`.
- Limit defaults to 500 per invocation.
- Newest-first by default, because recent captures are most useful.
- It must not duplicate existing jobs.

The worker then processes the queued rows gradually. Backfill must never block
capture or paste behavior.

## Correction Loop

Phase 6 makes manual project assignment teach the system:

- If a user assigns a project to an unassigned item, enqueue a low-friction
  suggestion such as "Add 'HBSP' as a LiveCase alias?"
- If a user changes an automatically assigned project, record that as a
  correction signal and offer to add a negative example to the wrong project or
  a positive example to the right project.

This does not ship in the first pass, but the data model must not block it.

## Settings

Add settings with conservative defaults:

- `project_auto_tagging_enabled = true`
- `project_auto_tagging_interval_minutes = 60`
- `project_auto_tagging_batch_size = 25`
- `project_auto_tagging_require_idle = true`
- `project_auto_tagging_idle_minutes = 5`
- `project_auto_tagging_opportunistic = true`

The first UI exposes a simple toggle plus a status row. Advanced interval,
batch-size, and idle settings remain internal defaults unless the user asks for
manual control.

## Observability

Add structured logs with `target = "project_tagger"`:

- scheduler skipped and reason
- batch started
- deterministic assignments count
- LLM assignments count
- low-confidence count
- failures count
- batch duration
- pending queue count

Add a compact status command for the UI:

```json
{
  "enabled": true,
  "pending": 123,
  "deferred": 4,
  "failed": 1,
  "last_run_at": "2026-06-25T10:00:00Z",
  "last_run_summary": "18 assigned, 7 skipped"
}
```

## Error Handling

- No LLM model downloaded: deterministic router still runs; LLM jobs stay
  pending or deferred.
- LLM load/generate failure: retry with backoff, up to a small attempt limit.
- Invalid project id from model: reject and keep unassigned.
- Ambiguous deterministic score: defer to LLM.
- Ambiguous LLM result: keep unassigned and record `last_error`.
- Deleted item: job disappears through cascade or is ignored if already loaded
  into a worker batch.

## Testing

Unit tests:

- Queue insertion is idempotent.
- Backfill enqueues only unassigned active rows.
- Deterministic router assigns exact aliases.
- Deterministic router uses capture context.
- Negative examples reduce score.
- Ambiguous matches do not assign.
- Worker skips when safety gates fail.
- Worker runs deterministic routing without LLM.
- Worker records LLM failures and backoff.

Integration or focused command tests:

- Direct voice persistence enqueues a tag job.
- Manual project update can coexist with pending jobs.
- Project profile fields round-trip through DB and Tauri commands.

## Phasing

Phase 1: data model, queue, direct voice enqueue, backfill command.

Phase 2: routing profile fields and project editor UI.

Phase 3: deterministic router and tests.

Phase 4: batch worker with safety gates and settings.

Phase 5: LLM background classification and status UI.

Phase 6: correction-based suggestions.

Correction suggestions are intentionally later. The reliable foundation is the
queue, profile, deterministic router, and resource-aware batch worker.
