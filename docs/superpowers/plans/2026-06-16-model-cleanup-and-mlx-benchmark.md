# Model Cleanup UI + MLX Benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the LLM model picker a Delete button + disk-usage view (mirroring the speech picker), and produce real GGUF-vs-MLX benchmark numbers on this Mac to decide whether an MLX runtime is worth building.

**Architecture:** Track A is frontend-only — the `delete_llm_model` command and its `deleteLlmModel` binding already exist, so only `LlmModelPicker.tsx` changes. Track B adds permanent inference-timing logs to the existing llama.cpp `generate()` path, drives them with an ignored `cargo` benchmark test for a reproducible GGUF baseline, then compares against `mlx-lm` for the same model, ending in a committed results note with a go/no-go verdict.

**Tech Stack:** React + TypeScript (Tauri frontend), Rust (`llama-cpp-2`, `tracing`), `mlx-lm` (Python, throwaway) for the MLX candidate. Spec: `docs/superpowers/specs/2026-06-16-model-cleanup-and-mlx-benchmark-design.md`.

> **Note on tests:** This project has a Rust test runner (`cargo test`) but **no JS test runner** (confirmed by the existing meeting-export spec). Track A (TSX) is therefore verified by `tsc --noEmit` + manual in-app checks, not unit tests — this matches the established project pattern. Track B's logic lives in Rust and is exercised by a `cargo` test.

---

## File Structure

| File | Track | Responsibility | Change |
|------|-------|----------------|--------|
| `src/components/LlmModelPicker.tsx` | A | LLM model list UI: download / activate / **delete**, Downloaded vs Available sections, total disk line | Modify (rewrite) |
| `src-tauri/src/llm/engine.rs` | B | llama.cpp `generate()` + **inference timing log** + ignored benchmark test | Modify |
| `docs/superpowers/specs/2026-06-16-mlx-benchmark-results.md` | B | Benchmark numbers + verdict | Create |

No backend changes for Track A (`delete_llm_model` at `src-tauri/src/commands.rs:1703` and `deleteLlmModel` at `src/lib/api.ts:397` already exist and are registered).

---

## Phase 1 — Track A: LLM model cleanup UI

### Task 1: Add Delete + disk view to the LLM model picker

**Files:**
- Modify (full rewrite): `src/components/LlmModelPicker.tsx`

The rewrite (a) extracts the existing card markup into a `ModelCard` subcomponent (DRY, so it isn't duplicated across two sections), (b) adds a `TrashIcon` + `handleDelete` mirroring `SpeechModelPicker.tsx`, (c) splits into "Downloaded models" / "Available to download" sections with a total-disk-used line, and (d) shows Delete **only** on downloaded, non-active models. All existing download/progress/activate behavior is preserved.

- [ ] **Step 1: Replace the file contents**

Overwrite `src/components/LlmModelPicker.tsx` with exactly:

```tsx
import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  deleteLlmModel,
  downloadLlmModel,
  listLlmModels,
  setActiveLlmModel,
  type DownloadProgress,
  type LlmModelStatus,
} from "../lib/api";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const fixed = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[i]}`;
}

type DownloadState = { bytes_downloaded: number; bytes_total: number };

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

type CardProps = {
  model: LlmModelStatus;
  downloading: DownloadState | null;
  downloadError: string | null;
  busy: boolean;
  onDownload: () => void;
  onActivate: () => void;
  onDelete: () => void;
};

function ModelCard({
  model,
  downloading,
  downloadError,
  busy,
  onDownload,
  onActivate,
  onDelete,
}: CardProps) {
  const isDownloading = downloading !== null && !model.downloaded;
  const disabled = !model.supported;
  return (
    <div
      title={disabled ? "Not yet supported" : undefined}
      className={`flex items-center justify-between gap-4 rounded-lg border border-line bg-surface p-4 ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <span className="font-semibold">{model.size_label}</span>
          <span className="text-muted"> — {model.display_name}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {model.family} · {formatBytes(model.size_bytes)} · {model.context_length} ctx
        </div>
        {isDownloading && downloading ? (
          <div className="mt-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
              <div
                className="h-full bg-fg transition-all"
                style={{
                  width: `${
                    downloading.bytes_total > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (downloading.bytes_downloaded /
                              downloading.bytes_total) *
                              100,
                          ),
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="mt-1 text-[11px] text-muted">
              {formatBytes(downloading.bytes_downloaded)} /{" "}
              {formatBytes(downloading.bytes_total)}
            </div>
          </div>
        ) : null}
        {downloadError && !isDownloading ? (
          <p className="mt-2 text-xs text-danger">
            Download failed: {downloadError}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!model.supported ? (
          <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
            Unavailable
          </span>
        ) : isDownloading ? (
          <span className="text-xs text-muted">Downloading…</span>
        ) : model.downloaded && model.active ? (
          <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
            Active
          </span>
        ) : model.downloaded ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon />
              Delete
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onActivate}
              className="rounded border border-line px-3 py-1 text-xs hover:bg-elevated disabled:opacity-50"
            >
              Use this model
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onDownload}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
          >
            Download
          </button>
        )}
      </div>
    </div>
  );
}

export default function LlmModelPicker() {
  const [models, setModels] = useState<LlmModelStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const pendingRef = useRef<Record<string, DownloadState>>({});
  const flushTimer = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const m = await listLlmModels();
      setModels(m);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      try {
        const fn = await listen<DownloadProgress>(
          "llm_model:progress",
          (event) => {
            const p = event.payload;
            pendingRef.current[p.id] = {
              bytes_downloaded: p.bytes_downloaded,
              bytes_total: p.bytes_total,
            };
            if (flushTimer.current === null) {
              flushTimer.current = window.setTimeout(() => {
                flushTimer.current = null;
                const pending = pendingRef.current;
                pendingRef.current = {};
                setDownloads((prev) => ({ ...prev, ...pending }));
              }, 200);
            }
          },
        );
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, []);

  const handleDownload = async (model: LlmModelStatus) => {
    setBusyId(model.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[model.id];
      return next;
    });
    setDownloads((prev) => ({
      ...prev,
      [model.id]: { bytes_downloaded: 0, bytes_total: model.size_bytes },
    }));
    const noActiveBefore = !models.some((m) => m.active && m.downloaded);
    const poll = window.setInterval(() => void refresh(), 2000);
    try {
      await downloadLlmModel(model.id);
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
      if (noActiveBefore) {
        try {
          await setActiveLlmModel(model.id);
        } catch {
          /* ignore */
        }
      }
      await refresh();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [model.id]: e instanceof Error ? e.message : String(e),
      }));
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
    } finally {
      window.clearInterval(poll);
      setBusyId((cur) => (cur === model.id ? null : cur));
      void refresh();
    }
  };

  const handleActivate = async (model: LlmModelStatus) => {
    setBusyId(model.id);
    try {
      await setActiveLlmModel(model.id);
      await refresh();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [model.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusyId((cur) => (cur === model.id ? null : cur));
    }
  };

  const handleDelete = async (model: LlmModelStatus) => {
    setBusyId(model.id);
    try {
      await deleteLlmModel(model.id);
      await refresh();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [model.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusyId((cur) => (cur === model.id ? null : cur));
    }
  };

  if (loadError && models.length === 0) {
    return (
      <p className="text-xs text-warning">
        Couldn’t load LLM models: {loadError}
      </p>
    );
  }

  const downloaded = models.filter((m) => m.downloaded);
  const available = models.filter((m) => !m.downloaded);
  const totalBytes = downloaded.reduce((sum, m) => sum + (m.size_bytes || 0), 0);

  return (
    <div className="flex flex-col gap-5">
      {downloaded.length > 0 ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
              Downloaded models
            </h4>
            {totalBytes > 0 ? (
              <span className="text-[11px] text-muted">
                {formatBytes(totalBytes)} on disk
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
            {downloaded.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                downloading={downloads[model.id] ?? null}
                downloadError={errors[model.id] ?? null}
                busy={busyId === model.id}
                onDownload={() => void handleDownload(model)}
                onActivate={() => void handleActivate(model)}
                onDelete={() => void handleDelete(model)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {available.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-[0.08em] text-muted">
            Available to download
          </h4>
          <div className="flex flex-col gap-3">
            {available.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                downloading={downloads[model.id] ?? null}
                downloadError={errors[model.id] ?? null}
                busy={busyId === model.id}
                onDownload={() => void handleDownload(model)}
                onActivate={() => void handleActivate(model)}
                onDelete={() => void handleDelete(model)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `bun run tsc --noEmit` (from repo root)
Expected: no errors. (If the project exposes a different typecheck script, `cat package.json` and use it; the design relies only on `deleteLlmModel`, which already exists in `src/lib/api.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/LlmModelPicker.tsx
git commit -m "feat(settings): delete + disk view for LLM models

Mirrors the speech model picker — Downloaded/Available sections, a
total-on-disk line, and a per-model Delete button shown only on
downloaded, non-active models (so the active model can't be removed
out from under the app). Backend delete_llm_model already existed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Build, install, and manually verify

**Files:** none (verification only)

- [ ] **Step 1: Build the release bundle**

Run: `bun tauri build --bundles app`
Expected: completes; bundle at `src-tauri/target/release/bundle/macos/Echo Scribe.app`.

- [ ] **Step 2: Reinstall (skip-TCC — no permission-related changes)**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 2b (if needed): get a second downloaded model so Delete is exercisable**

In Settings → Language Model, if only the active model is downloaded, click **Download** on the other Gemma 4 variant (E4B) so there is a downloaded, non-active model to delete.

- [ ] **Step 3: Verify in-app (Settings → Language Model)**

Confirm each:
- A **"Downloaded models"** section with a **"… on disk"** total in its header.
- The **active** model shows the green **Active** badge and **no** Delete button.
- A **non-active downloaded** model shows **Delete** (trash icon) + **Use this model**.
- Clicking **Delete** on the non-active model: it moves to **"Available to download"** within a second, and its folder under `~/Library/Application Support/EchoScribe/llm-models/<id>/` is gone (`ls "$HOME/Library/Application Support/EchoScribe/llm-models"`).
- **"Available to download"** lists non-downloaded models with a **Download** button.

Track A is complete and shippable once these pass.

---

## Phase 2 — Track B: MLX vs GGUF benchmark (spike)

### Task 3: Add inference-timing logs to the GGUF generate path

**Files:**
- Modify: `src-tauri/src/llm/engine.rs`

- [ ] **Step 1: Add the `Instant` import**

Find (`src-tauri/src/llm/engine.rs:21-23`):

```rust
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;
```

Replace with:

```rust
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
```

- [ ] **Step 2: Start the timer after request validation**

Find:

```rust
        if req.max_tokens == 0 {
            return Err(EngineError::Request("max_tokens must be > 0".into()));
        }
```

Replace with:

```rust
        if req.max_tokens == 0 {
            return Err(EngineError::Request("max_tokens must be > 0".into()));
        }

        let t_start = Instant::now();
```

- [ ] **Step 3: Mark the prefill/decode boundary**

Find:

```rust
        ctx.decode(&mut batch)
            .map_err(|e| EngineError::Decode(format!("prefill decode: {e}")))?;
```

Replace with:

```rust
        ctx.decode(&mut batch)
            .map_err(|e| EngineError::Decode(format!("prefill decode: {e}")))?;

        let prefill_ms = t_start.elapsed().as_millis() as u64;
        let t_decode_start = Instant::now();
```

- [ ] **Step 4: Emit the timing line before returning**

Find:

```rust
        Ok(strip_trailing_stops(&output, &req.stop_strings))
    }
}
```

Replace with:

```rust
        let decode_secs = t_decode_start.elapsed().as_secs_f64();
        let decode_tok_s = if decode_secs > 0.0 {
            n_decoded as f64 / decode_secs
        } else {
            0.0
        };
        info!(
            target: "llm_bench",
            n_prompt,
            n_decoded,
            prefill_ms,
            decode_tok_s,
            "llm generate timing"
        );

        Ok(strip_trailing_stops(&output, &req.stop_strings))
    }
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo build --lib && cd ..`
Expected: builds with no errors/warnings about `t_start`, `prefill_ms`, or `decode_tok_s`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/llm/engine.rs
git commit -m "feat(llm): log prefill ms + decode tok/s per generate

Adds an llm_bench tracing line (prompt tokens, generated tokens,
prefill ms, decode tokens/sec) to the llama.cpp path — diagnostics for
the MLX-vs-GGUF spike and ongoing perf visibility.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Add a reproducible GGUF benchmark test

**Files:**
- Modify: `src-tauri/src/llm/engine.rs` (the `#[cfg(test)] mod tests` block)

- [ ] **Step 1: Add the benchmark prompt const and ignored test**

Find (inside `mod tests`, right after `use super::*;` at `src-tauri/src/llm/engine.rs:311`):

```rust
mod tests {
    use super::*;
```

Replace with:

```rust
mod tests {
    use super::*;

    /// Shared prompt for the MLX-vs-GGUF spike. Use the SAME text on the MLX
    /// side (`mlx_lm.generate --prompt ...`) so prefill sizes match.
    const BENCH_PROMPT: &str = "Write a detailed, multi-paragraph explanation \
of how on-device speech-to-text systems work, covering audio capture, feature \
extraction, acoustic modeling, and decoding. Aim for at least 400 words.";

    /// GGUF decode-throughput baseline for the MLX-vs-llama.cpp spike.
    /// Ignored by default (loads a multi-GB model). Run with:
    ///   cargo test --release --lib llm::engine::tests::bench_gguf_gemma4_e2b -- --ignored --nocapture
    /// The `llm generate timing` line prints n_prompt / n_decoded / prefill_ms / decode_tok_s.
    #[test]
    #[ignore]
    fn bench_gguf_gemma4_e2b() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter("llm_bench=info")
            .with_test_writer()
            .try_init();

        let entry = crate::llm::registry::lookup("gemma-4-e2b-it-q4_k_m")
            .expect("gemma-4-e2b-it-q4_k_m must be in the registry");
        if !crate::llm::is_downloaded(&entry) {
            println!("gemma-4-e2b-it-q4_k_m not downloaded; skipping benchmark.");
            return;
        }
        let model_path =
            crate::llm::model_file_path(&entry).expect("model file path should exist");
        let engine = LlmEngine::load(&model_path, 16384).expect("model should load");

        // Warm-up so weight fault-in / Metal pipeline build doesn't skew timing.
        let _ = engine.generate(GenerateRequest {
            user: "Say hello.".to_string(),
            max_tokens: 8,
            n_ctx: Some(2048),
            ..Default::default()
        });

        // Timed run: stops cleared so it generates the full 256-token budget.
        let out = engine
            .generate(GenerateRequest {
                system: Some("You are a helpful writing assistant.".to_string()),
                user: BENCH_PROMPT.to_string(),
                history: Vec::new(),
                max_tokens: 256,
                temperature: 0.7,
                stop_strings: Vec::new(),
                grammar_gbnf: None,
                n_ctx: Some(4096),
            })
            .expect("generation should succeed");
        assert!(!out.is_empty(), "benchmark generation produced no output");
    }
```

- [ ] **Step 2: Verify the test compiles (without running the heavy body)**

Run: `cd src-tauri && cargo test --lib llm::engine::tests::bench_gguf_gemma4_e2b -- --list && cd ..`
Expected: lists `bench_gguf_gemma4_e2b: test` with no compile errors. (It won't run — it's `#[ignore]`.)

- [ ] **Step 3: Confirm the existing tests still pass**

Run: `cd src-tauri && cargo test --lib llm::engine && cd ..`
Expected: the existing `engine::tests` pass; `bench_gguf_gemma4_e2b` is reported as ignored.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/llm/engine.rs
git commit -m "test(llm): ignored GGUF decode-throughput benchmark

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: Capture the GGUF baseline numbers

**Files:** none (measurement). Requires `gemma-4-e2b-it-q4_k_m` downloaded (Settings → Language Model → Download if absent).

- [ ] **Step 1: Run the benchmark under a peak-RAM probe**

Run:
```bash
cd src-tauri && /usr/bin/time -l cargo test --release --lib \
  llm::engine::tests::bench_gguf_gemma4_e2b -- --ignored --nocapture 2>&1 \
  | tee /tmp/gguf_bench.txt; cd ..
```
Expected: a line like
`… llm generate timing n_prompt=NN n_decoded=256 prefill_ms=NNN decode_tok_s="NN.N"`
and, from `/usr/bin/time -l`, a `maximum resident set size  NNNNNNNN` line (bytes).

- [ ] **Step 2: Record**

From `/tmp/gguf_bench.txt`, note: `prefill_ms`, `decode_tok_s`, and `maximum resident set size` (÷ 1048576 for MiB). These are the GGUF Q4_K_M numbers for the results table in Task 7.

### Task 6: Capture the MLX candidate numbers

**Files:** none (measurement). Uses a throwaway venv — nothing committed.

- [ ] **Step 1: Install mlx-lm in a throwaway venv**

```bash
python3 -m venv /tmp/mlxbench
source /tmp/mlxbench/bin/activate
pip install -q -U mlx-lm
```
Expected: installs without error (Apple Silicon only; on Intel mlx-lm won't run — record "N/A — MLX is Apple-Silicon-only" and skip to Task 7).

- [ ] **Step 2: Run the same prompt through MLX**

```bash
/usr/bin/time -l python -m mlx_lm generate \
  --model mlx-community/gemma-4-e2b-it-4bit \
  --prompt "Write a detailed, multi-paragraph explanation of how on-device speech-to-text systems work, covering audio capture, feature extraction, acoustic modeling, and decoding. Aim for at least 400 words." \
  --max-tokens 256 --temp 0.7 2>&1 | tee /tmp/mlx_bench.txt
```
Expected: mlx-lm prints `Prompt: … tokens-per-sec`, `Generation: 256 tokens, NN.N tokens-per-sec`, and `Peak memory: N.NN GB`.
If the model id 404s, list candidates and retry with the exact name:
```bash
python -c "from huggingface_hub import HfApi; [print(m.id) for m in HfApi().list_models(author='mlx-community', search='gemma-4-e2b')]"
```

- [ ] **Step 3: Record + clean up**

Note MLX `Generation … tokens-per-sec` and `Peak memory`. Then:
```bash
deactivate; rm -rf /tmp/mlxbench
```

### Task 7: Write the results note and verdict

**Files:**
- Create: `docs/superpowers/specs/2026-06-16-mlx-benchmark-results.md`

- [ ] **Step 1: Fill in the numbers and decide**

Create the file with this structure, replacing every `…` with the captured numbers:

```markdown
# MLX vs GGUF Benchmark — Results

**Date:** 2026-06-16
**Machine:** … (chip, e.g. M3 Pro / total RAM)
**Model:** Gemma 4 E2B — GGUF Q4_K_M (llama.cpp/Metal) vs MLX 4-bit (mlx-lm)
**Prompt / settings:** shared BENCH_PROMPT, max_tokens=256, temp=0.7

| Metric | GGUF Q4_K_M (llama.cpp) | MLX 4-bit (mlx-lm) |
|--------|-------------------------|--------------------|
| Decode throughput (tok/s) | … | … |
| Prefill / TTFT | prefill_ms=… | prompt tok/s=… |
| Peak RAM | … MiB | … GB |
| Output quality (eyeball) | baseline | same / better / worse |

## Decision bar (from the design spec)

Adopt MLX only if it is **≥ ~25–30% faster on decode, or clearly lower peak
RAM**, with no quality regression — enough to justify a second inference engine
plus Apple-Silicon gating and a GGUF fallback for Intel.

## Verdict

**[GREEN — build the MLX Swift sidecar | RED — stay on GGUF]** because …

(If GREEN: the next step is a separate spec for an MLX Swift sidecar —
Apple-Silicon-only with a GGUF/llama.cpp fallback on Intel. If RED: no further
action; the timing logs from Task 3 stay as useful diagnostics.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-mlx-benchmark-results.md
git commit -m "docs: MLX vs GGUF benchmark results + verdict

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Track A delete button → Task 1 (ModelCard Delete, `handleDelete`, `deleteLlmModel`). ✓
- Track A Downloaded/Available sections + total disk line → Task 1 (sections + `totalBytes`). ✓
- Track A active-model guard → Task 1 (Delete only on `downloaded && !active`; active branch renders badge only). ✓
- Track A verification (no JS runner) → Task 1 Step 2 (`tsc`), Task 2 (manual). ✓
- Track B GGUF timing instrumentation → Task 3. ✓
- Track B reproducible baseline → Task 4 + Task 5. ✓
- Track B MLX candidate → Task 6. ✓
- Track B decision bar + results note → Task 7. ✓

**Placeholder scan:** Real code in every code step; the only `…` are in the Task 7 results template, which are intentionally filled from measured numbers at execution time. ✓

**Type/name consistency:** `LlmModelStatus` fields (`id`, `size_label`, `display_name`, `family`, `size_bytes`, `context_length`, `downloaded`, `active`, `supported`) match `LlmModelPicker.tsx` usage; `deleteLlmModel` matches `src/lib/api.ts:397`; `BENCH_PROMPT` text is identical in Task 4 (const) and Task 6 (`--prompt`); the `llm_bench` target is consistent across Task 3 (emit) and Tasks 4–5 (filter/read). ✓
