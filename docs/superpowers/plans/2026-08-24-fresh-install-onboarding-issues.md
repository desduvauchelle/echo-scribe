# Fresh-install onboarding — issue list (2026-08-24)

Source: a real first-install on another Mac (v1.0.11 via install.sh) where (1) the app
never appeared in System Settings → Privacy & Security → Accessibility when onboarding
sent the user there, (2) dictation never worked, (3) the speech model was downloaded but
the AI model apparently wasn't, and nothing said so.

All findings verified against current `main` (onboarding/permission code is behaviorally
identical to v1.0.11 — only i18n string extraction touched it since).

Reproduce with the fresh-install simulator: `scripts/build-fresh-sim.sh` (see §Simulator).

---

## P0 — directly explains the reported install

### 1. Settings pane is opened in the same tick as the async permission prompt → app missing from the list
`src/views/Onboarding.tsx:216-230` (Accessibility), `:193-206` (Screen Recording), same
pattern in `src/components/PermissionsSection.tsx:131-149`.

`AXIsProcessTrustedWithOptions(prompt: true)` registers the app with `tccd`
**asynchronously** and always returns `false` on a fresh Mac — so the "fallback"
`openAccessibilitySettings()` runs immediately, every time. System Settings then renders
a snapshot of the Accessibility list from before tccd wrote the row → **"Echo Scribe" is
not in the list**, and the real macOS dialog (which has its own "Open System Settings"
button) is buried behind the Settings window. The comment at `Onboarding.tsx:209-215`
says exactly this and says we should NOT open Settings ourselves — the code below it
does it anyway.

Fix: on first grant click, fire the prompt and do **not** open Settings; show "look for
the macOS dialog" + a secondary "Open System Settings" button for retries.

### 2. Missing Accessibility ⇒ dictation hotkey is completely dead, with zero feedback
`src-tauri/src/input/hotkeys.rs:449-453` — `CGEventTapCreate` returns NULL without
Accessibility; the listener thread logs one line and exits. No event, no toast, no tray
badge. Pressing the hotkey does nothing, silently. Also: the tap is only created at
`start_pipeline`, so a grant made *after* launch never re-arms it (relaunch required,
nothing says so).

Fix: emit a UI event on tap-creation failure; re-try tap creation when the permission
poll flips to granted; tell the user to relaunch if re-arm isn't possible.

### 3. Missing LLM ⇒ broad silent degradation, and onboarding lets it happen invisibly
- Onboarding gate `Onboarding.tsx:172` ignores the LLM (by design), and a **failed Gemma
  download still leaves "Start Echo Scribe" enabled** with only a small inline error on
  the card. Startup re-check `src/App.tsx:308-322` never re-raises a missing LLM.
- With no LLM: trigger-word dictation ("echo open Slack") **pastes the literal text**
  after a "Processing…" spinner — `src-tauri/src/coordinator.rs:1319-1321` swallows
  `NoActiveModel` with a `warn!`; log-captures file as untagged notes
  (`coordinator.rs:602-611`); meeting summaries complete blank (`meeting/mod.rs:881-915`).
- The toast written for exactly this ("Local AI not configured…", `src/App.tsx:116-122`)
  is **dead code**: the emit at `coordinator.rs:681-685` never includes the `error` field
  the frontend matches on.
- No banner anywhere shows model status (`PermissionWarningBanner` checks permissions only).

Fix: make the dead toast fire; add LLM state to the warning banner + startup check; make
the onboarding LLM section an explicit choice ("Skip — AI features stay off") instead of
a silently ignorable card.

### 4. Screen Recording "grant" can never turn green in-session
`CGPreflightScreenCaptureAccess` caches its answer per process
(`src-tauri/src/permissions.rs:87-89`); after the user flips the toggle, onboarding's
1.5 s poll (`Onboarding.tsx:149-166`) reports "Not granted" until app relaunch — and
onboarding never says "relaunch". (`screenrec/mod.rs:90-93` knows this; onboarding
doesn't.) Also the processes that actually capture are the sidecars, which never run
during onboarding (`SetupWindow.tsx:106-154` defers enumeration deliberately).

Fix: preflight from a short-lived child process (fresh cache) or detect the
grant-but-cached state and show the "quit and reopen" hint.

## P1 — likely contributors / adjacent landmines

### 5. Ad-hoc-signed release + quarantine ⇒ app translocation ⇒ TCC grants against a throwaway path
`release.yml` builds with `APPLE_SIGNING_IDENTITY: "-"`. `install.sh` strips quarantine,
but anyone who downloads the tarball manually and drags to /Applications runs translocated
from `/private/var/folders/.../AppTranslocation/...` — permission grants don't stick and
the app can appear missing/duplicated in the Privacy lists. Self-update
(`updater.rs:194-198`) also replaces the bundle with a new cdhash every time, re-rolling
TCC identity.

Fix (cheap): first-run self-check — if `current_exe()` contains `/AppTranslocation/`,
show "move the app to Applications / reinstall via the install command". Real fix:
Developer ID + notarization.

### 6. Model downloads: no timeout, no retry, no resume, no disk check, no integrity check
`src-tauri/src/asr/downloader.rs:171-240`, `src-tauri/src/llm/downloader.rs:156-222`:
- reqwest client has **no timeout** → a stalled connection = progress bar frozen forever.
- No retry/resume; a failed 3.46 GB Gemma restarts from byte 0.
- No disk-space preflight before committing to ~4.1 GB.
- Every manifest sha256 is `"PLACEHOLDER"` → verification skipped; 0-byte/truncated
  files pass `is_file()` and are treated as downloaded forever (`asr/downloader.rs:114`).
- A partial Parakeet is invisible: no `incomplete` flag on `SpeechModelStatus`
  (unlike LLM), and no Delete button until `downloaded == true`.

### 7. v1.0.11 release ships no Intel macOS build
Latest GitHub release assets: `EchoScribe-aarch64.tar.gz` + Windows exe only.
`install.sh` explicitly rejects x86_64. If the target Mac is Intel, install fails
outright. Either restore the Intel build in `release.yml` or make install.sh say
"Apple Silicon only" clearly.

### 8. Error copy points to a Settings page that doesn't exist
Several "no model" messages say **"Settings → AI Model"**; the nav item is labelled
**"Language Model"** (`src/locales/en/settings.json:28`). Also onboarding's promise
"Log-capture will show a friendly notice until you pick a model" is false (see issue 3).

## P2 — noted while auditing

- "Skip setup for now" (`Onboarding.tsx:435-447`) completes onboarding with zero models/
  permissions and **doesn't start the pipeline**, so even granting everything a minute
  later leaves dictation inert for the session.
- Sync TCC commands (`permissions_status`, prompts) run on the main thread and three
  components poll them every 1.5–3 s — UI stall hazard.
- `request_microphone_access` has no timeout if AVFoundation never invokes the block.
- Embedding model (`embeddinggemma`) has a download command but **no UI call sites** —
  unreachable by users.
- e2e onboarding spec never clicks "Grant access", so the prompt→Settings ordering baked
  into issue 1 has no coverage.

---

## Simulator (how to reproduce without touching the real install)

`scripts/build-fresh-sim.sh` builds + installs **/Applications/Echo Scribe Fresh.app**:
- identifier `com.echoscribe.freshsim` → its own TCC identity (macOS has never seen it:
  every permission prompt/list behavior is exactly first-install).
- all data under `~/Library/Application Support/EchoScribeFreshSim` (+ freshsim
  settings store, logs, `~/EchoScribeFreshSim`), via the compile-time knobs
  `ECHO_SCRIBE_DATA_FOLDER` / `ECHO_SCRIBE_BUNDLE_ID` (`src-tauri/src/lib.rs`).
- keychain entry, tccutil targets, uninstall paths follow the knob; **self-update is
  hard-disabled** in variant builds so it can never overwrite the real app.

`scripts/reset-fresh-sim.sh` returns the sim to never-launched state (wipes sim data +
sim TCC grants only).

Caveats: quit the real Echo Scribe first (shared CGEventTap hotkey + tray); don't
connect Drive from the sim unless testing it (separate keychain entry, safe, but
pointless); the sim's Info.plist prose still says "Echo Scribe" in system prompts.
