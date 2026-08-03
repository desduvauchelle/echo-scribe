#!/usr/bin/env bash
# Render the tray icon SVG sources in this directory to 64x64 PNGs in
# src-tauri/resources/. Uses headless Chrome (no extra deps) with a
# transparent background — qlmanage/QuickLook composites SVGs on opaque
# white, so it can't be used here.
#
# Run after editing any SVG:   bash scripts/tray-icons/generate.sh
# Then rebuild the app. The disc geometry in the badge SVGs must stay in
# sync with the knockout constants in src-tauri/src/ui/tray.rs.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../src-tauri/resources"

chrome=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  if [ -x "$c" ]; then chrome="$c"; break; fi
done
if [ -z "$chrome" ]; then
  echo "error: no Chrome/Chromium found to rasterize SVGs" >&2
  exit 1
fi

for svg in "$here"/*.svg; do
  name="$(basename "${svg%.svg}")"
  "$chrome" --headless=new --disable-gpu \
    --screenshot="$out/$name.png" \
    --window-size=64,64 \
    --default-background-color=00000000 \
    "file://$svg" >/dev/null 2>&1
  echo "rendered $name.png"
done
