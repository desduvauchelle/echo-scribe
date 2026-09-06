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

## Live-session timing (why the loop is paced)

Upstream's `respondRealtime` reads one 80 ms frame per step from the mic ring
buffer and never waits: a machine faster than real time (M5 Pro: ~68 ms/step
early in a session) runs ahead of the microphone, zero-pads the user's speech
and queues agent audio further and further ahead — the agent "keeps talking
and never answers". The patch adds `paceToInput`: the sidecar passes it in
live mode and the loop blocks (≤300 ms) until a full frame is available. In
prefilled file mode nothing changes. `--realtime-file` feeds a WAV at 24 kHz
in real time to exercise this headlessly (expect ≈80 ms/step, `mic_buffer_ms`
≈ one frame, `queued_frames` 0).

The `stats` event carries the diagnostics for "not hearing you" vs "hearing
you but rambling": `mic_peak`, `mic_active_pct`, `mic_buffer_ms` (how far
behind real time the model runs), `queued_frames` (agent audio not yet
played). Rust logs the whole payload under `target=personaplex`.

**Headphones.** Apple's Voice Processing echo cancellation (the Speakers
setting) suppresses the mic while the speaker plays, and PersonaPlex plays
almost continuously — so on speakers it rarely hears the user. Headphones with
echo cancellation off is the setup that works.

## Microphone selection

`echo-scribe-personaplex devices` prints CoreAudio input devices as JSON
(`uid`, `name`, `input_channels`, `is_default`); Tucky's
`personaplex_list_input_devices` runs it (no model load, ~100 ms). `chat
--input-device UID_OR_NAME` pins the capture device: the patch adds
`FullDuplexAudioIO.Configuration.inputDeviceID`, set on the input unit with
`kAudioOutputUnitProperty_CurrentDevice` before formats are read, and
`currentInputDeviceID()` reads back what is really live — the `ready` event
carries that name as `mic`, and the page shows "Listening on …". If the pinned
device refuses to start the sidecar retries with the system default and logs a
warning. The picker defaults to "Same as Dictation" (the name stored by
Settings → Dictation), then "System default", then the enumerated devices by
UID. With the Speakers setting (Voice Processing) the pin goes to the AUVoiceIO
unit; verify on the page which mic is reported live.

## What the agent knows (briefing)

PersonaPlex has no text channel during a conversation; the persona prompt is
prefilled once. `personaplex_build_briefing` assembles a budgeted snapshot
(`src-tauri/src/personaplex/briefing.rs`): focus-query captures (FTS + the
chat's chunk ranking) → latest daily recap → open tasks → recent meeting
summaries → projects → people, each with per-item caps, dropped greedily when
the character budget runs out. Optional `condense` rewrites it into prose with
the local Gemma. The page shows the text (editable) and appends it to the
persona at start; `compose_prompt` flattens both to one line because newlines
are not tokenizer pieces. Every briefing token is one frame of the model's
~3000-frame rolling context, hence the size presets and the >600-token
warning.

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
