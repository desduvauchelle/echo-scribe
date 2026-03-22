# Echo Scribe

A voice-first productivity agent for macOS. Press a key, speak your thought, and Echo Scribe captures it as an organized note or task — locally, privately, instantly.

---

## Mission

Echo Scribe exists to remove friction between a thought and its destination. The primary interface is your voice. You don't open an app, navigate a UI, or type a title. You press a configurable keyboard shortcut, speak, and the system handles the rest: transcription, classification, project routing, tagging, and storage.

Typing is supported as a secondary input mode for situations where voice isn't practical, but the experience is designed voice-first.

---

## How It Works

### 1. Capture (Voice → Text)
Press your configured global keyboard shortcut. The app begins listening immediately using a local speech model — no audio leaves your machine. Currently using Apple's native speech recognition (`SFSpeechRecognizer`), with a pluggable architecture to support alternative models (WhisperKit, etc.) in the future.

### 2. Process (Text → Structured Data)
The transcript is sent to a local AI model for analysis. The AI determines:
- Is this a **note** or a **task**?
- Does a relevant **project** already exist? If not, create one.
- Does the content fit an existing **category** within that project? Apply it.
- What **tags** are appropriate for filtering and organization?

The AI backend is configurable. Echo Scribe routes through your chosen CLI agent:
- Claude CLI (`claude`)
- Codex CLI (`codex`)
- GitHub Copilot CLI
- Gemini CLI (`gemini`)

You pick one in settings. This keeps the AI layer swappable without changing the core app.

### 3. Store (Structured Data → SQLite)
Notes and tasks are stored locally in SQLite via GRDB. Every entry belongs to a project, carries tags, and is timestamped. The schema is designed for fast filtering and full-text search.

### 4. Review (Activity Feed + Search)
A lightweight interface lets you browse recent captures, filter by project or tag, and search across all content. The UI stays out of the way — it's a place to review and act on what you've captured, not a primary workspace.

---

## Phase 1 Focus

The core loop, end-to-end:

```
keyboard shortcut → voice capture → transcription → AI classification → project/task/note storage → searchable feed
```

Everything else is future scope.

---

## Future Directions

Once the core loop is solid, Echo Scribe can expand its reach:

- **Email integration** — "You have an unread email from X, want me to draft a reply and open it as a draft in the browser?"
- **File creation** — Dictate a document into existence, similar to how Claude Artifacts work, but local
- **App control** — Open Pages, Numbers, Music, or other macOS apps by voice
- **Tool integrations** — Connect to calendars, task managers, or other services

These are not current priorities. The goal right now is to make the core loop fast, reliable, and genuinely useful.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Swift 6.0 |
| Platform | macOS 15+ |
| UI | SwiftUI |
| Database | SQLite via GRDB.swift |
| Speech-to-Text | Apple `SFSpeechRecognizer` (pluggable) |
| AI Backend | Local LLM via MLX / configurable CLI agent |
| Project Config | xcodegen (`project.yml`) |

---

## Requirements

- macOS 15.0 or later
- Xcode Command Line Tools (install with `xcode-select --install`)

## Getting Started

### Build and install

```bash
# Clone the repo
git clone <repo-url>
cd echo-scribe

# Generate the Xcode project (requires xcodegen: brew install xcodegen)
xcodegen generate

# Build the app
xcodebuild -project EchoScribe.xcodeproj \
  -scheme EchoScribe \
  -configuration Release \
  -derivedDataPath ./build \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES

# Install to Applications
cp -R ./build/Build/Products/Release/Echo\ Scribe.app /Applications/
```

### First launch

1. Open **Echo Scribe** from your Applications folder or Spotlight
2. macOS may block the app since it's not from the App Store — go to **System Settings > Privacy & Security** and click **Open Anyway**
3. Grant **Microphone** and **Speech Recognition** permissions when prompted

### Updating

Pull the latest changes and re-run the build:

```bash
git pull
xcodegen generate
xcodebuild -project EchoScribe.xcodeproj \
  -scheme EchoScribe \
  -configuration Release \
  -derivedDataPath ./build \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES
cp -R ./build/Build/Products/Release/Echo\ Scribe.app /Applications/
```

> **Note:** The first build takes a while as Swift Package Manager downloads and compiles dependencies (WhisperKit, MLX, etc.). Subsequent builds are faster.

---

## Design Principles

- **Local first** — no data leaves your machine by default
- **Voice first** — the keyboard shortcut is the primary entry point
- **AI as routing layer** — the AI classifies and organizes; it doesn't own your data
- **Swappable everything** — speech model, AI backend, and integrations are configurable
- **Minimal UI** — the interface exists to review captures, not to be a workspace
