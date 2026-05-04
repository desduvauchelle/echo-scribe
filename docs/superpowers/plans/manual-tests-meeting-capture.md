# Manual Test Plan — Meeting Capture

Run these tests on a fresh release build (`bun tauri build --bundles app`)
followed by the full TCC reset + reinstall sequence in CLAUDE.md.

## Setup

1. Reinstall the .app per CLAUDE.md.
2. Grant Microphone permission when prompted.
3. Grant Screen Recording permission when prompted (System Settings → Privacy & Security → Screen Recording → Echo Scribe).
4. Confirm Parakeet and Gemma 4 E2B are downloaded (Settings → Models).

## Test 1 — Manual hotkey, FaceTime call

1. Open FaceTime, start a call with a friend (or echo-test number).
2. Trigger a manual meeting capture (currently via the `start_meeting_manual` Tauri command — wire to a hotkey in a follow-up task).
3. Verify red recording overlay appears with timer + Stop button.
4. Talk for ~2 minutes, alternating speakers.
5. Click Stop in the overlay.
6. Verify overlay shows "Transcribing…" then disappears.
7. Open the app → Meetings → top entry.
8. Verify: title is editable, summary card has 3-5 bullets, action items if any, transcript shows alternating "You" / "Them" segments.

## Test 2 — Auto-detect, Zoom

1. Open Zoom, join any meeting.
2. Within ~5s, in-app prompt should appear: "Zoom meeting detected".
3. Click "Just once".
4. Verify recording starts, overlay shown.
5. Talk for ~30s.
6. Click Stop in the overlay.
7. Verify the meeting appears in the Meetings view.

## Test 3 — Browser meeting (Google Meet)

1. Open Chrome, go to meet.google.com, start a meeting.
2. After ~5s of mic activity, in-app prompt should appear: "Chrome meeting detected".
3. Click "Always".
4. Verify recording starts.
5. End the call by closing the tab.
6. Stop the meeting via the overlay.
7. Verify meeting saved with `detected_app_name = "Chrome"`.

## Test 4 — Mid-meeting Screen Recording revocation / mic-only fallback

1. Start a meeting via the manual command without Screen Recording permission.
2. Verify the app falls back to mic-only.
3. Verify the saved transcript has only "You" segments and `mic_only: true`.

## Test 5 — Force-quit recovery

1. Start a meeting; let it record for ~3 minutes.
2. `kill -9 $(pgrep "Echo Scribe")`
3. Reopen the app.
4. Verify a recovery toast appears.
5. Open Meetings → the killed meeting should appear with status "failed".

## Test 6 — Hard cap (long-running)

1. Hard cap is currently set to 240 minutes.
2. (Future): expose hard-cap setting in UI; for now, edit `MeetingManager::start` to use a shorter cap for testing.
3. After the cap, verify recording auto-stops.

## Test 7 — Concurrent meeting prevention

1. Start a meeting via the manual command.
2. While recording, open Zoom and join a call.
3. Verify the auto-detect does NOT trigger a second meeting (the first is still active).
4. Stop the first meeting.
5. Verify Zoom now triggers the consent flow.
