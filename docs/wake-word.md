# Wake-word listening

Settings → Tucky command → **Listen for “Tucky”** enables local standby
listening. It is off by default and remembers the user's choice. The menu bar
shows status and offers a pause/enable action.

Say “Hey Tucky, create a task to review the proposal,” or another supported
Tucky command. “Tucky” without “Hey” still works. The recording cue acknowledges the wake; a 1.2-second pause ends the
request. Escape cancels capture, and pressing a dictation/edit hotkey takes
priority. No speech after the wake times out after five seconds. Requests have
a thirty-second limit. Unsupported requests show a message instead of pasting.

On wake, a compact **“I’m listening…”** window appears to the left of the pet,
in the same place as dictation status, with a live microphone meter and Cancel
button. At the screen's left edge it fits on the pet's right. It changes to
**“Working on your request…”** while transcribing; the existing action or task
confirmation supplies the result. With the pet hidden, the standalone pill
appears at bottom center, shows the listening label, and keeps its waveform and Cancel control. Standby
alone does not display this request bubble.

Say “goodbye,” “never mind,” “go away,” “stop listening,” “cancel that,” or a
similar supported dismissal to discard the active request or hands-free
dictation. Recognition happens after the normal pause and transcription, before
command routing or pasting. “Actually never mind” can retract a preceding
request. Literal requests such as “create a task called Goodbye” are preserved.
Escape and Cancel discard capture immediately while listening. Dismissal returns
to wake-word standby; it does not turn off the opt-in wake setting.

- **Create a task:** “Hey Tucky, create a task to review the proposal.” Uses
  the existing filing flow and preserves the auto-file/review setting.
- **Dictate into the current text field:** “Hey Tucky, start dictating.” Wait
  for the new recording cue, then speak. This is a separate recording: the
  start command is never pasted. Two seconds of silence finishes it; Escape
  cancels. No speech within ten seconds cancels, and continuous speech has a
  two-minute limit. The original app and text-field target are retained.
- **Focus an open app/window:** “Hey Tucky, focus on Safari,” or “Hey Tucky,
  switch to Roadmap in TextEdit.” A window title must match uniquely. Ambiguous
  matches ask for a more specific name. Specific windows require Accessibility
  permission; success is reported only after macOS focus is verified.

- **Recenter the standalone pill:** “Tucky, recenter yourself.” With the pet
  hidden, moves the pill to the bottom center of its current display, above the
  Dock. If its display is unavailable, uses the primary display. The pet's
  position is preserved.

These basic commands have deterministic local routes. Other commands still use
the existing classifier. Wake listening resumes after the action finishes.

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
- The selected speech model transcribes the request. A strict whole-word transcript check
  accepts Tucky/Tuckey/Tuckie/Tuki and strips preceding audio. It does not use
  ordinary dictation's trigger-recovery shortcuts. Subsequent mentions of
  Tucky inside the request remain intact.
- `Action::WakeCommand` uses the existing bookmark/action/task/project route,
  with an explicit handoff for starting a new dictation recording.
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
  Pass `--model whisper-turbo` to test that installed model instead. The new
  “Hey Tucky” fixtures check task/dictation/window intent as well as the gate.
- `check_window_focus` exercises real native app/window focusing for a supplied
  name. It needs its own Accessibility grant to inspect individual windows;
  a standalone executable does not inherit the installed app's grant.
- `e2e/wake-word.spec.ts` exercises the actual frontend with mocked native
  messages: opt-in, status changes, pause, failure recovery, and narrow layout.

## Original verification (2026-09-23)

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

## Hands-free command verification (2026-10-02)

- New routing, negative-intent, task-body preservation, endpoint timeout,
  cancellation, and window-match checks pass. Existing wake checks also pass.
- Frontend build and all three focused browser checks pass. Settings checked at
  720 px width; these browser checks mock native IPC.
- Whisper Turbo recognizes and routes all nine new “Hey Tucky” fixtures
  (three commands, three voices). The expanded full acoustic run is 20/21:
  Karen's older “Tucky save a task…” fixture becomes “Tucky Saver task…”, so
  deterministic task routing is not confirmed for that sample.
- Parakeet still mishears several fixtures, including one “start” as “stop”.
  The trigger gate remains strict; ordinary words such as “Keep” are not added
  as wake-name aliases to conceal those failures.
- Native app focusing succeeded for TextEdit. Specific-window native testing
  is blocked by the diagnostic executable's missing Accessibility permission.
- Full Rust run: 880 passed, 12 ignored, one unrelated existing failure in
  `asr_lab::tests::lab_registry_does_not_change_dictation_models`, which expects
  Whisper Turbo to be absent despite the debug model registry including it.
  A subsequently added negative-command regression also passes.
- Real microphone, user voice, and installed end-to-end dictation/task/window
  flows remain acceptance checks; synthetic audio does not prove these.
- Rebuilt and installed `/Applications/Tucky.app`; strict code-signature checks
  passed and installed app/worker hashes match the build. Native Settings
  reached “Listening for Tucky” on the system-default microphone, then
  “Wake word is off” after restoring the original off setting. This confirms
  microphone/listener startup, not recognition of the user's spoken commands.
  The offline release build used the existing cached runtime via `ORT_LIB_PATH`.

### Listening bubble verification

- The placement regression failed on the previous above-Focus layout, and the
  dismissal regression failed on “Hey Tucky, goodbye.” Both now pass. All 10
  wake lifecycle/transcript checks pass, including dismissal variants and
  preservation of literal task titles and mentions of Tucky in dictation.
- The new browser regression first failed on the old generic “Recording” label.
  All 17 speech-bubble, wake-settings, and voice-paste browser checks now pass,
  including the listening label, microphone meter, Cancel event, processing
  transition, and standalone fallback. These checks mock native IPC.
- All 10 notice-column layout checks and 9 overlay checks pass. The wake bubble
  shares dictation's placement beside the pet without moving Focus.
  All 8 focused pet-persistence and recording-feedback checks also pass.
- Actual spoken activation, native bubble placement, and clicking Cancel during
  a live wake request still need acceptance on the installed app.
- Rebuilt and reinstalled the listening-bubble update. The installed app passes
  strict signature verification; app and wake-worker hashes match the build,
  and both processes are running from `/Applications/Tucky.app`. The current
  saved wake setting is enabled and was preserved during this installation.
