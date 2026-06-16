# MLX vs GGUF Benchmark — Results

**Date:** 2026-06-16
**Machine:** Apple **M5 Pro** (arm64), unified memory; ~53 GB GPU working set free at test time
**Model:** Gemma 4 E2B — GGUF Q4_K_M (llama.cpp/Metal, the app's current runtime) vs MLX 4-bit (`mlx-community/gemma-4-e2b-it-4bit`)
**Prompt / settings:** shared `BENCH_PROMPT` (~65 prompt tokens), `max_tokens=256`, `temp=0.7`

## Headline

**MLX could not run the model at all.** `mlx-lm` 0.31.3 — both the latest PyPI release **and** git `main` — fails to load `gemma-4-e2b-it-4bit` with:

```
ValueError: Received 140 parameters not in model:
language_model.model.layers.{15..34}.self_attn.{k_norm,k_proj,v_proj}...
```

Gemma 4 E2B uses an "effective-params" attention layout — **`shared_kv_layers=20`** plus a per-layer sliding-window pattern (confirmed in the GGUF metadata: `gemma4.attention.shared_kv_layers=20`, `gemma4.attention.sliding_window_pattern=[...]`). llama.cpp has native `arch=gemma4` support for this; the current `mlx-lm` gemma-4 model class does not define the per-layer K/V projections the checkpoint carries, so loading aborts. This affects **every** gemma-4-E2B quant (the mismatch is architectural, not quantization-specific), so 8-bit/bf16/QAT variants would fail identically.

## Numbers

| Metric | GGUF Q4_K_M (llama.cpp/Metal) | MLX 4-bit (mlx-lm) |
|--------|-------------------------------|--------------------|
| Decode throughput | **83.1 tok/s** (256-token run) | ❌ model fails to load |
| Prefill / time-to-first-token | **68 ms** (65-token prompt; incl. tokenize + per-request context build) | ❌ |
| Peak RSS | **3.40 GiB** (mmap'd Q4 weights resident) | ❌ (crashed at load, ~0.1 GB) |
| Output quality | baseline (works) | ❌ unmeasurable |

Warm-up run (excluded): 62.8 tok/s, included one-time Metal pipeline compilation.

GGUF baseline reproducible via the in-repo bench:
`cargo test --release --lib llm::engine::tests::bench_gguf_gemma4_e2b -- --ignored --nocapture`
(the `llm_bench` tracing line reports `prefill_ms` + `decode_tok_s`).

## Decision bar (from the design spec)

> Adopt MLX only if it is **≥ ~25–30% faster on decode, or clearly lower peak RAM**, with no quality regression — enough to justify a second inference engine plus Apple-Silicon gating and a GGUF fallback for Intel.

## Verdict

**RED — stay on GGUF / llama.cpp. Do not build an MLX runtime now.**

Rationale:
1. **The bar cannot be met** — MLX can't load gemma-4-E2B in the mainstream runtime (`mlx-lm`), so there is no decode/RAM win to bank. This held on an **M5 Pro**, the *best-case* hardware for MLX (its Neural Accelerators are where MLX's advantage is largest), so the result isn't a weak-hardware artifact.
2. **GGUF is already fast enough** — 83 tok/s decode + 68 ms prefill on this machine means a 256-token formatting/classification completes in ~3 s; meeting synthesis is comfortably interactive. There is no performance pain to solve.
3. **High cost, unproven benefit** — an MLX runtime means a second inference engine, Apple-Silicon gating, a GGUF fallback for Intel, and ongoing maintenance — to chase a speedup we can't even measure.
4. The only known gemma-4-E2B MLX path today is a single-maintainer Swift port (`VincentGourbin/gemma-4-swift-mlx`); basing the app's core LLM on bleeding-edge/single-source support is itself a risk that fails the spirit of the decision bar.

## Revisit trigger

Re-run this benchmark when `mlx-lm` (or another maintained MLX runtime) gains real gemma-4-E2B support — i.e. when `mlx_lm.generate --model mlx-community/gemma-4-e2b-it-4bit` loads without the parameter-mismatch error. The GGUF baseline harness (`bench_gguf_gemma4_e2b`) and the `llm_bench` timing logs are now in place, so re-evaluation is a one-command measurement. If, at that point, MLX clears the decode/RAM bar, the next step is a dedicated spec for an **MLX Swift sidecar** (Apple-Silicon-only, GGUF fallback on Intel).

## Note

Echo Scribe still ships an **Intel** build, which cannot run MLX at all — so even in a GREEN future, GGUF/llama.cpp stays as the cross-arch baseline and MLX would only ever be an Apple-Silicon fast path.
