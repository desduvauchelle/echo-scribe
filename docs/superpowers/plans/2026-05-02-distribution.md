# Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a curl-based install system so non-technical macOS users can install Echo Scribe with one pasted command.

**Architecture:** GitHub Releases hosts two `.tar.gz` archives (Apple Silicon + Intel). A shell script at repo root downloads the right one, installs to `/Applications/`, and strips the quarantine attribute so Gatekeeper never blocks it. GitHub Actions builds both arches automatically on version tag push.

**Tech Stack:** Bash, GitHub Actions, Tauri (`bun tauri build --bundles app`), `softprops/action-gh-release@v2`

---

### Task 1: Write `install.sh`

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Create `install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="denisduvauchelle/echo-scribe"
APP_BUNDLE="Echo Scribe.app"

# Must be macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: Echo Scribe only supports macOS." >&2
  exit 1
fi

# Detect architecture
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ASSET="EchoScribe-aarch64.tar.gz"
elif [[ "$ARCH" == "x86_64" ]]; then
  ASSET="EchoScribe-x86_64.tar.gz"
else
  echo "Error: Unsupported architecture: $ARCH" >&2
  exit 1
fi

echo "Installing Echo Scribe..."

# Fetch latest release tag
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | sed 's/.*"tag_name": "\(.*\)".*/\1/')

if [[ -z "$LATEST" ]]; then
  echo "Error: Could not fetch latest release. Check your internet connection." >&2
  exit 1
fi

echo "Latest version: $LATEST"

# Download to a temp dir (cleaned up on exit)
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${ASSET}"
echo "Downloading $ASSET..."
curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/$ASSET"

# Quit any running instance
echo "Stopping Echo Scribe if running..."
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null || true
pkill -f "Echo Scribe" 2>/dev/null || true
sleep 1

# Remove old installation
if [[ -d "/Applications/$APP_BUNDLE" ]]; then
  echo "Removing old installation..."
  rm -rf "/Applications/$APP_BUNDLE"
fi

# Extract
echo "Installing to /Applications/..."
tar -xzf "$TMPDIR/$ASSET" -C /Applications/

# Strip quarantine so Gatekeeper doesn't block the unsigned app
xattr -dr com.apple.quarantine "/Applications/$APP_BUNDLE" 2>/dev/null || true

# Launch
open "/Applications/$APP_BUNDLE"

echo ""
echo "Echo Scribe installed — you can find it in your Applications folder."
```

- [ ] **Step 2: Make it executable and validate with shellcheck**

```bash
chmod +x install.sh
# Install shellcheck if needed: brew install shellcheck
shellcheck install.sh
```

Expected: no errors or warnings. Fix any `shellcheck` issues before continuing.

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat(distribution): add curl install script"
```

---

### Task 2: Replace `.github/workflows/release.yml`

The existing file is from the old Swift/xcodegen/Sparkle era and needs a full rewrite for Tauri.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace the workflow file**

Overwrite `.github/workflows/release.yml` with:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            arch: aarch64
          - os: macos-13
            arch: x86_64

    runs-on: ${{ matrix.os }}
    timeout-minutes: 90

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install Node dependencies
        run: bun install

      - name: Build app bundle
        run: bun tauri build --bundles app

      - name: Package
        run: |
          tar -czf "EchoScribe-${{ matrix.arch }}.tar.gz" \
            -C src-tauri/target/release/bundle/macos \
            "Echo Scribe.app"

      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          files: "EchoScribe-${{ matrix.arch }}.tar.gz"
```

- [ ] **Step 2: Verify YAML is valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" 2>/dev/null \
  || brew install python-yaml && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

Expected: no output (parses without error).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(distribution): replace legacy workflow with Tauri release CI"
```

---

### Task 3: Update `README.md`

The README still documents the old Swift/xcodegen build. Replace the tech stack, requirements, and build/install sections with Tauri-accurate content and the new install command.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README content**

Replace the entire file with:

```markdown
# Echo Scribe

A voice-first dictation app for macOS. Press a hotkey, speak, and Echo Scribe transcribes locally using Parakeet — no internet required.

---

## Install

Open Terminal (Cmd+Space, type "Terminal", press Enter) and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/denisduvauchelle/echo-scribe/main/install.sh | bash
```

The script installs the app to `/Applications/` and handles macOS security permissions automatically. To update, run the same command again.

---

## Requirements

- macOS 12 or later
- Apple Silicon (M1/M2/M3) or Intel Mac

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2 (Rust + React) |
| UI | React + TypeScript |
| Speech-to-Text | Parakeet (local, on-device) |
| LLM | Gemma 4 (local, on-device via llama.cpp) |
| Storage | SQLite |
| Build | Bun + Cargo |

---

## Design Principles

- **Local first** — no audio or text leaves your machine
- **Voice first** — the hotkey is the primary entry point
- **Minimal UI** — the interface exists to review captures, not to be a workspace

---

## Building from Source

```bash
# Prerequisites: Rust (rustup), Bun, CMake
git clone https://github.com/denisduvauchelle/echo-scribe.git
cd echo-scribe
bun install
bun tauri build --bundles app
```

The `.app` bundle lands at `src-tauri/target/release/bundle/macos/Echo Scribe.app`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for Tauri, add curl install instructions"
```
