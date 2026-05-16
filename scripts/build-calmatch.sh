#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT/src-tauri/calmatch"
swift build -c release
mkdir -p "$ROOT/src-tauri/binaries"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac
cp .build/release/echo-scribe-calmatch "$ROOT/src-tauri/binaries/echo-scribe-calmatch-$TRIPLE"
echo "built: src-tauri/binaries/echo-scribe-calmatch-$TRIPLE"
