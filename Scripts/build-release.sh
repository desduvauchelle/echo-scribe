#!/bin/bash
set -euo pipefail

# Usage: ./Scripts/build-release.sh <version-tag>
# Example: ./Scripts/build-release.sh v1.2.0
#
# Environment variables (optional):
#   SIGNING_IDENTITY  - Code signing identity (default: "Developer ID Application")
#   NOTARY_PROFILE    - Notarytool keychain profile (default: "EchoScribeNotary")
#   SKIP_NOTARIZE     - Set to "1" to skip notarization (for local testing)

TAG="${1:?Usage: build-release.sh <version-tag> (e.g. v1.2.0)}"
VERSION="${TAG#v}"
BUILD_NUMBER=$(git rev-list --count HEAD)
SIGNING_IDENTITY="${SIGNING_IDENTITY:-Developer ID Application}"
NOTARY_PROFILE="${NOTARY_PROFILE:-EchoScribeNotary}"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="${PROJECT_DIR}/build"
ARCHIVE_PATH="${BUILD_DIR}/EchoScribe.xcarchive"
EXPORT_PATH="${BUILD_DIR}/export"
APP_NAME="Echo Scribe"
APP_PATH="${EXPORT_PATH}/${APP_NAME}.app"

echo "=== Echo Scribe Release Build ==="
echo "Version: ${VERSION} (build ${BUILD_NUMBER})"
echo "Signing: ${SIGNING_IDENTITY}"
echo ""

cd "$PROJECT_DIR"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Step 1: Patch version in Info.plist
echo ">>> Patching version..."
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" \
    EchoScribe/Resources/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD_NUMBER}" \
    EchoScribe/Resources/Info.plist

# Step 2: Generate Xcode project (if using XcodeGen)
if command -v xcodegen &>/dev/null; then
    echo ">>> Generating Xcode project..."
    xcodegen generate
fi

# Step 3: Resolve dependencies
echo ">>> Resolving packages..."
xcodebuild -project EchoScribe.xcodeproj \
    -scheme EchoScribe \
    -resolvePackageDependencies \
    -quiet

# Step 4: Archive
echo ">>> Archiving..."
xcodebuild -project EchoScribe.xcodeproj \
    -scheme EchoScribe \
    -configuration Release \
    -archivePath "$ARCHIVE_PATH" \
    archive \
    CODE_SIGN_IDENTITY="${SIGNING_IDENTITY}" \
    CODE_SIGNING_ALLOWED=YES \
    -quiet

# Step 5: Export archive
echo ">>> Exporting archive..."
xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportOptionsPlist Scripts/ExportOptions.plist \
    -exportPath "$EXPORT_PATH" \
    -quiet

# Step 6: Deep sign (ensures all embedded frameworks and XPC services are signed)
echo ">>> Code signing..."
codesign --deep --force --options runtime \
    --sign "${SIGNING_IDENTITY}" \
    "$APP_PATH"

# Verify signature
codesign --verify --deep --strict "$APP_PATH"
echo "    Signature verified."

# Step 7: Notarize
if [ "$SKIP_NOTARIZE" = "1" ]; then
    echo ">>> Skipping notarization (SKIP_NOTARIZE=1)"
else
    echo ">>> Notarizing app..."
    ZIP_PATH="${BUILD_DIR}/EchoScribe-notarize.zip"
    ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

    xcrun notarytool submit "$ZIP_PATH" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait

    echo ">>> Stapling app..."
    xcrun stapler staple "$APP_PATH"

    rm "$ZIP_PATH"
fi

# Step 8: Create DMG
echo ">>> Creating DMG..."
chmod +x Scripts/create-dmg.sh
Scripts/create-dmg.sh "$APP_PATH" "$VERSION"

DMG_PATH="${BUILD_DIR}/EchoScribe-${VERSION}.dmg"

# Step 9: Notarize DMG
if [ "$SKIP_NOTARIZE" = "1" ]; then
    echo ">>> Skipping DMG notarization"
else
    echo ">>> Notarizing DMG..."
    xcrun notarytool submit "$DMG_PATH" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait

    echo ">>> Stapling DMG..."
    xcrun stapler staple "$DMG_PATH"
fi

echo ""
echo "=== Build Complete ==="
echo "DMG: ${DMG_PATH}"
echo "Version: ${VERSION} (build ${BUILD_NUMBER})"
