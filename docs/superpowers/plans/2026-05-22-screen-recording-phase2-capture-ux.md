# Screen Recording — Phase 2: Capture UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the user choose what to record (entire screen vs a specific window) and which audio to capture (system audio and/or a selected microphone) from a floating setup window opened via the macOS menu-bar (tray), with the tray icon turning red while recording.

**Architecture:** Extend the `echo-scribe-screenrec` sidecar with `--list-sources` and source/audio selection flags (incl. mic capture + mixing into one audio track). Add Rust commands + settings persistence + a tray menu control that opens a new `screenrec-setup` webview window and flips the tray icon to the Recording state. Reuse Phase 1's supervisor, DB, and library view.

**Tech Stack:** Swift (ScreenCaptureKit, AVFoundation, AVAudioEngine), Rust (Tauri v2), React/TypeScript.

**Builds on Phase 1** (`docs/superpowers/plans/2026-05-22-screen-recording-phase1-capture-core.md`, merged to main). Spec: `docs/superpowers/specs/2026-05-22-screen-recording-design.md`.

**Phase 2 scope:** source picker (display/window) + mic selection + setup window + tray start/stop + red icon + persisted audio prefs. **Deferred to Phase 3/4:** export presets, Google Drive, global hotkey (the spec lists a hotkey under Phase 2 but it requires coordinator integration and is split out as an optional follow-up, Task 7, to keep the core shippable).

---

## File Structure

**Modify:**
- `src-tauri/screenrec/main.swift` — `--list-sources`; `record` source flags (`--display`/`--window`) + audio flags (`--mic <uid>`, `--no-sysaudio`) + mic capture & mixing
- `src-tauri/src/screenrec/mod.rs` — `list_sources()` (run sidecar one-shot), `RecordParams`, extend `ScreenrecHandle::start`
- `src-tauri/src/commands.rs` — `list_screen_sources`, extend `start_screen_recording` to take params, screenrec settings get/set commands, `open_screenrec_setup`, tray flip on start/stop
- `src-tauri/src/lib.rs` — register new commands; create the setup window; tray menu item + event wiring
- `src-tauri/src/settings.rs` — keys + getters/setters for screenrec audio/source prefs
- `src-tauri/src/ui/tray.rs` — "Start/Stop screen recording" menu item + relabel + use `TrayPipelineState::Recording`
- `src-tauri/src/overlay.rs` — `create_screenrec_setup` / show window (mirror existing overlays)
- `vite.config.ts` — add `screenrec-setup` multipage entry
- `src/lib/api.ts` — wrappers for the new commands/types
- `src/views/sections/RecordingsView.tsx` — start now opens the setup window instead of recording immediately (optional; keep a direct "quick record" too)

**Create:**
- `src/screenrec-setup/index.html`, `src/screenrec-setup/main.tsx`, `src/screenrec-setup/SetupWindow.tsx` (+ css) — the picker UI

---

## Task 1: Sidecar `--list-sources` + Rust `list_screen_sources` command

Enumerate displays + windows so the picker can list them. Mic list reuses the existing `list_input_devices` command (cpal) — do NOT duplicate mic enumeration here.

**Files:** `src-tauri/screenrec/main.swift`, `src-tauri/src/screenrec/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/api.ts`

- [ ] **Step 1: Add `--list-sources` to the sidecar**

In `src-tauri/screenrec/main.swift`, before the `record` arg handling, detect `--list-sources` as the first arg. When present, run a one-shot async query and print ONE JSON object to **stdout**, then exit 0:

```swift
if CommandLine.arguments.contains("--list-sources") {
    if #available(macOS 14.0, *) {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                let displays = content.displays.map { d -> [String: Any] in
                    ["id": d.displayID, "width": d.width, "height": d.height,
                     "label": "Display \(d.displayID) (\(d.width)×\(d.height))"]
                }
                let windows = content.windows.compactMap { w -> [String: Any]? in
                    guard let title = w.title, !title.isEmpty,
                          let app = w.owningApplication?.applicationName, w.isOnScreen,
                          w.frame.width > 80, w.frame.height > 80 else { return nil }
                    return ["id": w.windowID, "app": app, "title": title,
                            "width": Int(w.frame.width), "height": Int(w.frame.height)]
                }
                let out: [String: Any] = ["displays": displays, "windows": windows]
                let data = try JSONSerialization.data(withJSONObject: out)
                FileHandle.standardOutput.write(data)
                exit(0)
            } catch {
                emitFatal("list_sources", error.localizedDescription)
            }
        }
        RunLoop.main.run()
    } else {
        emitFatal("os", "macOS 14+ required")
    }
}
```
(Place this so it runs before the `record`/`--out` parsing and the existing capture path. Keep the existing `record --out` behavior intact for when `--list-sources` is absent.)

- [ ] **Step 2: Build + smoke-test the sidecar**

Run:
```bash
bash scripts/build-screenrec.sh
./src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin --list-sources
```
Expected: one JSON line on stdout with `displays` (≥1) and `windows` arrays. (If Screen Recording permission is absent in this shell, you may get the `list_sources` error on stderr — that's acceptable; the JSON shape is what matters and is verified in the app at Task 5.)

- [ ] **Step 3: Add `list_sources()` to the Rust supervisor (TDD the JSON parse)**

In `src-tauri/src/screenrec/mod.rs`, add types + a parse function with a unit test, then the runner:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplaySource { pub id: u32, pub width: i64, pub height: i64, pub label: String }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowSource { pub id: u32, pub app: String, pub title: String, pub width: i64, pub height: i64 }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Sources { pub displays: Vec<DisplaySource>, pub windows: Vec<WindowSource> }

pub fn parse_sources(stdout: &str) -> Result<Sources, String> {
    serde_json::from_str::<Sources>(stdout.trim()).map_err(|e| e.to_string())
}

/// Run the sidecar `--list-sources` one-shot and parse its stdout JSON.
pub fn list_sources() -> Result<Sources, String> {
    let bin = resolve_binary().map_err(|e| e.to_string())?;
    let out = Command::new(&bin).arg("--list-sources")
        .stdout(Stdio::piped()).stderr(Stdio::null())
        .output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    parse_sources(&text)
}
```
Add a test:
```rust
    #[test]
    fn parse_sources_reads_displays_and_windows() {
        let s = r#"{"displays":[{"id":1,"width":3840,"height":2160,"label":"Display 1"}],"windows":[{"id":42,"app":"Safari","title":"x","width":800,"height":600}]}"#;
        let got = parse_sources(s).unwrap();
        assert_eq!(got.displays.len(), 1);
        assert_eq!(got.windows[0].app, "Safari");
    }
```
Run: `cd src-tauri && cargo test --lib screenrec 2>&1 | tail -8; cd ..` — passes.

- [ ] **Step 4: Tauri command + registration + api.ts**

In `commands.rs`:
```rust
#[tauri::command]
pub fn list_screen_sources() -> Result<crate::screenrec::Sources, String> {
    crate::screenrec::list_sources()
}
```
Register `list_screen_sources` in `lib.rs` `generate_handler!` + the `use crate::commands::{...}` block.
In `src/lib/api.ts`:
```ts
export type DisplaySource = { id: number; width: number; height: number; label: string };
export type WindowSource = { id: number; app: string; title: string; width: number; height: number };
export type ScreenSources = { displays: DisplaySource[]; windows: WindowSource[] };
export const listScreenSources = (): Promise<ScreenSources> => invoke("list_screen_sources");
```

- [ ] **Step 5: Build + commit**

`cd src-tauri && cargo build --lib 2>&1 | tail -8; cd ..` then:
```bash
git add src-tauri/screenrec/main.swift src-tauri/src/screenrec/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/api.ts src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin
git commit -m "feat(screenrec): enumerate displays + windows (--list-sources)"
```

---

## Task 2: Source selection in `record` (display vs window)

**Files:** `src-tauri/screenrec/main.swift`, `src-tauri/src/screenrec/mod.rs`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Sidecar accepts `--display <id>` or `--window <id>`**

In `src-tauri/screenrec/main.swift` `run()`, parse an optional source selector and build the `SCContentFilter` accordingly. Read the current `run()` first. Replace the filter construction so that:
- If `--window <id>` given: find the `SCWindow` whose `windowID == id` in `content.windows` and use `SCContentFilter(desktopIndependentWindow: window)`. Set `cfg.width/height` from `window.frame` (clamped to the 3840 long-edge rule already in the file).
- Else if `--display <id>` given: find the `SCDisplay` with `displayID == id` (fallback to `.first`). Use the existing display filter + `CGDisplayCopyDisplayMode` pixel-size + clamp logic.
- Else: current default (first display).

Parse the args near the existing `--out` parse:
```swift
var displayID: UInt32? = nil
var windowID: UInt32? = nil
// in the arg loop: --display <n> -> displayID, --window <n> -> windowID (UInt32(args[i+1]))
```
Keep the H.264 long-edge clamp + even-dims logic for whichever source's pixel size is chosen. For a window, base dims on `Int(window.frame.width)`/`height` × backing scale — to stay simple and safe, clamp the same way and let SCStream scale.

- [ ] **Step 2: Build the sidecar** — `bash scripts/build-screenrec.sh` (must compile). Real capture verified in Task 5/manual.

- [ ] **Step 3: Rust `RecordParams` + extend `ScreenrecHandle::start`**

In `src-tauri/src/screenrec/mod.rs`, add:
```rust
#[derive(Debug, Clone, Default)]
pub struct RecordParams {
    pub display_id: Option<u32>,
    pub window_id: Option<u32>,
    pub mic_device: Option<String>, // device UID/name; None = no mic
    pub sysaudio: bool,
}
```
Change `start(out_path: PathBuf)` to `start(out_path: PathBuf, params: RecordParams)` and push the corresponding args (`--display`/`--window`, `--mic`, `--no-sysaudio` when `!params.sysaudio`) onto the `Command`. Keep the readiness gate from Phase 1.

- [ ] **Step 4: Extend `start_screen_recording` command to take params**

In `commands.rs`, change `start_screen_recording` to accept the selection + audio flags and pass a `RecordParams`. Also store `has_mic`/`has_sysaudio`/`source_label` on the row from the params (replace the hardcoded "Entire screen"/false/true). Signature:
```rust
#[tauri::command]
pub fn start_screen_recording(
    state: State<'_, AppState>,
    display_id: Option<u32>,
    window_id: Option<u32>,
    mic_device: Option<String>,
    sysaudio: bool,
    source_label: String,
) -> Result<(), String> { /* build RecordParams, start, store label in a field for stop to read */ }
```
Because `stop_screen_recording` builds the row, thread the chosen `source_label`/`has_mic`/`has_sysaudio` through: store them alongside the handle (e.g. change `active_recording` to hold `(ScreenrecHandle, RecordingMeta)` where `RecordingMeta { source_label, has_mic, has_sysaudio }`), and read them in `stop`. Update the AppState field type + lib.rs init accordingly.

- [ ] **Step 5: Build + commit**

`cargo build --lib` + `cargo test --lib screenrec`, then:
```bash
git add -A && git commit -m "feat(screenrec): record a chosen display or window with audio params"
```

---

## Task 3: Microphone capture + system-audio mixing (hardest)

Capture the selected mic and mix it with system audio into a single AAC track.

**Files:** `src-tauri/screenrec/main.swift`

- [ ] **Step 1: Implement mic capture + a software mixer**

In `src-tauri/screenrec/main.swift`, when `--mic <uid>` is provided, capture microphone audio in parallel with SCStream system audio and SUM them into one stream before the AAC `audioInput`. Implementation guidance (verify against the compiler; this is the part the spec flagged as the real complexity):

- Use `AVCaptureSession` + `AVCaptureDeviceInput` (device matched by `uniqueID == uid`) + `AVCaptureAudioDataOutput` on its own queue to receive mic `CMSampleBuffer`s; OR `AVAudioEngine` input node tap. Prefer `AVCaptureAudioDataOutput` so you get `CMSampleBuffer`s directly.
- Resample both mic and SCStream system audio to a common format (Float32, 48k, stereo) using `AVAudioConverter` (the syscap sidecar at `src-tauri/syscap/main.swift` has the working AVAudioConverter pattern — read it).
- Maintain a small mixing buffer keyed by time; sum the two PCM streams sample-by-sample with clamping, then append the mixed buffer to `audioInput`. If only mic OR only system audio is enabled, pass that one through (no summing). If neither, write video-only (don't add an audio input).
- Gate all mixer state on the existing `stateQ` serial queue to avoid cross-queue races.

Because mixing two independently-clocked sources is fiddly, an acceptable Phase-2 simplification: if BOTH mic and system audio are on, mix; if only one is on, pass through. Use minimal buffering — align by appending whatever is available per tick with PTS from the system-audio clock; small drift is acceptable for v1. Document the chosen approach in code comments.

- [ ] **Step 2: Build** — `bash scripts/build-screenrec.sh` must compile. Note `NSMicrophoneUsageDescription` must exist in `src-tauri/Info.plist` (the dictation feature already declares it — confirm; if missing, add it, which makes this a TCC-reset build per CLAUDE.md).

- [ ] **Step 3: Commit**
```bash
git add src-tauri/screenrec/main.swift && git commit -m "feat(screenrec): capture + mix microphone with system audio"
```

---

## Task 4: Settings persistence for audio/source prefs

**Files:** `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/api.ts`

- [ ] **Step 1: Settings keys + getters/setters**

In `src-tauri/src/settings.rs`, add keys + get/set pairs (mirror `audio_feedback_enabled` at settings.rs:280-295):
- `KEY_SCREENREC_SYSAUDIO` → bool, default `true`
- `KEY_SCREENREC_MIC_ENABLED` → bool, default `false`
- `KEY_SCREENREC_MIC_DEVICE` → String (device name/uid), default ""

```rust
pub fn screenrec_sysaudio(&self) -> bool { self.store.get(KEY_SCREENREC_SYSAUDIO).and_then(|v| v.as_bool()).unwrap_or(true) }
pub fn set_screenrec_sysaudio(&self, on: bool) -> Result<(), SettingsError> { self.store.set(KEY_SCREENREC_SYSAUDIO, serde_json::Value::Bool(on)); self.store.save().map_err(|e| SettingsError::Store(e.to_string())) }
// ...mic_enabled (bool, default false), mic_device (String, default "")
```

- [ ] **Step 2: Commands + registration + api.ts**

Add `get_screenrec_audio_prefs` / `set_screenrec_audio_prefs` commands returning/accepting a small struct `{ sysaudio: bool, mic_enabled: bool, mic_device: String }`. Register in lib.rs. Add api.ts wrappers + a `ScreenrecAudioPrefs` type.

- [ ] **Step 3: Build + commit**
`cargo build --lib`, then `git add -A && git commit -m "feat(screenrec): persist last-used audio/source prefs"`.

---

## Task 5: Setup webview window (the picker UI)

A floating window listing screen + windows + mic, with toggles + Start. Mirrors the existing overlay-window machinery.

**Files:** `vite.config.ts`, `src/screenrec-setup/{index.html,main.tsx,SetupWindow.tsx,SetupWindow.css}`, `src-tauri/src/overlay.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Vite multipage entry**

In `vite.config.ts` `rollupOptions.input`, add:
```ts
      "screenrec-setup": resolve(__dirname, "src/screenrec-setup/index.html"),
```

- [ ] **Step 2: Create the window HTML + React entry**

Create `src/screenrec-setup/index.html` (mirror `src/overlay/index.html`, but a normal opaque window — not transparent), `src/screenrec-setup/main.tsx` (ReactDOM root rendering `<SetupWindow />`).

- [ ] **Step 3: `SetupWindow.tsx`**

A normal window UI that on mount calls `listScreenSources()` + `listInputDevices()` + `getScreenrecAudioPrefs()`, shows:
- A segmented "Entire screen" vs "Window" choice; for "Window", a scrollable list of `windows` (app — title). For "Entire screen", the display list (default first).
- A "System audio" toggle (default from prefs), a "Microphone" toggle + a `<select>` of input devices (default from prefs).
- A primary **Start recording** button that persists prefs via `setScreenrecAudioPrefs(...)`, calls `startScreenRecording({ display_id|window_id, mic_device|null, sysaudio, source_label })`, then closes the window (`getCurrentWindow().hide()` via `@tauri-apps/api/window`).
Use the app's design tokens (read `src/styles/globals.css`). Keep it focused (one screen, no routing).

- [ ] **Step 4: Rust: create + open the setup window**

In `src-tauri/src/overlay.rs`, add `create_screenrec_setup(app)` + `show_screenrec_setup(app)` mirroring `create_recording_overlay`/`show_recording_overlay` (overlay.rs:21-59,127-158) BUT: decorated, resizable, NOT transparent, NOT always-on-top, centered, label `screenrec_setup`, url `WebviewUrl::App("src/screenrec-setup/index.html")`. Create it (hidden) during setup in `lib.rs` like the other overlays; add a command `open_screenrec_setup` that calls `show_screenrec_setup`. Register the command.

- [ ] **Step 5: Build the app + verify the window opens**

`bun run build` (typecheck + bundle frontend). Then a full `bun tauri build --bundles app` is needed for the new window to be testable in the app (Task 6 wires the tray to open it; manual verify there).

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(screenrec): recording setup window (source + mic picker)"
```

---

## Task 6: Tray start/stop + red icon

Menu-bar control: a menu item to start (opens the setup window) / stop, and the tray icon goes red (`TrayPipelineState::Recording`) while recording.

**Files:** `src-tauri/src/ui/tray.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src/views/sections/RecordingsView.tsx`

- [ ] **Step 1: Add the tray menu item**

In `src-tauri/src/ui/tray.rs` `install()` (tray.rs:32-61), add a `screenrec` menu item ("Start screen recording") to the menu, store a clone in `TrayHandle` (new field `screenrec_item: Mutex<Option<MenuItem<R>>>`), and a helper `set_screenrec_active(&self, active: bool)` that relabels it ("Stop screen recording"/"Start screen recording") and calls `set_state(Recording)` / `set_state(Idle)` to flip the icon (red while recording). Mirror the existing `meeting_item` + `set_meeting_active` pattern.

- [ ] **Step 2: Handle the menu click**

In `bind_menu()` (tray.rs:65-164), add a `"screenrec"` case: read `AppState.active_recording`; if recording → call `stop_screen_recording` logic (emit a `screenrec-stop` event the same way meeting does, or call the command path) and `set_screenrec_active(false)`; if idle → `crate::overlay::show_screenrec_setup(app)` to open the picker.

- [ ] **Step 3: Flip the tray on start/stop from anywhere**

In `start_screen_recording` and `stop_screen_recording` commands (commands.rs), after success, lock `state.tray` and call `set_screenrec_active(true/false)` so the icon turns red on start (from the setup window) and back on stop (from the library button or tray). Mirror `state.tray.lock()` usage.

- [ ] **Step 4: Library view uses the setup window**

In `src/views/sections/RecordingsView.tsx`, change the "Record screen" button (when not recording) to call a new `openScreenrecSetup()` api wrapper (invoke `open_screenrec_setup`) instead of `startScreenRecording()` directly, so the picker is the single entry point. Keep "Stop recording" calling `stopScreenRecording()`. Add `openScreenrecSetup` to api.ts.

- [ ] **Step 5: Build, install, manual verify**

```bash
bun tauri build --bundles app
```
Then reinstall (skip-TCC unless Task 3 added `NSMicrophoneUsageDescription` to Info.plist — then full TCC reset per CLAUDE.md). Manual test:
1. Click the menu-bar (tray) icon → "Start screen recording" → setup window opens.
2. Pick "Window" → choose a window (or "Entire screen"); toggle System audio; toggle Microphone + pick a device; click Start.
3. Tray icon turns **red**; the setup window closes.
4. Speak + play audio for ~5s. Click the tray → "Stop screen recording" (or the library Stop button). Icon returns to normal.
5. In Recordings: the new row plays with the chosen source, and has both mic + system audio mixed (or whichever were enabled). `source_label` reflects the choice.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(screenrec): tray start/stop control with red recording icon"
```

---

## Task 7 (optional follow-up): global hotkey to start/stop

Deferred unless requested. Would add a `screenrec_binding` in settings + a new `Binding`/listener wired through the coordinator (`input/hotkeys.rs` + `coordinator.rs`) to toggle recording (open setup on start, stop on second press). Tracked separately to keep Task 1-6 shippable.

---

## Self-Review Notes

- **Spec coverage (Phase 2):** source picker (T1+T2+T5), mic selection + mixing (T3), persisted audio prefs (T4), setup window (T5), tray red-icon start/stop (T6). Global hotkey explicitly deferred (T7).
- **Contract consistency:** `RecordParams` (Rust) ↔ sidecar flags ↔ `start_screen_recording` args ↔ `SetupWindow` invoke payload must agree on field names (`display_id`/`window_id`/`mic_device`/`sysaudio`/`source_label`). `Sources`/`DisplaySource`/`WindowSource` (Rust) ↔ `ScreenSources` (TS) must match.
- **Known hard part:** Task 3 audio mixing — implementer should expect compiler iteration; a pass-through-when-single-source simplification is acceptable for v1.
- **TCC:** only Task 3 may touch `NSMicrophoneUsageDescription`; if so, that build needs a full TCC reset (CLAUDE.md). All other builds are skip-TCC.
- **Tray click nuance:** macOS tray icons with a menu show the menu on click; "click icon = stop" is implemented as a menu ITEM ("Stop screen recording") + red icon, not a literal single-click-stops-without-menu (which a menu-bearing tray can't do cleanly).
```
