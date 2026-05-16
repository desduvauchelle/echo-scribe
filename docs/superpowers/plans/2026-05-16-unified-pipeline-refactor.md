# Unified Chunked Transcription Pipeline Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed 60 s WAV chunking with silence-aware ~20 s / 30 s-hard-cap chunks, add bounded 3–5 s ASR overlap with transcript stitching, and aggressively flush audio buffers so meetings/guided sessions stay memory-bounded.

**Architecture:** `ChunkedWavWriter` (src-tauri/src/meeting/recorder.rs) gains a silence-aware close policy. A new `stitch` module removes the duplicated text the overlap produces. `meeting/pipeline.rs` retains only the previous chunk's tail PCM (per speaker), prepends it before transcription, and stitches the result. Phase 0 instruments RSS to *confirm* the ~2 GiB source before the flush logic is written (project rule: diagnose with data, not hypotheses).

**Tech Stack:** Rust, tokio, cpal, Parakeet (`transcribe_rs`) via `crate::asr::pipeline::AsrPipeline`, rusqlite, `libc::getrusage` for RSS.

This plan is Plan A of two. Plan B (the Guide feature) is authored after this lands so its tasks bind to the real interfaces created here.

---

## File Structure

- `src-tauri/src/meeting/recorder.rs` — MODIFY: chunk-size constants, silence-aware close in `ChunkedWavWriter`, expose chunk seconds.
- `src-tauri/src/meeting/stitch.rs` — CREATE: word-level overlap removal between consecutive chunk transcripts.
- `src-tauri/src/meeting/mod.rs` — MODIFY: register `stitch` module; replace hardcoded `"chunk_seconds": 60` with the real value; add RSS instrumentation calls.
- `src-tauri/src/meeting/pipeline.rs` — MODIFY: retain previous-chunk tail PCM per speaker, prepend before transcription, stitch result, free buffers; RSS instrumentation.
- `src-tauri/src/util/rss.rs` — CREATE: `max_rss_bytes()` + `log_rss(label)` helper.
- `src-tauri/src/util/mod.rs` — CREATE or MODIFY: register `rss`.
- `src-tauri/src/lib.rs` — MODIFY: register `util` module if newly created.
- `src-tauri/Cargo.toml` — MODIFY: add `libc` dependency.

---

## Phase 0 — RSS instrumentation (confirm the memory source)

### Task 1: RSS helper

**Files:**
- Create: `src-tauri/src/util/rss.rs`
- Create/Modify: `src-tauri/src/util/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: inline `#[cfg(test)]` in `src-tauri/src/util/rss.rs`

- [ ] **Step 1: Add `libc` dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
libc = "0.2"
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/util/rss.rs`:

```rust
//! Process resident-set-size probe for memory instrumentation.

/// Peak resident set size of this process, in bytes.
///
/// macOS `getrusage` reports `ru_maxrss` in **bytes** (Linux reports KiB).
/// This is a high-water mark — it never decreases — which is exactly what
/// we want for "did this path ever balloon".
pub fn max_rss_bytes() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    if rc != 0 {
        return 0;
    }
    let raw = usage.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        raw
    } else {
        raw * 1024
    }
}

/// Log the current peak RSS with a label, in MiB, at INFO level.
pub fn log_rss(label: &str) {
    let mib = max_rss_bytes() / (1024 * 1024);
    tracing::info!(rss_mib = mib, "[mem] {label}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_rss_is_nonzero_and_grows_with_allocation() {
        let before = max_rss_bytes();
        // Touch ~64 MiB so the peak provably moves.
        let mut big: Vec<u8> = vec![0u8; 64 * 1024 * 1024];
        for i in (0..big.len()).step_by(4096) {
            big[i] = 1;
        }
        let after = max_rss_bytes();
        std::hint::black_box(&big);
        assert!(before > 0, "RSS probe returned 0");
        assert!(after >= before, "peak RSS must be monotonic");
    }
}
```

- [ ] **Step 3: Register the module**

Create `src-tauri/src/util/mod.rs` (or add the line if it exists):

```rust
pub mod rss;
```

In `src-tauri/src/lib.rs`, add alongside the other top-level `mod` declarations (search for `mod meeting;` and add near it):

```rust
mod util;
```

(If `src-tauri/src/util/mod.rs` already existed and was already declared in `lib.rs`, skip the `lib.rs` edit and only add `pub mod rss;`.)

- [ ] **Step 4: Run the test, expect PASS**

Run: `cd src-tauri && cargo test --lib util::rss:: -- --nocapture`
Expected: `max_rss_is_nonzero_and_grows_with_allocation ... ok`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/util/ src-tauri/src/lib.rs
git commit -m "feat(mem): add RSS probe helper for memory instrumentation"
```

### Task 2: Instrument the meeting/synthesis path

**Files:**
- Modify: `src-tauri/src/meeting/pipeline.rs` (drain loop, after each chunk)
- Modify: `src-tauri/src/meeting/mod.rs` (stop(): before/after `pipeline.finalize()`, before/after `synthesizer::synthesize`)

- [ ] **Step 1: Instrument the drain loop**

In `src-tauri/src/meeting/pipeline.rs`, inside `spawn_drain`, in the `Ok(text)` branch right after `builder.lock().await.push(seg);` add:

```rust
{
    let b = builder.lock().await;
    let seg_count = b.segments.len();
    let text_bytes: usize = b.segments.iter().map(|s| s.text.len()).sum();
    drop(b);
    tracing::info!(seg_count, text_bytes, "[mem] chunk drained");
}
crate::util::rss::log_rss("after chunk transcribe");
```

- [ ] **Step 2: Instrument stop() in meeting/mod.rs**

In `src-tauri/src/meeting/mod.rs`, in `stop()`:

Immediately before `let (segments, failed) = pipeline.finalize().await;` add:
```rust
crate::util::rss::log_rss("before pipeline.finalize");
```
Immediately after that line add:
```rust
crate::util::rss::log_rss("after pipeline.finalize");
tracing::info!(seg_count = segments.len(), "[mem] segments materialized");
```
Immediately before the `let synthesis = synthesizer::synthesize(` call add:
```rust
crate::util::rss::log_rss("before synthesize");
```
Immediately after the `.await;` that ends that `synthesize(...)` call add:
```rust
crate::util::rss::log_rss("after synthesize");
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/pipeline.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(mem): instrument meeting transcription + synthesis RSS"
```

- [ ] **Step 5: Capture a real measurement (manual, records the finding)**

Build and run a real ~10+ min meeting (`bun tauri build --bundles app`, install per CLAUDE.md, run a call, stop it). Collect logs (Console.app filtered to the app, or run the binary from terminal). Record the `[mem]` lines and which label the RSS jump occurs at into a new section "Phase 0 finding" appended to this plan file, then commit:

```bash
git add docs/superpowers/plans/2026-05-16-unified-pipeline-refactor.md
git commit -m "docs(mem): record Phase 0 RSS finding"
```

> If the jump is at "after synthesize" (LLM context, expected to be large and is freed when Llm idle-unloads) rather than accumulating across "after chunk transcribe", the flush work in Phase 2 narrows to the LLM lifecycle and the audio-buffer tasks below become low-priority. Adjust Phase 2 emphasis based on the measured label before implementing it.

---

## Phase 1 — Silence-aware chunking

### Task 3: Chunk-size constants + silence helper

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/meeting/recorder.rs`

- [ ] **Step 1: Replace the chunk constants**

In `src-tauri/src/meeting/recorder.rs`, replace:

```rust
const CHUNK_SECONDS: u64 = 60;
const SAMPLES_PER_CHUNK: u64 = SAMPLE_RATE as u64 * CHUNK_SECONDS;
```

with:

```rust
/// Soft target: once this many samples are buffered, the writer looks for a
/// silence boundary to close the chunk on.
const CHUNK_TARGET_SECONDS: u64 = 20;
const CHUNK_TARGET_SAMPLES: u64 = SAMPLE_RATE as u64 * CHUNK_TARGET_SECONDS;
/// Hard cap: force-close even mid-speech at this many samples.
const CHUNK_MAX_SECONDS: u64 = 30;
const CHUNK_MAX_SAMPLES: u64 = SAMPLE_RATE as u64 * CHUNK_MAX_SECONDS;
/// The chunk-duration value recorded into transcript JSON metadata.
pub const CHUNK_TARGET_SECONDS_PUB: u64 = CHUNK_TARGET_SECONDS;
/// Window (samples) whose RMS is tested for the silence boundary: 300 ms.
const SILENCE_WINDOW_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * 300;
/// i16 RMS gate. Mirrors `audio::vad::RMS_THRESHOLD` (0.003 of full-scale)
/// scaled to i16: 0.003 * 32768 ≈ 98.
const SILENCE_RMS_I16: f32 = 98.0;
```

- [ ] **Step 2: Write the failing test for the silence helper**

Add to the `tests` module in `src-tauri/src/meeting/recorder.rs`:

```rust
#[test]
fn rms_i16_detects_silence_vs_speech() {
    let silence = vec![0i16; SILENCE_WINDOW_SAMPLES];
    assert!(super::rms_i16(&silence) < SILENCE_RMS_I16);

    let loud: Vec<i16> = (0..SILENCE_WINDOW_SAMPLES)
        .map(|i| ((i as f32 * 0.2).sin() * 8000.0) as i16)
        .collect();
    assert!(super::rms_i16(&loud) > SILENCE_RMS_I16);
}
```

- [ ] **Step 3: Run it, expect FAIL**

Run: `cd src-tauri && cargo test --lib meeting::recorder::tests::rms_i16_detects_silence_vs_speech`
Expected: FAIL — `cannot find function rms_i16`.

- [ ] **Step 4: Implement the helper**

In `src-tauri/src/meeting/recorder.rs`, add at module scope (above `impl ChunkedWavWriter`):

```rust
/// Root-mean-square amplitude of an i16 PCM window.
fn rms_i16(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    ((sum_sq / samples.len() as f64).sqrt()) as f32
}
```

- [ ] **Step 5: Run it, expect PASS**

Run: `cd src-tauri && cargo test --lib meeting::recorder::tests::rms_i16_detects_silence_vs_speech`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs
git commit -m "feat(meeting): add silence-aware chunk constants + rms helper"
```

### Task 4: Silence-aware close policy in ChunkedWavWriter

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Rewrite `write()` to use the new policy**

In `src-tauri/src/meeting/recorder.rs`, replace the body of `ChunkedWavWriter::write` with:

```rust
pub fn write(&mut self, samples: &[i16]) -> std::io::Result<()> {
    let mut offset = 0;
    while offset < samples.len() {
        if self.writer.is_none() {
            self.open_new_chunk()?;
        }
        // How many more samples until the hard cap.
        let until_cap = (CHUNK_MAX_SAMPLES - self.samples_in_chunk) as usize;
        let take = until_cap.min(samples.len() - offset);
        let slice = &samples[offset..offset + take];
        self.write_raw(slice)?;
        self.tail.extend_from_slice(slice);
        if self.tail.len() > SILENCE_WINDOW_SAMPLES {
            let excess = self.tail.len() - SILENCE_WINDOW_SAMPLES;
            self.tail.drain(0..excess);
        }
        self.samples_in_chunk += take as u64;
        self.total_samples += take as u64;
        offset += take;

        let at_cap = self.samples_in_chunk >= CHUNK_MAX_SAMPLES;
        let past_target = self.samples_in_chunk >= CHUNK_TARGET_SAMPLES;
        let at_silence = self.tail.len() >= SILENCE_WINDOW_SAMPLES
            && rms_i16(&self.tail) < SILENCE_RMS_I16;
        if at_cap || (past_target && at_silence) {
            self.finalize_chunk()?;
        }
    }
    Ok(())
}
```

- [ ] **Step 2: Add the `tail` field**

In the `ChunkedWavWriter` struct definition add a field:

```rust
    /// Sliding window of the most recent samples, used for silence detection.
    tail: Vec<i16>,
```

In `ChunkedWavWriter::new`, add `tail: Vec::with_capacity(SILENCE_WINDOW_SAMPLES + 1),` to the struct literal.

In `open_new_chunk()`, after `self.samples_in_chunk = 0;` add `self.tail.clear();`.

- [ ] **Step 3: Replace the obsolete rotation test**

In the `tests` module, replace `rotates_at_60_seconds` and `wav_header_is_valid_after_finalize` so they no longer reference `SAMPLE_RATE * 60`. Replace `rotates_at_60_seconds` with:

```rust
#[test]
fn force_cuts_at_hard_cap_on_continuous_speech() {
    let tmp = tempdir().unwrap();
    let (mut w, mut rx) = make_writer(tmp.path(), Speaker::You);
    // 31 s of continuous loud audio → must force-cut at 30 s (no silence).
    let loud: Vec<i16> = (0..SAMPLE_RATE as usize)
        .map(|i| ((i as f32 * 0.2).sin() * 8000.0) as i16)
        .collect();
    for _ in 0..31 {
        w.write(&loud).unwrap();
    }
    let chunk = rx.try_recv().expect("hard-cap chunk emitted");
    assert_eq!(chunk.start_ms, 0);
    assert_eq!(chunk.end_ms, CHUNK_MAX_SECONDS * 1000);
}

#[test]
fn closes_on_silence_after_target() {
    let tmp = tempdir().unwrap();
    let (mut w, mut rx) = make_writer(tmp.path(), Speaker::You);
    let loud: Vec<i16> = (0..SAMPLE_RATE as usize)
        .map(|i| ((i as f32 * 0.2).sin() * 8000.0) as i16)
        .collect();
    // 22 s loud (past the 20 s target) ...
    for _ in 0..22 {
        w.write(&loud).unwrap();
    }
    // ... then 0.5 s of silence → should close shortly after 22 s.
    let silence = vec![0i16; (SAMPLE_RATE / 2) as usize];
    w.write(&silence).unwrap();
    let chunk = rx.try_recv().expect("silence-closed chunk emitted");
    assert_eq!(chunk.start_ms, 0);
    assert!(
        chunk.end_ms >= 22_000 && chunk.end_ms < CHUNK_MAX_SECONDS * 1000,
        "expected silence close between 22s and 30s, got {}",
        chunk.end_ms
    );
}
```

Replace `wav_header_is_valid_after_finalize`'s loop body (`for _ in 0..60`) with `for _ in 0..31` and its loud-buffer construction to match `force_cuts_at_hard_cap_on_continuous_speech` (use the `loud` vec, not `one_sec` of zeros — zeros would close early on silence). Keep its header assertions unchanged. Leave `flush_partial_emits_remaining_chunk` as-is.

- [ ] **Step 4: Run the recorder tests, expect PASS**

Run: `cd src-tauri && cargo test --lib meeting::recorder::tests`
Expected: all PASS (`force_cuts_at_hard_cap_on_continuous_speech`, `closes_on_silence_after_target`, `flush_partial_emits_remaining_chunk`, `wav_header_is_valid_after_finalize`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs
git commit -m "feat(meeting): silence-aware 20s/30s-cap chunk close policy"
```

### Task 5: Make transcript chunk_seconds dynamic

**Files:**
- Modify: `src-tauri/src/meeting/mod.rs`

- [ ] **Step 1: Replace the hardcoded value**

In `src-tauri/src/meeting/mod.rs`, in `stop()`, in the `transcript_json` builder, replace:

```rust
            "chunk_seconds": 60,
```

with:

```rust
            "chunk_seconds": crate::meeting::recorder::CHUNK_TARGET_SECONDS_PUB,
```

- [ ] **Step 2: Build to verify**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/meeting/mod.rs
git commit -m "fix(meeting): record real chunk duration in transcript metadata"
```

---

## Phase 2 — Bounded overlap + transcript stitching

### Task 6: The stitch module

**Files:**
- Create: `src-tauri/src/meeting/stitch.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (add `pub mod stitch;`)
- Test: inline `#[cfg(test)]` in `stitch.rs`

- [ ] **Step 1: Register the module**

In `src-tauri/src/meeting/mod.rs`, in the module declaration block near the top (where `pub mod pipeline;` etc. are), add:

```rust
pub mod stitch;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/meeting/stitch.rs`:

```rust
//! Removes the duplicated leading words a chunk's transcript contains because
//! its audio was prefixed with an overlap tail from the previous chunk.
//!
//! Strategy: normalize to lowercase alphanumeric word tokens. Find the
//! longest K (capped) such that the last K normalized words of `prev_tail`
//! equal the first K normalized words of `new_text`. Drop those K words from
//! the front of `new_text` (operating on the original, un-normalized words so
//! casing/punctuation of the kept remainder is preserved).

/// Max words of overlap we will look for. 5 s of speech ≈ ~15 words; cap
/// generously so a long stable phrase still aligns, but bound the search.
const MAX_OVERLAP_WORDS: usize = 40;

fn norm(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Returns `new_text` with any leading words that duplicate the tail of
/// `prev_text` removed. If there is no overlap, returns `new_text` trimmed.
pub fn strip_overlap(prev_text: &str, new_text: &str) -> String {
    let new_words: Vec<&str> = new_text.split_whitespace().collect();
    if new_words.is_empty() {
        return String::new();
    }
    let prev_words: Vec<&str> = prev_text.split_whitespace().collect();
    if prev_words.is_empty() {
        return new_words.join(" ");
    }

    let prev_norm: Vec<String> = prev_words.iter().map(|w| norm(w)).collect();
    let new_norm: Vec<String> = new_words.iter().map(|w| norm(w)).collect();

    let max_k = MAX_OVERLAP_WORDS
        .min(prev_norm.len())
        .min(new_norm.len());

    let mut best_k = 0;
    for k in 1..=max_k {
        let prev_suffix = &prev_norm[prev_norm.len() - k..];
        let new_prefix = &new_norm[..k];
        if prev_suffix == new_prefix {
            best_k = k;
        }
    }
    new_words[best_k..].join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_overlap_returns_new_text() {
        assert_eq!(
            strip_overlap("the cat sat", "on the mat today"),
            "on the mat today"
        );
    }

    #[test]
    fn exact_word_overlap_is_removed() {
        // prev ends with "we should ship it", new repeats then continues.
        let out = strip_overlap(
            "so in summary we should ship it",
            "we should ship it by friday for sure",
        );
        assert_eq!(out, "by friday for sure");
    }

    #[test]
    fn overlap_ignores_case_and_punctuation() {
        let out = strip_overlap(
            "... let's circle back on Budget.",
            "Budget — and timeline are the blockers",
        );
        assert_eq!(out, "— and timeline are the blockers");
    }

    #[test]
    fn empty_prev_returns_new() {
        assert_eq!(strip_overlap("", "hello there"), "hello there");
    }

    #[test]
    fn empty_new_returns_empty() {
        assert_eq!(strip_overlap("anything", "   "), "");
    }

    #[test]
    fn full_duplicate_returns_empty() {
        assert_eq!(strip_overlap("alpha beta gamma", "beta gamma"), "");
    }
}
```

- [ ] **Step 3: Run the tests, expect PASS**

Run: `cd src-tauri && cargo test --lib meeting::stitch::`
Expected: all 6 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/meeting/stitch.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(meeting): add transcript overlap stitch module"
```

> **AS BUILT (deviation from the snippet below):** The per-chunk
> `workers.push(tokio::spawn(...))` + `Semaphore::new(1)` structure prescribed
> below was found racy in code review — detached per-chunk workers made the
> per-speaker tail read→transcribe→write non-atomic, desyncing overlap under
> backpressure. The drain loop was instead made **sequential** (a single
> `while let Some(chunk) = rx.recv().await { ... }` inside one outer
> `tokio::spawn`), and the `Semaphore` was removed entirely (the sequential
> loop already guarantees one transcription at a time). Both failure branches
> (load + transcribe) now clear that speaker's tail AND `last_text` so a
> failed chunk can't poison the next chunk's overlap/stitch. `spawn_drain`
> still returns `JoinHandle<()>`; `Pipeline::finalize()` and the `mod.rs`
> caller are unchanged. Future work (Plan B) should build on the sequential
> drain loop, not the snippet below.

### Task 7: Wire bounded overlap into the transcription pipeline

**Files:**
- Modify: `src-tauri/src/meeting/pipeline.rs`
- Test: inline `#[cfg(test)]` in `pipeline.rs`

Context: `AsrPipeline` exposes `pub async fn transcribe(&self, samples: Vec<f32>, from_rate: u32, channels: u16)` and `pub fn load_wav_16k_mono_int16(path) -> Result<(Vec<f32>,u32,u16), AsrError>` (associated fn). Chunk WAVs are 16 kHz mono. We read the WAV, prepend the previous chunk's tail (same speaker), transcribe, then `strip_overlap` against the previous segment's text.

- [ ] **Step 1: Add overlap constant + per-speaker tail state**

In `src-tauri/src/meeting/pipeline.rs`, add near the top (after the `use` block):

```rust
/// Seconds of the previous chunk's audio prepended to the next chunk so
/// Parakeet has acoustic context across the boundary. Bounded — only the
/// last chunk's tail is ever retained.
const OVERLAP_SECONDS: usize = 4;
const OVERLAP_SAMPLES: usize = 16_000 * OVERLAP_SECONDS;
```

Change `TranscriptBuilder` to also remember the last text per speaker so stitching has a reference:

Replace:
```rust
#[derive(Default)]
pub struct TranscriptBuilder {
    pub segments: Vec<Segment>,
    pub failed: Vec<PathBuf>,
}
```
with:
```rust
#[derive(Default)]
pub struct TranscriptBuilder {
    pub segments: Vec<Segment>,
    pub failed: Vec<PathBuf>,
    /// Last emitted text per speaker (You, Them) for overlap stitching.
    last_text_you: String,
    last_text_them: String,
}

impl TranscriptBuilder {
    fn last_text(&self, sp: Speaker) -> &str {
        match sp {
            Speaker::You => &self.last_text_you,
            Speaker::Them => &self.last_text_them,
        }
    }
    fn set_last_text(&mut self, sp: Speaker, t: &str) {
        match sp {
            Speaker::You => self.last_text_you = t.to_string(),
            Speaker::Them => self.last_text_them = t.to_string(),
        }
    }
}
```

(Keep the existing `push` and `finalize` methods in their own/extended `impl` block — do not delete them.)

- [ ] **Step 2: Add a per-speaker tail store to `Pipeline`**

Replace the `Pipeline` struct and `new` with:

```rust
pub struct Pipeline {
    asr: Arc<AsrPipeline>,
    builder: Arc<Mutex<TranscriptBuilder>>,
    sem: Arc<Semaphore>,
    failed_dir: PathBuf,
    /// Last OVERLAP_SAMPLES of f32 PCM per speaker. Bounded by construction.
    tails: Arc<Mutex<(Vec<f32>, Vec<f32>)>>,
}

impl Pipeline {
    pub fn new(asr: Arc<AsrPipeline>, failed_dir: PathBuf) -> Self {
        Self {
            asr,
            builder: Arc::new(Mutex::new(TranscriptBuilder::default())),
            sem: Arc::new(Semaphore::new(1)), // Parakeet on ANE is single-tenant
            failed_dir,
            tails: Arc::new(Mutex::new((Vec::new(), Vec::new()))),
        }
    }

    fn tail_index(sp: Speaker) -> usize {
        match sp {
            Speaker::You => 0,
            Speaker::Them => 1,
        }
    }
}
```

- [ ] **Step 3: Rewrite the worker body in `spawn_drain`**

In `spawn_drain`, clone `tails` alongside the other clones:
```rust
        let tails = self.tails.clone();
```
and inside the `tokio::spawn`'d closure, also `let tails = tails.clone();` before the worker `tokio::spawn`.

Replace the worker closure body (the `async move { let _permit ... }` block) with:

```rust
                workers.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await.expect("semaphore");
                    let idx = Pipeline::tail_index(chunk.speaker);

                    // Read this chunk's PCM, prepend the retained tail.
                    let loaded = AsrPipeline::load_wav_16k_mono_int16(&chunk.path);
                    let (cur, transcribe_input) = match loaded {
                        Ok((cur, _rate, _ch)) => {
                            let prefix = {
                                let t = tails.lock().await;
                                let side = if idx == 0 { &t.0 } else { &t.1 };
                                side.clone()
                            };
                            let mut input =
                                Vec::with_capacity(prefix.len() + cur.len());
                            input.extend_from_slice(&prefix);
                            input.extend_from_slice(&cur);
                            (cur, input)
                        }
                        Err(e) => {
                            error!(?e, path = %chunk.path.display(), "load chunk failed");
                            let _ = tokio::fs::create_dir_all(&failed_dir).await;
                            let dest = failed_dir
                                .join(chunk.path.file_name().unwrap_or_default());
                            let _ = tokio::fs::rename(&chunk.path, &dest).await;
                            builder.lock().await.failed.push(dest);
                            return;
                        }
                    };

                    match asr.transcribe(transcribe_input, 16_000, 1).await {
                        Ok(raw_text) => {
                            // Update the retained tail to this chunk's last
                            // OVERLAP_SAMPLES (bounded — old tail dropped).
                            {
                                let mut t = tails.lock().await;
                                let side = if idx == 0 { &mut t.0 } else { &mut t.1 };
                                let start = cur.len().saturating_sub(OVERLAP_SAMPLES);
                                *side = cur[start..].to_vec();
                            }
                            // Stitch: drop words duplicated from the prev tail.
                            let stitched = {
                                let b = builder.lock().await;
                                crate::meeting::stitch::strip_overlap(
                                    b.last_text(chunk.speaker),
                                    &raw_text,
                                )
                            };
                            if !stitched.trim().is_empty() {
                                let mut b = builder.lock().await;
                                b.set_last_text(chunk.speaker, &stitched);
                                b.push(Segment {
                                    speaker: chunk.speaker,
                                    start_ms: chunk.start_ms,
                                    end_ms: chunk.end_ms,
                                    text: stitched,
                                });
                            }
                            // Free the chunk WAV — disk flush.
                            if let Err(e) =
                                tokio::fs::remove_file(&chunk.path).await
                            {
                                warn!(?e, path = %chunk.path.display(), "remove chunk failed");
                            }
                            // `cur` and `transcribe_input` drop here.
                            let seg_count =
                                builder.lock().await.segments.len();
                            tracing::info!(seg_count, "[mem] chunk drained");
                            crate::util::rss::log_rss("after chunk transcribe");
                        }
                        Err(e) => {
                            error!(?e, path = %chunk.path.display(), "transcribe failed");
                            let _ = tokio::fs::create_dir_all(&failed_dir).await;
                            let dest = failed_dir
                                .join(chunk.path.file_name().unwrap_or_default());
                            let _ = tokio::fs::rename(&chunk.path, &dest).await;
                            builder.lock().await.failed.push(dest);
                        }
                    }
                }));
```

> This replaces the Phase 0 Task 2 Step 1 instrumentation block (now folded inline above). Remove the standalone `[mem] chunk drained` block added in Task 2 Step 1 if it still exists, to avoid double logging.

- [ ] **Step 4: Add a stitch-integration test**

Add to a `#[cfg(test)] mod tests` in `pipeline.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::{Segment, Speaker};

    #[test]
    fn builder_tracks_last_text_per_speaker() {
        let mut b = TranscriptBuilder::default();
        b.set_last_text(Speaker::You, "we should ship it");
        b.set_last_text(Speaker::Them, "sounds good to me");
        assert_eq!(b.last_text(Speaker::You), "we should ship it");
        assert_eq!(b.last_text(Speaker::Them), "sounds good to me");
        b.push(Segment {
            speaker: Speaker::You,
            start_ms: 0,
            end_ms: 1000,
            text: "hello".into(),
        });
        assert_eq!(b.segments.len(), 1);
    }
}
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `cd src-tauri && cargo test --lib meeting::pipeline::`
Expected: PASS. Then `cd src-tauri && cargo build --lib` — compiles.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/meeting/pipeline.rs
git commit -m "feat(meeting): bounded ASR overlap + transcript stitch in pipeline"
```

### Task 8: Full meeting test-suite regression pass

**Files:** none (verification task)

- [ ] **Step 1: Run the full lib test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: all tests PASS. Pay attention to `meeting::recorder`, `meeting::pipeline`, `meeting::stitch`, `util::rss`, and any `mod.rs` meeting tests. Fix any breakage before continuing — do not mark complete with failures.

- [ ] **Step 2: Clippy**

Run: `cd src-tauri && cargo clippy --lib -- -D warnings`
Expected: no warnings. Fix any introduced by the new code.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A src-tauri/src
git commit -m "chore(meeting): clippy + test fixes for pipeline refactor"
```

### Task 9: Real-world verification

**Files:** none (manual verification)

- [ ] **Step 1: Build + install per CLAUDE.md**

Run `bun tauri build --bundles app`, then the full TCC reset + reinstall sequence from `CLAUDE.md`.

- [ ] **Step 2: Run a real meeting and verify**

Record a real ~5–10 min call with talking and pauses. Then verify:
- Transcript reads coherently across chunk boundaries (no dropped/duplicated phrases at seams — the stitch working).
- `[mem]` RSS log lines stay bounded across chunks (not monotonically climbing per chunk).
- Meeting summary still generates and saves as before.

Record pass/fail + the RSS numbers in a "Phase 2 verification" section appended to this plan, then commit:

```bash
git add docs/superpowers/plans/2026-05-16-unified-pipeline-refactor.md
git commit -m "docs: record pipeline refactor verification"
```

---

## Self-Review

**Spec coverage (Section 1 of `2026-05-16-meeting-guide-design.md`):**
- Silence-aware 20 s / 30 s-cap chunking → Tasks 3–4. ✓
- RMS-energy silence detection, no new VAD model → Task 3 (`rms_i16`, `SILENCE_RMS_I16` mirrors `audio::vad`). ✓
- Bounded 3–5 s overlap, prev-tail-only retention → Task 7 (`OVERLAP_SECONDS = 4`, per-speaker bounded tail). ✓
- Overlap stitch (timestamps unavailable in `AsrPipeline::transcribe` → text fuzzy match) → Task 6, wired Task 7. Spec said "timestamps if available; else fuzzy" — Parakeet's `transcribe` returns plain `String` with no timestamps, so fuzzy is the path; documented in Task 7 context. ✓
- Aggressive RAM flush (drop chunk buffers, delete WAV) → Task 7 (explicit drop of `cur`/`transcribe_input`, `remove_file` retained). ✓
- Memory-source instrumentation as first step (project rule) → Phase 0 Tasks 1–2. ✓
- Shared path (meetings + future guided sessions ride one pipeline) → no fork introduced; `meeting/pipeline.rs` is the single path. ✓
- Dynamic `chunk_seconds` in transcript metadata → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The two manual tasks (9, and Phase 0 Step 5) are explicitly verification/measurement, with concrete commands and recorded outputs — not deferred implementation.

**Type consistency:** `Speaker` (`You`/`Them`) used consistently; `strip_overlap(prev,new)->String` signature identical in Task 6 definition and Task 7 call; `AsrPipeline::transcribe(Vec<f32>,u32,u16)` and `load_wav_16k_mono_int16` match the real signatures in `src-tauri/src/asr/pipeline.rs`; `CHUNK_TARGET_SECONDS_PUB` defined in Task 3, consumed in Task 5; `crate::util::rss::log_rss` defined Task 1, used Tasks 2 & 7.

**Risk:** Task 7 Step 3 is the largest single edit. The cap on overlap-stitch correctness is covered by `meeting::stitch` unit tests (Task 6) plus the real-world seam check (Task 9 Step 2). If `cargo test --lib` reveals the existing `mod.rs` meeting tests depend on 60 s behavior, Task 8 Step 1 is the gate that catches it.
