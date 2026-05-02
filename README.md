# Echo Scribe

A voice-first dictation app for macOS. Press a hotkey, speak, and Echo Scribe transcribes locally using Parakeet — no internet required.

---

## Install

Open Terminal (Cmd+Space, type "Terminal", press Enter) and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/denisduvauchelle/echo-scribe/main/install.sh | bash
```

The script installs the app to `/Applications/` and handles macOS security permissions automatically. To update, run the same command again.

---

## Requirements

- macOS 12 or later
- Apple Silicon (M1/M2/M3) or Intel Mac

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2 (Rust + React) |
| UI | React + TypeScript |
| Speech-to-Text | Parakeet (local, on-device) |
| LLM | Gemma 4 (local, on-device via llama.cpp) |
| Storage | SQLite |
| Build | Bun + Cargo |

---

## Design Principles

- **Local first** — no audio or text leaves your machine
- **Voice first** — the hotkey is the primary entry point
- **Minimal UI** — the interface exists to review captures, not to be a workspace

---

## Building from Source

```bash
# Prerequisites: Rust (rustup), Bun, CMake
git clone https://github.com/denisduvauchelle/echo-scribe.git
cd echo-scribe
bun install
bun tauri build --bundles app
```

The `.app` bundle lands at `src-tauri/target/release/bundle/macos/Echo Scribe.app`.
