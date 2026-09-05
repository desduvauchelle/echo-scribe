#!/usr/bin/env bash
set -euo pipefail

REPO="desduvauchelle/echo-scribe"
APP_BUNDLE="Tucky.app"
LEGACY_BUNDLE="Echo Scribe.app"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"

# Must be macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: Tucky only supports macOS." >&2
  exit 1
fi

for tool in curl tar osascript pkill xattr open; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: required macOS tool '$tool' was not found." >&2
    exit 1
  fi
done

# Detect architecture — Tucky ships Apple Silicon only.
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ASSET="Tucky-aarch64.tar.gz"
elif [[ "$ARCH" == "x86_64" ]]; then
  echo "Error: Tucky is Apple Silicon only — Intel Macs are not supported." >&2
  exit 1
else
  echo "Error: Unsupported architecture: $ARCH" >&2
  exit 1
fi

echo "Installing Tucky..."

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

if [[ -n "${LOCAL_APP_BUNDLE:-}" ]]; then
  APP_SRC="$LOCAL_APP_BUNDLE"
else
  DOWNLOAD_URL="${DOWNLOAD_URL:-https://github.com/${REPO}/releases/latest/download/${ASSET}}"
  echo "Downloading $ASSET..."
  curl -fsSL "$DOWNLOAD_URL" -o "$WORK_DIR/$ASSET"
  echo "Extracting archive..."
  tar -xzf "$WORK_DIR/$ASSET" -C "$WORK_DIR/"
  APP_SRC="$WORK_DIR/$APP_BUNDLE"
  # Old releases remain installable through a supplied DOWNLOAD_URL.
  if [[ ! -d "$APP_SRC" ]]; then APP_SRC="$WORK_DIR/$LEGACY_BUNDLE"; fi
fi

# Validate and stage before touching either existing installation.
if [[ ! -x "$APP_SRC/Contents/MacOS/echo-scribe" || ! -f "$APP_SRC/Contents/Info.plist" ]]; then
  echo "Error: archive does not contain a valid Tucky app bundle." >&2
  exit 1
fi
STAGED="$(run_install mktemp -d "$INSTALL_DIR/.tucky-install.XXXXXX")"
run_install cp -R "$APP_SRC" "$STAGED/$APP_BUNDLE"

# Quit any running instance
if [[ "${SKIP_STOP:-0}" != "1" ]]; then
  echo "Stopping Tucky if running..."
  # Address only an already-running app; do not launch an absent old name.
  osascript -e 'if application id "com.echoscribe.app" is running then tell application id "com.echoscribe.app" to quit' 2>/dev/null || true
  for name in "$APP_BUNDLE" "$LEGACY_BUNDLE"; do
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < <(ps -axo pid=,comm= | awk -v exe="$INSTALL_DIR/$name/Contents/MacOS/echo-scribe" '
      { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if ($0 == exe) print pid }')
  done
  sleep 1
fi

# Keep the previous bundle recoverable. Data and settings are never moved.
BACKUP="$(run_install mktemp -d "$INSTALL_DIR/.tucky-backup.XXXXXX")"
for name in "$APP_BUNDLE" "$LEGACY_BUNDLE"; do
  if [[ -e "$INSTALL_DIR/$name" || -L "$INSTALL_DIR/$name" ]]; then
    run_install mv "$INSTALL_DIR/$name" "$BACKUP/$name"
  fi
done
if ! run_install mv "$STAGED/$APP_BUNDLE" "$INSTALL_DIR/$APP_BUNDLE"; then
  for name in "$APP_BUNDLE" "$LEGACY_BUNDLE"; do
    if [[ -e "$BACKUP/$name" || -L "$BACKUP/$name" ]]; then
      run_install mv "$BACKUP/$name" "$INSTALL_DIR/$name"
    fi
  done
  exit 1
fi
run_install rmdir "$STAGED"
# Preserve existing MCP commands and login items that use the old app path.
run_install ln -s "$APP_BUNDLE" "$INSTALL_DIR/$LEGACY_BUNDLE"
echo "Previous installation backup: $BACKUP"

# Strip quarantine so Gatekeeper doesn't block the unsigned app
run_install xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_BUNDLE" 2>/dev/null || true

# Launch
if [[ "${SKIP_LAUNCH:-0}" != "1" ]]; then
  open "$INSTALL_DIR/$APP_BUNDLE"
fi

echo ""
echo "Tucky installed — you can find it in $INSTALL_DIR."
