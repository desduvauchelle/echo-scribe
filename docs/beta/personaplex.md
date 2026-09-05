# Beta: PersonaPlex voice lab (Settings → Beta)

**Status:** local-only beta (2026-09-05). Hidden unless the beta marker exists.

## What it is

[NVIDIA PersonaPlex-7B-v1](https://huggingface.co/nvidia/personaplex-7b-v1) is a
7B **full-duplex speech-to-speech** model built on Kyutai's Moshi architecture
(Mimi codec + temporal transformer + depth transformer). It listens and speaks
at the same time, so it can interrupt, back-channel and be interrupted, with
sub-second response latency. It is **not a text LLM**: audio in → audio out,
plus a text stream of what the agent says (its "inner monologue"). English only.
Persona = a text system prompt + one of 18 voice presets.

It cannot run on Tucky's llama.cpp engine. The only Apple-Silicon runtime is
MLX, via [soniqo/speech-swift](https://github.com/soniqo/speech-swift) (Swift,
Apache-2.0), which loads the public, ungated 8-bit conversion
[`aufklarer/PersonaPlex-7B-MLX-8bit`](https://huggingface.co/aufklarer/PersonaPlex-7B-MLX-8bit)
(~9.75 GB; Mimi, tokenizer and voices included; CC-BY-NC-4.0). The 4-bit
conversion is smaller but produces garbled speech — don't use it.

## Architecture

```
Settings → Beta → PersonaPlexLab.tsx
        │  invoke()                       ▲ events: personaplex:download / personaplex:event
        ▼                                 │
src-tauri/src/personaplex.rs  (gating, status, download + session supervisors)
        │  spawn, stdin kept open          ▲ stdout: JSON lines   stderr: logs
        ▼                                 │
~/Library/Application Support/EchoScribe/personaplex/bin/echo-scribe-personaplex
   (Swift, src-tauri/personaplex/ — depends on patched speech-swift v0.0.27)
        │  AVAudioEngine (Voice Processing AEC) + MLX
        ▼
~/Library/Application Support/EchoScribe/llm-models/personaplex-7b-mlx-8bit/
```

- **Sidecar commands:** `download --model-dir DIR` (resumable, checksummed,
  byte-weighted progress), `chat --model-dir DIR --voice NATF2 --prompt "…"
  [--no-aec] [--input-wav in.wav --output-wav out.wav]`, `voices`, `version`.
- **Events (stdout):** `hello`, `progress`, `done`, `loading`, `warming`,
  `ready`, `text` (one SentencePiece piece), `level`, `stats` (ms/step; the
  real-time budget is 80 ms), `error`, `stopped`. The Rust supervisor adds
  `stderr` and `exited`.
- **Stop protocol:** `stop` on stdin, or SIGTERM, or stdin EOF (Tucky died) →
  audio engines stop, `stopped` is emitted, process exits.
- **Why a patch:** upstream's full-duplex `respondRealtime` yields audio only
  and resolves voice files from the default cache dir. `src-tauri/personaplex/
  patches/speech-swift-v0.0.27.patch` adds an `onTextToken` callback and a
  `modelDirectory` so a caller-managed model folder is self-contained.

## Enable / disable

```bash
touch "$HOME/Library/Application Support/EchoScribe/beta.enabled"   # show Settings → Beta
rm    "$HOME/Library/Application Support/EchoScribe/beta.enabled"   # hide it again
```
`ECHO_SCRIBE_BETA=1` in the environment does the same. Release builds ship the
code but nobody without the marker sees the page.

## Build the sidecar (once per machine, and after touching src-tauri/personaplex)

```bash
xcodebuild -downloadComponent MetalToolchain   # once; needed to precompile mlx.metallib
bash scripts/build-personaplex-sidecar.sh
```

The script clones speech-swift at the pinned tag into
`src-tauri/personaplex/.deps/` (gitignored), applies the patch, builds with
`--disable-keychain` (SwiftPM otherwise blocks on a keychain dialog), compiles
`mlx.metallib`, and installs binary + metallib + `version.json` into the
Application Support folder above. Nothing is added to `tauri.conf.json`
`externalBin`, so release CI is untouched.

## Headless smoke test

```bash
say -o /tmp/q.aiff "Hello there, can you tell me a joke about cats?" && afconvert /tmp/q.aiff /tmp/q.wav -f WAVE -d LEI16@24000
"$HOME/Library/Application Support/EchoScribe/personaplex/bin/echo-scribe-personaplex" chat \
  --model-dir "$HOME/Library/Application Support/EchoScribe/llm-models/personaplex-7b-mlx-8bit" \
  --voice NATF2 --prompt "You are a helpful assistant." \
  --input-wav /tmp/q.wav --output-wav /tmp/answer.wav --ignore-stdin
```
Text events print the agent's transcript; `/tmp/answer.wav` holds its voice.

## Known limitations

- ~10 GB RAM while a session runs; 24 GB+ Macs recommended.
- No end-of-turn signal: a live session runs until Stop (capped at ~8 min by
  the runtime's token cache).
- Echo cancellation is Apple Voice Processing on the mic; with headphones you
  can turn it off for slightly more natural input.
- Logs: `target: "personaplex"` in the daily log (Settings → Diagnostics).
