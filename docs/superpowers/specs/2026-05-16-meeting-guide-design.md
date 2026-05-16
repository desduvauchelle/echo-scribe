# Meeting Guide — Design Spec

Date: 2026-05-16
Status: Approved (design phase). Implementation plan to follow.

## Summary

Add a **Guide** feature: during a manually-started "guided session" over a
video call (Zoom/Meet/FaceTime/etc.), Echo Scribe shows a live, always-on-top
HUD that steers the conversation toward a user-defined goal — surfacing
covered/uncovered talking points and 1–3 dynamic suggestions, refreshed every
~20–30 s as transcription chunks complete.

The feature rides a **refactored, unified chunked-transcription pipeline** that
both normal meetings and guided sessions share. The refactor also fixes a
standing memory problem (meeting synthesis ballooning to ~2 GiB RAM) by
flushing audio buffers aggressively after each chunk.

Guidance is **optional**: it only activates when a guided session is started
with a template attached. Auto-detected meetings with no guide behave exactly
as today.

## Goals

- Live, low-friction conversational guidance during real calls.
- Reusable, user-authored guide templates (goal + freeform notes).
- One shared recording/transcription pipeline for meetings and guided
  sessions, with bounded memory.
- Guided sessions still produce the normal saved transcript + post-call
  summary, plus saved guide artifacts.

## Non-goals

- Token-by-token / sub-second realtime transcription or streaming LLM output
  (ASR is whole-chunk, Gemma is one-shot — out of scope to change).
- Auto-attaching guides to detected meetings (manual start only, by decision).
- A second resident LLM for guidance (deferred unless contention proves
  painful in practice).
- Mid-call chunk-size switching (seam risk; rejected).

## Decisions (locked during brainstorming)

1. Guidance surface: **floating always-on-top HUD overlay** (option A).
2. Guide attaches via **manual "Start guided session"** only — never
   auto-attached to detected meetings.
3. A guided session **is a normal meeting** (full recorder/ASR/synthesis
   pipeline) **plus** saved guide artifacts.
4. Template `notes` is **freeform prose**; the LLM derives the key points and
   tracks coverage (no user-maintained checklist field).
5. Engine approach **A**: piggyback the existing per-chunk pipeline + shared
   Gemma, **skip-if-busy**.
6. Pipeline refactor: **silence-aware 20 s target / 30 s hard-cap chunks**,
   bounded **3–5 s overlap** for ASR context, aggressive RAM flush. Shared by
   both meetings and guided sessions.
7. In-call mode toggle: **Auto / On-demand** only. Chunk size is a fixed
   pipeline property, not a live toggle.

## Section 1 — Unified chunked transcription pipeline (refactor)

**Current state.** `src-tauri/src/meeting/recorder.rs` rotates a WAV every
`CHUNK_SECONDS = 60`. `src-tauri/src/meeting/pipeline.rs` drains chunks to
Parakeet (single-tenant, semaphore = 1) and accumulates segments in a
`TranscriptBuilder`. Synthesis (`meeting/synthesizer.rs`) runs only after
`MeetingManager::stop()`. Observed: synthesis path grows to ~2 GiB RAM.

**Changes.**

- **Silence-aware chunking.** Target chunk = 20 s. After 20 s elapsed, keep
  recording and close the chunk at the next detected silence; hard cap 30 s
  (force-cut even mid-speech). Silence = RMS energy below a threshold for
  ≥ ~400 ms, computed on the existing mic buffer. No VAD model / new
  dependency.
- **Bounded overlap for ASR context.** Prepend the previous chunk's last
  3–5 s of PCM to chunk N before transcription (Parakeet accuracy improves
  with boundary context; also recovers words lost at the 30 s force-cut).
  Retain **only** the previous chunk's ≤5 s tail in RAM (~160 KB) — never
  cumulative history.
- **Overlap stitch.** The overlap region transcribes twice. Trim the new
  chunk's transcript at the join: use Parakeet word timestamps if available;
  otherwise fuzzy-align the overlap text and cut at best match. Stitch happens
  **before** the chunk's text is emitted. This is the highest-risk unit —
  must have dedicated tests (drop/dup words).
- **Aggressive RAM flush.** On chunk close: write WAV → hand path to ASR
  drain → explicitly drop that chunk's PCM/`Vec<f32>` buffers. After a chunk
  transcribes: free decoded f32 buffers; delete the chunk WAV (configurable
  "keep for debug" flag). Only the growing **text** transcript is retained
  (kilobytes). Final synthesis reads accumulated text + the resident Gemma
  model — no re-decode of all audio.
- **Shared path.** Normal auto-detected meetings and manually-started guided
  sessions run this exact pipeline. Guidance is a pure consumer of the
  per-chunk "chunk transcribed" event. Zero forked recording logic.

**Memory-source instrumentation (first implementation step).** The ~2 GiB
source is not yet proven. Per project engineering rule (diagnose with data,
not hypotheses): the first implementation task instruments allocation to
**confirm** where memory grows (retained f32 buffers vs. accumulated segment
list vs. re-decoded chunk audio vs. Gemma context) before the flush logic is
written. Design assumes retained audio buffers + accumulated segments;
instrumentation validates or redirects.

**Cadence impact.** 20–30 s of 16 kHz mono transcribes well under realtime on
Parakeet (single-tenant), so it keeps up. Guidance refreshes every ~20–30 s.

## Section 2 — Guide templates + guided-session lifecycle

**Template data model.** New SQLite table `guide_templates` (reusable user
content, consistent with meetings living in DB rather than the settings
store):

| field | notes |
|---|---|
| `id` | uuid |
| `name` | short label; shown in picker + HUD |
| `description` | one-liner; picker only |
| `goal` | conversation objective; primary LLM steering text |
| `notes` | freeform prose (questions, talking points, context); LLM derives points from this |
| `created_at` / `updated_at` | timestamps |

**CRUD UI.** New settings section "Guide Templates": list + add/edit/delete
form (name, description, goal, notes textarea). Follows existing settings
section patterns.

**Starting a guided session (manual only).**

1. New explicit action in the Meetings area: **"Start guided session"**.
2. Template picker (templates list + "none").
3. On pick: start the Section 1 recording pipeline **and** attach the chosen
   template **and** open the HUD window.
4. The guided session **is** a meeting row — produces the normal post-call
   transcript + summary, plus guide artifacts.

**Guide artifacts saved into the meeting record** (extends the meetings table
/ summary JSON in `src-tauri/src/db/meetings.rs`):

- `guide_template_id` + a frozen **snapshot** of the template text used (later
  edits to the template must not rewrite history).
- Final derived key-points + covered/partial/open state at hangup.
- Timestamped timeline of suggestions the HUD emitted (post-call review).

Auto-detected meetings with no guided session: unchanged — no HUD, no guide
loop.

## Section 3 — Guidance engine + HUD

**Engine loop** (runs only when the active session has a template attached):

- Hooks the existing "chunk transcribed" event from the Section 1 pipeline.
  Each fire enqueues one guidance job (Auto mode), or a job runs only on the
  "Guide me now" button (On-demand mode).
- Prompt = system role + template `goal` + template `notes` + a **bounded**
  rolling transcript window (token-budgeted; oldest text dropped from the
  *prompt* only — the full transcript still accumulates to disk for the
  recap) + the **prior derived points** (fed back so the LLM updates statuses
  instead of regenerating the list).
- One-shot Gemma call → JSON:
  `{ "key_points": [{"id","label","status":"covered|partial|open"}],
     "suggestions": ["…"] }` (1–3 suggestions). Parsed → emit a
  `guide-update` Tauri event → HUD renders.
- Stable IDs + prior-points feedback prevent checklist flicker between cycles.

**Contention policy.** Single shared Gemma context (also used by
voice-at-cursor and end-of-call synthesis). Strict priority:
**voice-at-cursor (user-blocking) > end-of-call synthesis > guide loop**. The
guide job is abortable; if a higher-priority job arrives, the guide cycle is
skipped and the HUD shows staleness ("updated 40s ago"). The guide loop never
blocks dictation.

**In-call modes.** `Auto` (job per chunk) and `On-demand` ("Guide me now"
button). Same engine; only the trigger differs. Chunk size is fixed by the
Section 1 pipeline, not a live toggle.

**HUD window.** Always-on-top, transparent, draggable, collapsible — reuses
the existing overlay-window precedent (`crate::overlay::show_consent_overlay`).
Contents:

- Header: template name; collapse / minimize / close affordances.
- Goal line.
- Key points list with covered · partial · open states.
- 1–3 "suggest now" items.
- Footer: staleness label, mode menu (Auto / On-demand), End button.
- Collapsed state: template name, coverage count (e.g. 3/5), single next-best
  suggestion.

**Event additions (frontend ⇄ backend).** New Tauri events alongside existing
`meeting-started` / `meeting-status` / `meeting-complete`:
`guide-update` (key points + suggestions + timestamp), plus commands to start
a guided session, switch mode, trigger on-demand, and end.

## Privacy / consent

A guided session uses the same recording path as meetings; the existing
meeting consent/overlay mechanism applies. No new audio capture surface is
introduced. The HUD displays only derived text; no raw audio leaves the
device (Gemma + Parakeet are local).

## Risks

- **Overlap stitch correctness** — dropped/duplicated words at chunk seams.
  Mitigation: prefer word-timestamp trim; dedicated unit tests with
  adversarial seams.
- **LLM contention** — heavy mid-call dictation starves the guide loop.
  Mitigation: skip-if-busy + visible staleness; option B (second context)
  held in reserve.
- **Memory-source assumption** — the ~2 GiB cause is unproven. Mitigation:
  instrumentation is the first implementation task; flush design adjusts to
  the measured source.
- **Chunk-size vs. Parakeet throughput** — if 20–30 s chunks plus overlap
  exceed realtime on low-end hardware, the queue backs up. Mitigation:
  measure RTF; degrade gracefully (drop overlap, then lengthen chunk) under
  sustained backlog.

## Testing

- Silence-aware chunker: boundary at silence, 30 s force-cut, no audio lost
  across the seam (with overlap).
- Overlap stitch: no dropped/duplicated words across many synthetic seams,
  including mid-word force-cuts.
- Memory: instrumented assertion that per-chunk buffers are freed; RSS stays
  bounded across a long synthetic session.
- Guide JSON parsing + prior-points stability (IDs persist across cycles).
- Contention: guide job yields to voice-at-cursor and end-of-call synthesis.
- Template CRUD round-trip; template snapshot frozen into the meeting record
  is immutable against later template edits.
- Guided session produces both a normal meeting summary and saved guide
  artifacts.
