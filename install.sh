#!/usr/bin/env bash
set -euo pipefail

REPO="desduvauchelle/echo-scribe"
APP_BUNDLE="Echo Scribe.app"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"

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

# Detect architecture — Echo Scribe ships Apple Silicon only.
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ASSET="EchoScribe-aarch64.tar.gz"
elif [[ "$ARCH" == "x86_64" ]]; then
  echo "Error: Echo Scribe is Apple Silicon only — Intel Macs are not supported." >&2
  exit 1
else
  echo "Error: Unsupported architecture: $ARCH" >&2
  exit 1
fi

echo "Installing Echo Scribe..."

if [[ ! -d "$INSTALL_DIR" && -w "$(dirname "$INSTALL_DIR")" ]]; then
  mkdir -p "$INSTALL_DIR"
fi

INSTALL_PREFIX=()
if [[ ! -w "$INSTALL_DIR" ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Error: $INSTALL_DIR is not writable and sudo is not available." >&2
    exit 1
  fi
  echo "Administrator permission is required to install to $INSTALL_DIR."
  sudo -v
  INSTALL_PREFIX=(sudo)
fi

run_install() {
  if (( ${#INSTALL_PREFIX[@]} )); then
    "${INSTALL_PREFIX[@]}" "$@"
  else
    "$@"
  fi
}

run_install mkdir -p "$INSTALL_DIR"

# Download to a temp dir (cleaned up on exit)
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DOWNLOAD_URL="${DOWNLOAD_URL:-https://github.com/${REPO}/releases/latest/download/${ASSET}}"
echo "Downloading $ASSET..."
curl -fsSL "$DOWNLOAD_URL" -o "$WORK_DIR/$ASSET"

# Quit any running instance
if [[ "${SKIP_STOP:-0}" != "1" ]]; then
  echo "Stopping Echo Scribe if running..."
  osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null || true
  pkill -f "Echo Scribe" 2>/dev/null || true
  sleep 1
fi

# Remove old installation
if [[ -d "$INSTALL_DIR/$APP_BUNDLE" ]]; then
  echo "Removing old installation..."
  run_install rm -rf "$INSTALL_DIR/$APP_BUNDLE"
fi

# Extract
echo "Extracting archive..."
tar -xzf "$WORK_DIR/$ASSET" -C "$WORK_DIR/"
APP_SRC=$(find "$WORK_DIR" -maxdepth 2 -name "Echo Scribe.app" -type d | head -1)
if [[ -z "$APP_SRC" ]]; then
  echo "Error: Echo Scribe.app not found in archive." >&2
  exit 1
fi
echo "Installing to $INSTALL_DIR/..."
run_install cp -R "$APP_SRC" "$INSTALL_DIR/"

# Strip quarantine so Gatekeeper doesn't block the unsigned app
run_install xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_BUNDLE" 2>/dev/null || true

# Launch
if [[ "${SKIP_LAUNCH:-0}" != "1" ]]; then
  open "$INSTALL_DIR/$APP_BUNDLE"
fi

echo ""
echo "Echo Scribe installed — you can find it in $INSTALL_DIR."
