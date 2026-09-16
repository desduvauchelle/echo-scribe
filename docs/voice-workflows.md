# Bookmark voice workflows

Settings → Tucky command → Custom workflows lets you add, edit, disable, or
remove bookmark workflows. Save workflows applies the whole list. Each workflow
has a trigger phrase and a full HTTP(S) URL. An empty list is the default.

Example: save `Pipe drive new authors` with the exact URL of your Pipedrive page.
With app actions and trigger-word routing enabled, use the voice-typing hotkey
and say `Tucky, Pipe drive new authors`. Use your configured command prefix if
it differs from Tucky. Enter the phrase as it is transcribed; `Pipedrive` and
`Pipe drive` are distinct phrases.

The coordinator checks enabled bookmarks after its existing command-mode gate
and before LLM classification. Matching uses the whole phrase, ignoring case,
spacing, and punctuation. A match opens the URL with the existing macOS URL
launcher and consumes the command, without asking an LLM. Failed bookmark opens
show a toast rather than pasting the command. Unmatched commands retain their
existing routing. URLs require HTTP(S) and cannot contain embedded credentials;
normalized duplicate phrases are rejected, including disabled entries.

Persistence uses the existing local settings store (`voice_workflows_v1`). A
failed save restores the previous in-memory setting and leaves the UI draft
available for retry. Page navigation discards unsaved edits.

## Verification (2026-09-14)

- `bun run build`: passed.
- `cargo test --lib voice_workflows --offline`: 3 checks passed.
- `cargo test --lib llm::action_launcher:: --offline`: 13 surrounding checks passed.
- Browser preview with mocked Tauri IPC: add/save, settings navigation, disable,
  remove/save, and simulated failed save retaining the draft passed.
- Screenshot: `output/playwright/voice-workflows.png`.
- Not yet verified: installed Tucky, real microphone recognition, native settings
  persistence across app restarts, or the actual external bookmark opening.
