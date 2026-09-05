#!/usr/bin/env bash
# Both archives contain the same signed app. The legacy filename, directory,
# and executable let existing Echo Scribe updaters install the Tucky release.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/Tucky.app}"
OUT="${2:-$ROOT}"
test -x "$APP/Contents/MacOS/echo-scribe"
mkdir -p "$OUT"
tar -czf "$OUT/Tucky-aarch64.tar.gz" -C "$(dirname "$APP")" "$(basename "$APP")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/Echo Scribe.app"
tar -czf "$OUT/EchoScribe-aarch64.tar.gz" -C "$STAGE" "Echo Scribe.app"
