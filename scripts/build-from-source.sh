#!/usr/bin/env bash
set -euo pipefail

# Builds Tucky from source and installs it to /Applications.
# macOS only (Swift sidecars + ScreenCaptureKit + TCC).

[[ "$(uname -s)" == "Darwin" ]] || { echo "Tucky builds on macOS only." >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Tucky"
BUNDLE_ID="com.echoscribe.app"
BUILT_APP="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

confirm() { read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]; }

ensure_brew() {
  command -v brew >/dev/null 2>&1 && return
  echo "Homebrew is required to install the missing package."
  confirm "Install Homebrew now?" || { echo "Install it from https://brew.sh then re-run." >&2; exit 1; }
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"; fi
}

# --- prerequisites -----------------------------------------------------------

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are not installed."
  confirm "Run 'xcode-select --install' now?" && xcode-select --install || true
  echo "Finish the Apple installer dialog, then re-run this script." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust (cargo) was not found."
  confirm "Install Rust via rustup?" || { echo "Install it from https://rustup.rs then re-run." >&2; exit 1; }
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "CMake was not found."
  ensure_brew
  brew install cmake
fi

if command -v bun >/dev/null 2>&1; then
  PM=bun
elif command -v npm >/dev/null 2>&1; then
  PM=npm
else
  echo "Neither bun nor npm was found."
  ensure_brew
  confirm "Install bun via Homebrew?" || { echo "Install bun (https://bun.sh) or Node/npm, then re-run." >&2; exit 1; }
  brew install bun
  PM=bun
fi

# --- build -------------------------------------------------------------------

cd "$ROOT"
echo "==> Installing JS dependencies ($PM)"
if [[ "$PM" == bun ]]; then bun install; else npm install; fi

echo "==> Building Swift sidecars"
"$SCRIPT_DIR/build-syscap.sh"
"$SCRIPT_DIR/build-screenrec.sh"

echo "==> Building app bundle"
if [[ "$PM" == bun ]]; then bun tauri build --bundles app; else npx tauri build --bundles app; fi

[[ -d "$BUILT_APP" ]] || { echo "Build failed: $BUILT_APP not found." >&2; exit 1; }

# --- install -----------------------------------------------------------------
# Use the shared installer for backups and the old MCP/login-item path alias.
bash "$SCRIPT_DIR/sign-macos-bundle.sh" "$BUILT_APP"
LOCAL_APP_BUNDLE="$BUILT_APP" bash "$ROOT/install.sh"
echo "Done. Tucky is in /Applications."
