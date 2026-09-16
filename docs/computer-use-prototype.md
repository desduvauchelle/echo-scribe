# Background computer use — first native slice

Status: development prototype, separate from installed Tucky and its voice/dictation path.
No AI provider, credentials, external controller dependency, or private macOS APIs.

## Acceptance criterion

Open a disposable Chrome profile, navigate to Google through the address bar, enter
`Word` into the page's search field, submit, and verify a rendered results page.
No CDP, Playwright, browser DOM, HTTP search request, or preconstructed search URL is
used by this test. The driver is deterministic Python; this is a test of native
computer-control primitives, **not yet an autonomous model-driven task**.

The report distinguishes search success from background behavior. It requires a
matching Google results URL/query, a matching window title and an external result
link in Accessibility state. Consent/CAPTCHA blocks are failures, not bypassed.
Every mutation reports foreground PID and cursor changes; a focus change stops the
session. This sampling detects changes around actions, not transient focus flashes
between samples. Human mouse movement can also make a background check fail.

## Run

```sh
swift test --package-path src-tauri/computer-use
python3 scripts/test-computer-use-google.py
bash scripts/build-computer-use.sh
open 'src-tauri/computer-use/.build/Tucky Computer Use Prototype.app'
```

In the prototype window, grant **Accessibility** to **Tucky Computer Use Prototype**
in System Settings. This is a new bundle ID; existing Tucky/Codex grants do not grant
it access. Screenshot permission is optional for the test, required for PNG evidence.
Click **Run Google test**. **Stop** terminates the driver, which shuts down the helper.
Chrome remains open for reviewing the result. Test runs create a new profile each
time, without reading your existing signed-in profile. Quit these test Chrome
instances when finished. Reports contain local page text and live only in the
private temporary directory printed in the window.

For a terminal host that already has Accessibility permission:

```sh
swift build --package-path src-tauri/computer-use
python3 scripts/computer-use-google.py --close
```

The app build uses the repository's stable local signing identity and a distinct
`com.echoscribe.computer-use-prototype` identifier. On another machine set
`TUCKY_COMPUTER_USE_SIGNING_IDENTITY` explicitly. No TCC resets, installation over
Tucky, release changes, or stored credentials are involved. The GUI driver uses
`/usr/bin/python3` (Xcode Command Line Tools prerequisite).

## Tool boundary

The executable accepts `--pid PID`, optionally `--allow-actions`. These are host
capabilities fixed at startup, not grants the model can request. Stdin/stdout is
NDJSON with one response per request; stderr contains tool names/result codes only.

```json
{"id":"1","tool":"status"}
{"id":"2","tool":"observe"}
{"id":"3","tool":"set_value","revision":"FROM_OBSERVE","element":17,"text":"Word"}
{"id":"4","tool":"stop"}
```

Tools: `status`, `observe`, `screenshot`, `click` (AXPress), `set_value`, `type`,
`key`, `scroll` (AX page action), `stop`. Keyboard keys are restricted to
`address_bar`, `select_all`, `return`, `tab`, `escape`. There is no shell tool.

- Accessibility trees are bounded (500 nodes, depth 30, three-second traversal
  budget checked between nodes) with secure field values redacted. Individual AX
  requests have a messaging timeout; slow apps can exceed the traversal budget.
- Observations issue one-use revisions expiring after eight seconds. Failed
  mutations consume their revision too, so uncertain writes are not replayed.
- Control is bound to a running PID/launch date and the selected window. Elements
  are retained AX references, checked for owner and identity before action.
- Key events use public per-PID delivery and require the selected app's focused
  window. They never activate an app, post global input, warp the cursor, or use
  the clipboard. Delivery is explicitly **unverified** until app state confirms it.
- Input yields when the user is typing in the target app. Cancellation is latched;
  the input reader can signal Stop while typing, and an Escape monitor is installed.
  Live Escape behavior needs installed-host verification. Releasing keys is paired
  with their keydown without awaiting further model work.
- Screenshots match only the selected app/window, never capture the full desktop,
  and are returned in memory. The test runner writes its final image to its private
  evidence directory if permitted.
- A 15-second client timeout terminates the helper without retrying a mutation.

## Current verification / next gate

Native builds and policy/acceptance-oracle tests are available. The initial live
Google run stopped on missing Accessibility permission, before sending UI input.
That is **not** a passed Google test or background-control proof.

After permission is granted, run the Google test and inspect report.json and the
results screenshot. Record any unsupported AX action or dropped background key.
Do not silently introduce foreground fallback just to make the test pass.

Only after this native path passes: add a bounded agent loop and explicit voice
entry point in Tucky; app/task approvals, progress, Stop, and consequential-action
confirmation belong in that integration. Compare a hosted vision model with the
existing local text model on supported AX tasks. No API calls have been made by
this prototype.

## Research basis

- [Apple AX actions](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)
- [Apple targeted input](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:))
- [Apple window capture](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
- [Claude background behavior](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)

This is original implementation code; it does not embed or broker Codex/Claude
private components and does not claim their compatibility or reliability.
