#!/usr/bin/env bash
# Build + install "Echo Scribe Fresh" — a fully isolated fresh-install simulator.
#
# It is the same app, but:
#   - bundle identifier com.echoscribe.freshsim  -> its own TCC permission state
#     (macOS treats it as a brand-new app: no mic/accessibility/screen grants)
#   - product name "Echo Scribe Fresh"           -> installs alongside the real app
#   - data folder EchoScribeFreshSim             -> its own settings, DB, models,
#     recordings and logs; never touches ~/Library/Application Support/EchoScribe
#
# The data folder + bundle id are baked in at compile time via
# ECHO_SCRIBE_DATA_FOLDER / ECHO_SCRIBE_BUNDLE_ID (see data_folder_name() and
# bundle_id() in src-tauri/src/lib.rs), so the app can be launched normally
# via Finder/`open` with no env tricks. The bundle-id knob also isolates the
# keychain entry, tccutil targets, and MCP settings path; self-update is
# hard-disabled for variant builds (platform.rs / updater.rs).
#
# To re-simulate a fresh install after a first run:
#   scripts/reset-fresh-sim.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Sidecars are gitignored build artifacts; build them if missing.
[ -e src-tauri/binaries ] || { bash scripts/build-syscap.sh; bash scripts/build-screenrec.sh; }
ls src-tauri/binaries/echo-scribe-syscap-* >/dev/null 2>&1 || bash scripts/build-syscap.sh
ls src-tauri/binaries/echo-scribe-screenrec-* >/dev/null 2>&1 || bash scripts/build-screenrec.sh

[ -d node_modules ] || bun install

ECHO_SCRIBE_DATA_FOLDER=EchoScribeFreshSim \
ECHO_SCRIBE_BUNDLE_ID=com.echoscribe.freshsim \
  bun tauri build --bundles app --config scripts/fresh-sim.conf.json

APP="src-tauri/target/release/bundle/macos/Echo Scribe Fresh.app"
[ -d "$APP" ] || { echo "build produced no bundle at $APP" >&2; exit 1; }

# Sanity: never overwrite the real app.
osascript -e 'tell application "Echo Scribe Fresh" to quit' 2>/dev/null || true
rm -rf "/Applications/Echo Scribe Fresh.app"
cp -R "$APP" /Applications/

echo
echo "Installed /Applications/Echo Scribe Fresh.app"
echo "  identifier : com.echoscribe.freshsim (fresh TCC — no permissions granted)"
echo "  data dir   : ~/Library/Application Support/EchoScribeFreshSim"
echo "  real app + its data are untouched."
echo
echo "Tip: quit the real Echo Scribe before launching the sim (global hotkey/tray conflict)."
