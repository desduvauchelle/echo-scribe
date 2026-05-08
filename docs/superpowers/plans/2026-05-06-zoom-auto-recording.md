# Zoom Auto-Recording (Smart Meeting Detection) — Completed

**Goal:** Fix meeting auto-detection so it only starts recording when a Zoom meeting is actually in progress (not just when the app is launched), and auto-stops when the meeting ends.

## Root Cause

The detector in `detector.rs` treated native apps (Zoom, Teams) differently from browsers:
- **Browsers**: Required mic active for 5+ seconds — safe
- **Native apps**: Only required app frontmost for 4 seconds, **no mic check** — just launching Zoom triggered recording

## Changes Made

### 1. Unified mic requirement (core fix)
All app types now require mic active for 5+ seconds before triggering. Zoom doesn't activate the mic until you join a meeting, so this prevents false triggers on launch.

### 2. Window title filtering (safety layer)
Added `is_idle_window_title()` that filters out known idle titles:
- Zoom: "Zoom Workplace", "Zoom"
- Teams: "Microsoft Teams", "Microsoft Teams (work or school)"

Switched detector to use `capture_context()` (which returns window title via Accessibility API) instead of bare `frontmost_bundle_id()`.

### 3. Auto-stop monitor
Added `spawn_end_monitor()` that polls every 5 seconds and counts consecutive silent mic checks. After 30 seconds of mic silence (6 checks), auto-stops the meeting. If the meeting app is also not frontmost, counts 2x faster (15 seconds).

Wired into all meeting start paths: auto-detect (Always), manual start command, and tray toggle.

## Files Modified
- `src-tauri/src/meeting/detector.rs` — all three features + 8 unit tests
- `src-tauri/src/commands.rs` — spawn end-monitor after manual start
- `src-tauri/src/ui/tray.rs` — spawn end-monitor after tray start
