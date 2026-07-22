# Windows Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows build that installs cleanly, honestly gates every macOS-only feature, and runs the core dictation loop (hotkey/button → mic → Parakeet → paste).

**Architecture:** The dictation pipeline (`cpal` mic → `transcribe-rs` → `arboard`+`enigo` paste → `coordinator.rs` state machine) is already cross-platform; only the *trigger* is missing on Windows. We add a Windows trigger (global-shortcut plugin + in-app button) that feeds the existing `CoordinatorMsg::Hotkey` channel, flip the `direct_voice_capture` capability on for Windows, and wire the already-tested `platform::Capabilities` model into the frontend to hide macOS-only surfaces.

**Tech Stack:** Rust / Tauri v2, `tauri-plugin-global-shortcut`, React + TypeScript, Vitest, `cpal`, `transcribe-rs`, `enigo`, `arboard`.

## Global Constraints

- All macOS-native code stays behind `#[cfg(target_os = "macos")]`; the crate MUST compile on `windows-latest` (`cargo test --lib`).
- Windows default dictation hotkey: **`Ctrl+Alt+Space`**, **push-to-talk** (hold to record). Not swallowed on Windows — chosen to avoid conflicts.
- In-app Record button: **toggle** (click to start, click to stop).
- Gate UI on **capabilities** returned by `platform_capabilities()`, never on a raw OS string.
- macOS-only commands invoked on Windows MUST return a friendly `Err("… not supported on this platform")` — never panic.
- Windows release stays in its own `.github/workflows/windows.yml`; `install.sh` remains macOS-only.
- TDD, DRY, YAGNI, frequent commits.

## File Structure

- `src-tauri/src/platform.rs` — capability model (modify: flip `direct_voice_capture` on Windows).
- `src-tauri/Cargo.toml` — add cross-platform `tauri-plugin-global-shortcut`.
- `src-tauri/src/lib.rs` — register the global-shortcut plugin; register the new dictation command.
- `src-tauri/src/input/trigger.rs` — **new**: platform-agnostic helpers that map trigger inputs to `HotkeyEvent` (unit-testable), + the Windows global-shortcut registration.
- `src-tauri/src/commands.rs` — wire the Windows trigger into `ensure_pipeline_started`; add `set_dictation_active` command.
- `src/lib/capabilities.tsx` — **new**: `PlatformCapabilitiesProvider` + `useCapabilities()`.
- `src/App.tsx` — wrap the tree in the provider.
- `src/components/DictationButton.tsx` — **new**: in-app Record toggle, gated on `direct_voice_capture`.
- `src/views/Main.tsx`, `src/views/Settings.tsx`, `src/components/UpdateBanner.tsx` — gate macOS-only surfaces.
- `src/lib/api.ts` — add `setDictationActive` binding.
- `.github/workflows/windows.yml` — publish the NSIS installer on tag.

---

### Task 1: Enable `direct_voice_capture` on Windows

**Files:**
- Modify: `src-tauri/src/platform.rs` (the `for_os` body + the `windows_capabilities_disable_macos_sidecar_features` test)

**Interfaces:**
- Produces: `Capabilities::for_os("windows").direct_voice_capture == true`; all other Windows sidecar flags remain `false`.

- [ ] **Step 1: Update the Windows test to expect the new flag**

In `src-tauri/src/platform.rs`, change the Windows test so it asserts dictation is now enabled:

```rust
    #[test]
    fn windows_capabilities_disable_macos_sidecar_features() {
        let caps = Capabilities::for_os("windows");
        // Sidecar-backed features remain off on Windows.
        assert!(!caps.meeting_auto_detect);
        assert!(!caps.system_audio_capture);
        assert!(!caps.calendar_matching);
        assert!(!caps.screen_recording);
        assert!(!caps.bundle_self_update);
        // Core dictation loop is enabled on Windows (cpal + Parakeet + paste).
        assert!(caps.direct_voice_capture);
        assert!(caps.local_database);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib windows_capabilities_disable_macos_sidecar_features`
Expected: FAIL — `assert!(caps.direct_voice_capture)` panics (currently `false`).

- [ ] **Step 3: Flip the flag in `for_os`**

In `src-tauri/src/platform.rs`, change `direct_voice_capture` so it is true on Windows too. Replace the field line in `for_os`:

```rust
    pub fn for_os(os: &str) -> Self {
        let macos = os == "macos";
        let windows = os == "windows";
        Self {
            // Dictation loop works on macOS and Windows (cpal mic, Parakeet
            // ASR, arboard+enigo paste). Other platforms stay off until proven.
            direct_voice_capture: macos || windows,
            local_database: true,
            meeting_auto_detect: macos,
            system_audio_capture: macos,
            calendar_matching: macos,
            screen_recording: macos,
            bundle_self_update: macos,
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib platform`
Expected: PASS (both `macos_capabilities_enable_sidecar_features` and the Windows test).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/platform.rs
git commit -m "feat(platform): enable direct_voice_capture on Windows"
```

---

### Task 2: Add the global-shortcut plugin

**Files:**
- Modify: `src-tauri/Cargo.toml` (add dependency)
- Modify: `src-tauri/src/lib.rs:199-206` (register the plugin in the builder)

**Interfaces:**
- Produces: `app.global_shortcut()` available on the `AppHandle` (via `tauri_plugin_global_shortcut::GlobalShortcutExt`).

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, in the cross-platform `[dependencies]` section (near the other `tauri-plugin-*` lines), add:

```toml
tauri-plugin-global-shortcut = "2"
```

- [ ] **Step 2: Register the plugin**

In `src-tauri/src/lib.rs`, in the `tauri::Builder::default()` chain (right after the existing `.plugin(tauri_plugin_autostart::init(...))`), add:

```rust
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS (no errors; new crate resolves).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "chore(deps): add tauri-plugin-global-shortcut and register it"
```

---

### Task 3: Windows global-hotkey trigger

**Files:**
- Create: `src-tauri/src/input/trigger.rs`
- Modify: `src-tauri/src/input/mod.rs` (add `pub mod trigger;`)
- Modify: `src-tauri/src/commands.rs` (`ensure_pipeline_started`, ~line 686-711)

**Interfaces:**
- Consumes: `crate::coordinator::{Action, CoordinatorMsg}`, `crate::input::hotkeys::HotkeyEvent`, `tokio::sync::mpsc::UnboundedSender`.
- Produces:
  - `fn shortcut_state_to_hotkey(pressed: bool) -> HotkeyEvent`
  - `#[cfg(not(target_os = "macos"))] fn register_default_dictation_shortcut(app: &tauri::AppHandle, coord_tx: UnboundedSender<CoordinatorMsg>) -> Result<(), String>`

- [ ] **Step 1: Write the failing test for the pure mapping**

Create `src-tauri/src/input/trigger.rs`:

```rust
//! Cross-platform dictation trigger helpers.
//!
//! macOS uses the CGEventTap listener in `hotkeys.rs`. Windows/Linux have no
//! event tap, so we drive the coordinator from the global-shortcut plugin and
//! the in-app Record button. Both funnel into `CoordinatorMsg::Hotkey`.

use crate::input::hotkeys::HotkeyEvent;

/// Map a "is the trigger currently active?" boolean to a coordinator hotkey
/// transition. `true` => `Pressed` (start capture), `false` => `Released`
/// (stop + transcribe + paste). Shared by the global shortcut and the button.
pub fn shortcut_state_to_hotkey(pressed: bool) -> HotkeyEvent {
    if pressed {
        HotkeyEvent::Pressed
    } else {
        HotkeyEvent::Released
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_pressed_and_released() {
        assert_eq!(shortcut_state_to_hotkey(true), HotkeyEvent::Pressed);
        assert_eq!(shortcut_state_to_hotkey(false), HotkeyEvent::Released);
    }
}
```

Add `pub mod trigger;` to `src-tauri/src/input/mod.rs` (alongside the existing `pub mod hotkeys;`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib trigger::tests`
Expected: FAIL — module not yet part of the tree / or PASS-after-add; if `mod.rs` not updated it fails to compile. Add the `pub mod trigger;` line, then it should compile and PASS. (If it already passes here, that's fine — the real deliverable is Step 3.)

- [ ] **Step 3: Add the Windows registration function**

Append to `src-tauri/src/input/trigger.rs`:

```rust
/// Register the default Windows/Linux dictation hotkey (Ctrl+Alt+Space,
/// push-to-talk) with the global-shortcut plugin, forwarding Pressed/Released
/// into the coordinator as `Action::VoiceAtCursor`.
///
/// Windows can't swallow the keystroke the way the macOS CGEventTap does, so
/// the default is a deliberately non-conflicting combo. Rebinding on Windows is
/// deferred; v1 ships this fixed default.
#[cfg(not(target_os = "macos"))]
pub fn register_default_dictation_shortcut(
    app: &tauri::AppHandle,
    coord_tx: tokio::sync::mpsc::UnboundedSender<crate::coordinator::CoordinatorMsg>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            let ev = shortcut_state_to_hotkey(matches!(event.state(), ShortcutState::Pressed));
            if let Err(e) = coord_tx.send(crate::coordinator::CoordinatorMsg::Hotkey(
                crate::coordinator::Action::VoiceAtCursor,
                ev,
            )) {
                tracing::warn!(target: "trigger", ?e, "failed to forward global shortcut to coordinator");
            }
        })
        .map_err(|e| format!("failed to register dictation hotkey: {e}"))?;

    tracing::info!(target: "trigger", "registered default dictation hotkey Ctrl+Alt+Space");
    Ok(())
}
```

- [ ] **Step 4: Call it from `ensure_pipeline_started`**

In `src-tauri/src/commands.rs`, inside `ensure_pipeline_started`, right after the four `spawn_listener(...)` calls (~line 711), add:

```rust
        // macOS drives the coordinator from the CGEventTap listeners above.
        // Non-macOS has no tap, so register the global-shortcut trigger.
        #[cfg(not(target_os = "macos"))]
        {
            if let Err(e) = crate::input::trigger::register_default_dictation_shortcut(
                app,
                coord_tx.clone(),
            ) {
                tracing::warn!(target: "trigger", %e, "dictation hotkey unavailable");
            }
        }
```

(Confirm the local variable is named `coord_tx` and `app: &AppHandle` is in scope at that point; both are per the existing signature.)

- [ ] **Step 5: Verify it compiles and the mapping test passes**

Run: `cd src-tauri && cargo test --lib trigger`
Expected: PASS. Also `cargo check` clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/input/trigger.rs src-tauri/src/input/mod.rs src-tauri/src/commands.rs
git commit -m "feat(input): Windows dictation hotkey via global-shortcut plugin"
```

---

### Task 4: In-app dictation toggle command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `set_dictation_active` command)
- Modify: `src-tauri/src/lib.rs` (import + `invoke_handler` registration)
- Modify: `src/lib/api.ts` (TypeScript binding)

**Interfaces:**
- Consumes: `crate::input::trigger::shortcut_state_to_hotkey`, `AppState.coord_tx`.
- Produces: Tauri command `set_dictation_active(active: bool) -> Result<(), String>`; TS `setDictationActive(active: boolean): Promise<void>`.

- [ ] **Step 1: Add the command**

In `src-tauri/src/commands.rs`, add near the other coordinator-sending commands (e.g. after the `CancelLogCapture` command ~line 553):

```rust
/// Start/stop dictation from the in-app Record button. `true` begins capture,
/// `false` ends it (transcribe + paste). Mirrors a push-to-talk hotkey but as a
/// toggle. Works on every platform that has `direct_voice_capture`.
#[tauri::command]
pub fn set_dictation_active(state: State<'_, AppState>, active: bool) -> Result<(), String> {
    let ev = crate::input::trigger::shortcut_state_to_hotkey(active);
    let guard = state
        .coord_tx
        .lock()
        .map_err(|_| "coord_tx lock poisoned".to_string())?;
    let tx = guard
        .as_ref()
        .ok_or_else(|| "dictation pipeline is not running yet".to_string())?;
    tx.send(CoordinatorMsg::Hotkey(Action::VoiceAtCursor, ev))
        .map_err(|e| format!("failed to send dictation event: {e}"))?;
    Ok(())
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`: add `set_dictation_active` to the `use crate::commands::{...}` import list (near `platform_capabilities`, line 94) and to the `tauri::generate_handler![...]` list (near line 209).

- [ ] **Step 3: Add the TypeScript binding**

In `src/lib/api.ts`, near `platformCapabilities`, add:

```ts
export const setDictationActive = (active: boolean): Promise<void> =>
  invoke("set_dictation_active", { active });
```

- [ ] **Step 4: Verify compile + typecheck**

Run: `cd src-tauri && cargo check` — Expected: PASS.
Run: `bun run build` (or `bunx tsc --noEmit`) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(dictation): set_dictation_active command for in-app trigger"
```

---

### Task 5: Frontend capabilities provider

**Files:**
- Create: `src/lib/capabilities.tsx`
- Create: `src/lib/capabilities.test.tsx`
- Modify: `src/App.tsx` (wrap the tree)

**Interfaces:**
- Consumes: `platformCapabilities()` and `PlatformCapabilities` from `src/lib/api.ts`.
- Produces: `<PlatformCapabilitiesProvider>` and `useCapabilities(): PlatformCapabilities` (all flags default to `false` until loaded, except nothing is assumed true).

- [ ] **Step 1: Write the failing test**

Create `src/lib/capabilities.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockCaps = {
  direct_voice_capture: true,
  local_database: true,
  meeting_auto_detect: false,
  system_audio_capture: false,
  calendar_matching: false,
  screen_recording: false,
  bundle_self_update: false,
};

vi.mock("./api", () => ({
  platformCapabilities: vi.fn(() => Promise.resolve(mockCaps)),
}));

import { PlatformCapabilitiesProvider, useCapabilities } from "./capabilities";

function Probe() {
  const caps = useCapabilities();
  return (
    <div>
      <span data-testid="voice">{String(caps.direct_voice_capture)}</span>
      <span data-testid="screen">{String(caps.screen_recording)}</span>
    </div>
  );
}

describe("PlatformCapabilitiesProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provides fetched capability flags", async () => {
    render(
      <PlatformCapabilitiesProvider>
        <Probe />
      </PlatformCapabilitiesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toBe("true"));
    expect(screen.getByTestId("screen").textContent).toBe("false");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/capabilities.test.tsx`
Expected: FAIL — `./capabilities` module does not exist.

- [ ] **Step 3: Implement the provider**

Create `src/lib/capabilities.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { platformCapabilities, type PlatformCapabilities } from "./api";

// Conservative defaults: assume nothing is available until the backend answers,
// so we never flash a macOS-only surface on Windows during load.
const DEFAULT_CAPS: PlatformCapabilities = {
  direct_voice_capture: false,
  local_database: true,
  meeting_auto_detect: false,
  system_audio_capture: false,
  calendar_matching: false,
  screen_recording: false,
  bundle_self_update: false,
};

const CapabilitiesContext = createContext<PlatformCapabilities>(DEFAULT_CAPS);

export function PlatformCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [caps, setCaps] = useState<PlatformCapabilities>(DEFAULT_CAPS);

  useEffect(() => {
    let alive = true;
    platformCapabilities()
      .then((c) => {
        if (alive) setCaps(c);
      })
      .catch(() => {
        // Leave DEFAULT_CAPS in place; a failed probe hides macOS-only UI
        // rather than showing broken buttons.
      });
    return () => {
      alive = false;
    };
  }, []);

  return <CapabilitiesContext.Provider value={caps}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): PlatformCapabilities {
  return useContext(CapabilitiesContext);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/capabilities.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wrap the app**

In `src/App.tsx`, import the provider and wrap the existing tree inside `ToastProvider`:

```tsx
import { PlatformCapabilitiesProvider } from "./lib/capabilities";

export default function App() {
  return (
    <ToastProvider>
      <PlatformCapabilitiesProvider>
        <ActivityPanelProvider>
          <AppShell />
          <ActivityPanel />
        </ActivityPanelProvider>
      </PlatformCapabilitiesProvider>
    </ToastProvider>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/capabilities.tsx src/lib/capabilities.test.tsx src/App.tsx
git commit -m "feat(ui): PlatformCapabilities provider + useCapabilities hook"
```

---

### Task 6: In-app Record button

**Files:**
- Create: `src/components/DictationButton.tsx`
- Create: `src/components/DictationButton.test.tsx`
- Modify: `src/views/Main.tsx` (render the button in the top bar)

**Interfaces:**
- Consumes: `useCapabilities()`, `setDictationActive` from `src/lib/api.ts`.
- Produces: `<DictationButton />` — renders only when `direct_voice_capture` is true; toggles capture.

- [ ] **Step 1: Write the failing test**

Create `src/components/DictationButton.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const setDictationActive = vi.fn(() => Promise.resolve());
vi.mock("../lib/api", () => ({ setDictationActive: (a: boolean) => setDictationActive(a) }));

const caps = { direct_voice_capture: true };
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => caps }));

import DictationButton from "./DictationButton";

describe("DictationButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    caps.direct_voice_capture = true;
  });

  it("toggles dictation active state on click", async () => {
    render(<DictationButton />);
    const btn = screen.getByRole("button", { name: /record|dictate|stop/i });
    fireEvent.click(btn);
    expect(setDictationActive).toHaveBeenCalledWith(true);
    fireEvent.click(btn);
    expect(setDictationActive).toHaveBeenCalledWith(false);
  });

  it("renders nothing when direct_voice_capture is false", () => {
    caps.direct_voice_capture = false;
    const { container } = render(<DictationButton />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/components/DictationButton.test.tsx`
Expected: FAIL — `./DictationButton` does not exist.

- [ ] **Step 3: Implement the button**

Create `src/components/DictationButton.tsx`:

```tsx
import { useState } from "react";
import { setDictationActive } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";

/// In-app dictation trigger. A toggle: first click starts capture, second stops
/// it (transcribe + paste). Complements the global hotkey and needs no global
/// shortcut registration. Only shown where the platform supports dictation.
export default function DictationButton() {
  const caps = useCapabilities();
  const [active, setActive] = useState(false);

  if (!caps.direct_voice_capture) return null;

  const toggle = async () => {
    const next = !active;
    setActive(next);
    try {
      await setDictationActive(next);
    } catch {
      // Roll back the visual state if the pipeline isn't ready.
      setActive(!next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={
        active
          ? "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
          : "rounded-md bg-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
      }
      aria-pressed={active}
    >
      {active ? "Stop dictation" : "Record / Dictate"}
    </button>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/components/DictationButton.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Mount it in the top bar**

In `src/views/Main.tsx`, import `DictationButton` and render it in the header/top-bar region (near the Settings control). Add:

```tsx
import DictationButton from "../components/DictationButton";
```

and place `<DictationButton />` in the top-bar JSX (the row that holds the Settings/theme controls).

- [ ] **Step 6: Commit**

```bash
git add src/components/DictationButton.tsx src/components/DictationButton.test.tsx src/views/Main.tsx
git commit -m "feat(ui): in-app dictation Record button"
```

---

### Task 7: Gate macOS-only surfaces

**Files:**
- Modify: `src/views/Main.tsx` (hide Meetings + Recordings nav)
- Modify: `src/components/UpdateBanner.tsx` (hide when no self-update)
- Modify: `src/views/Main.tsx` test or create `src/views/Main.gating.test.tsx`

**Interfaces:**
- Consumes: `useCapabilities()`.

- [ ] **Step 1: Write the failing gating test**

Create `src/views/Main.gating.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const caps = {
  direct_voice_capture: true,
  local_database: true,
  meeting_auto_detect: false,
  system_audio_capture: false,
  calendar_matching: false,
  screen_recording: false,
  bundle_self_update: false,
};
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => caps }));

import { MacOnlyNav } from "./Main";

describe("Main nav gating", () => {
  it("hides Meetings and Recordings when their capabilities are false", () => {
    render(<MacOnlyNav />);
    expect(screen.queryByText("Meetings")).toBeNull();
    expect(screen.queryByText("Recordings")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/views/Main.gating.test.tsx`
Expected: FAIL — `MacOnlyNav` is not exported.

- [ ] **Step 3: Extract and gate the macOS-only nav items**

In `src/views/Main.tsx`, wrap the `Meetings` and `Recordings` `NavItem`s in a small exported component that reads capabilities. Replace the two inline `NavItem`s (lines ~144-155) with `<MacOnlyNav section={section} setSection={setSection} />` and add:

```tsx
export function MacOnlyNav(props?: {
  section?: MainSection;
  setSection?: (s: MainSection) => void;
}) {
  const caps = useCapabilities();
  return (
    <>
      {caps.meeting_auto_detect && (
        <NavItem
          label="Meetings"
          active={props?.section?.kind === "meetings"}
          onClick={() => props?.setSection?.({ kind: "meetings" })}
        />
      )}
      {caps.screen_recording && (
        <NavItem
          label="Recordings"
          active={props?.section?.kind === "recordings"}
          onClick={() => props?.setSection?.({ kind: "recordings" })}
        />
      )}
    </>
  );
}
```

Add `import { useCapabilities } from "../lib/capabilities";` at the top of `Main.tsx`. (Keep the original `NavItem` icon props — copy them from the lines you are replacing so the icons stay identical.)

- [ ] **Step 4: Guard the section routes too**

In the `switch (section.kind)` in `Main.tsx`, make the `"meetings"` and `"recordings"` cases fall through to the dashboard when their capability is false, so a stale route can't render a gated view:

```tsx
      case "meetings":
        return caps.meeting_auto_detect ? <MeetingsView /> : <DashboardView />;
      case "recordings":
        return caps.screen_recording ? <RecordingsView /> : <DashboardView />;
```

(Read `const caps = useCapabilities();` once at the top of the component that owns this switch.)

- [ ] **Step 5: Gate the UpdateBanner**

In `src/components/UpdateBanner.tsx`, at the top of the component body add:

```tsx
  const caps = useCapabilities();
  if (!caps.bundle_self_update) return null;
```

with `import { useCapabilities } from "../lib/capabilities";`.

- [ ] **Step 6: Run the gating test to verify it passes**

Run: `bunx vitest run src/views/Main.gating.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the full frontend suite**

Run: `bunx vitest run`
Expected: PASS (513+ existing tests still green).

- [ ] **Step 8: Commit**

```bash
git add src/views/Main.tsx src/views/Main.gating.test.tsx src/components/UpdateBanner.tsx
git commit -m "feat(ui): gate Meetings/Recordings/self-update on non-macOS"
```

---

### Task 8: Backend hardening — no crashes on Windows

**Files:**
- Modify: `src-tauri/src/lib.rs` (audit startup spawns; guard any ungated sidecar spawn)
- Modify: `src-tauri/src/commands.rs` (add a capabilities-gated startup test)

**Interfaces:**
- Produces: startup that spawns **no** Swift-sidecar-backed loop when its capability is false; a test asserting Windows capabilities keep sidecar features off.

- [ ] **Step 1: Audit for ungated sidecar spawns**

Run: `cd src-tauri && grep -n 'detector::spawn\|screenrec\|calmatch\|syscap\|Command::new' src/lib.rs`
Expected: the meeting detector spawn is already wrapped in `if capabilities.meeting_auto_detect`. Confirm no other sidecar loop (screenrec/calmatch) is spawned unconditionally at startup. If one is, wrap it in the matching `if capabilities.<flag>` guard, mirroring the meeting-detector pattern.

- [ ] **Step 2: Write a test that Windows startup capabilities gate the sidecars**

In `src-tauri/src/platform.rs` `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn non_macos_never_enables_sidecar_loops() {
        for os in ["windows", "linux"] {
            let caps = Capabilities::for_os(os);
            assert!(!caps.meeting_auto_detect, "{os} must not auto-detect meetings");
            assert!(!caps.screen_recording, "{os} must not screen record");
            assert!(!caps.system_audio_capture, "{os} must not capture system audio");
            assert!(!caps.calendar_matching, "{os} must not match calendars");
        }
    }
```

- [ ] **Step 3: Run the test**

Run: `cd src-tauri && cargo test --lib non_macos_never_enables_sidecar_loops`
Expected: PASS.

- [ ] **Step 4: Full lib test run (the Windows-CI gate)**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS. This is the same command `windows.yml` runs.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/platform.rs
git commit -m "fix(platform): assert + enforce sidecar loops stay off on non-macOS"
```

---

### Task 9: Publish the Windows installer on tag

**Files:**
- Modify: `.github/workflows/windows.yml`

**Interfaces:**
- Produces: a GitHub Release asset (the NSIS `.exe`) when a `v*.*.*` tag is pushed.

- [ ] **Step 1: Add a tag trigger and a release-publish step**

In `.github/workflows/windows.yml`, add `tags: ['v*.*.*']` to the `push` trigger, grant `contents: write`, and add a publish step that runs only on tag pushes. After the existing "Upload Windows installer" step, add:

```yaml
      - name: Publish installer to the tagged Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          files: |
            src-tauri/target/release/bundle/nsis/*.exe
          fail_on_unmatched_files: true
```

And change the `permissions:` block at the top from `contents: read` to `contents: write`.

- [ ] **Step 2: Validate the workflow YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/windows.yml'))" && echo OK`
Expected: `OK` (valid YAML).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/windows.yml
git commit -m "ci(windows): publish NSIS installer to the tagged Release"
```

---

## Manual verification (required gate before public download)

CI proves the app *compiles* on Windows; only real hardware proves it *runs*. On a Windows 10/11 machine or VM:

1. Install the NSIS `.exe`. App launches with **no** sidecar error dialog.
2. Sidebar shows Dashboard/Chat/Daily but **not** Meetings or Recordings.
3. Settings shows **no** system-audio, calendar, or screen-recording toggles; no macOS permission panels.
4. Press-and-hold **Ctrl+Alt+Space**, speak, release → transcribed text pastes into a focused Notepad window.
5. Click the in-app **Record / Dictate** button, speak, click **Stop dictation** → same paste result.
6. `echo-scribe.log` shows `registered default dictation hotkey Ctrl+Alt+Space` and no panics.

## Self-Review Notes

- **Spec coverage:** Capability flip (§1)→Task 1; trigger/global-shortcut + button (§2)→Tasks 2-4,6; frontend gating (§3)→Tasks 5,7; backend hardening (§4)→Task 8; installer/release (§5)→Task 9; testing (§6)→tests in every task + manual gate. All spec sections mapped.
- **Type consistency:** `shortcut_state_to_hotkey(bool)->HotkeyEvent` defined in Task 3, consumed in Task 4; `setDictationActive(boolean)` defined Task 4, consumed Task 6; `useCapabilities()` defined Task 5, consumed Tasks 6-7.
- **Deferred (documented non-goals):** Windows hotkey rebinding UI, keystroke suppression, AX selection/"edit selection" mode — all intentionally out of scope for v1.
