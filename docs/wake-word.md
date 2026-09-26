# Wake-word listening

Settings → Tucky command → **Listen for “Tucky”** enables local standby
listening. It is off by default and remembers the user's choice. The menu bar
shows status and offers a pause/enable action.

Say “Tucky, save a task: review the proposal,” or another supported Tucky
command. The recording cue acknowledges the wake; a 1.2-second pause ends the
request. Escape cancels capture, and pressing a dictation/edit hotkey takes
priority. No speech after the wake times out after five seconds. Requests have
a thirty-second limit. Unsupported requests show a message instead of pasting.

Standby runs only while Tucky is open and the Mac is awake. It pauses during
dictation, command processing, file/meeting transcription, active meetings,
screen recording, and global hotkey pause. It resumes when idle. A saved input
device is respected; a missing saved device produces an error rather than
silently choosing another. With “system default,” a changed default microphone
is detected within one second. Interruptions discard the pending wake request.

## Audio and command routing

- The coordinator owns the single dictation/wake Recorder. Standby retains at
  most three seconds of microphone audio in RAM. It does not save or upload it.
- A separate `tucky-wakeword` worker runs sherpa-onnx's small English keyword
  detector. The process isolates its ONNX runtime from Parakeet's runtime.
  Model provenance, hash, original model card, and license are bundled under
  `resources/wakeword`.
- The worker is primed with silence before reporting ready. After detection,
  capture continues on the same microphone stream, preserving the pre-roll
  and immediate words after “Tucky.” The worker then exits.
- Parakeet transcribes the request. A strict whole-word transcript check
  accepts Tucky/Tuckey/Tuckie/Tuki and strips preceding audio. It does not use
  ordinary dictation's trigger-recovery shortcuts. Subsequent mentions of
  Tucky inside the request remain intact.
- `Action::WakeCommand` uses the existing bookmark/action/task/project route.
  It never reaches ordinary dictation's paste or transcript-history fallback.
  Explicit note/task requests retain the existing filing and review behavior.
- No polling timer or detector runs when disabled. Audio queues are bounded;
  slow workers, microphone errors, and missing audio stop capture and retry.
  Feature history resets at a quiet boundary after a minute, with a two-minute
  cap for continuous noise. Sleep/resume gaps restart the listener.

## Build and verification

`scripts/build-wakeword.sh` downloads a checksum-pinned model archive and builds
the separate Rust worker using its lockfile. Release builds invoke this script
automatically. For native development, run it once before enabling wake mode.
The app bundle includes the worker, model files, and notices; signing and the
existing first-launch smoke check include the worker.

- `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline` checks
  bounded audio, request boundaries, timeout, busy-state gating, and surrounding
  behavior.
- `python3 scripts/test-wakeword.py` generates local synthetic speech and
  exercises the real streaming PCM protocol. It never opens the microphone.
- Build the `check_wake_transcript` example, then pass its executable with
  `--asr` to the acoustic check to also exercise real Parakeet transcription
  and the command gate. The example never executes commands or saves history.
- `e2e/wake-word.spec.ts` exercises the actual frontend with mocked native
  messages: opt-in, status changes, pause, failure recovery, and narrow layout.

## Verified in this checkout

- Rust library tests: 795 passed, 8 ignored.
- Browser checks: 3 passed (wake-word settings and existing same-app dictation).
- Detector plus actual Parakeet/command-gate checks: 12 passed, including six
  positive requests across Samantha, Daniel, and Karen synthetic voices.
- A 70-second real-time silent-PCM run produced no wake events. Detector RSS
  stayed near 59 MiB; CPU time was about 1.9 seconds over the first 60 seconds,
  including startup. This measures the worker, not total app/battery use.
- macOS bundle built and signed; the detector executed from inside the bundle.
- Installed `/Applications/Tucky.app`, preserving a previous-bundle backup.
  Installed app/worker hashes match the built artifacts; strict signature
  verification passed.
- Native Settings reached “Listening for Tucky” with the selected microphone,
  then “Wake word is off” on disable. Left disabled after verification.

Synthetic speech is not live spoken-command acceptance. The current test set covers
three English voices, immediate speech, silence, and several negative phrases.
“Kentucky” is a known first-stage acoustic candidate; the transcript gate rejects
it, so it may show the listening cue but does not authorize a command. Real voice,
room noise, speaker playback, Bluetooth device changes, pause during live dictation,
and battery impact still need acceptance on the installed app. Audio from another
person or a speaker saying the actual wake word can activate it; this is not
speaker identification.
