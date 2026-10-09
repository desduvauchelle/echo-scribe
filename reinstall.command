#!/usr/bin/env bash
# Build Tucky and reinstall it into /Applications.
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

# Local reinstalls retain the speech models and measured comparison scores.
# Set both flags to 0 to build the standard distribution catalog instead.
export TUCKY_LOCAL_ASR="${TUCKY_LOCAL_ASR:-1}"
export VITE_LOCAL_ASR="${VITE_LOCAL_ASR:-$TUCKY_LOCAL_ASR}"

# Finder and a newly renamed checkout may not inherit the old shell setup.
if ! command -v bun >/dev/null 2>&1 && [[ -x "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi
# Reuse the locally cached ONNX library instead of depending on a directory-
# specific shell variable. An explicit caller-supplied path always wins.
if [[ -z "${ORT_LIB_PATH:-}" && "$(uname -m)" == "arm64" ]]; then
    for library in "$HOME"/Library/Caches/ort.pyke.io/dfbin/aarch64-apple-darwin/*/libonnxruntime.a; do
        if [[ -f "$library" ]]; then
            export ORT_LIB_PATH="$(dirname "$library")"
            break
        fi
    done
fi

echo "==> Building release bundle…"
bun tauri build --bundles app

BUNDLE="src-tauri/target/release/bundle/macos/Tucky.app"
if [[ ! -d "$BUNDLE" ]]; then
    echo "build did not produce $BUNDLE" >&2
    exit 1
fi

echo "==> Verifying signed bundle…"
bash scripts/sign-macos-bundle.sh "$BUNDLE"

if [[ $RESET_TCC -eq 1 ]]; then
    echo "==> Resetting TCC grants…"
    tccutil reset Microphone com.echoscribe.app || true
    tccutil reset Accessibility com.echoscribe.app || true
fi

if [[ $WIPE_MODELS -eq 1 ]]; then
    echo "==> Wiping downloaded models…"
    rm -rf "$HOME/Library/Application Support/Tucky/models" "$HOME/Library/Application Support/EchoScribe/models"
    rm -rf "$HOME/Library/Application Support/Tucky/llm-models" "$HOME/Library/Application Support/EchoScribe/llm-models"
fi

echo "==> Installing Tucky (preserving data and previous app backup)…"
# Install without launching so the database can be migrated while closed.
LOCAL_APP_BUNDLE="$BUNDLE" SKIP_LAUNCH=1 bash install.sh
python3 scripts/migrate-tucky-data.py
# Refresh this bundle's LaunchServices registration after the display-name change.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Tucky.app
open /Applications/Tucky.app

echo "==> Done."
