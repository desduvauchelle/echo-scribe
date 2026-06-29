# Echo Scribe

**[echoscribe.app →](https://desduvauchelle.github.io/echo-scribe/)**

A voice-first personal capture tool for macOS. Press a hotkey, speak, and Echo Scribe transcribes and understands your words — entirely on your device, with no internet required.

---

## What it does

Echo Scribe turns your voice into organized knowledge. A single global hotkey starts recording from anywhere on your Mac. When you stop speaking, your words are transcribed, classified by a local AI, and saved — no review step, no typing, no friction.

Everything runs on your machine. No audio leaves your device. No account required. No subscription.

---

## How it works

```
Hotkey → Mic → VAD → Parakeet (ASR) → Gemma 4 (LLM) → SQLite
```

1. **Press your hotkey** from any app — a floating overlay appears so you know it's listening
2. **Speak naturally** — Voice Activity Detection detects when you stop talking
3. **Parakeet transcribes** — a fast, accurate on-device speech recognition model runs locally via CoreML
4. **Gemma 4 classifies** — a local LLM (4B parameters, Metal-accelerated) understands your capture and routes it to the right category: note, task, or idea
5. **Saved automatically** — no review modal, no confirmation step; it just lands in your library

The app lives in your menu bar. The main window gives you a feed of everything captured, full-text search, a task list, an analytics dashboard, and a chat interface to query your notes with the same local LLM.

---

## 100% private by design

- Audio is processed in memory and never written to disk
- All AI inference runs locally (Parakeet + Gemma 4 via llama.cpp with Metal GPU offload)
- No telemetry, no analytics, no cloud sync
- SQLite database lives in `~/Library/Application Support/EchoScribe/` — your data, your machine
- Models are downloaded once and cached locally; no internet needed after that

---

## Use cases

**Capture thoughts without breaking flow**
You're in the zone coding or writing. An idea surfaces. Press the hotkey, say it out loud, press again — back to work in under 5 seconds.

**Build a voice-driven task list**
Say "remind me to follow up with Sarah about the contract on Friday" and it lands in your task list, automatically classified.

**Meeting notes on autopilot**
Keep Echo Scribe running during calls. Capture decisions, action items, and ideas as they happen without ever switching windows.

**Personal knowledge base**
Every capture is searchable. Use the chat interface to ask questions across everything you've ever captured — "what did I decide about the API design?" — answered by the same local LLM that classified the notes.

**Journaling and thinking out loud**
Some thoughts come easier spoken than typed. Echo Scribe is a frictionless way to externalize ideas and have them organized and searchable later.

**Developers and writers**
Dictate code comments, documentation drafts, TODO items, or feature ideas without leaving the keyboard-driven flow.

---

## Install

Open Terminal (Cmd+Space, type "Terminal", press Enter) and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/desduvauchelle/echo-scribe/main/install.sh | bash
```

The script installs to `/Applications/`, handles macOS security permissions, and works on both Apple Silicon and Intel. To update, run the same command again.

Echo Scribe also checks GitHub Releases in the background. When a newer release has been downloaded, the app shows a restart banner and replaces the app bundle on restart while preserving your local data in `~/Library/Application Support/EchoScribe/`.

The public build is ad-hoc signed, not Developer ID notarized. The installer and updater remove the quarantine flag after downloading so macOS should not show the "developer cannot be verified" block for installs done through this command.

---

## Requirements

- macOS 14 or later
- Apple Silicon (M1/M2/M3/M4) or Intel Mac
- ~2 GB disk space for AI models (downloaded on first use)

## Windows

Echo Scribe does not currently have a working Windows build or installer. The
repo is built around macOS-specific capture, permission, sidecar, and local AI
runtime pieces. See [docs/WINDOWS.md](docs/WINDOWS.md) for the current support
status and the validation checklist for a future Windows port.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Tauri 2 (Rust + React) |
| UI | React 19 + TypeScript + Tailwind v4 |
| Speech-to-Text | Parakeet (local, on-device, CoreML) |
| LLM | Gemma 4 (local, on-device, Metal GPU via llama.cpp) |
| Audio | cpal + rubato (48kHz → 16kHz resampling) |
| Voice Activity Detection | vad-rs |
| Storage | SQLite with FTS5 full-text search |
| Settings | tauri-plugin-store |
| Build | Bun + Cargo |

---

## Building from source

macOS only.

```bash
git clone https://github.com/desduvauchelle/echo-scribe.git
cd echo-scribe
./scripts/build-from-source.sh
```

The script checks prerequisites (Xcode Command Line Tools, Rust, CMake, and
bun or npm), asking for confirmation before installing anything missing. It
builds the Swift sidecars and the app bundle, then installs **Echo Scribe.app**
to `/Applications` and launches it.
