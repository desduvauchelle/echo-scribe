#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${1:-$ROOT/src-tauri/target/release/bundle/macos/Echo Scribe.app}"
CONFIG="$ROOT/src-tauri/tauri.conf.json"
ENTITLEMENTS="$ROOT/src-tauri/Entitlements.plist"

if [[ ! -d "$APP_PATH" ]]; then
  echo "app bundle not found: $APP_PATH" >&2
  exit 1
fi

IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(python3 - "$CONFIG" <<'PY'
import json
import sys

with open(sys.argv[1]) as f:
    config = json.load(f)

identity = (
    config.get("bundle", {})
    .get("macOS", {})
    .get("signingIdentity")
)
print(identity or "-")
PY
)"
fi

sign_executable() {
  local name="$1"
  local identifier="$2"
  local path="$APP_PATH/Contents/MacOS/$name"
  if [[ ! -f "$path" ]]; then
    echo "sidecar not found: $path" >&2
    exit 1
  fi
  codesign --force --sign "$IDENTITY" --options runtime --identifier "$identifier" "$path"
}

sign_executable "echo-scribe-syscap" "com.echoscribe.app.syscap"
sign_executable "echo-scribe-screenrec" "com.echoscribe.app.screenrec"

codesign --force --sign "$IDENTITY" --options runtime --entitlements "$ENTITLEMENTS" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
