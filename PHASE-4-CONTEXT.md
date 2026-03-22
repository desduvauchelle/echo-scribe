# Phase 4: WhisperKit & Settings

## Goal
Add optional high-accuracy Whisper-based speech-to-text (WhisperKit) as an alternative to Apple Speech. Create a Settings view for speech engine selection, model management, and global hotkey configuration.

## Current State (after Phase 3)
- App has full voice recording → AI enrichment → feed/kanban/calendar/project views
- `SpeechServiceProtocol` is already protocol-based — easy to add new implementations
- `SpeechEngine` enum already has `.apple` and `.whisper` cases
- `RecordingViewModel.updateSpeechService()` exists for hot-swapping engines
- `AudioCaptureManager` exists but is unused (Apple Speech handles its own audio)

## What needs to be done

### 1. Add WhisperKit dependency
**File: `project.yml`** — Add under `packages:`:
```yaml
WhisperKit:
  url: https://github.com/argmaxinc/WhisperKit.git
  from: "0.16.0"
```
Add to target dependencies. Run `xcodegen generate`.

### 2. Add KeyboardShortcuts dependency
**File: `project.yml`** — Add:
```yaml
KeyboardShortcuts:
  url: https://github.com/sindresorhus/KeyboardShortcuts.git
  from: "2.0.0"
```

### 3. Create WhisperSpeechService
**New file: `EchoScribe/Services/Speech/WhisperSpeechService.swift`**

Implements `SpeechServiceProtocol`. Uses WhisperKit for local Whisper inference:
- Download Whisper model on demand (user opts in via Settings)
- Use `AudioCaptureManager` to capture mic audio
- Buffer audio and transcribe with WhisperKit
- Publish partial results via `AsyncStream<TranscriptionUpdate>`
- WhisperKit has built-in VAD (Voice Activity Detection)

### 4. Create SettingsView
**New file: `EchoScribe/Views/Settings/SettingsView.swift`**
**New file: `EchoScribe/ViewModels/SettingsViewModel.swift`**

Settings tabs:
- **Speech**: Picker for Apple Speech vs WhisperKit. Model download status/progress for Whisper.
- **AI Model**: Current MLX model name, download status. Button to switch models.
- **Recording**: Push-to-talk vs always-listening toggle. Global hotkey config.
- **Data**: Database location info. Export as JSON/Markdown button.

Add `Settings` scene to `EchoScribeApp.swift`.

### 5. Global hotkey
Use `KeyboardShortcuts` package. Register Option+Space as default toggle-recording shortcut. Works system-wide when app is running.

**File: `EchoScribe/App/EchoScribeApp.swift`** — register hotkey
**File: `EchoScribe/Utilities/Constants.swift`** — define shortcut name

## Key existing files
- `EchoScribe/Services/Speech/SpeechService.swift` — protocol + SpeechEngine enum
- `EchoScribe/Services/Speech/AppleSpeechService.swift` — reference implementation
- `EchoScribe/Services/Speech/AudioCaptureManager.swift` — mic capture (for WhisperKit)
- `EchoScribe/ViewModels/RecordingViewModel.swift` — `updateSpeechService()` for hot-swap
- `EchoScribe/App/EchoScribeApp.swift` — add Settings scene here
- `project.yml` — add dependencies here

## Build & verify
1. `xcodegen generate`
2. Build in Xcode
3. Open Settings (Cmd+,), switch speech engine to Whisper
4. Verify Whisper model downloads and transcription works
5. Test global hotkey (Option+Space) triggers recording
