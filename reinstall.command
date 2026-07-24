#!/usr/bin/env bash
# Build Echo Scribe and reinstall it into /Applications.
# Double-click in Finder, or run from a terminal.
#
# Flags:
#   --reset-tcc   Also reset Microphone + Accessibility grants (forces a
#                 re-prompt on next launch). Skip unless perms feel broken.
#   --wipe-models Also delete downloaded Parakeet + Gemma weights. Slow!
#
# Default behavior keeps grants and models so iteration is fast.

set -euo pipefail

cd "$(dirname "$0")"

RESET_TCC=0
WIPE_MODELS=0
for arg in "$@"; do
    case "$arg" in
        --reset-tcc)   RESET_TCC=1 ;;
        --wipe-models) WIPE_MODELS=1 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

echo "==> Building release bundle…"
bun tauri build --bundles app

BUNDLE="src-tauri/target/release/bundle/macos/Echo Scribe.app"
if [[ ! -d "$BUNDLE" ]]; then
    echo "build did not produce $BUNDLE" >&2
    exit 1
fi

echo "==> Stabilizing macOS sidecar signatures…"
bash scripts/sign-macos-bundle.sh "$BUNDLE"

echo "==> Quitting any running instance…"
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null || true
pkill -f "Echo Scribe" 2>/dev/null || true
sleep 1

if [[ $RESET_TCC -eq 1 ]]; then
    echo "==> Resetting TCC grants…"
    tccutil reset Microphone com.echoscribe.app || true
    tccutil reset Accessibility com.echoscribe.app || true
fi

if [[ $WIPE_MODELS -eq 1 ]]; then
    echo "==> Wiping downloaded models…"
    rm -rf "$HOME/Library/Application Support/EchoScribe/models"
    rm -rf "$HOME/Library/Application Support/EchoScribe/llm-models"
fi

echo "==> Replacing /Applications/Echo Scribe.app…"
rm -rf "/Applications/Echo Scribe.app"
cp -R "$BUNDLE" /Applications/

echo "==> Launching…"
open "/Applications/Echo Scribe.app"

echo "==> Done."
