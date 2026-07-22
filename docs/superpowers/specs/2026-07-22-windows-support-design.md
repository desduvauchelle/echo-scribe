# Windows Support — Clean Build, Honest Gating, Basic Dictation

**Date:** 2026-07-22
**Status:** Design — awaiting review
**Scope owner:** Denis

## Goal

Ship a Windows build of Echo Scribe that:

1. **Installs cleanly** from an NSIS `.exe` and launches without crashing.
2. **Honestly gates** every macOS-only feature — no broken buttons for features that
   physically cannot work on Windows.
3. **Runs the core dictation loop**: global hotkey / in-app button → mic capture →
   Parakeet transcription → paste into the focused app.

This is **not** a port of screen recording, system-audio capture, or calendar/meeting
detection. Those remain macOS-only and are gated off on Windows.

## Non-goals (explicitly deferred)

- Screen recording + editor (`screenrec` Swift sidecar / ScreenCaptureKit).
- System / loopback audio capture (`syscap` Swift sidecar).
- Calendar matching + meeting auto-detection (`calmatch` Swift sidecar / EventKit).
- Keystroke **suppression** (swallowing the hotkey) — macOS-only via CGEventTap.
- Accessibility-based selection capture / "edit selection" mode (AX APIs, macOS-only).
- Bundled self-update on Windows (`bundle_self_update` stays off).

## Current state (verified 2026-07-22)

The foundation already exists — this is mostly wiring, not greenfield:

- **`windows.yml` CI builds an NSIS installer and last passed** (2026-07-09). Rust lib
  tests pass on `windows-latest`; `tauri build` produces the `.exe`.
- **`src-tauri/src/platform.rs`** already models per-OS `Capabilities` and is unit-tested.
  On Windows every sidecar-backed flag is `false`; only `local_database` is `true`.
- **`platform_capabilities` command** exposes the struct to the frontend — but **nothing
  in the frontend consumes it today.** That is the core gap for honest gating.
- The dictation pipeline is cross-platform **except the trigger**:
  - Mic capture → `cpal` (`audio/recorder.rs`). ✅
  - Transcription → `transcribe-rs` ONNX / Parakeet, CPU. ✅
  - Paste → `arboard` set-text + `enigo` Ctrl+V (`input/paste.rs:115`, `synthesize_cmd_v`
    non-macOS branch). ✅
  - Coordinator state machine (`coordinator.rs`) is platform-agnostic. ✅
  - Local LLM → llama.cpp CPU baseline already wired under
    `cfg(not(target_os = "macos"))` in `Cargo.toml`. ✅
  - **Gap:** `input/hotkeys.rs:68` `spawn_listener` is a logged no-op on Windows, so the
    coordinator never receives a trigger. Optional enrichment (`focus::capture_context`,
    AX selection) is also no-op on Windows — acceptable for v1.

## Design

### 1. Capability model (`platform.rs`)

Flip `direct_voice_capture` to `true` on Windows so the dictation UI stays visible and the
loop is enabled. All other Windows flags stay `false`.

```
direct_voice_capture: true   // was: macos-only
local_database:       true
meeting_auto_detect:  false
system_audio_capture: false
calendar_matching:    false
screen_recording:     false
bundle_self_update:   false
```

Update the existing `windows_capabilities_disable_macos_sidecar_features` test to assert
`direct_voice_capture` is now `true` on Windows (the other assertions stand).

### 2. Dictation trigger on Windows

Two triggers, both feeding the **existing** `CoordinatorMsg::Hotkey` channel so
`coordinator.rs` is untouched.

**a. Global hotkey** — add `tauri-plugin-global-shortcut` (official, cross-platform). On
Windows, register the user's bound hotkey and forward `Pressed` / `Released` events into
`CoordinatorMsg::Hotkey(action, HotkeyEvent::Pressed|Released)`.

- Default Windows hotkey: a **non-conflicting combo** (e.g. `Ctrl+Alt+Space`) with
  **push-to-talk** (hold to record) to match the Mac UX. The keystroke is *not* swallowed
  on Windows — the non-conflicting default avoids interfering with the focused app.
- This lives behind `cfg(target_os = "windows")` (or `not(macos)`); macOS keeps its
  CGEventTap listener unchanged.

**b. In-app Record button** — a visible toggle button in the app window (click to start,
click to stop). Guaranteed trigger that needs no global-shortcut registration. Emits the
same `Pressed` (on start) / `Released` (on stop) into the coordinator channel via a small
command (e.g. `dictation_toggle`). Shown when `direct_voice_capture` is true — so it also
appears on macOS as a secondary trigger, which is harmless and arguably useful.

### 3. Frontend capability gating

Add a **`PlatformCapabilitiesProvider`** React context that calls `platformCapabilities()`
once at startup and exposes the flags via a `useCapabilities()` hook. Gate each surface:

| Capability | UI gated when false |
|---|---|
| `screen_recording` | Recording editor entry points, "Record screen" buttons, screenrec setup window triggers, camera self-view |
| `meeting_auto_detect` / `calendar_matching` | Meetings view/filter, calendar settings, meeting consent overlay, "match calendar" actions |
| `system_audio_capture` | System/loopback audio toggle in any recording UI |
| `direct_voice_capture` | Dictation trigger UI + in-app Record button (visible on Windows now) |
| `bundle_self_update` | "Check for updates" / self-update UI (Windows uses the installer) |

macOS **permissions** UI (mic / accessibility / screen / calendar TCC panels in
`PermissionsSection.tsx`, `Onboarding.tsx`, `PermissionWarningBanner.tsx`) is macOS-only —
hide or replace with a short "Not applicable on Windows" note, and skip the macOS
permission steps in onboarding.

Rule: gate on **capabilities** (what the OS can do), not on raw OS string, so the mapping
stays declarative and testable.

### 4. Backend hardening (no crashes on Windows)

- Audit startup (`lib.rs` setup): confirm no Swift-sidecar spawn (meeting detector,
  screenrec, calmatch) runs when its capability is false. Each such path must be
  capability-gated or return a friendly `Err`, never panic.
- Confirm `tauri.windows.conf.json`'s `externalBin: []` doesn't cause a launch-time
  sidecar-resolution failure.
- Any macOS-only command still registered on Windows must return a friendly
  `Err("… not supported on this platform")` (pattern already used, e.g.
  `copy_file_to_clipboard`), so an accidental invoke surfaces a toast, not a crash.

### 5. Installer + release

- Keep the Windows build in its **own `windows.yml`**, independent of the Mac
  `release.yml`. Publish the NSIS `.exe` from there (upgrade the current CI-artifact upload
  to a published Release asset on tag, keeping Mac and Windows release paths separate).
- `install.sh` stays macOS-only (already refuses non-Darwin). Windows users download the
  `.exe`. Landing-page copy: macOS = curl script; Windows = download the installer.

### 6. Testing

- **Backend unit:** update `platform::Capabilities` tests for the `direct_voice_capture`
  flip; add a test that a representative macOS-only command returns a friendly error on
  non-macOS (via the existing error-string pattern).
- **Frontend unit:** `PlatformCapabilitiesProvider` fetches and provides flags; gating
  tests assert each macOS-only surface is not rendered when its flag is false, and the
  dictation UI + Record button render when `direct_voice_capture` is true.
- **Manual smoke (Windows VM / hardware):** install the NSIS `.exe`, launch clean (no
  sidecar error), trigger dictation via both hotkey and Record button, confirm paste lands
  in a focused app (e.g. Notepad), and verify no screen-rec/meetings/calendar buttons are
  visible.

## Risks / open questions

- **Global-shortcut vs. custom listener divergence.** Two trigger code paths (macOS
  CGEventTap, Windows plugin) must produce identical `HotkeyEvent` semantics into the
  coordinator. Mitigation: a thin Windows adapter that emits the same enum; no coordinator
  changes.
- **cpal device quirks on Windows** (WASAPI default-device edge cases). Mitigation: the
  existing `RecorderError::NoDevice` friendly-error path already surfaces this; covered by
  the manual smoke test.
- **enigo Ctrl+V timing on Windows** (some apps need a small delay after clipboard set).
  Mitigation: verify in the smoke test; add a short delay only if observed.
- **Real-hardware validation.** CI proves it *compiles*; only a Windows VM/box proves it
  *runs*. The manual smoke test is a required gate before publishing a public download.
