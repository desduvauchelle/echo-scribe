#!/usr/bin/env bash
set -euo pipefail

REPO="desduvauchelle/echo-scribe"
APP_BUNDLE="Echo Scribe.app"

# Must be macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: Echo Scribe only supports macOS." >&2
  exit 1
fi

for tool in curl tar osascript pkill xattr open; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: required macOS tool '$tool' was not found." >&2
    exit 1
  fi
done

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

INSTALL_PREFIX=()
if [[ ! -w "/Applications" ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Error: /Applications is not writable and sudo is not available." >&2
    exit 1
  fi
  echo "Administrator permission is required to install to /Applications."
  sudo -v
  INSTALL_PREFIX=(sudo)
fi

# Download to a temp dir (cleaned up on exit)
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
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
  "${INSTALL_PREFIX[@]}" rm -rf "/Applications/$APP_BUNDLE"
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
"${INSTALL_PREFIX[@]}" cp -R "$APP_SRC" /Applications/

# Strip quarantine so Gatekeeper doesn't block the unsigned app
"${INSTALL_PREFIX[@]}" xattr -dr com.apple.quarantine "/Applications/$APP_BUNDLE" 2>/dev/null || true

# Launch
open "/Applications/$APP_BUNDLE"

echo ""
echo "Echo Scribe installed — you can find it in your Applications folder."
