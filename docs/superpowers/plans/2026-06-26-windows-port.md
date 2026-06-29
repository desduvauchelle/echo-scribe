# Windows Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Echo Scribe build, install, and run on Windows in a clearly scoped limited mode, then expand toward feature parity behind platform capability checks.

**Architecture:** Keep the existing macOS app as the primary implementation and add a small platform boundary for Windows. Windows should initially disable macOS-only sidecar features with explicit capability flags and user-facing errors, while preserving the core app shell, settings, database, model registry, and direct voice capture path wherever the current Rust dependencies support it.

**Tech Stack:** Tauri 2, Rust, React, TypeScript, Bun, Cargo, GitHub Actions, Windows WebView2, Microsoft C++ Build Tools, NSIS/MSI bundling through Tauri.

---

## File Structure

- Modify `src-tauri/Cargo.toml`
  - Move macOS-only dependencies out of global dependencies.
  - Use platform-specific llama.cpp features: Metal on macOS, CPU-compatible baseline elsewhere.
  - Keep shared dependencies global only when they compile on Windows.
- Modify `src-tauri/build.rs`
  - Build Swift sidecars only when `CARGO_CFG_TARGET_OS=macos`.
  - Keep feedback WAV generation platform-neutral.
- Create `src-tauri/src/platform.rs`
  - Centralize platform capability decisions.
  - Expose `Capabilities` and simple helper functions for startup, commands, and UI.
- Modify `src-tauri/src/lib.rs`
  - Add `platform` module.
  - Configure autostart plugin without macOS-only launcher assumptions on Windows.
  - Start meeting detector, screen recording setup, updater, and dock/Space behavior only when supported.
  - Avoid macOS-only forced `_exit` behavior on Windows.
- Modify `src-tauri/src/calendar/mod.rs`
  - Make the sidecar-backed calendar implementation macOS-only.
  - Add Windows-safe stubs returning unavailable/no match.
- Modify `src-tauri/src/meeting/syscap.rs`
  - Make the system-audio sidecar implementation macOS-only.
  - Add Windows-safe stubs that return clear unsupported errors.
- Modify `src-tauri/src/meeting/recorder.rs`
  - Treat unsupported system audio capture as mic-only instead of failing the meeting subsystem.
- Modify `src-tauri/src/meeting/detector.rs`
  - Gate CoreAudio polling behind `target_os = "macos"`.
  - Make auto-detection no-op on Windows until native meeting detection is implemented.
- Modify `src-tauri/src/screenrec/mod.rs`
  - Keep JSON parsing tests shared.
  - Make sidecar operations return `"screen recording is not supported on this platform"` on Windows.
  - Resolve recordings directory through `dirs::data_dir()` instead of hardcoded `~/Library/Application Support`.
- Modify `src-tauri/src/screenrec/drive.rs`
  - Compile only on macOS until credential storage is made cross-platform.
  - Add non-macOS stubs for Google Drive commands if frontend commands remain registered.
- Modify `src-tauri/src/updater.rs`
  - Make the current tarball `.app` updater macOS-only.
  - Add a Windows-safe no-op updater until Windows release assets exist.
- Modify `src-tauri/tauri.conf.json`
  - Stop bundling macOS sidecar binaries for Windows builds.
  - Add Windows bundle metadata once `bun tauri build --target x86_64-pc-windows-msvc` is possible on Windows CI.
- Create: `src-tauri/tauri.windows.conf.json`
  - Override `bundle.externalBin` to `[]` for Windows so Tauri does not look for macOS Swift sidecars with Windows target suffixes.
- Modify `src/components/PermissionsSection.tsx`, `src/views/sections/MeetingsView.tsx`, `src/views/sections/RecordingsView.tsx`, and screen recording controls as needed.
  - Use backend capability responses or unsupported command errors to hide/disable unavailable Windows features.
- Create `.github/workflows/windows.yml`
  - Build Windows on `windows-latest` with Rust, Bun, CMake, and Visual Studio Build Tools.
  - Run `bun run build`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, and `bun tauri build`.
- Modify `docs/WINDOWS.md`
  - Replace "not supported" with the current support tier once CI creates an installer.
  - Include end-user install steps only after a Windows release asset exists.

## Milestones

1. **Windows compile hygiene:** Cargo and Tauri source compile on a Windows host, with unsupported features behind stubs.
2. **Windows CI:** A GitHub Actions job proves the Windows build on every PR.
3. **Windows installer artifact:** Tauri emits NSIS/MSI output and release docs point users at the generated installer.
4. **Core workflow smoke:** App launches, opens the main window/tray, persists settings, opens the database under `%APPDATA%`, and handles unavailable features gracefully.
5. **Voice capture parity:** Global hotkey, microphone recording, ASR, transcript post-processing, and paste-at-cursor are implemented with Windows-native behavior.
6. **Optional parity:** Meeting detection, system audio capture, calendar matching, screen recording, and Google Drive credential storage get Windows-native implementations.

## Task 1: Add Platform Capabilities

**Files:**
- Create: `src-tauri/src/platform.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/platform.rs`

- [ ] **Step 1: Write the failing tests**

Add this test module to the new file before any production use:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_capabilities_enable_sidecar_features() {
        let caps = Capabilities::for_os("macos");
        assert!(caps.meeting_auto_detect);
        assert!(caps.system_audio_capture);
        assert!(caps.calendar_matching);
        assert!(caps.screen_recording);
        assert!(caps.bundle_self_update);
    }

    #[test]
    fn windows_capabilities_disable_macos_sidecar_features() {
        let caps = Capabilities::for_os("windows");
        assert!(!caps.meeting_auto_detect);
        assert!(!caps.system_audio_capture);
        assert!(!caps.calendar_matching);
        assert!(!caps.screen_recording);
        assert!(!caps.bundle_self_update);
        assert!(!caps.direct_voice_capture);
        assert!(caps.local_database);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib platform::
```

Expected: FAIL because `src-tauri/src/platform.rs` and `Capabilities` do not exist.

- [ ] **Step 3: Implement minimal platform capability module**

Create `src-tauri/src/platform.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub direct_voice_capture: bool,
    pub local_database: bool,
    pub meeting_auto_detect: bool,
    pub system_audio_capture: bool,
    pub calendar_matching: bool,
    pub screen_recording: bool,
    pub bundle_self_update: bool,
}

impl Capabilities {
    pub fn current() -> Self {
        Self::for_os(std::env::consts::OS)
    }

    pub fn for_os(os: &str) -> Self {
        let macos = os == "macos";
        Self {
            direct_voice_capture: macos,
            local_database: true,
            meeting_auto_detect: macos,
            system_audio_capture: macos,
            calendar_matching: macos,
            screen_recording: macos,
            bundle_self_update: macos,
        }
    }
}
```

Add to `src-tauri/src/lib.rs`:

```rust
pub mod platform;
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib platform::
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/platform.rs src-tauri/src/lib.rs
git commit -m "chore: add platform capability model"
```

## Task 2: Gate macOS-Only Build Inputs

**Files:**
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add build-script unit helper**

Refactor `build.rs` so sidecar gating is testable without running Swift:

```rust
fn should_build_swift_sidecars(profile: &str, target_os: &str) -> bool {
    profile == "release" && target_os == "macos"
}
```

- [ ] **Step 2: Add build-script tests**

Add:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_macos_builds_swift_sidecars() {
        assert!(should_build_swift_sidecars("release", "macos"));
    }

    #[test]
    fn release_windows_skips_swift_sidecars() {
        assert!(!should_build_swift_sidecars("release", "windows"));
    }

    #[test]
    fn debug_macos_skips_swift_sidecars() {
        assert!(!should_build_swift_sidecars("debug", "macos"));
    }
}
```

- [ ] **Step 3: Use the helper in `main`**

Replace the current release-only condition with:

```rust
let profile = std::env::var("PROFILE").unwrap_or_default();
let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
if should_build_swift_sidecars(&profile, &target_os) {
    // existing Swift sidecar commands
}
```

- [ ] **Step 4: Move macOS-only dependencies**

In `src-tauri/Cargo.toml`, move these out of global `[dependencies]`:

```toml
keyring = { version = "3", features = ["apple-native"] }
coreaudio-sys = "0.2.17"
llama-cpp-2 = { version = "0.1.146", default-features = false, features = ["metal"] }
llama-cpp-sys-2 = { version = "0.1.146", default-features = false }
```

Add:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
keyring = { version = "3", features = ["apple-native"] }
coreaudio-sys = "0.2.17"
llama-cpp-2 = { version = "0.1.146", default-features = false, features = ["metal"] }
llama-cpp-sys-2 = { version = "0.1.146", default-features = false }

[target.'cfg(not(target_os = "macos"))'.dependencies]
llama-cpp-2 = { version = "0.1.146", default-features = false }
llama-cpp-sys-2 = { version = "0.1.146", default-features = false }
```

- [ ] **Step 5: Verify macOS host still builds**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib platform::
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: both PASS on macOS.

## Task 3: Make macOS Sidecar Modules Safe on Windows

**Files:**
- Modify: `src-tauri/src/calendar/mod.rs`
- Modify: `src-tauri/src/meeting/syscap.rs`
- Modify: `src-tauri/src/screenrec/mod.rs`
- Modify: `src-tauri/src/screenrec/drive.rs`

- [ ] **Step 1: Add unsupported error assertions**

Add tests around pure functions that can run on macOS while checking Windows behavior by injected OS strings:

```rust
#[test]
fn resolve_sidecar_triple_rejects_windows() {
    assert!(sidecar_triple_for("windows", "x86_64").is_none());
}
```

- [ ] **Step 2: Extract sidecar triple helpers**

Use this pattern in each sidecar module:

```rust
fn sidecar_triple_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        _ => None,
    }
}
```

- [ ] **Step 3: Return unsupported errors on non-macOS**

For commands that currently assume a sidecar, return exact strings:

```rust
Err("screen recording is not supported on this platform".to_string())
Err(CalendarError::UnsupportedPlatform)
Err("system audio capture is not supported on this platform".to_string())
```

- [ ] **Step 4: Verify parser tests still pass**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib screenrec::tests calendar::tests meeting::syscap::tests
```

Expected: existing parser tests PASS.

## Task 4: Gate Runtime Startup

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/ui/tray.rs`
- Modify: `src-tauri/src/overlay.rs`

- [ ] **Step 1: Use `Capabilities::current()` in setup**

Add near setup startup:

```rust
let capabilities = crate::platform::Capabilities::current();
```

- [ ] **Step 2: Gate macOS-only startup calls**

Wrap:

```rust
if capabilities.meeting_auto_detect {
    crate::meeting::detector::spawn(...);
}

if capabilities.screen_recording {
    crate::overlay::create_screenrec_setup(&app.handle().clone());
}

if capabilities.bundle_self_update {
    crate::updater::spawn_updater(handle);
}
```

- [ ] **Step 3: Use platform-specific autostart setup**

Create a small helper in `src-tauri/src/platform.rs` if the plugin requires different launcher values:

```rust
pub fn install_autostart_plugin<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    {
        builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
    }
}
```

If this does not compile on Windows, replace the non-macOS branch with the plugin's Windows-supported initialization from the installed crate API.

- [ ] **Step 4: Verify macOS host**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

## Task 5: Windows CI Build Job

**Files:**
- Create: `.github/workflows/windows.yml`

- [ ] **Step 1: Add workflow**

```yaml
name: Windows

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: oven-sh/setup-bun@v2
      - name: Install CMake
        run: choco install cmake --installargs 'ADD_CMAKE_TO_PATH=System' -y
      - name: Install dependencies
        run: bun install
      - name: Build frontend
        run: bun run build
      - name: Test Rust library
        run: cargo test --manifest-path src-tauri/Cargo.toml --lib
      - name: Build Tauri app
        run: bun tauri build
```

- [ ] **Step 2: Push and read the first failure**

Expected first failure after Tasks 1-4 should identify the next real Windows-specific crate or API blocker, not Swift sidecars or obvious macOS-only startup calls.

## Task 6: Windows UI Capability States

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/views/sections/MeetingsView.tsx`
- Modify: `src/views/sections/RecordingsView.tsx`
- Modify: `src/components/PermissionsSection.tsx`

- [ ] **Step 1: Add backend command**

Add command:

```rust
#[tauri::command]
pub fn platform_capabilities() -> crate::platform::Capabilities {
    crate::platform::Capabilities::current()
}
```

Derive `serde::Serialize` on `Capabilities`.

- [ ] **Step 2: Add frontend API type**

```ts
export type PlatformCapabilities = {
  direct_voice_capture: boolean;
  local_database: boolean;
  meeting_auto_detect: boolean;
  system_audio_capture: boolean;
  calendar_matching: boolean;
  screen_recording: boolean;
  bundle_self_update: boolean;
};

export function platformCapabilities() {
  return invoke<PlatformCapabilities>("platform_capabilities");
}
```

- [ ] **Step 3: Disable unavailable controls**

Use `platformCapabilities()` to hide or disable screen recording, calendar matching, and auto-detect controls when the backend reports false.

## Task 7: Windows Installer Documentation

**Files:**
- Modify: `docs/WINDOWS.md`
- Modify: `README.md`

- [ ] **Step 1: Keep current warning until installer exists**

Do not add end-user install instructions while no release asset exists.

- [ ] **Step 2: Once CI produces an installer, add instructions**

Use:

```markdown
1. Download `Echo Scribe_*_x64-setup.exe` from the latest GitHub Release.
2. Run the installer.
3. If Windows SmartScreen warns about an unsigned app, choose "More info" and "Run anyway" only if you trust this release.
4. Launch Echo Scribe from the Start menu.
```

- [ ] **Step 3: Document limitations**

List unsupported Windows features until implemented:

```markdown
Currently unavailable on Windows: meeting auto-detection, system audio capture, screen recording, and calendar matching.
```

## Task 8: Native Windows Feature Parity

**Files:**
- Create: `src-tauri/src/input/hotkeys/windows.rs`
- Create: `src-tauri/src/input/focus/windows.rs`
- Create: `src-tauri/src/meeting/windows_audio.rs`
- Create: `src-tauri/src/screenrec/windows.rs`

- [ ] **Step 1: Implement global hotkey using a proven Windows API path**

Prefer a maintained Rust crate already used by Tauri or a direct `RegisterHotKey` implementation if swallowing is not required for v1.

- [ ] **Step 2: Implement paste-at-cursor**

Use Windows clipboard plus `Ctrl+V`, analogous to the current non-macOS fallback in `src-tauri/src/input/paste.rs`.

- [ ] **Step 3: Implement focus context**

Start with foreground window title and process name. Add browser URL/title later through browser-specific accessibility/UI Automation work.

- [ ] **Step 4: Implement meeting/system audio only after core voice capture works**

Use Windows WASAPI loopback for system audio capture.

---

## Self-Review

- Spec coverage: The plan covers build configuration, runtime gates, CI, installer documentation, and future Windows-native parity.
- Placeholder scan: The plan intentionally does not promise unsupported feature implementations in the first milestone. Unsupported features return explicit errors until implemented.
- Type consistency: `Capabilities` is the common backend type used by Rust startup, commands, and frontend API.
