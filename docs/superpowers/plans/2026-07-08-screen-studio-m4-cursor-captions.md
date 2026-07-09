# Screen Studio Parity — M4: Cursor Polish, Captions, Loudness, Motion Blur

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Timed captions generated from the local ASR (editable, burned in at export), loudness normalization of the exported audio, cursor smoothing + hide-idle for the synthetic cursor, and motion blur during zoom transitions.

**Architecture:** Captions are project state (`project.captions`), generated once by a new backend command that produces `{startMs, endMs, text}` segments (native transcribe-rs timestamps if available, else VAD-boundary chunked transcription), then edited/rendered exactly like every other overlay — looked up at SOURCE time by one pure function shared by preview and export. Loudness normalization is a pure Rust WAV pass (gated-RMS measure → gain → soft-knee peak limiter) slotted after retime, before mux. Cursor smoothing is a precomputed pure pass over the move-event path; hide-idle replaces the hard 2 s cutoff with a fade. Motion blur is multi-sample zoom-state accumulation during transition ramps (same decoded frame, N eased zoom states, alpha 1/N) — no inter-frame state needed.

**Tech Stack:** unchanged. Suites baseline: cargo **503**, bun **257**, build clean.

## Global Constraints

- All M2/M2.1/M3 conventions hold: SOURCE-time for every effect lookup; only emitted timestamps re-anchor/retime; one shared resolver per effect for preview+export parity; CLAUDE.md logging/friendly-error discipline (`target: "screenrec"` / `target: "captions"`).
- **No DB migration expected** — captions/audio settings live in `project_json` (tolerant parse). If a task discovers a migration is needed, next free number is **26** (verify against MIGRATIONS tail first — collisions have happened twice).
- Never break trim/cursor/webcam/aspect/zoom/keystroke/speed behavior shipped in M2–M3; pinned tests keep passing.
- New EditorProject fields must default to OFF/neutral so existing projects render identically (tolerant parse, missing → defaults).
- Sidecar (Swift) changes are NOT expected this milestone. If one becomes necessary, rebuild + commit the binary in the same commit.
- Branch: `feat/screen-studio-m4-captions`.

## Data contracts

**EditorProject v1 additions** (tolerant parse: missing → defaults):

```ts
captions: {
  enabled: boolean;                 // default false
  segments: Array<{ startMs: number; endMs: number; text: string }> | null; // null = never generated
};
audio: { normalizeLoudness: boolean };            // default false
cursor: { enabled; scale; smoothing: number; hideIdle: boolean };
  // smoothing 0..1, default 0 (existing look unchanged); hideIdle default false
motionBlur: boolean;                              // default false
```

**Caption generation (Rust command):** `generate_captions(recording_id) -> Vec<CaptionSegment { start_ms, end_ms, text }>` — extracts the recording's audio WAV (reuse `transcribe_recording`'s extract path, commands.rs:3679), then: (1) FIRST check whether transcribe-rs/Parakeet exposes token/segment timestamps (timebox 30 min — the TDT model family has native alignment; the wrapper may hide it); (2) else segment the 16 kHz audio at VAD speech boundaries (the pipeline's existing VAD, with original-offset bookkeeping) and transcribe each segment independently; (3) fallback if VAD offsets are impractical: fixed ~8 s windows split at the lowest-energy sample near each boundary. Segments are POST-processed by the existing filler-strip only if trivially reusable — plain text per segment is fine for v1. Empty-text segments dropped. Segment times are SOURCE-time ms relative to the recording's t=0 (same time base as events.jsonl).

**Loudness (Rust, pure, TDD):** `normalize_wav_loudness(in, out) -> Result<LoudnessReport>` on 48 kHz mono i16 WAV (reuse `read_mono_wav`/`write_mono_wav`, screenrec/mod.rs:249-319): gated RMS measure (400 ms blocks, −40 dBFS gate) → single gain toward target −16 dBFS → soft-knee limiter at −1 dBFS ceiling. Pure function; report holds measured/applied values for logging. Applied in `finalize_rendered_recording` AFTER retime, BEFORE mux, behind `project.audio.normalizeLoudness` (passed like the speed-ranges param; malformed → skip + warn).

**Caption lookup (TS, pure, TDD):** `captionAt(tMs, segments) -> string | null` — binary search, segments non-overlapping (clamp/sort on save like speed ranges). Rendered bottom-center of the CONTENT rect as a pill (match keystroke-badge styling constants); when captions are enabled the keystroke badge shifts up one strip height (extract shared layout const — don't collide).

**Cursor smoothing (TS, pure, TDD):** `smoothCursorPath(moves, strength) -> CursorSample[]` — centripetal Catmull-Rom (or one-euro filter — implementer's choice, justify in report) resampled over the move samples; strength 0 returns input unchanged (identity test pinned). Precomputed once per events load (memoized like zoom blocks), consumed by the existing `cursorStateAt` unchanged. Hide-idle: when `hideIdle`, cursor alpha fades 1→0 over the last 500 ms before an idle gap (> 2 s, the existing `CURSOR_MAX_GAP_MS`) instead of vanishing at the gap edge — extend `cursorStateAt`'s return with `alpha` (default 1; compositor multiplies).

**Motion blur (TS):** during zoom transition ramps only (rising/falling edges of `zoomStateAt`, which already exposes eased interpolation): composite N=4 sub-samples of the SAME decoded frame at t − k·(frameInterval/N) zoom states with `globalAlpha = 1/N`, accumulate. Pure helper `motionBlurSamples(tMs, blocks, n) -> ZoomState[]` (TDD: plateau/no-block → single sample; mid-ramp → N distinct states). Export always; preview MAY skip for perf if measured jank — document the choice in the task report.

---

### Task 1: EditorProject v1 extensions (Sonnet — model plumbing, TDD)

**Files:** `src/lib/editorProject.ts` + `tests/editorProject.test.ts`.

The four contract additions above: defaults, tolerant parse (missing/malformed → defaults, ranges clamped), `clampCaptionSegments(segments, durationMs)` (sort, clamp to [0,duration], drop empty-text/invalid/overlapping — keep earlier, mirror `clampSpeedRanges`), smoothing/hideIdle/motionBlur field plumbing. Existing-project fixtures must parse unchanged.

### Task 2: Caption generation backend (Opus — ASR integration, riskiest)

**Files:** `src-tauri/src/asr/` (segment-timing plumbing), `src-tauri/src/commands.rs` (`generate_captions` command + registration in `lib.rs`), `src/lib/api.ts` wrapper. Rust tests for the pure segmentation/offset math (synthetic WAV fixtures).

Follow the caption-generation contract. Investigation step FIRST (timestamps in transcribe-rs? — write findings to the task report before implementing). Log segment count + total speech ms at info; friendly error string on failure ("Caption generation failed — see logs."). Long recordings: reuse `transcribe_long`'s chunking discipline so memory stays flat; emit progress events (`captions-progress`, ratio 0..1) so the UI can show a bar.

### Task 3: Captions editor UI + burn-in render (Sonnet)

**Files:** `src/views/sections/EditorView.tsx` (Captions section: Generate button + progress + regenerate, enable toggle, per-segment inline text edit + delete; gated on recording having audio), `src/lib/render/compositor.ts` (+tests: `captionAt`, caption pill draw, keystroke-badge offset when captions active), `src/lib/render/renderPipeline.ts` (same lookup at `tMsSource`).

Preview and export must render identical captions (shared `captionAt` + shared style consts). Trim/speed interaction: lookup is SOURCE-time — a caption spanning a trimmed/sped region needs no special handling (same rule as keystroke badges).

### Task 4: Loudness normalization (Opus — DSP, pure, TDD)

**Files:** `src-tauri/src/screenrec/mod.rs` (pure `normalize_wav_loudness` + unit tests: silence → unchanged + no gain blow-up (gate), quiet speech → boosted to ~target, hot signal → attenuated, peaks never exceed ceiling, i16 round-trip), `src-tauri/src/commands.rs` (`finalize_rendered_recording` applies it post-retime pre-mux behind the project flag — param passed alongside the speed-ranges header, parse defensively), `src/views/sections/EditorView.tsx` (Audio row: "Normalize loudness" toggle), `src/lib/render/renderPipeline.ts`/export plumbing for the flag.

Log the LoudnessReport (measured dBFS, gain applied) at info. Fail-safe: normalization error → export continues with un-normalized audio + warn (never fail the export for a polish step).

### Task 5: Cursor smoothing + hide-idle + motion blur (Opus — render math)

**Files:** `src/lib/render/compositor.ts` (+tests: `smoothCursorPath` identity at 0 / smoothness property at 1 (max deviation bounded, endpoints pinned), `cursorStateAt` alpha fade contract, `motionBlurSamples`), `src/views/sections/EditorView.tsx` (Cursor section: Smoothing slider 0–1 step 0.1, Hide-when-idle toggle; Appearance section: Motion blur toggle; preview consumes smoothed path + blur), `src/lib/render/renderPipeline.ts` (export consumes identically — one memoized smoothed path, blur accumulation in the composite step).

Perf note: smoothing is precomputed (not per-frame); blur multiplies draw cost ×N only inside transition ramps (~600 ms per block). Measure preview fps before/after on a real recording; if preview jank, preview skips blur (export keeps it) — document.

### Task 6: E2E + manual QA (Sonnet)

Suites (503+ / 257+), `bun run build` clean, `bun tauri build --bundles app`, skip-TCC install (Screen Recording re-grant reminder!), boot + log check. Write `.superpowers/sdd/m4-manual-qa.md`: generate captions on a recording with speech → segments appear with sane times; edit a segment's text; enable → preview shows pill, export burns it in; normalize loudness → exported audio audibly leveled + LoudnessReport in log; smoothing slider visibly smooths jittery cursor; hide-idle fades cursor during a pause; motion blur visible on zoom-in transition in export; all combined (trim+speed+zoom+captions+blur+16:9+webcam) exports coherently; pre-M4 recordings/projects unchanged.

## Self-review notes

- Captions timing quality is the milestone's real risk: VAD-boundary segments give phrase-level (not word-level) captions — acceptable v1, matches the "editable segments" UX. The task 2 investigation step exists so we don't hand-roll alignment if the library already ships it.
- Every new effect obeys the SOURCE-time invariant; reviewers should re-run the M3-style frame trace including a caption + blurred transition frame.
- Loudness normalization is deliberately a simple gated-RMS + limiter, not EBU R128 — document the constant choices in code; upgrading to K-weighting later is a drop-in.
- Motion blur reuses the eased `zoomStateAt` — no decoder changes, no inter-frame buffering; if N=4 looks steppy on fast transitions, bump N before reaching for real frame blending.
- `smoothing` defaults to 0 and `motionBlur`/`hideIdle`/`normalizeLoudness` default false: zero behavior change for existing projects (pinned by Task 1 fixtures).
