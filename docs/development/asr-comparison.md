# Local speech comparison

Run `bun run dev:asr`, then open **Settings → Dictation → Parakeet vs. Whisper**.
The script builds an optimized, separate speech worker and starts a debug Tauri
app with its own identity (`com.echoscribe.asrlab`) and data folder
(`EchoScribeAsrLab`). The installed app is unaffected. Skip onboarding if you
only want to import audio; accessibility permission is not needed for the lab.

For an already-running ordinary development app, run `bun run asr:setup` once
and use the same settings panel. The standalone worker is intentionally not a
release dependency or a packaged sidecar. Production frontend builds remove
the panel; release native commands reject lab requests.

Download Parakeet v3, Whisper Base, or Whisper Large v3 Turbo Q5 from the panel.
Whisper downloads have revision-pinned URLs and SHA-256/size metadata in
`src-tauri/asr-lab/models.json`; they use the app's existing resilient download
engine. No recordings leave the computer. Select a model to test it alone, or
compare all downloaded models sequentially. This selection applies only to the
lab, not the ordinary dictation/paste pipeline.

Record or import 0.1–60 seconds of audio. Every engine receives the same decoded,
resampled 16 kHz mono samples. Import support follows the WebView's audio codecs.
The microphone uses the system default input. Optional reference text enables
case/punctuation-insensitive word error rate (WER). WER is literal: “twelve” and
“12” count as different tokens. It is not a semantic quality score. Export JSON
keeps the raw timings, output text, reference, and input filename.

## What the measurements mean

- Load: model construction and engine initialization in a fresh worker process.
  This is not guaranteed cold-disk loading: OS file and Metal shader caches may
  already be warm. The first-ever Metal initialization can be much slower.
- First pass: one raw transcription after model construction.
- Warm: median of three more transcriptions of the same clip and loaded model.
- Speed: clip duration divided by warm time. Higher is faster than real time.
- Loaded/peak RSS: the isolated worker's resident memory after load / process
  high-water mark. This is not all application memory, GPU allocation, or model
  file size. Current RSS is implemented on macOS; other platforms report zero.
- Entire benchmark: native command wall time, including process startup, input
  serialization, load, and all four transcriptions. Audio decoding is excluded.

The worker exits after each benchmark to release model memory, and the native
command terminates it after four minutes. Concurrent downloads/tests are
rejected. Parakeet uses the same transcribe-rs 0.3.11/int8/CPU path as dictation;
Whisper uses whisper.cpp with Metal on macOS. These are practical runtime
comparisons, not equal-hardware model-only benchmarks. Other AI work or heavy
applications can affect the results.

For a useful decision, test several recordings of your actual voice, language,
names, numbers, and noise. Alternate model order across runs before comparing
loading. A clean synthetic clip only establishes a working integration.

Sources: [Parakeet model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
[Whisper](https://github.com/openai/whisper),
[whisper.cpp](https://github.com/ggml-org/whisper.cpp).

## Regular dictation: Whisper Base

Whisper Base is also available in the standard **Transcription Models** picker
beside Parakeet v3. Download (~148 MB), select **Use this model**, or **Delete** it
using the existing controls. Selection persists; Parakeet remains the default.
The shared pipeline retains its resampling, silence trimming, cleanup, and paste
behavior. Meeting/caption callers also use the selected engine and receive native
Whisper segment timestamps. Switching/deletion during active inference is rejected.
Deleting an active model releases its weights; re-download it or select another
installed model before dictating again.

Normal Cargo builds compile `src-tauri/whisper-worker` into a separately bundled
`tucky-whisper` executable. It stays loaded for the normal speech idle timeout and
is terminated/reaped on model change, deletion, or unload. It has no cloud API.
This separation prevents conflicts with the app's llama.cpp ggml symbols. The
worker reads bounded binary PCM chunks and returns JSON transcripts/timestamps;
blocked writes and inference have timeouts. Longer recordings use 60-second chunks.

Verification (2026-09-26): 65 speech tests passed, including real Parakeet →
Whisper Base → Parakeet transcription, caption segments, and worker reuse/unload.
Native local-app picker selection, deletion, and verified download were exercised.

## Additional dictation choices (local development)

Settings → Dictation now also offers **Whisper Turbo Q5** and **Qwen3-ASR 0.6B 4-bit**, alongside Base and Parakeet. Turbo is visible in debug builds; Qwen is visible in Apple-silicon macOS debug builds. Release registries omit these two experimental choices. The standard verified downloader, selection persistence, and removal controls are reused.

Run `bun run dev:asr` to prepare both workers and launch the isolated dev app. Qwen setup uses `uv` and a dedicated Python 3.12 environment in `src-tauri/target/qwen-runtime`, with MLX Audio 0.5.6 / MLX 0.32.2. It does not use a system Python environment or depend on the benchmark output folder. Qwen runs with Hugging Face and Transformers offline flags after explicit model download. No audio leaves the machine. Its weights and tokenizer files are revision-pinned with SHA-256 verification in `models.json`.

Both worker runtimes stay loaded between requests and are dropped when switching or unloading. Requests contain up to 60 seconds of 16 kHz mono PCM; longer input is split. Qwen's timestamp segments cover audio chunks, not word-aligned captions. Vocabulary hints from the benchmark are not yet wired into these raw model workers; existing app dictionary/postprocessing remains unchanged.

The personal voice report (`output/voice-sample-2026-09-26/report.md`, private ignored output) supports this shortlist on one 28.73-second recording: Turbo had 11.3% literal WER, Qwen 15.1%, Base 20.8%, and Parakeet 15.1%. Base was fastest at 0.19 seconds warm; Qwen 0.30 seconds, Parakeet 0.60 seconds, Turbo 1.06 seconds. Vocabulary-assisted results are a separate condition, not defaults in the app.

Verification: the real pipeline integration test now switches Parakeet → Base → Turbo → Qwen → Parakeet, checking transcriptions and segment output. The Qwen worker also reproduced the personal recording's unassisted transcript on two requests in one process. Native settings selection, removal, and verified re-download are checked separately from microphone-to-cursor behavior, which still requires macOS permissions for the dev bundle.

### Install the experiment locally

For an optimized, signed local app with the experimental choices and measured ratings enabled:

```sh
bash scripts/setup-qwen-runtime.sh
TUCKY_LOCAL_ASR=1 VITE_LOCAL_ASR=1 bash reinstall.command
```

The Rust flag opts the two experimental models into this build; the Vite flag includes the ratings. Normal release builds still omit them. Qwen uses this checkout's `src-tauri/target/qwen-runtime`; retain that runtime folder while testing this local installation. Installation preserves the regular app's data, models, and permissions.
