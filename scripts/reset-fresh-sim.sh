#!/usr/bin/env bash
# Reset "Echo Scribe Fresh" back to a never-launched state:
# wipe its (isolated) data folders and its TCC permission grants.
# The real Echo Scribe app, data, models and permissions are untouched.
set -euo pipefail

osascript -e 'tell application "Echo Scribe Fresh" to quit' 2>/dev/null || true
sleep 1

# Data + logs + settings store (identifier-derived) + event archive.
rm -rf "$HOME/Library/Application Support/EchoScribeFreshSim"
rm -rf "$HOME/Library/Application Support/com.echoscribe.freshsim"
rm -rf "$HOME/Library/Logs/EchoScribeFreshSim"
rm -rf "$HOME/EchoScribeFreshSim"
rm -rf "$HOME/Library/Caches/com.echoscribe.freshsim"
rm -rf "$HOME/Library/WebKit/com.echoscribe.freshsim"
rm -rf "$HOME/Library/HTTPStorages/com.echoscribe.freshsim"
rm -rf "$HOME/Library/Saved Application State/com.echoscribe.freshsim.savedState"
rm -f  "$HOME/Library/Preferences/com.echoscribe.freshsim.plist"
rm -f  "$HOME/Library/LaunchAgents/Echo Scribe Fresh.plist"

# Same service list as TCC_RESET_SERVICES in src-tauri/src/commands.rs.
for svc in Microphone Accessibility ScreenCapture Camera AppleEvents; do
  tccutil reset "$svc" com.echoscribe.freshsim || true
done

echo "Echo Scribe Fresh reset to fresh-install state (data + permissions cleared)."
