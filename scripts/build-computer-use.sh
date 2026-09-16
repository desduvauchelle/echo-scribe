#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE="$ROOT/src-tauri/computer-use"
swift build --package-path "$PACKAGE" -c release
APP="$PACKAGE/.build/Tucky Computer Use Prototype.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$PACKAGE/.build/release/tucky-computer-use" "$APP/Contents/MacOS/tucky-computer-use"
cp "$ROOT/scripts/computer-use-google.py" "$APP/Contents/Resources/computer-use-google.py"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>tucky-computer-use</string>
<key>CFBundleIdentifier</key><string>com.echoscribe.computer-use-prototype</string>
<key>CFBundleName</key><string>Tucky Computer Use Prototype</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSAccessibilityUsageDescription</key><string>Operate the browser you select for the background computer-use test.</string>
<key>NSScreenCaptureUsageDescription</key><string>Capture the selected browser window to verify the computer-use test.</string>
</dict></plist>
PLIST
# A separate stable identity keeps prototype grants separate from installed Tucky.
# Override explicitly on machines without this repository's local signing identity.
codesign --force --sign "${TUCKY_COMPUTER_USE_SIGNING_IDENTITY:-F6FD1D39BE4E52054A6B72E1EC5E90A03F5E5B77}" "$APP"
codesign --verify --strict "$APP"
echo "$APP"
