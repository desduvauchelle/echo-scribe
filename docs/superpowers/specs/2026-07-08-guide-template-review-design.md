# Guide Template Post-Meeting Review & Cross-Meeting Analysis — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorm) — ready for implementation plan
**Area:** `src-tauri/src/meeting/*`, `src-tauri/src/db/*`, `src/views/sections/MeetingsView.tsx`, `src/lib/api.ts`

## Problem

Guided meetings run a live guidance engine (`meeting/guidance.rs`) that produces
key points + suggestions every few seconds and emits them to the HUD overlay as
`guide-update` events. **None of it is persisted** — when the meeting ends, the
coaching is gone. The `meetings` row keeps `guide_template_json` (which template
was attached) and `summary_json` (the generic meeting summary), but there is:

1. no record of what the guide actually surfaced during the call, and
2. no holistic, whole-transcript assessment of how the conversation went against
   the guide's objective — the live engine only ever sees a rolling ~4 KB window.

## Goals

- Persist each guide's runtime results with the meeting so they can be reviewed
  and analyzed after the fact.
- Generate, at meeting end, a **holistic review** that runs the guide template's
  objective against the *whole* transcript — distinct from the twitchy live
  coaching. For each attached guide it produces:
  - a **coaching scorecard** — every non-empty line of the template `notes`
    graded `met` / `partial` / `missed` (loose enum) with an evidence quote and a
    one-line "why", **plus 1–2 emergent observations** the model noticed that
    weren't in the notes (hybrid rubric),
  - an **objective synthesis** — a 2–4 sentence narrative of how the conversation
    went against the template `goal`,
  - an **overall** verdict: `strong` / `mixed` / `weak`.
- Surface it in two UIs:
  - a **per-meeting review panel** in the meeting detail (narrative-first, with
    expandable criterion rows), and
  - a **cross-meeting trend view** aggregating a template's scorecards over time.

## Non-goals (YAGNI)

- No re-run of the *live* engine offline; the end review is a separate pass.
- No editing/annotating of a generated review by the user (v2 if wanted).
- No changing the live HUD behavior or the existing `summary_json` synthesis.
- No cross-template "leadership across all guides" meta-analysis — trend view is
  scoped to one template at a time.

## Current state (verified)

- `meeting/guidance.rs`: `GuidanceEngine` holds `Inner { template, llm, app, state }`;
  `State { rolling, prior_points, last_suggestions }`. `GuidanceResponse { key_points:
  Vec<DerivedPoint{id,label,status}>, suggestions: Vec<String> }`. `emit_update()`
  fires the `guide-update` event. Verdict-like strings are parsed loosely (no strict enum).
- `meeting/synthesizer.rs`: `flatten_transcript(segments)`, chunked map-reduce
  (`synthesize()` builds per-chunk summaries then a final pass via
  `llm::prompt::build_meeting_synthesis_prompt(..., custom_prompt)`), returns
  `StoredSummary`. Transcript budget ~18 KB; guidance window is 4 KB (`ROLLING_BYTES`).
- `meeting/mod.rs`: `attach_guide()` inserts template snapshot into
  `meetings.guide_template_json` and creates a `GuidanceEngine` in
  `guide_engines: Vec<..>` (cap 2). `stop()` orchestrates finalize → synthesize → persist.
- `db/guide_templates.rs`: `GuideTemplate { id, name, description, goal, notes,
  created_at, updated_at }`.
- `db/meetings.rs` / `db/schema.rs`: current `schema_meta.schema_version = 23`
  (verified against live `echo.db`). Migrations are versioned in `run_migrations()`.

## Data model

New dedicated table (chosen over JSON columns for lean meeting rows + queryable
cross-meeting analysis). New module `db/meeting_guide_runs.rs` mirroring
`db/guide_templates.rs`.

```sql
CREATE TABLE meeting_guide_runs (
  id             TEXT PRIMARY KEY,                          -- ULID
  meeting_id     TEXT NOT NULL REFERENCES meetings(item_id) ON DELETE CASCADE,
  template_id    TEXT NOT NULL,                             -- builtin-* or user template id
  template_name  TEXT NOT NULL,                             -- denormalized for trend grouping
  template_json  TEXT NOT NULL,                             -- snapshot of goal+notes as attached
  slot           INTEGER NOT NULL,                          -- HUD slot 0..1
  started_at     TEXT NOT NULL,
  timeline_json  TEXT,                                      -- downsampled live coaching (nullable)
  review_json    TEXT,                                      -- scorecard+emergent+synthesis (nullable until ready)
  status         TEXT NOT NULL,                             -- 'pending' | 'ready' | 'failed'
  error          TEXT,                                      -- diagnostics detail (nullable)
  generated_at   TEXT,                                      -- when review finished (nullable)
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_guide_runs_meeting  ON meeting_guide_runs(meeting_id);
CREATE INDEX idx_guide_runs_template ON meeting_guide_runs(template_name);
```

**Migration v24** creates the table and bumps `schema_meta.schema_version` to `24`
(re-verify the max against live `schema_meta` at implementation time — we've had
migration-number collisions between branches before). A migration test asserts
version `24`, mirroring the existing `== "23"` assertion.

The existing `meetings.guide_template_json` is left untouched (backward compat; it
remains the quick "what was attached" snapshot). The new table supplements it.

### `review_json` shape

```json
{
  "overall": "strong | mixed | weak",
  "synthesis": "2–4 sentence narrative vs the template goal",
  "scorecard": [
    { "criterion": "give credit by name for specific contributions",
      "verdict":   "met | partial | missed | unknown",   // parsed loosely
      "evidence":  "short quote / paraphrase from transcript",
      "why":       "one-line assessment",
      "tip":       "one concrete 'try next time' (optional)" }
  ],
  "emergent": [ { "observation": "…", "evidence": "…" } ]   // 1–2 items
}
```

`criterion` entries are seeded from the template `notes` split on newlines
(non-empty lines). `emergent` is the hybrid extra.

### `timeline_json` shape

```json
[ { "t_ms": 123456, "keyPoints": [ {"id","label","status"} ], "suggestions": ["…"] } ]
```

Downsampled: an entry is appended only when `keyPoints`/`suggestions` differ from
the previous entry (dedup). Capped at `N = 200` entries; if exceeded, keep the most
recent N and `warn!(target: "guide", ...)` (no silent truncation).

## Lifecycle / pipeline

1. **Attach** (`attach_guide`): after creating the `GuidanceEngine`, insert a
   `meeting_guide_runs` row with `status='pending'`, `started_at`, `slot`,
   `template_id/name/json`. The row exists even if the app dies mid-meeting.
2. **During the call**: `guidance.rs` `State` gains `timeline: Vec<TimelineEntry>`.
   In `emit_update` (or right before it), append a deduped entry. In-memory only —
   no per-cycle DB writes.
3. **At stop** (`meeting/mod.rs::stop`, after `summary_json` is saved and the
   meeting is marked `complete`):
   - For each engine, flush its `timeline` → `UPDATE meeting_guide_runs SET
     timeline_json=…` (status stays `pending`).
   - Enqueue one **review job per guide**, serialized *after* summary synthesis on
     the LLM engine's existing lock (guidance's skip-if-busy note confirms end-of-call
     work FIFO-serializes there). Meeting is already `complete`, so the app is
     responsive; reviews land a beat later — that's what `status` is for.
4. **Review job** (new `meeting/guide_review.rs`):
   - Reuse the synthesizer's chunked map-reduce over `flatten_transcript`. Map step:
     per chunk, detect evidence relevant to each criterion. Reduce step: assemble
     the scorecard (verdict + best evidence + why per criterion), 1–2 emergent
     observations, synthesis, and overall.
   - New prompt `llm::prompt::build_guide_review_prompt(goal, notes_criteria, chunk/context)`
     asking for strict JSON matching `review_json`. Parse loosely (reuse the
     `DerivedPoint.status` tolerance pattern).
   - On success: `UPDATE … SET review_json=…, status='ready', generated_at=…`;
     emit `guide-review-updated { meetingId, runId }`.
   - On failure: `status='failed'`, `error=<detail>`, `error!(target:"guide", …)`.

## Prompts

`build_guide_review_prompt`:
- **System:** "You are a communication coach reviewing a meeting transcript. The
  user is the speaker labeled `you`. Assess how they performed against each
  criterion; cite a short piece of evidence; decide met/partial/missed. Add 1–2
  emergent observations not covered by the criteria. Then write a short synthesis
  against the objective. Output strict JSON."
- **User:** the objective (`goal`), the numbered criteria (`notes` lines), and the
  transcript (chunk or reduced context). For long meetings the map step feeds raw
  chunks (to preserve evidence quotes); the reduce step feeds the map outputs.

## Frontend

### Per-meeting review panel — `MeetingsView.tsx` detail

Narrative-first (validated via visual companion, panel "B"): one block per guide run.

- **Header:** template name + `overall` pill (`strong`/`mixed`/`weak`) + status.
- **States:** `pending` → "Generating review…" spinner; `failed` → friendly line
  ("Guide review couldn't be generated — see Settings → Diagnostics → logs") +
  **Retry**; `ready` → full panel.
- **Ready panel:**
  - synthesis narrative (leads),
  - **Scorecard**: each criterion is a collapsed row (verdict pill + name +
    chevron); **click to expand** → evidence quote + why + "Try:" tip. Use an
    explicit class-toggle for expand (native `<details>` was unreliable inside the
    companion frame; the shipped component uses React state per row).
  - "What also stood out" (emergent),
  - collapsible **Live coaching timeline** rendering `timeline_json`.

### Cross-meeting trend view (in scope)

A "‹Template› — across your calls" screen (entry point: a link from the review
panel header and/or a Guide section in the meetings sidebar). Scoped to one
template, selectable.

- **Insight strip** (auto-derived from scorecards): #1 recurring gap (criterion
  most often `missed`), consistent strength (most often `met`), and a "watch"
  (recent regression).
- **Criteria heatmap:** rows = criteria, columns = recent guided calls (newest
  right), cells = met/partial/missed swatch; right column = "hit" count (# Met).
  Horizontal-scroll on narrow widths.
- **Overall trend row:** the per-meeting `overall` verdicts in sequence.
- Clicking a column opens that meeting's review panel.

### Tauri commands + `api.ts`

- `list_guide_runs(meeting_id) -> Vec<GuideRun>`
- `guide_runs_for_template(template_id, limit) -> Vec<GuideRun>` (trend view)
- `regenerate_guide_review(run_id)` (retry / manual re-run)
- `api.ts` wrappers + TS types (`GuideRun`, `GuideReview`, `ScorecardItem`,
  `TimelineEntry`).

## Error handling & diagnostics (per CLAUDE.md)

- `target: "guide"` logs at: review start, success (criteria count, overall),
  failure (error string + which stage). Never log transcript content verbatim
  beyond what's needed; no secrets involved.
- UI shows a short friendly message on failure; raw detail stays in the log.
- `status` + `error` columns drive all UI states; a failed review never blocks the
  meeting from being `complete`.

## Testing

**Rust:**
- notes → criteria splitting (blank-line handling, trimming).
- loose verdict parsing (`met`/`Met`/`partial`/unknown → enum).
- timeline dedup + cap-at-N with truncation warning.
- `review_json` / `timeline_json` serialize/deserialize round-trip.
- `db/meeting_guide_runs`: insert-at-attach → update-timeline → update-review →
  `list_guide_runs` / `guide_runs_for_template`; `ON DELETE CASCADE` with meeting.
- migration v24 creates table + bumps version to 24 (assertion test).
- `build_guide_review_prompt` snapshot (criteria + goal wiring).

**Frontend:**
- pure helpers (e.g. trend aggregation: gap/strength/hit-counts) unit-tested like
  the existing `tests/*.test.ts`.

## Rollout / backward compat

- Meetings without guide runs → panels render nothing; no data migration.
- Pre-existing `guide_template_json` untouched.
- Long meetings (e.g. today's 100-min / 138 KB transcript): reviews run in the
  background after `complete`; the panel shows "Generating review…" until `ready`.
