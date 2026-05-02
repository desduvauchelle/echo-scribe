# Phase 0 — Tauri Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Tauri+Rust+React skeleton where pressing **Right Control** records audio, releasing it pastes `"hello world"` at the cursor in any app, with a tray icon reflecting recording state.

**Architecture:** Single Tauri binary. Rust backend owns the audio/hotkey/paste pipeline coordinated through an mpsc-driven state machine. React frontend is a placeholder pane (real UI is Phase 5). No ASR, no LLM, no DB, no UI views — those are later phases. The hardcoded `"hello world"` transcription proves the pipeline shape before adding ML.

**Tech Stack:** Tauri v2, Rust 1.83+, React 18 + TypeScript + Tailwind v4, `rdev` (hotkeys), `cpal` (audio), `enigo` (paste), `tokio` (async), `tracing` + `tracing-subscriber` (logs).

---

## File Structure

After Phase 0 the repo looks like this. Files marked **NEW** are created in this plan; **DELETED** are removed in Task 2.

```
echo-scribe/
├── BUILD_PLAN.md                           (kept, marked superseded)
├── CLAUDE.md                               (kept)
├── README.md                               (kept)
├── decisions/                              (kept)
├── docs/                                   (kept; spec + this plan live here)
├── apps/                                   DELETED
├── packages/                               DELETED
├── scripts/                                DELETED
├── _old/                                   DELETED
├── package.json                            NEW (Tauri scaffold; replaces old monorepo root)
├── tsconfig.json                           NEW
├── vite.config.ts                          NEW
├── index.html                              NEW
├── src/                                    NEW (React frontend)
│   ├── App.tsx
│   ├── main.tsx
│   └── styles/globals.css
└── src-tauri/                              NEW (Rust backend)
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── icons/
    └── src/
        ├── main.rs                         Tauri entry point
        ├── lib.rs                          Library root, wires managers
        ├── coordinator.rs                  mpsc state machine
        ├── input/
        │   ├── mod.rs
        │   ├── binding.rs                  Hotkey binding type w/ left/right modifier specificity
        │   ├── hotkeys.rs                  rdev wrapper
        │   └── paste.rs                    enigo wrapper
        ├── audio/
        │   ├── mod.rs
        │   └── recorder.rs                 cpal wrapper
        └── ui/
            ├── mod.rs
            └── tray.rs                     System tray with red/green state
```

Each Rust file has one responsibility. Files that change together (e.g. `binding.rs` + `hotkeys.rs`) live together under `input/`.

---

## Tasks

### Task 1: Pre-rebuild safety checkpoint

Tag the current `main` HEAD as `swift-archive` so the Swift+Bun implementation stays accessible.

**Files:** None modified. Git refs only.

- [ ] **Step 1: Verify clean working tree on main**

Run:
```bash
git status && git branch --show-current
```
Expected: `nothing to commit, working tree clean`; current branch is `main`.

- [ ] **Step 2: Create the archive tag**

Run:
```bash
git tag -a swift-archive -m "Swift+Bun-sidecar implementation, archived before Tauri rebuild"
```
Expected: silent success.

- [ ] **Step 3: Verify the tag points at HEAD**

Run:
```bash
git show swift-archive --no-patch --format="%H %s"
```
Expected: prints the current HEAD commit hash and its message.

---

### Task 2: Wipe the working tree

Delete Swift+Bun source artifacts. Keep documentation and config.

**Files:**
- Delete: `apps/`, `packages/`, `scripts/`, `_old/`, `node_modules/`, `bun.lock`, `package.json`, `biome.json`, `tsconfig.json`
- Modify: `BUILD_PLAN.md` (prepend supersedence notice)
- Keep: `README.md`, `CLAUDE.md`, `decisions/`, `docs/`, `.gitignore`, `.github/`, `.claude/`, `.git/`

- [ ] **Step 1: Delete source directories**

Run:
```bash
rm -rf apps packages scripts _old node_modules
```
Expected: silent success.

- [ ] **Step 2: Delete root config files**

Run:
```bash
rm -f bun.lock package.json biome.json tsconfig.json
```
Expected: silent success.

- [ ] **Step 3: Verify what remains**

Run:
```bash
ls -A
```
Expected output (order may vary): `.claude  .git  .github  .gitignore  BUILD_PLAN.md  CLAUDE.md  README.md  decisions  docs`. No `apps`, `packages`, `scripts`, `_old`, `node_modules`, `package.json`, `bun.lock`, `biome.json`, `tsconfig.json`.

- [ ] **Step 4: Mark BUILD_PLAN.md as superseded**

Read the current first line of `BUILD_PLAN.md` to confirm where to insert. Then prepend the following block to the very top of the file (before the existing `# Echo Scribe — Build Plan for Claude Code` heading):

```markdown
> **SUPERSEDED 2026-05-01.** This brief described the original Swift+Bun-sidecar architecture. The authoritative design is now `docs/superpowers/specs/2026-05-01-tauri-rebuild-design.md` and the current build plan is `docs/superpowers/plans/2026-05-01-phase-0-tauri-skeleton.md`. This file is preserved for historical context only — do not implement against it.

---

```

- [ ] **Step 5: Commit the wipe**

Run:
```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: wipe Swift+Bun work for Tauri rebuild

Tagged previous implementation as swift-archive. Working tree is now
clean docs + decisions, ready for Tauri scaffolding.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```
Expected: commit succeeds.

---

### Task 3: Scaffold the Tauri project

Initialize Tauri v2 with React+TS+Tailwind v4 at the repo root.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles/globals.css`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/icons/*`

- [ ] **Step 1: Run the Tauri scaffolder**

Run from repo root:
```bash
bun create tauri-app . --identifier com.echoscribe.app
```

When prompted, answer:
- Project name → `echo-scribe`
- Identifier → `com.echoscribe.app`
- Frontend language → `TypeScript / JavaScript`
- Package manager → `bun`
- UI template → `React`
- UI flavor → `TypeScript`

Expected: project files created. If `bun create tauri-app` is unavailable, fall back to `npm create tauri-app@latest .` and pick the same options.

- [ ] **Step 2: Verify scaffold layout**

Run:
```bash
ls src src-tauri && cat src-tauri/Cargo.toml | head -15
```
Expected: `src/` contains `App.tsx`, `main.tsx`; `src-tauri/` contains `Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`. `Cargo.toml` shows `[package] name = "echo-scribe"` (or similar) and `tauri = { version = "2", ... }`.

- [ ] **Step 3: Install Tailwind v4**

Run:
```bash
bun add -D tailwindcss @tailwindcss/vite
```
Expected: dependencies added to `package.json`.

- [ ] **Step 4: Wire Tailwind into Vite**

Replace `vite.config.ts` with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
});
```

- [ ] **Step 5: Create the Tailwind stylesheet**

Create `src/styles/globals.css`:

```css
@import "tailwindcss";

html, body, #root {
  height: 100%;
  margin: 0;
}
```

Modify `src/main.tsx` so its imports look like this (keep the rest of the file):

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 6: Replace App.tsx with a placeholder**

Replace `src/App.tsx` with:

```tsx
export default function App() {
  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Echo Scribe</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Phase 0 skeleton. Press Right Control anywhere to test the pipeline.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Boot the dev server to verify**

Run:
```bash
bun tauri dev
```
Expected: a window opens with the dark "Echo Scribe" placeholder. Confirm the window appears, then kill with Ctrl+C.

- [ ] **Step 8: Commit the scaffold**

Run:
```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: scaffold Tauri v2 + React + TS + Tailwind v4

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Configure Tauri app metadata

Set window dimensions, menu, and basic identifiers in `tauri.conf.json`.

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Update tauri.conf.json**

Replace the `app.windows` array and `productName` in `src-tauri/tauri.conf.json` so the relevant sections look like:

```json
{
  "productName": "Echo Scribe",
  "version": "0.1.0",
  "identifier": "com.echoscribe.app",
  "build": {
    "beforeDevCommand": "bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "bun run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Echo Scribe",
        "width": 900,
        "height": 600,
        "minWidth": 600,
        "minHeight": 400,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "category": "Productivity",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

Keep any existing keys the scaffold provided that aren't shown above.

- [ ] **Step 2: Verify dev still boots**

Run:
```bash
bun tauri dev
```
Expected: window opens at 900×600 with title "Echo Scribe". Kill with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "chore(tauri): set product name and window defaults

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Add Rust dependencies

Add the crates Phase 0 needs: `rdev`, `cpal`, `enigo`, `tokio`, `tracing`, `tracing-subscriber`, `serde`, `thiserror`.

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies**

Add to the `[dependencies]` table in `src-tauri/Cargo.toml` (preserve existing tauri/serde entries; add anything missing):

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
tokio = { version = "1", features = ["sync", "rt-multi-thread", "macros", "time"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
rdev = "0.5"
cpal = "0.15"
enigo = "0.2"
```

- [ ] **Step 2: Verify it builds**

Run:
```bash
cd src-tauri && cargo build --release 2>&1 | tail -20 && cd ..
```
Expected: builds successfully. If a crate version is missing or yanked, run `cargo search <name>` to find the latest and update accordingly.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build(rust): add Phase 0 dependencies

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Define the Binding type

A `Binding` is either a single key or a modifier-aware combo. Left/right modifier specificity is preserved.

**Files:**
- Create: `src-tauri/src/input/mod.rs`, `src-tauri/src/input/binding.rs`

- [ ] **Step 1: Write failing tests**

Create `src-tauri/src/input/binding.rs`:

```rust
use rdev::Key;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModifierSide {
    Left,
    Right,
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModifierKind {
    Control,
    Shift,
    Alt,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub primary: SerKey,
    pub modifiers: Vec<(ModifierKind, ModifierSide)>,
}

/// Serializable wrapper around `rdev::Key` since rdev's `Key` doesn't impl Serialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerKey(pub Key);

impl Binding {
    /// A single-key binding. No modifiers.
    pub fn single(key: Key) -> Self {
        Self { primary: SerKey(key), modifiers: Vec::new() }
    }

    /// True if the binding is a single key (no modifiers required).
    pub fn is_single(&self) -> bool {
        self.modifiers.is_empty()
    }

    /// Check whether the given currently-pressed-keys set satisfies this binding.
    pub fn is_satisfied_by(&self, pressed: &[Key]) -> bool {
        // primary must be pressed
        if !pressed.contains(&self.primary.0) {
            return false;
        }
        // every required modifier must be pressed on the right side
        for (kind, side) in &self.modifiers {
            if !modifier_satisfied(*kind, *side, pressed) {
                return false;
            }
        }
        true
    }
}

fn modifier_satisfied(kind: ModifierKind, side: ModifierSide, pressed: &[Key]) -> bool {
    let (left, right) = match kind {
        ModifierKind::Control => (Key::ControlLeft, Key::ControlRight),
        ModifierKind::Shift => (Key::ShiftLeft, Key::ShiftRight),
        ModifierKind::Alt => (Key::Alt, Key::AltGr),
        ModifierKind::Meta => (Key::MetaLeft, Key::MetaRight),
    };
    let left_pressed = pressed.contains(&left);
    let right_pressed = pressed.contains(&right);
    match side {
        ModifierSide::Left => left_pressed,
        ModifierSide::Right => right_pressed,
        ModifierSide::Either => left_pressed || right_pressed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_key_binding_is_satisfied_when_key_pressed() {
        let b = Binding::single(Key::ControlRight);
        assert!(b.is_satisfied_by(&[Key::ControlRight]));
        assert!(!b.is_satisfied_by(&[Key::ControlLeft]));
        assert!(!b.is_satisfied_by(&[]));
    }

    #[test]
    fn combo_requires_both_primary_and_modifier() {
        let b = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        assert!(b.is_satisfied_by(&[Key::KeyL, Key::MetaRight]));
        assert!(!b.is_satisfied_by(&[Key::KeyL, Key::MetaLeft]));
        assert!(!b.is_satisfied_by(&[Key::KeyL]));
    }

    #[test]
    fn either_side_modifier_accepts_left_or_right() {
        let b = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Shift, ModifierSide::Either)],
        };
        assert!(b.is_satisfied_by(&[Key::KeyL, Key::ShiftLeft]));
        assert!(b.is_satisfied_by(&[Key::KeyL, Key::ShiftRight]));
        assert!(!b.is_satisfied_by(&[Key::KeyL]));
    }

    #[test]
    fn is_single_distinguishes_combos_from_singles() {
        assert!(Binding::single(Key::ControlRight).is_single());
        let combo = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        assert!(!combo.is_single());
    }
}
```

Create `src-tauri/src/input/mod.rs`:

```rust
pub mod binding;
```

Update `src-tauri/src/lib.rs` to include the module. Find the existing `pub fn run()` (or similar Tauri entry) and add this `pub mod input;` line near the top of the file (just under any existing `pub mod` lines or at file top if none):

```rust
pub mod input;
```

- [ ] **Step 2: Run tests, expect failures or successes**

Run:
```bash
cd src-tauri && cargo test --lib input::binding 2>&1 | tail -20 && cd ..
```
Expected: 4 tests pass. (The implementation was written together with the tests; this step verifies it.)

If any test fails, debug the implementation in `binding.rs` until all pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/input src-tauri/src/lib.rs
git commit -m "feat(input): Binding type with left/right modifier specificity

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Implement the hotkey listener

A `HotkeyManager` that listens for OS-level keyboard events via `rdev` and emits press/release events on a registered binding.

**Files:**
- Create: `src-tauri/src/input/hotkeys.rs`
- Modify: `src-tauri/src/input/mod.rs`

- [ ] **Step 1: Write the hotkeys module**

Create `src-tauri/src/input/hotkeys.rs`:

```rust
use std::sync::{Arc, Mutex};
use std::thread;

use rdev::{listen, Event, EventType, Key};
use tokio::sync::mpsc;
use tracing::{error, info};

use super::binding::Binding;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    /// The bound action's binding became fully satisfied (transition from not-satisfied to satisfied).
    Pressed,
    /// The binding stopped being satisfied (any required key released).
    Released,
}

/// Spawns a background thread that listens to global keyboard events and
/// emits HotkeyEvent::Pressed / Released on the given channel whenever the
/// given binding's satisfaction state changes.
///
/// `rdev::listen` blocks the calling thread, so this must run on a dedicated thread.
pub fn spawn_listener(binding: Binding, tx: mpsc::UnboundedSender<HotkeyEvent>) {
    thread::spawn(move || {
        let pressed: Arc<Mutex<Vec<Key>>> = Arc::new(Mutex::new(Vec::new()));
        let satisfied = Arc::new(Mutex::new(false));

        let pressed_for_cb = Arc::clone(&pressed);
        let satisfied_for_cb = Arc::clone(&satisfied);
        let binding = binding.clone();

        info!(?binding, "starting hotkey listener");

        let result = listen(move |event: Event| {
            let mut pressed = match pressed_for_cb.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            match event.event_type {
                EventType::KeyPress(k) => {
                    if !pressed.contains(&k) {
                        pressed.push(k);
                    }
                }
                EventType::KeyRelease(k) => {
                    pressed.retain(|p| *p != k);
                }
                _ => return,
            }
            let now_satisfied = binding.is_satisfied_by(&pressed);
            let mut sat = match satisfied_for_cb.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            if now_satisfied && !*sat {
                *sat = true;
                let _ = tx.send(HotkeyEvent::Pressed);
            } else if !now_satisfied && *sat {
                *sat = false;
                let _ = tx.send(HotkeyEvent::Released);
            }
        });

        if let Err(e) = result {
            error!(?e, "rdev listener exited unexpectedly");
        }
    });
}
```

- [ ] **Step 2: Update input/mod.rs**

Replace `src-tauri/src/input/mod.rs` with:

```rust
pub mod binding;
pub mod hotkeys;
```

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cd src-tauri && cargo build --lib 2>&1 | tail -20 && cd ..
```
Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/input
git commit -m "feat(input): rdev-based hotkey listener with press/release events

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Implement the audio recorder

A `Recorder` that captures microphone input via `cpal` into a `Vec<f32>` buffer.

**Files:**
- Create: `src-tauri/src/audio/mod.rs`, `src-tauri/src/audio/recorder.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the recorder**

Create `src-tauri/src/audio/recorder.rs`:

```rust
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, Stream};
use thiserror::Error;
use tracing::{info, warn};

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error("no default input device")]
    NoDevice,
    #[error("failed to build input stream: {0}")]
    BuildStream(String),
    #[error("failed to start input stream: {0}")]
    StartStream(String),
    #[error("recorder is not running")]
    NotRunning,
}

pub struct Recorder {
    stream: Option<Stream>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            stream: None,
            samples: Arc::new(Mutex::new(Vec::new())),
            sample_rate: 0,
        }
    }

    pub fn start(&mut self) -> Result<(), RecorderError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or(RecorderError::NoDevice)?;
        let config = device
            .default_input_config()
            .map_err(|e| RecorderError::BuildStream(e.to_string()))?;
        self.sample_rate = config.sample_rate().0;
        info!(sample_rate = self.sample_rate, format = ?config.sample_format(), "starting recorder");

        // Reset buffer
        if let Ok(mut s) = self.samples.lock() {
            s.clear();
        }

        let samples = Arc::clone(&self.samples);
        let stream_config = config.config();
        let stream = match config.sample_format() {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| append_samples(&samples, data),
                |err| warn!(?err, "input stream error"),
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples(&samples, &converted);
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let converted: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    append_samples(&samples, &converted);
                },
                |err| warn!(?err, "input stream error"),
                None,
            ),
            other => return Err(RecorderError::BuildStream(format!("unsupported sample format {:?}", other))),
        }
        .map_err(|e| RecorderError::BuildStream(e.to_string()))?;

        stream.play().map_err(|e| RecorderError::StartStream(e.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(Vec<f32>, u32), RecorderError> {
        let stream = self.stream.take().ok_or(RecorderError::NotRunning)?;
        drop(stream); // dropping stops the cpal stream
        let samples = self.samples.lock().map(|s| s.clone()).unwrap_or_default();
        info!(sample_count = samples.len(), "stopped recorder");
        Ok((samples, self.sample_rate))
    }
}

fn append_samples(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32]) {
    if let Ok(mut b) = buf.lock() {
        b.extend_from_slice(data);
    }
}
```

Create `src-tauri/src/audio/mod.rs`:

```rust
pub mod recorder;
```

Add to `src-tauri/src/lib.rs` near the other `pub mod` lines:

```rust
pub mod audio;
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd src-tauri && cargo build --lib 2>&1 | tail -20 && cd ..
```
Expected: builds without errors. Warnings about unused imports are OK at this stage.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/audio src-tauri/src/lib.rs
git commit -m "feat(audio): cpal-based microphone recorder

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 9: Implement paste at cursor

A `paste` function that copies text to the clipboard and synthesizes Cmd+V via `enigo`.

**Files:**
- Create: `src-tauri/src/input/paste.rs`
- Modify: `src-tauri/src/input/mod.rs`

- [ ] **Step 1: Write the paste module**

Create `src-tauri/src/input/paste.rs`:

```rust
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use thiserror::Error;
use tracing::{info, warn};

#[derive(Debug, Error)]
pub enum PasteError {
    #[error("failed to set clipboard: {0}")]
    Clipboard(String),
    #[error("failed to synthesize keystroke: {0}")]
    Keystroke(String),
    #[error("failed to initialize enigo: {0}")]
    Init(String),
}

/// Copies `text` to the clipboard and synthesizes Cmd+V (macOS) /
/// Ctrl+V (other platforms) to paste at the focused application's cursor.
pub fn paste_at_cursor(text: &str) -> Result<(), PasteError> {
    use arboard::Clipboard;

    let mut clipboard = Clipboard::new().map_err(|e| PasteError::Clipboard(e.to_string()))?;
    clipboard
        .set_text(text)
        .map_err(|e| PasteError::Clipboard(e.to_string()))?;
    info!(len = text.len(), "set clipboard text");

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| PasteError::Init(e.to_string()))?;

    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };

    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| PasteError::Keystroke(e.to_string()))?;

    if let Err(e) = enigo.key(Key::Unicode('v'), Direction::Release) {
        warn!(?e, "could not release v key (likely already released)");
    }

    Ok(())
}
```

- [ ] **Step 2: Add arboard to Cargo.toml**

Add to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
arboard = "3"
```

- [ ] **Step 3: Update input/mod.rs**

Replace `src-tauri/src/input/mod.rs` with:

```rust
pub mod binding;
pub mod hotkeys;
pub mod paste;
```

- [ ] **Step 4: Verify it compiles**

Run:
```bash
cd src-tauri && cargo build --lib 2>&1 | tail -20 && cd ..
```
Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/input
git commit -m "feat(input): paste-at-cursor via arboard + enigo

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Implement the coordinator state machine

A single-threaded state machine that consumes `HotkeyEvent`s and dispatches the recording → stub-transcription → paste pipeline.

**Files:**
- Create: `src-tauri/src/coordinator.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing tests for state transitions**

Create `src-tauri/src/coordinator.rs`:

```rust
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::audio::recorder::Recorder;
use crate::input::hotkeys::HotkeyEvent;
use crate::input::paste::paste_at_cursor;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineState {
    Idle,
    Recording,
    Processing,
}

pub type StateHandle = Arc<Mutex<PipelineState>>;

pub fn new_state_handle() -> StateHandle {
    Arc::new(Mutex::new(PipelineState::Idle))
}

/// Spawn the coordinator task. It owns a Recorder and consumes HotkeyEvents.
/// On Pressed → start recording. On Released → stop recording, run stub
/// transcription, paste the result, return to Idle.
///
/// `on_state_change` is called whenever the pipeline state changes; the UI tray
/// uses this to update its icon color.
pub fn spawn(
    mut hotkey_rx: mpsc::UnboundedReceiver<HotkeyEvent>,
    state: StateHandle,
    on_state_change: impl Fn(PipelineState) + Send + 'static,
) {
    tokio::spawn(async move {
        let mut recorder = Recorder::new();

        while let Some(event) = hotkey_rx.recv().await {
            match event {
                HotkeyEvent::Pressed => {
                    if !transition(&state, PipelineState::Idle, PipelineState::Recording) {
                        warn!("ignored Pressed: not in Idle state");
                        continue;
                    }
                    on_state_change(PipelineState::Recording);
                    if let Err(e) = recorder.start() {
                        error!(?e, "failed to start recorder; returning to Idle");
                        force_state(&state, PipelineState::Idle);
                        on_state_change(PipelineState::Idle);
                    }
                }
                HotkeyEvent::Released => {
                    if !transition(&state, PipelineState::Recording, PipelineState::Processing) {
                        warn!("ignored Released: not in Recording state");
                        continue;
                    }
                    on_state_change(PipelineState::Processing);
                    let stop_result = recorder.stop();
                    match stop_result {
                        Ok((samples, sr)) => {
                            info!(samples = samples.len(), sample_rate = sr, "transcribing (stub)");
                            // Phase 0: hardcoded transcription.
                            let text = "hello world";
                            if let Err(e) = paste_at_cursor(text) {
                                error!(?e, "paste failed");
                            }
                        }
                        Err(e) => error!(?e, "recorder.stop failed"),
                    }
                    force_state(&state, PipelineState::Idle);
                    on_state_change(PipelineState::Idle);
                }
            }
        }
    });
}

fn transition(state: &StateHandle, from: PipelineState, to: PipelineState) -> bool {
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if *s == from {
        *s = to;
        true
    } else {
        false
    }
}

fn force_state(state: &StateHandle, to: PipelineState) {
    if let Ok(mut s) = state.lock() {
        *s = to;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_succeeds_when_state_matches() {
        let s = new_state_handle();
        assert!(transition(&s, PipelineState::Idle, PipelineState::Recording));
        assert_eq!(*s.lock().unwrap(), PipelineState::Recording);
    }

    #[test]
    fn transition_fails_when_state_mismatches() {
        let s = new_state_handle();
        assert!(!transition(&s, PipelineState::Recording, PipelineState::Processing));
        assert_eq!(*s.lock().unwrap(), PipelineState::Idle);
    }

    #[test]
    fn force_state_overrides_unconditionally() {
        let s = new_state_handle();
        force_state(&s, PipelineState::Processing);
        assert_eq!(*s.lock().unwrap(), PipelineState::Processing);
        force_state(&s, PipelineState::Idle);
        assert_eq!(*s.lock().unwrap(), PipelineState::Idle);
    }
}
```

Add to `src-tauri/src/lib.rs` near the other `pub mod` lines:

```rust
pub mod coordinator;
```

- [ ] **Step 2: Run the unit tests**

Run:
```bash
cd src-tauri && cargo test --lib coordinator 2>&1 | tail -20 && cd ..
```
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src
git commit -m "feat(coordinator): mpsc-driven state machine for hotkey-record-paste pipeline

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 11: Implement the system tray

A tray icon that updates color (gray=Idle, red=Recording, yellow=Processing) based on coordinator state changes.

**Files:**
- Create: `src-tauri/src/ui/mod.rs`, `src-tauri/src/ui/tray.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the tray module**

Create `src-tauri/src/ui/tray.rs`:

```rust
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Runtime};
use tracing::warn;

use crate::coordinator::PipelineState;

pub struct TrayHandle {
    icon: TrayIcon,
}

impl TrayHandle {
    pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayHandle> {
        let quit = MenuItem::with_id(app, "quit", "Quit Echo Scribe", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&quit])?;

        let icon = TrayIconBuilder::new()
            .menu(&menu)
            .icon(idle_icon())
            .on_menu_event(|app, event| {
                if event.id().as_ref() == "quit" {
                    app.exit(0);
                }
            })
            .build(app)?;

        Ok(TrayHandle { icon })
    }

    pub fn set_state(&self, state: PipelineState) {
        let img = match state {
            PipelineState::Idle => idle_icon(),
            PipelineState::Recording => recording_icon(),
            PipelineState::Processing => processing_icon(),
        };
        if let Err(e) = self.icon.set_icon(Some(img)) {
            warn!(?e, "failed to update tray icon");
        }
    }
}

/// Solid-color 16x16 RGBA icon. Phase 0 uses flat colors as placeholders;
/// Phase 6 swaps these for designed assets. The buffer is leaked into
/// 'static memory because tray icons live for the full app lifetime — there
/// are exactly three of these and no need to free them.
fn solid_color_icon(r: u8, g: u8, b: u8) -> Image<'static> {
    let size = 16u32;
    let mut buf = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        buf.extend_from_slice(&[r, g, b, 255]);
    }
    let leaked: &'static [u8] = Box::leak(buf.into_boxed_slice());
    Image::new(leaked, size, size)
}

fn idle_icon() -> Image<'static> {
    solid_color_icon(120, 120, 120)
}
fn recording_icon() -> Image<'static> {
    solid_color_icon(220, 50, 50)
}
fn processing_icon() -> Image<'static> {
    solid_color_icon(220, 180, 50)
}
```

Create `src-tauri/src/ui/mod.rs`:

```rust
pub mod tray;
```

Add to `src-tauri/src/lib.rs`:

```rust
pub mod ui;
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd src-tauri && cargo build --lib 2>&1 | tail -25 && cd ..
```
Expected: builds without errors. The `tray-icon` Tauri feature was added in Task 5; if a feature error appears, double-check `Cargo.toml`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ui src-tauri/src/lib.rs
git commit -m "feat(ui): tray icon with idle/recording/processing color states

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 12: Wire the pipeline together in lib.rs

Tie hotkey listener → coordinator → recorder → paste, plus tray state updates, on app startup.

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: Write the lib.rs entry**

Replace `src-tauri/src/lib.rs` with:

```rust
pub mod audio;
pub mod coordinator;
pub mod input;
pub mod ui;

use std::sync::{Arc, Mutex};

use rdev::Key;
use tauri::Manager;
use tokio::sync::mpsc;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::coordinator::{new_state_handle, PipelineState};
use crate::input::binding::Binding;
use crate::input::hotkeys::{spawn_listener, HotkeyEvent};
use crate::ui::tray::TrayHandle;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    info!("starting Echo Scribe Phase 0");

    tauri::Builder::default()
        .setup(|app| {
            let tray = TrayHandle::install(&app.handle().clone())?;
            let tray = Arc::new(Mutex::new(tray));

            let (hotkey_tx, hotkey_rx) = mpsc::unbounded_channel::<HotkeyEvent>();

            let default_binding = Binding::single(Key::ControlRight);
            spawn_listener(default_binding, hotkey_tx);

            let state = new_state_handle();
            let tray_for_state = Arc::clone(&tray);
            coordinator::spawn(hotkey_rx, state, move |new_state: PipelineState| {
                if let Ok(t) = tray_for_state.lock() {
                    t.set_state(new_state);
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Replace `src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    echo_scribe_lib::run();
}
```

> **Note:** `echo_scribe_lib` is the default library name Tauri's scaffold generates. If your `Cargo.toml` `[lib] name` differs, replace it accordingly (look for `name = "..._lib"` in `Cargo.toml`).

- [ ] **Step 2: Build the full app**

Run:
```bash
cd src-tauri && cargo build 2>&1 | tail -20 && cd ..
```
Expected: builds without errors. Address any errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat: wire hotkey-record-paste pipeline with tray state

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 13: Manual end-to-end verification

This task verifies the full Phase 0 acceptance criteria. It is manual because audio capture, paste simulation, and tray rendering require human eyes and a real keyboard.

**Files:** None modified.

- [ ] **Step 1: Boot the app**

Run:
```bash
bun tauri dev
```
Expected:
- A window opens showing the "Echo Scribe — Phase 0 skeleton" placeholder
- The system tray (menu bar on macOS) shows a gray dot
- Console logs include `starting Echo Scribe Phase 0` and `starting hotkey listener`

On first launch, macOS will prompt for **Accessibility** permission (for `enigo` to synthesize keystrokes) and **Microphone** permission (for `cpal`). Grant both, then restart `bun tauri dev`.

- [ ] **Step 2: Test the recording → paste loop**

1. Open TextEdit, click in the document.
2. Press and hold the **Right Control** key.
3. Verify the tray icon turns red.
4. Speak a short phrase (it won't be transcribed in Phase 0 — we just need a non-empty recording).
5. Release Right Control.
6. Verify the tray briefly turns yellow then back to gray.
7. Verify "hello world" appears in TextEdit at the cursor.

Expected: every step succeeds. If paste fails silently, check Accessibility permission. If recording produces a `NoDevice` error, check Microphone permission.

- [ ] **Step 3: Test that other keys do nothing**

Press a few other keys (Left Control, A, Space). Verify the tray stays gray and nothing pastes. This confirms the `Binding::single(Key::ControlRight)` only fires for Right Control.

- [ ] **Step 4: Test clean shutdown**

Use the tray menu's "Quit Echo Scribe" item, or Cmd+Q.

Then verify no orphaned process:
```bash
pgrep -lf echo-scribe
```
Expected: empty output (or only the shell command itself).

- [ ] **Step 5: Tag Phase 0 complete**

If all verification steps pass:

```bash
git tag -a phase-0-tauri-complete -m "Phase 0 (Tauri skeleton) complete: hotkey + record + paste pipeline working"
```

Expected: tag created. If any verification step failed, do not tag — open a fix commit and re-verify before tagging.

---

## Definition of done

Phase 0 is complete when:

- [x] All 13 tasks in this plan are checked off
- [x] `bun tauri dev` opens the app without errors
- [x] Right Control hold-to-talk pastes "hello world" into any text field
- [x] Tray icon transitions: gray → red (recording) → yellow (processing) → gray
- [x] Quitting via tray cleanly exits with no orphaned processes
- [x] `cargo test --lib` passes all unit tests in `binding` and `coordinator`
- [x] `phase-0-tauri-complete` tag exists

After tagging, **stop and notify the user.** Phase 1 (real Parakeet transcription) needs its own implementation plan.
