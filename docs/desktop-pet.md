# Desktop pet

Use the menu bar's **Show desktop pet** checkbox to turn the companion on or off. It starts off each app launch. Drag the squirrel to reposition it; re-enabling places it at the primary display's bottom-right work area.

The transparent, non-focusable window defaults to Small (100 × 112). Settings → General → Desktop pet and the pet's right-click menu offer Small, Medium (140 × 156), and Large (180 × 200); selection is saved across app launches. Right-click the pet for Pet size and Hide pet. Only Show desktop pet remains in the menu bar. Disabling destroys the window and stops polling.

There is no idle body movement. The original squirrel has pointer-following eyes and headphones that appear during capture (dictation, meetings, or an unpaused screen recording). Processing alone does not show headphones. A 16-bar meter beneath the pet uses the existing dictation microphone-level feed. Levels are clamped to 0–1 and expire after 300 ms, so silent or unavailable input cannot leave a stale moving meter. Meeting and screen-recording capture paths currently provide no live levels to this meter; their bars stay flat. Reduced Motion disables pupil movement and headphone transitions while retaining the recording indicator. These reactions only read capture state; they never control recording.

Artwork is the existing squirrel from `src-tauri/icons/tucky-master.png`, copied unchanged into `public/mascot/pet-original.png`. The inline SVG uses a dark-perimeter trace of the original pixels to clip out the pale background, then overlays movable eyes and headphones. A subtle CSS drop shadow lifts the silhouette above the desktop. This is an animated SVG composition containing the original PNG, not a fully vector-traced replacement.

Recording and processing status appear to the left of the pet, independently of Today's Focus and the notification column above it. Near the display's left edge, status moves to the pet's right. Its window stays inside the display work area as the pet moves or changes size. Wake-word requests show “I’m listening…” in that same position, then keep their processing status there. With the pet hidden, a wake request uses the bottom-center widget. The listening bubble includes a live microphone meter and Cancel button; Escape also cancels capture. Spoken dismissals such as “goodbye” and “never mind” discard the request after transcription and return to standby.

## Verification

- TypeScript and Vite production build passed.
- Rust check passed.
- Nine tray menu tests passed, including pet availability across recording/meeting states.
- Four reused monitor-placement tests passed (negative coordinates, unplugged display, clamping, no displays).
- Browser checks passed at all three sizes. Mocked native-state checks verified the stationary body, headphones on/off, reduced motion, and right-click context-menu invocation.
- Focused Rust checks passed for size dimensions, capture/processing headphones, and invalid/stale audio levels.
- Settings component checks passed for save, synchronization after context-menu size changes, and save failure feedback.
- On 2026-09-11, rebuilt a temporary snapshot combining current main-checkout work with this pet change, installed and relaunched /Applications/Tucky.app. Strict code-signature verification passed; installed and built executable SHA-256 match (22bf985a573d17227c4f20d2c2730b44ce27dd5a42ef736ebefc6e324f412b5c). The installed executable contains Show desktop pet, Pet size, and Hide pet. Installed Settings → General → Desktop pet was verified through the native UI: Small → Medium → Small succeeded. Live microphone and native pet context-menu flows still need the acceptance checks below.

## Native acceptance checks

1. Launch a local build, toggle **Show desktop pet**, and verify the checked state matches visibility.
2. Move the mouse outside the pet window; eyes should continue following it.
3. Drag between displays, including a display left of the primary, then disconnect that display. The pet should return to an available work area.
4. Toggle off/on repeatedly; only one pet should appear, without stealing keyboard focus.
5. Start dictation, a meeting, and a screen recording separately. Existing overlays and stop controls should behave normally and the pet toggle should remain available.
6. Select each Pet size in Settings and in the right-click menu. Verify the controls stay synchronized, and restart the app to check persistence.
7. Dictate and verify the meter follows actual microphone sound and falls flat on silence.
8. Right-click the pet, choose Hide pet, and verify both the window and menu-bar checkmark clear.
9. Enable macOS Reduce Motion; headphones should still reflect capture but switch without animation.

Initial source checks reused existing local dependencies and sidecars. The later installation used reinstall.command and the cached ONNX library via ORT_LIB_PATH. Previous app backup: /Applications/.tucky-backup.gg8Yee. Main-checkout source files were not modified; integrate this pet change there before its next rebuild to retain the feature.
