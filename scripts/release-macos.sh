#!/usr/bin/env bash
# Build a Developer ID signed, notarized Finder installer. Never install it or
# modify /Applications, privacy permissions, or the user's application data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "${1:-}" in
  ""|--check) ;;
  *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac
for tool in bun security codesign hdiutil ditto xcrun python3; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
xcrun --find notarytool >/dev/null
xcrun --find stapler >/dev/null

IDENTITIES="$(security find-identity -v -p codesigning)"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(printf '%s\n' "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application:.*\)".*/\1/p')"
fi
if [[ "$IDENTITY" != "Developer ID Application:"* || "$IDENTITY" == *$'\n'* ]] ||
   ! printf '%s\n' "$IDENTITIES" | grep -Fq "\"$IDENTITY\""; then
  echo "Select one installed Developer ID Application certificate with APPLE_SIGNING_IDENTITY." >&2
  echo "In Xcode: Settings > Apple Accounts > your team > Manage Certificates > + > Developer ID Application." >&2
  exit 1
fi
PROFILE="${TUCKY_NOTARY_PROFILE:-tucky-apple-notarization}"
NOTARY_ARGS=(--keychain-profile "$PROFILE")
if [[ -n "${TUCKY_NOTARY_KEYCHAIN:-}" ]]; then
  NOTARY_ARGS+=(--keychain "$TUCKY_NOTARY_KEYCHAIN")
fi
echo "Signing identity: $IDENTITY"
echo "Notarization Keychain profile: $PROFILE"
if [[ "${1:-}" == --check ]]; then
  echo "Local signing prerequisites passed. Notarization authentication is checked when building."
  exit 0
fi

OUT="$ROOT/output/mac-release"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Check authentication before a long build. Credentials stay in Keychain.
xcrun notarytool history "${NOTARY_ARGS[@]}" --output-format json > "$WORK/history.json"

# Final signing/notarization happens after adding the legacy executable alias.
# Disable Tauri's automatic notarization so no bundle changes follow approval.
unset APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
export TUCKY_LOCAL_ASR="${TUCKY_LOCAL_ASR:-1}"
export VITE_LOCAL_ASR="${VITE_LOCAL_ASR:-$TUCKY_LOCAL_ASR}"
# Also covers the separate Whisper/wakeword Cargo builds invoked by build.rs.
export CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=none
APPLE_SIGNING_IDENTITY=- bun tauri build --bundles app
APP="$ROOT/src-tauri/target/release/bundle/macos/Tucky.app"
CODESIGN_IDENTITY="$IDENTITY" bash scripts/sign-macos-bundle.sh "$APP"

notarize() {
  local artifact="$1"
  xcrun notarytool submit "$artifact" "${NOTARY_ARGS[@]}" --wait --output-format json > "$WORK/result.json"
  python3 - "$WORK/result.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
if result.get('status') != 'Accepted':
    sys.exit('Notarization failed: ' + str(result.get('status')) +
             '. Inspect with xcrun notarytool log ' + str(result.get('id')) +
             ' --keychain-profile <profile>.')
print('Apple accepted submission ' + result['id'])
PY
}

ditto -c -k --keepParent "$APP" "$WORK/Tucky.zip"
notarize "$WORK/Tucky.zip"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
codesign --verify --deep --strict "$APP"
spctl --assess --type execute --verbose=2 "$APP"

# Keep existing updater and MCP archive paths using the same approved app.
bash scripts/package-release.sh "$APP" "$OUT"
mkdir -p "$WORK/dmg"
ditto "$APP" "$WORK/dmg/Tucky.app"
ln -s /Applications "$WORK/dmg/Applications"
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
ARCH="$(uname -m)"
DMG="$OUT/Tucky-$VERSION-$ARCH.dmg"
hdiutil create -volname Tucky -srcfolder "$WORK/dmg" -format UDZO -ov "$WORK/Tucky.dmg"
codesign --force --sign "$IDENTITY" --timestamp "$WORK/Tucky.dmg"
notarize "$WORK/Tucky.dmg"
xcrun stapler staple "$WORK/Tucky.dmg"
xcrun stapler validate "$WORK/Tucky.dmg"
codesign --verify --strict "$WORK/Tucky.dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$WORK/Tucky.dmg"
mv "$WORK/Tucky.dmg" "$DMG"
echo "Verified Finder installer: $DMG"
