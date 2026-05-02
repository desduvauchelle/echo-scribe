# Echo Scribe — Working Notes for Claude

## Build + reinstall workflow (macOS)

**Always run a TCC reset when you rebuild and replace `/Applications/Echo Scribe.app`.**

macOS TCC (Transparency, Consent, and Control) keys permission grants on the binary's code signature. Every release build produces a binary with a new ad-hoc signature, so the prior Microphone and Accessibility grants no longer apply. Symptoms when you skip the reset: in-process permission prompts crash silently, the Accessibility list shows multiple stale "Echo Scribe.app" entries, or the new binary thinks it has no permissions even though the System Settings toggle is on.

The full reset-and-reinstall sequence:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
tccutil reset Microphone com.echoscribe.app
tccutil reset Accessibility com.echoscribe.app
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

Things to know:

- Add `rm -rf "$HOME/Library/Application Support/EchoScribe/models"` if you also want to force a re-download of Parakeet models (e.g. you changed the model URLs). Otherwise leave the user's downloaded models alone.
- Add `rm -rf "$HOME/Library/Application Support/EchoScribe"` if you want a complete clean slate (wipes settings store too — user has to redo the hotkey choice).
- Bypass `tccutil` only when the user explicitly says "don't reset TCC" (sometimes useful when they want to verify in-place upgrades work without re-permissioning).

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
curl -fsSL https://raw.githubusercontent.com/denisduvauchelle/echo-scribe/main/install.sh | bash
```
The script detects arch, fetches the latest release from the GitHub API, downloads the matching `.tar.gz`, installs to `/Applications/`, and strips the quarantine attribute so Gatekeeper never blocks it.

## Plans + specs

Phase plans live under `docs/superpowers/plans/`. The Phase 0 plan and Phase 1 plan are the source of truth for what we've built so far. Future phases get their own plan files.

The architectural design lives at `docs/superpowers/specs/2026-05-01-tauri-rebuild-design.md`.
