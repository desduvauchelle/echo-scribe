# Recording walkthroughs into fix prompts

Open a recording from Dashboard → Recordings and select **Create fix prompt**.
Record the microphone while explaining what should change and what should stay.
Include the whole browser window and address bar if the page URL matters.

Tucky uses the downloaded speech model to produce timed narration and the
downloaded local language model to organize it into fix, change, preserve, and
clarification findings. No cloud AI, browser extension, or website access is used.
The language model sees text only: it cannot verify a visual defect or infer its
root cause. The receiving coding agent should inspect the included images.

Each finding has source narration, requested result, uncertainty, an optional
page/URL field, and one or two full-frame screenshots. Initial screenshots use
the start and end of the referenced narration. Recent recorded pointer positions
suggest a target; they are not verified element boundaries. Change the screenshot
time and click the image (or enter percentage coordinates) to correct its marker.
Existing pixelation masks are covered with solid rectangles in the output.
After reopening a saved bundle, recapture a screenshot before changing its marker.

**Save & copy prompt** saves the edited bundle and copies its Markdown text.
**Open prompt & images** reveals `prompt.md` beside the actual JPG attachments.
Paste the text into the coding agent and attach the JPGs from this folder. Text
clipboard copying does not attach images. Markdown image paths are relative, so
the folder can be moved as a unit.

Generation saves the first result automatically. Review edits show an unsaved
indicator until saved. Closing and reopening the panel keeps the in-progress
session; restarting the app reloads the most recently saved bundle. Each save
creates a version beneath `<recording-id>.fix-prompts` in the recordings folder.
Deleting the recording also deletes these managed bundles; copies made elsewhere
are unaffected. There is no automatic seven-day deletion.

Long narration is processed in bounded batches without truncating the transcript.
Review findings at batch boundaries for duplication or split context. The complete
transcript is included for reference. No URL extraction or OCR is performed: when
the URL is absent, the handoff asks the receiving agent to read the address bar if
visible and avoid inventing missing locations.

## Verification

- `bun test tests/recordingFeedback.test.ts`: pointer alignment and privacy regions.
- `cargo test --offline --lib recording_feedback`: source references and atomic bundles.
- Optional local-model smoke test (uses already downloaded models only):
  `cargo test --offline --lib recording_feedback::tests::local_model_walkthrough -- --ignored --nocapture`.
  Set `TUCKY_FEEDBACK_TEST_WAV` to a synthetic 16 kHz mono WAV to also exercise ASR.
- The browser review flow can be checked with the existing Tauri IPC mock and a
  local MP4 fixture. Media must support byte-range requests; failed seeking is
  rejected rather than silently attaching the first frame.
