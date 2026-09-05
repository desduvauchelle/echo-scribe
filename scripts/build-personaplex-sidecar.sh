#!/usr/bin/env bash
# Builds the PersonaPlex beta sidecar (src-tauri/personaplex) and installs it
# OUTSIDE the app bundle, next to Tucky's data:
#
#   ~/Library/Application Support/EchoScribe/personaplex/bin/
#     echo-scribe-personaplex   the Swift/MLX executable
#     mlx.metallib              precompiled Metal kernels (needs the Xcode
#                               Metal Toolchain: xcodebuild -downloadComponent MetalToolchain)
#     version.json              what was built, for Settings → Beta
#
# The runtime is soniqo/speech-swift pinned to SPEECH_SWIFT_TAG and patched
# (patches/) so the full-duplex loop reports text tokens and honours a
# caller-managed model directory. Nothing here touches tauri.conf.json or CI:
# the beta stays local-only until it graduates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$ROOT/src-tauri/personaplex"
DEPS="$PKG/.deps/speech-swift"
TAG="${SPEECH_SWIFT_TAG:-v0.0.27}"
PATCH="$PKG/patches/speech-swift-$TAG.patch"
DATA_DIR="${ECHO_SCRIBE_DATA_FOLDER:-EchoScribe}"
INSTALL_DIR="${PERSONAPLEX_INSTALL_DIR:-$HOME/Library/Application Support/$DATA_DIR/personaplex/bin}"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "error: PersonaPlex/MLX needs Apple Silicon" >&2
  exit 1
fi
if ! xcrun -sdk macosx metal --version >/dev/null 2>&1; then
  echo "error: Xcode Metal Toolchain missing. Run: xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi

echo "==> upstream speech-swift $TAG"
if [[ ! -d "$DEPS/.git" ]]; then
  git clone --depth 1 --branch "$TAG" https://github.com/soniqo/speech-swift.git "$DEPS"
fi
(
  cd "$DEPS"
  git fetch -q --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
  git checkout -q -f "$TAG"
  git clean -q -fdx -e .build
  if [[ -f "$PATCH" ]]; then
    git apply "$PATCH"
    echo "    applied $(basename "$PATCH")"
  fi
)

echo "==> swift build (release)"
# --disable-keychain: SwiftPM otherwise consults the login keychain for
# GitHub credentials during resolution and can block forever on a keychain
# access dialog (observed 2026-09-05) — the dependencies are all public.
(cd "$PKG" && swift build -c release --disable-sandbox --disable-keychain)

echo "==> mlx.metallib"
BUILD_DIR="$PKG/.build" "$DEPS/scripts/build_mlx_metallib.sh" release

echo "==> install → $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$PKG/.build/release/echo-scribe-personaplex" "$INSTALL_DIR/"
cp "$PKG/.build/release/mlx.metallib" "$INSTALL_DIR/"
# Resource bundles some targets ship (copied when present so lookups next to
# the executable keep working).
for b in "$PKG"/.build/release/*.bundle; do
  [[ -e "$b" ]] && rm -rf "$INSTALL_DIR/$(basename "$b")" && cp -R "$b" "$INSTALL_DIR/"
done
UPSTREAM_COMMIT="$(cd "$DEPS" && git rev-parse --short HEAD)"
cat > "$INSTALL_DIR/version.json" <<JSON
{
  "sidecar": "$("$INSTALL_DIR/echo-scribe-personaplex" version | awk '{print $2}')",
  "speech_swift": "$TAG",
  "speech_swift_commit": "$UPSTREAM_COMMIT",
  "patch": "$(basename "$PATCH")",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo "installed: $INSTALL_DIR/echo-scribe-personaplex"
cat "$INSTALL_DIR/version.json"
