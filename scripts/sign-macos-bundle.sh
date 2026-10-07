#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${1:-$ROOT/src-tauri/target/release/bundle/macos/Tucky.app}"
CONFIG="$ROOT/src-tauri/tauri.conf.json"
ENTITLEMENTS="$ROOT/src-tauri/Entitlements.plist"

if [[ ! -d "$APP_PATH" ]]; then
  echo "app bundle not found: $APP_PATH" >&2
  exit 1
fi

IDENTITY="${CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
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

# Developer ID releases require a secure timestamp. Keep ad-hoc/local signing
# usable without contacting Apple's timestamp service.
SIGN_OPTIONS=(--options runtime)
if [[ "$IDENTITY" == "Developer ID Application:"* ]]; then
  SIGN_OPTIONS+=(--timestamp)
fi

# Sign embedded native libraries before the containing app.
while IFS= read -r -d '' path; do
  codesign --force --sign "$IDENTITY" "${SIGN_OPTIONS[@]}" "$path"
done < <(find "$APP_PATH/Contents" -type f -name '*.dylib' -print0)

sign_executable() {
  local name="$1"
  local identifier="$2"
  local path="$APP_PATH/Contents/MacOS/$name"
  if [[ ! -f "$path" ]]; then
    echo "sidecar not found: $path" >&2
    exit 1
  fi
  codesign --force --sign "$IDENTITY" "${SIGN_OPTIONS[@]}" --entitlements "$ENTITLEMENTS" --identifier "$identifier" "$path"
}

sign_executable "echo-scribe-syscap" "com.echoscribe.app.syscap"
sign_executable "echo-scribe-screenrec" "com.echoscribe.app.screenrec"
sign_executable "tucky-wakeword" "com.echoscribe.app.wakeword"
sign_executable "tucky-whisper" "com.echoscribe.app.whisper"

# Preserve old MCP paths and updater validation inside the signed bundle.
if [[ -x "$APP_PATH/Contents/MacOS/Tucky" ]]; then
  ln -sfn Tucky "$APP_PATH/Contents/MacOS/echo-scribe"
fi

codesign --force --sign "$IDENTITY" "${SIGN_OPTIONS[@]}" --entitlements "$ENTITLEMENTS" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
