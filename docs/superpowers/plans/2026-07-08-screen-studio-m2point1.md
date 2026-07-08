# Screen Studio Parity — M2.1: Camera Fix, Aspect Presets, Live Self-View

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make webcam capture actually work (camera TCC was silently denied — diagnosed from logs 2026-07-08), add aspect-ratio presets to the editor/export (16:9, 9:16, 1:1, 4:3 with the recording centered and padding distributed to the short axis), and show a floating camera self-view while recording.

**Architecture:** Camera permission is requested by the MAIN app process (mirroring the existing mic pattern in `src-tauri/src/permissions.rs` — `objc2_av_foundation::AVCaptureDevice::requestAccessForMediaType_completionHandler`, media type Video); the grant covers the sidecar child. Aspect presets extend the compositor's output-dims math (pure, testable) consumed identically by preview and export. Self-view is a small always-on-top Tauri window using webview `getUserMedia` — with an explicit spike step because concurrent camera access (webview + sidecar AVCaptureSession) and WKWebView getUserMedia permission plumbing must be proven before committing to the design.

**Tech Stack:** unchanged (Swift sidecar, Rust/Tauri v2, React/TS, bun test).

## Global Constraints

- All M2 conventions hold (source-time lookups; webcamTime = mainTime + offset_ms; CLAUDE.md logging/friendly-error discipline; `target:"screenrec"`).
- Sidecar changes rebuild + commit the aarch64 binary in the same commit.
- Suites baseline: cargo **477**, bun **93**, `bun run build` clean. Never break them.
- No `tccutil`, ever. Camera prompt must come from an explicit in-app request.
- Evidence for the camera bug (recording rec-1783535504314): sidecar emitted `webcam_ready` then `camera_finish: Cannot Record` + `camera_no_file`; `webcam_recording` (didStartRecordingTo) never fired; no TCC prompt was ever shown. No `requestAccess`/`authorizationStatus` exists in the sidecar.
- Branch: `feat/screen-studio-m2point1`.

---

### Task 1: Camera permission — request from the app, verify in the sidecar

**Files:** Modify `src-tauri/src/permissions.rs` (mirror the mic pattern: `camera_authorized()` using `AVCaptureDevice::authorizationStatusForMediaType(AVMediaTypeVideo)`; `pub async fn request_camera() -> CameraAccessOutcome` — mirror `MicAccessOutcome` (Granted/Denied/Undetermined) or generalize minimally; `SettingsPane::Camera` variant with the `x-apple.systempreferences:com.apple.preference.security?Privacy_Camera` deep link, mirroring the existing panes); Modify `src-tauri/src/commands.rs` (+ `lib.rs` registration): commands `request_camera_access() -> String` ("granted"/"denied"/"undetermined") and `open_camera_settings()`; Modify `src/lib/api.ts` (wrappers); Modify `src/screenrec-setup/SetupWindow.tsx`: when the Camera checkbox is toggled ON → `await requestCameraAccess()`; on "denied" → keep the checkbox ON but show an inline warning row ("Camera access is off for Echo Scribe. Open System Settings → Privacy & Security → Camera, enable Echo Scribe, then quit and reopen." + an "Open Settings" button calling `openCameraSettings()`); on "granted" proceed silently. Modify `src-tauri/screenrec/Webcam.swift`: in `init?`, before building the session, check `AVCaptureDevice.authorizationStatus(for: .video)`; when not `.authorized`, `emit(["event":"warn","kind":"camera_denied","msg":"camera permission not granted; recording continues without webcam"])` and return nil (same degrade path, truthful log).

- [ ] **Step 1:** Rust: implement permissions.rs additions with a unit test for the outcome mapping where the existing mic code has one (match its test style; the async prompt itself can't be unit-tested — status mapping can).
- [ ] **Step 2:** Commands + registration + api.ts + SetupWindow flow.
- [ ] **Step 3:** Sidecar authorization check; `bash scripts/build-screenrec.sh`.
- [ ] **Step 4:** `cargo test --lib` (477+new) · `bun test` (93) · `bun run build` clean.
- [ ] **Step 5:** Commit (source + binary): `fix(screenrec): request camera permission from the app; sidecar logs camera_denied truthfully`

### Task 2: Aspect-ratio presets (Auto, 16:9, 9:16, 1:1, 4:3)

**Files:** Modify `src/lib/editorProject.ts` (+`tests/editorProject.test.ts`): `appearance.aspect: "auto" | "16:9" | "9:16" | "1:1" | "4:3"`, default `"auto"`, tolerant parse (unknown → "auto"). Modify `src/lib/render/compositor.ts` (+`tests/compositor.test.ts`): new pure `outputLayout(frameW, frameH, padding, aspect) -> { outW, outH, contentX, contentY, contentW, contentH }` — TDD FIRST:

- "auto": current behavior — `outW = frameW + 2*padding`, `outH = frameH + 2*padding`, content at (padding, padding), size (frameW, frameH).
- Fixed aspect: content box = frame + 2*padding on each side (as auto); canvas = smallest rect of the target aspect that CONTAINS the content box; content centered → the extra space lands on the short axis (a wide 16:9 canvas around a tallish window ⇒ extra left/right… and around a wide-short window ⇒ extra top/bottom — assert both orientations in tests). Long edge capped 3840 with aspect preserved (content scaled down proportionally if the cap binds; assert).
- All overlay/zoom/cursor/webcam drawing must position within the CONTENT rect (not the full canvas): thread `outputLayout` through `drawCompositeV2`/`drawFrameLayer` replacing the implicit `(padding, padding, outW-2p, outH-2p)` content rect. `webcamRect` margins anchor to the canvas (bubble may sit in the letterbox area — that matches Screen Studio) — document the choice.

Modify `src/lib/render/renderPipeline.ts` (output sizing + even-dim rounding via `outputLayout`) and `src/views/sections/EditorView.tsx` (preview canvas sizing + a segmented "Aspect" control in the appearance section; persists via existing debounced save).

- [ ] **Step 1:** TDD `outputLayout` (RED→GREEN, both orientations + cap case + auto-equivalence).
- [ ] **Step 2:** Thread through compositor/pipeline/preview + UI control.
- [ ] **Step 3:** Suites green (`bun test` 93+new, build clean, cargo untouched 477+Task1 count).
- [ ] **Step 4:** Commit: `feat(editor): aspect-ratio presets with centered content and short-axis padding`

### Task 3: Live camera self-view while recording

**Files:** likely `src-tauri/src/overlay.rs` (window creation — follow `create_screenrec_setup`'s pattern), `src-tauri/tauri.conf.json`/`capabilities/*.json` if a new window needs them, new `src/camera-preview/` webview page, `src-tauri/src/commands.rs` (show/hide on recording start/stop when camera enabled), SetupWindow (nothing new — rides the camera toggle).

- [ ] **Step 1 — SPIKE (decides the design; timebox it):** (a) Can the Tauri WKWebView do `getUserMedia` video? (WKWebView needs the permission-request delegate honored — check what Tauri v2 exposes; test in `bun run dev` or a scratch window; app has NSCameraUsageDescription and, after Task 1, an authorized camera.) (b) Can the webview hold the camera WHILE the sidecar's AVCaptureSession records from the same device (concurrent multi-client camera access — generally allowed on modern macOS; prove it: run the sidecar `record --camera` from the installed app context is hard headlessly — instead prove the inverse cheaply: two local AVCaptureSessions in a Swift harness on the same device, plus webview getUserMedia while a harness session runs). Write findings to the task report BEFORE implementing.
- [ ] **Step 2 — Implement per spike outcome:** Preferred: small (≈240×180) always-on-top, draggable, frameless window with rounded-corner mirrored `<video>` from getUserMedia(deviceId matching the chosen camera), created when recording starts with camera enabled, destroyed on stop (wire into `start_screen_recording`/`stop_screen_recording_inner` alongside the tray flip; also destroy on recording-error paths). Display capture already excludes the app's own windows (SCContentFilter excludingApplications) so the self-view won't appear in display recordings; window captures are unaffected by other windows — verify the exclusion claim by reading main.swift's display path and note it. Fallbacks if the spike fails: (a) concurrent access denied → self-view only in the SETUP window (pre-flight mirror preview that stops before recording starts); (b) getUserMedia impossible in WKWebView → report BLOCKED with evidence; the controller decides (native preview would be a separate design).
- [ ] **Step 3:** Suites green; commit: `feat(screenrec): floating camera self-view while recording` (or the fallback variant with an honest message).

### Task 4: E2E + updated manual QA

- [ ] Build + skip-TCC install + boot + suites. Update `.superpowers/sdd/m2-manual-qa.md` → `m2point1-manual-qa.md`: (1) enable Camera in setup → EXPECT the macOS camera prompt now (grant it); (2) record 20s with camera + enhance-cursor → self-view visible while recording; (3) editor shows the webcam section (toggle it off/on — the after-the-fact control), aspect 16:9 → preview letterboxes correctly; (4) export → plays with audio, webcam bubble present, 16:9 canvas; (5) re-check `screenrec-last.log` shows `webcam_recording` + non-empty `webcam` in stopped. Remind: Screen Recording re-grant needed again after reinstall.

## Self-review notes
- Task 1 is the root-cause fix (main-process prompt); the sidecar check is diagnostics, not the fix itself.
- Task 2's `outputLayout` keeps every consumer on one pure function — preview/export can't drift; content-rect threading is the risky part and is where the reviewer should focus.
- Task 3 has explicit fallbacks; it must never block recording (self-view failure = warn + continue).
