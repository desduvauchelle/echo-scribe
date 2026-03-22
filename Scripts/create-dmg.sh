#!/bin/bash
set -euo pipefail

# Usage: ./Scripts/create-dmg.sh <path-to-.app> <version>
# Example: ./Scripts/create-dmg.sh "build/export/Echo Scribe.app" "1.2.0"

APP_PATH="${1:?Usage: create-dmg.sh <app-path> <version>}"
VERSION="${2:?Usage: create-dmg.sh <app-path> <version>}"
OUTPUT_DIR="build"
DMG_NAME="EchoScribe-${VERSION}.dmg"

if [ ! -d "$APP_PATH" ]; then
    echo "Error: App not found at $APP_PATH"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Remove existing DMG if present
rm -f "${OUTPUT_DIR}/${DMG_NAME}"

if command -v create-dmg &>/dev/null; then
    echo "Creating styled DMG with create-dmg..."
    create-dmg \
        --volname "Echo Scribe" \
        --volicon "$APP_PATH/Contents/Resources/AppIcon.icns" \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 100 \
        --icon "Echo Scribe.app" 150 190 \
        --app-drop-link 450 190 \
        --hide-extension "Echo Scribe.app" \
        --no-internet-enable \
        "${OUTPUT_DIR}/${DMG_NAME}" \
        "$APP_PATH" \
    || {
        # create-dmg returns non-zero if background image is missing, but DMG is still created
        if [ -f "${OUTPUT_DIR}/${DMG_NAME}" ]; then
            echo "DMG created (some optional styling may have been skipped)"
        else
            echo "Error: DMG creation failed"
            exit 1
        fi
    }
else
    echo "create-dmg not found, using hdiutil fallback..."
    echo "  Install with: brew install create-dmg"

    STAGING_DIR=$(mktemp -d)
    cp -R "$APP_PATH" "$STAGING_DIR/"
    ln -s /Applications "$STAGING_DIR/Applications"

    hdiutil create \
        -volname "Echo Scribe" \
        -srcfolder "$STAGING_DIR" \
        -ov \
        -format UDZO \
        "${OUTPUT_DIR}/${DMG_NAME}"

    rm -rf "$STAGING_DIR"
fi

echo "DMG created: ${OUTPUT_DIR}/${DMG_NAME}"
