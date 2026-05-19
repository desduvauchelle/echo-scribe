#!/usr/bin/env bash
set -euo pipefail

REPO="desduvauchelle/echo-scribe"
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
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")

if [[ -z "$LATEST" ]]; then
  echo "Error: Could not fetch latest release. Check your internet connection." >&2
  exit 1
fi

echo "Latest version: $LATEST"

# Download to a temp dir (cleaned up on exit)
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${ASSET}"
echo "Downloading $ASSET..."
curl -fsSL "$DOWNLOAD_URL" -o "$WORK_DIR/$ASSET"

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
echo "Extracting archive..."
tar -xzf "$WORK_DIR/$ASSET" -C "$WORK_DIR/"
APP_SRC=$(find "$WORK_DIR" -maxdepth 2 -name "Echo Scribe.app" -type d | head -1)
if [[ -z "$APP_SRC" ]]; then
  echo "Error: Echo Scribe.app not found in archive." >&2
  exit 1
fi
echo "Installing to /Applications/..."
if [[ ! -w "/Applications" ]]; then
  echo "Error: /Applications is not writable. Try running with sudo." >&2
  exit 1
fi
cp -R "$APP_SRC" /Applications/

# Strip quarantine so Gatekeeper doesn't block the unsigned app
xattr -dr com.apple.quarantine "/Applications/$APP_BUNDLE" 2>/dev/null || true

# Launch
open "/Applications/$APP_BUNDLE"

echo ""
echo "Echo Scribe installed — you can find it in your Applications folder."
