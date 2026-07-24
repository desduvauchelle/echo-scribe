# Echo Scribe — Distribution Design

**Date:** 2026-05-02  
**Scope:** Unsigned macOS app distribution via curl install script + GitHub Releases + GitHub Actions CI

## Context

Echo Scribe is a Tauri (Rust + React) app with no Apple Developer account, so no code signing or notarization. macOS Gatekeeper blocks unsigned apps unless the quarantine extended attribute is removed. The distribution system handles this automatically so users never see the "developer cannot be verified" dialog.

**Target audience:** Non-technical macOS users who can follow "open Terminal and paste this" instructions.

## Architecture

Three components:

1. **GitHub Releases** — Binary distribution host. Each release contains two `.tar.gz` archives, one per CPU architecture. Archives contain `Echo Scribe.app/` at the root.
2. **`install.sh`** — Shell script at the repo root, hosted via GitHub's raw URL. Single command for users.
3. **`.github/workflows/release.yml`** — Builds both architectures on tag push and uploads assets to the GitHub Release.

## Release Assets

Each GitHub Release provides:
- `EchoScribe-aarch64.tar.gz` — Apple Silicon build
- `EchoScribe-x86_64.tar.gz` — Intel build

Created by:
```bash
tar -czf EchoScribe-{arch}.tar.gz -C src-tauri/target/release/bundle/macos "Echo Scribe.app"
```

## install.sh

Lives at repo root. User-facing install command:
```bash
curl -fsSL https://raw.githubusercontent.com/desduvauchelle/echo-scribe/main/install.sh | bash
```

Script logic (in order):
1. Bail with a clear message if not macOS
2. Detect arch: `uname -m` → `arm64` → `aarch64`, `x86_64` stays as-is
3. Fetch latest release tag from GitHub API (`/repos/desduvauchelle/echo-scribe/releases/latest`)
4. Download `EchoScribe-{arch}.tar.gz` from the release assets URL
5. Quit any running instance (`osascript` + `pkill -f "Echo Scribe"`)
6. Remove old `/Applications/Echo Scribe.app` if present
7. Extract archive to `/Applications/`
8. Strip quarantine: `xattr -dr com.apple.quarantine "/Applications/Echo Scribe.app"`
9. Launch the app: `open "/Applications/Echo Scribe.app"`
10. Print: "Echo Scribe installed — you can find it in your Applications folder."

Error handling: any failure prints a clear message and exits non-zero. No silent failures. `curl` uses `-fsSL` (fail on HTTP errors, silent, follow redirects).

## GitHub Actions Workflow

File: `.github/workflows/release.yml`

Trigger: `push` of tags matching `v*.*.*`

Two jobs in a matrix:
| Runner | Arch |
|---|---|
| `macos-latest` | `aarch64` |
| `macos-13` | `x86_64` |

Each job:
1. Checkout repo
2. Install Bun (via `oven-sh/setup-bun`)
3. Install Rust stable (via `dtolnay/rust-toolchain`)
4. Install Node deps (`bun install`) — picks up `@tauri-apps/cli` from devDependencies
6. Build: `bun tauri build --bundles app`
7. Package: `tar -czf EchoScribe-{arch}.tar.gz -C src-tauri/target/release/bundle/macos "Echo Scribe.app"`
8. Upload asset to the triggering release (using `softprops/action-gh-release`)

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no secrets to configure.

## Release Workflow (for maintainer)

```bash
# Bump version in src-tauri/tauri.conf.json and src-tauri/Cargo.toml first, then:
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions builds both arches and attaches assets to the release. Users who re-run the install command get the latest version.

## Update Flow for Users

Re-running the install command installs the latest release. The script always fetches the latest tag from the GitHub API, so no version pinning needed on the user side.

## Out of Scope

- Auto-update within the app (can be added later via `tauri-plugin-updater`)
- Homebrew Cask (can be added later once the release infra is stable)
- Windows / Linux distribution
- Code signing or notarization
