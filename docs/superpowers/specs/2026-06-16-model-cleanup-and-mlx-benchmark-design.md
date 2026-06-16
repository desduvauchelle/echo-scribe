# Model Cleanup UI + MLX Benchmark — Design

**Date:** 2026-06-16
**Status:** Approved (design), pending implementation plan

## Background

The app already runs **Gemma 4** for all LLM work (meeting synthesis, log-capture
classification, voice actions, formatting, daily recap). The default is
`gemma-4-e2b-it-q4_k_m` (~3.2 GB) with `gemma-4-e4b-it-q4_k_m` (~5.5 GB) as an
alternate — both **GGUF**, run via the `llama-cpp-2` crate with Metal GPU
offload (`src-tauri/src/llm/engine.rs`). Speech-to-text is Parakeet V3 (ONNX via
`transcribe-rs`).

Two user requests motivate this work:

1. **"Use the new Gemma-4-for-MLX models on Mac."** Clarified during
   brainstorming: the MLX builds are the *same Gemma 4 weights* in Apple's
   on-device format — a **runtime** change (Apple-Silicon-only), not a better
   model. On Apple Silicon, MLX *may* be moderately faster / lighter on RAM than
   llama.cpp for sub-14B models, but benchmarks are mixed and the cost is a whole
   second inference engine. Decision: **measure before committing** (consistent
   with the prior CoreML-vs-CPU-ONNX decision).
2. **"Let me delete downloaded models so they don't pile up."** Speech models
   already have a full Delete UX; the LLM model picker does not — even though the
   `delete_llm_model` backend command and its frontend binding already exist.

## Scope

### In scope

- **Track A (ship now): LLM model cleanup UI.** Add per-model Delete + disk-usage
  visibility to the Language Model picker, mirroring the existing speech picker.
- **Track B (spike): MLX vs GGUF benchmark.** Produce real numbers on this Mac
  for Gemma 4 E2B and a documented go/no-go recommendation. Includes adding
  permanent inference-timing logs to the GGUF path.

### Out of scope (future, gated on Track B)

- Building an MLX runtime / Swift MLX sidecar. Deferred to its own spec, only if
  Track B clears the decision bar.
- Changing the default model or adding new model entries.
- Any speech-model changes.
- A unified cross-type "Storage" page listing LLM + speech together. The user
  chose to mirror the per-picker speech pattern instead.

## Track A — LLM model cleanup UI

### Current state (verified)

- `delete_llm_model(id)` — `src-tauri/src/commands.rs:1703`. Looks up the registry
  entry and `remove_dir_all`s `llm::model_dir(entry)`
  (`~/Library/Application Support/EchoScribe/llm-models/<id>/`). Registered in
  `src-tauri/src/lib.rs:224`. **Does not** clear the active-model setting.
- `deleteLlmModel(id)` binding — `src/lib/api.ts:397`.
- `src/components/LlmModelPicker.tsx` — flat list, no Delete button. Already shows
  size in the metadata line (`{family} · {size} · {ctx}`, line 178).
- Template: `src/components/SpeechModelPicker.tsx` — `ModelCard` subcomponent,
  `handleDelete` (lines 444–458), `TrashIcon`, and "Downloaded models" /
  "Available to download" sections.

**Backend is complete. This track is frontend-only.**

### Design — `src/components/LlmModelPicker.tsx`

Refactor the flat list to mirror the speech picker:

1. Import `deleteLlmModel`. Add `handleDelete(model)` mirroring the speech
   picker's: set `busyId`, `await deleteLlmModel(model.id)`, `refresh()`, capture
   errors into the existing `errors` map on failure.
2. Add a **Delete** button (a `TrashIcon` + "Delete", same muted→danger hover
   styling as the speech picker) on each **downloaded, non-active** model.
3. Split rendering into **"Downloaded models"** and **"Available to download"**
   sections (same headings/markup as the speech picker).
4. Above the Downloaded section, show a **total disk used** line — sum of
   `size_bytes` for downloaded models via the existing `formatBytes`. Directly
   serves "I don't want 50 models I never use."
5. Keep the per-model size visible on downloaded cards (already present, line
   178). This is a deliberate divergence from the speech picker, which only shows
   size on *available* cards — for the cleanup use case, size matters most on the
   models you might delete.

### Active-model safety (deliberate refinement)

`delete_llm_model` does not clear the active setting, so deleting the active
model would leave the app pointing at missing weights (next `generate()` fails to
load). To prevent this: **render Delete only on downloaded models that are not
active** (`downloaded && !active`). The active model shows just its "Active"
badge. Consequence: a user must switch to another downloaded model before
deleting the current one, and cannot delete their only/active model — which is
the desired guard. This is a small, intentional improvement over the speech
picker (which currently allows deleting the active model); the speech picker is
left unchanged in this phase.

### Data flow

```
Delete click (downloaded, non-active model)
  → invoke delete_llm_model(id)        [Rust: remove_dir_all model dir]
  → refresh() → listLlmModels()         [model now shows as not-downloaded]
  → error → inline "Delete failed: …" (existing errors map)
```

### Error handling

- `delete_llm_model` `Err(String)` (unknown id / IO failure) → inline error under
  the card via the existing `errors` state, same as download errors.
- No confirmation dialog (mirrors the speech picker). Note: `window.confirm` is
  unavailable in this Tauri setup; if a confirm is ever wanted it must use
  `@tauri-apps/plugin-dialog` `ask()` — out of scope here.

### Testing (Track A)

- No JS test runner in the project, so verification is manual: build, install,
  open Settings → Language Model, confirm: total disk line, Delete on the
  non-active downloaded model, no Delete on the active model, deleting frees the
  folder and the model returns to "Available to download". `tsc --noEmit` passes.

## Track B — MLX vs GGUF benchmark (spike)

Goal: real numbers on **this** Mac for Gemma 4 E2B, to decide whether an MLX
runtime is worth building. Exploratory — does not alter app architecture.

### Steps

1. **GGUF baseline instrumentation.** Add `tracing` logs to
   `LlmEngine::generate()` (`src-tauri/src/llm/engine.rs`, `target: "llm_bench"`):
   prompt-token count, generated-token count, prefill/time-to-first-token (ms),
   and decode throughput (tokens/sec). This is permanent, useful diagnostics
   (aligns with the project's "log key transitions" rule), not throwaway.
2. **Capture baseline.** Drive a realistic meeting-synthesis-sized prompt through
   the existing Test Inference path (`TestInference`, used at
   `src/views/Settings.tsx:308`) with `gemma-4-e2b-it`. Read prefill ms + decode
   tok/s from `echo-scribe.log`; read peak RSS from the existing periodic memory
   sampler.
3. **MLX candidate.** In a throwaway venv: `pip install mlx-lm`, run
   `mlx_lm.generate --model mlx-community/gemma-4-e2b-it-4bit` on the *same*
   prompt, capture decode tok/s from its verbose output and peak RSS via
   `/usr/bin/time -l`. (mlx-lm is the reference impl — it gives the MLX ceiling; a
   shipped Swift sidecar would be ≤ this but close.)
4. **Compare against a pre-set bar.** Adopt MLX only if it is **≥ ~25–30% faster
   on decode, or clearly lower peak RAM**, with no output-quality regression —
   enough to justify a second engine plus Apple-Silicon gating and a GGUF
   fallback for Intel.
5. **Output.** A short results note committed to
   `docs/superpowers/specs/2026-06-16-mlx-benchmark-results.md`: the numbers, the
   verdict, and (if green) a pointer to a follow-up MLX Swift sidecar spec.

### Testing (Track B)

- The added timing logs get a small `cargo test` sanity check only if a pure
  helper is extracted; otherwise verified by reading real log output during the
  baseline capture. The benchmark itself is the verification.

## Files touched

**Track A**
- `src/components/LlmModelPicker.tsx` — Delete button, Downloaded/Available
  sections, total-disk line, active-model guard. (Only file; backend + binding
  already exist.)

**Track B**
- `src-tauri/src/llm/engine.rs` — inference timing logs.
- `docs/superpowers/specs/2026-06-16-mlx-benchmark-results.md` — results note (new).

## Permissions / TCC

No TCC-relevant changes in either track: no new Info.plist usage descriptions,
entitlements, or capabilities. A standard **skip-TCC** reinstall applies to both
the Track A frontend change and the Track B Rust rebuild.
