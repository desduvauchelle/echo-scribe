# Guide kinds — tracker / coach / checklist

Date: 2026-08-01
Status: Approved, implemented in this change.

## Problem

Every live guide runs through one hardwired prompt persona
(`build_guidance_prompt` in `src-tauri/src/llm/prompt.rs`): *"Track whether
the conversation has covered each key point implied by the user's goal and
notes."* Template notes always become a coverage checklist, and the
suggestion channel always emits coaching advice. Two real failures observed:

1. **No note-taker guide.** The user authored a "Live summary" template
   (goal: *"Get a live summary of the meeting"*, notes: *"You simply have a
   bullet point list of the main items discussed so far, and constantly
   update it."*). The engine cannot do this: it derives "key points implied
   by the goal" and tracks *coverage* instead of maintaining a live bullet
   list of what was actually said.
2. **Behavioral guides become rule-nags.** `builtin-leadership` notes are six
   commandments ("speak last: gather everyone's view first", …). The engine
   turns each into a checklist item and re-suggests the rules context-free —
   a rigid format that doesn't fit a real conversation.

Root cause: one prompt shape for all guides. Coverage semantics fit agenda
guides (sales, discovery) but are a category error for note-taking and for
behavioral coaching.

## Design

Add `kind` to guide templates. Same JSON contract (`key_points` +
`suggestions`) for all kinds, so the engine, HUD event flow, and timeline
persistence stay unchanged — only the prompt persona and the meaning of the
two channels differ.

| kind | key_points | suggestions | statuses |
|---|---|---|---|
| `checklist` (default) | agenda topics derived from notes | ≤1 next-best action | covered / partial / open (as today) |
| `coach` | ≤4 live observations on how the conversation is going vs. the principles | ≤1 contextual nudge, tied to a specific recent moment; silence is the norm; generic rule-restating forbidden | covered=going well / partial=mixed / open=needs attention |
| `tracker` | the live bullet notes themselves (3–10, stable ids, labels may be refined) | ≤2 "updates" (new decision / change to an earlier point) | open=under discussion / partial=tentative / covered=settled |

### Data

- Migration 32: `ALTER TABLE guide_templates ADD COLUMN kind TEXT NOT NULL
  DEFAULT 'checklist'`; set `kind='coach'` on builtin communication /
  de-escalate / leadership / signals; rewrite `builtin-leadership`
  goal+notes into adaptive principles **only when the row still matches the
  old shipped text** (user edits survive); insert new `builtin-live-notes`
  tracker template (INSERT OR IGNORE — deletion sticks, same pattern as the
  v31 signals insert).
- `GuideTemplate.kind` serde-defaults to `checklist` so old `template_json`
  snapshots on `meeting_guide_runs` still deserialize.

### Behavior changes

- `build_guidance_prompt(kind, …)` — three personas as above.
- Tracker cycles get a larger `max_tokens` (more points than a checklist).
- `guide-init` / `guide-update` / `get_active_guides` payloads carry `kind`.
- Post-meeting review: a rubric review of note-taking instructions is
  meaningless, so tracker runs skip the review LLM job and complete
  immediately with a stub "ready" review pointing at the timeline (which is
  the artifact). `regenerate_guide_review` short-circuits the same way.
  Coach templates keep the rubric review — grading principles with evidence
  post-hoc is still useful and its notes stay line-oriented.

### UI

- Template manager: kind selector (Checklist / Coach / Note-taker) with
  per-kind notes placeholder; kind label on each row; the "Track after
  meetings" insight block is hidden for trackers.
- HUD: tracker guides render open points with a "•" bullet (not the ○
  todo-marker) and tracker waiting copy says notes are being built.

## Out of scope

- Auto-migrating user-authored templates to a kind (can't infer intent in a
  migration). The user's existing "Live summary" template is flipped to
  `tracker` manually as a one-off.
- Changing the review JSON contract or the trend view.
