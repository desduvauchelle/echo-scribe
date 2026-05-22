# Echo Scribe — Working Notes for Claude

## Error handling & diagnostics (required for every feature)

Build features so failures are *debuggable without a rebuild*. This is not optional polish — wire it in as you write the feature:

- **Log at every failure + key transition.** Use `tracing` (`info!`/`warn!`/`error!`) in Rust and surface sidecar failures as structured JSON events. Logs go to the daily `echo-scribe.log` (Settings → Diagnostics → open log folder; `log_dir()` in `src-tauri/src/lib.rs`). Give logs a `target:` (e.g. `target: "drive"`) so they're greppable. Log the *result* of fallible boundary ops (keychain, network, file IO, subprocess) — both success ("stored token, N chars") and failure (the error string + relevant status/body). Never log secrets/tokens (log lengths/ids instead).
- **Surface errors in the UI.** Every user-triggered action that can fail must show the actual error string to the user (toast or inline), not fail silently. The Recordings/Drive flows already return `Err(String)` to the frontend and render it — match that pattern.
- **HTTP/IPC boundaries:** check `resp.status().is_success()` before parsing, and put the response body in the error so a 401/403/quota failure reads as itself, not a generic "missing field". Same for subprocess: capture stderr and surface the structured error kind.
- **Diagnose with logs, not hypotheses.** If a bug's cause isn't provable from data in hand, add the logging that would capture it, have the user reproduce, then fix from what the logs show. Don't guess-and-rebuild in a loop.

## Build + reinstall workflow (macOS)

**Default: SKIP the TCC reset.** Most rebuilds keep the same bundle identifier + Info.plist usage descriptions + entitlements; macOS Sequoia+ then re-binds prior permission grants to the new ad-hoc-signed binary automatically. The user's stated preference for this project is "skip TCC unless I say otherwise."

**Only reset TCC when this rebuild changes anything permission-related**, e.g.:

- `src-tauri/Info.plist` — `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`, `NSAccessibilityUsageDescription`, `NSCalendarsFullAccessUsageDescription`, etc. (added, removed, or text changed).
- `src-tauri/tauri.conf.json` — `identifier` (bundle id), `macOSPrivateApi`, `entitlements` paths.
- `src-tauri/capabilities/*.json` — new windows or permission keys.
- `src-tauri/Cargo.toml` — TCC-touching deps (e.g. cpal feature flips, ScreenCaptureKit-related crates, calendar/EventKit crates).
- A new permission category needs to be re-requested (e.g. first build that adds calendar access).

Symptoms when you SHOULD HAVE reset and didn't: in-process permission prompts crash silently; the Accessibility list shows multiple stale "Echo Scribe.app" entries; the new binary thinks it has no permissions even though the System Settings toggle is on. Sidecar-specific: `stream_stopped: Failed to find any displays or windows to capture` from `echo-scribe-syscap` is the canonical Screen Recording-not-granted signal.

**Skip-TCC reinstall (default):**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

**Full TCC-reset reinstall (only when permission-related code changed, or user explicitly asks):**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
tccutil reset Microphone com.echoscribe.app
tccutil reset Accessibility com.echoscribe.app
tccutil reset ScreenCapture com.echoscribe.app
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

Things to know:

- Add `rm -rf "$HOME/Library/Application Support/EchoScribe/models"` if you also want to force a re-download of Parakeet models (e.g. you changed the model URLs). Otherwise leave the user's downloaded models alone.
- Add `rm -rf "$HOME/Library/Application Support/EchoScribe"` if you want a complete clean slate (wipes settings store too — user has to redo the hotkey choice).
- If the user explicitly says "reset TCC" / "do a full reset" → use the full sequence even if no permission code changed.

## Build commands

```bash
# Release .app bundle (what we install to /Applications/)
bun tauri build --bundles app

# Frontend-only dev (no Rust rebuild)
bun run dev

# Rust unit tests
cd src-tauri && cargo test --lib && cd ..
```

Don't run `bun tauri dev` from a subagent — it spawns a window that won't terminate cleanly.

## Release workflow (distribution)

Echo Scribe is distributed unsigned via a curl install script + GitHub Releases. Full design at `docs/superpowers/specs/2026-05-02-distribution-design.md`.

**To cut a release:**
1. Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
2. Commit the version bump
3. Tag and push:
```bash
git tag v0.x.y
git push origin v0.x.y
```
GitHub Actions (`release.yml`) builds Apple Silicon + Intel `.app` bundles and attaches them to the GitHub Release automatically. `GITHUB_TOKEN` is provided by GitHub Actions — no secrets to configure.

**User install command:**
```bash
curl -fsSL https://raw.githubusercontent.com/desduvauchelle/echo-scribe/main/install.sh | bash
```
The script detects arch, fetches the latest release from the GitHub API, downloads the matching `.tar.gz`, installs to `/Applications/`, and strips the quarantine attribute so Gatekeeper never blocks it.

## Plans + specs

Phase plans live under `docs/superpowers/plans/`. The Phase 0 plan and Phase 1 plan are the source of truth for what we've built so far. Future phases get their own plan files.

The architectural design lives at `docs/superpowers/specs/2026-05-01-tauri-rebuild-design.md`.
