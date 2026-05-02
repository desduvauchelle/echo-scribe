# Echo Scribe — Tauri Rebuild Design

**Status**: Proposed
**Date**: 2026-05-01
**Supersedes**: The Swift+Bun-sidecar architecture in `BUILD_PLAN.md` (Phase 0 + Phase 1 work currently in `main`)

---

## Context

Echo Scribe currently exists as a Swift macOS shell that spawns a Bun TypeScript sidecar over JSON-RPC, with a React UI in WKWebView. Phase 0 and most of Phase 1 are working. After studying the architecture of [cjpais/handy](https://github.com/cjpais/handy) — a Rust+Tauri dictation tool — we are switching to a single-process Tauri+Rust architecture before building further phases.

This is a strategic decision, not a forced one. The existing architecture is sound but pays significant operational complexity (sidecar lifecycle, port discovery, WebSocket reconnect, three processes) for cross-platform core sharing that we do not yet need. Tauri collapses that complexity into one binary while giving us better transcription (Parakeet/Whisper instead of `SFSpeechRecognizer`) and a working reference pattern for local LLM integration.

We are taking **inspiration** from Handy's patterns, not forking its code. The result is a clean-room implementation owned entirely by Echo Scribe.

---

## Mission (unchanged)

A voice-first personal "second brain" for macOS. Two global hotkeys: one inserts dictated text at the cursor in any app (silently logged), one captures dictated text into Echo Scribe with AI classification into projects/notes/tasks. Local-first, private, no cloud dependencies by default.

---

## Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Tauri v2 | One Rust binary, native WebView, mature ecosystem |
| Frontend | React + Tailwind v4 + Vite + TypeScript | Same as previous plan |
| ASR (default) | `transcribe-rs` (Parakeet V3) | CPU-optimized, good quality |
| ASR (optional) | `whisper-rs` (Whisper Turbo) | Future option, not Phase 1 |
| VAD | `vad-rs` | Smart end-of-speech detection |
| Audio capture | `cpal` | Cross-platform mic I/O |
| Audio resample | `rubato` | 48kHz → 16kHz for ASR |
| Hotkeys | `rdev` (left/right modifier aware) | Global keyboard shortcuts; distinguishes left vs right Ctrl/Shift/Alt/Meta |
| Paste at cursor | `enigo` | Synthetic Cmd+V |
| Local LLM | `llama-cpp-2` (GGUF models) | Self-contained, Metal accel on macOS |
| LLM (Mac, optional) | Apple Intelligence (future) | Future provider option, macOS-only, gracefully unavailable elsewhere |
| Database | `rusqlite` + FTS5 | Embedded, fast, full-text search |
| Migrations | `refinery` | Compile-time-checked migrations |
| ULID | `ulid` crate | Sortable IDs |
| State management | Tauri's managed state (`Arc<Mutex<...>>`) | Idiomatic for Tauri |

**Platform**: macOS 14+ first. Tauri makes Linux/Windows possible later but not Phase 1 scope.

**Out of scope for the rebuild**: cross-platform shipping, iOS, cloud LLM providers, multi-provider LLM matrix, Apple Intelligence integration, translation, multi-language UI.

---

## Architecture

### Process model

A single Tauri binary. The Rust backend owns:
- The audio pipeline (capture → VAD → ASR → optional classify → action)
- The local LLM engine
- The SQLite database and event log
- Global hotkey listening
- The system tray and recording overlay

The React frontend (running in the embedded WebView) communicates with Rust via Tauri commands (`invoke()`) for reads/writes and Tauri events for push notifications (recording state, classification ready, etc.).

No sidecar. No WebSocket. No port discovery.

### Coordinator pattern

A single-threaded coordinator serializes all pipeline lifecycle events through an `mpsc` channel. This pattern is borrowed from Handy and eliminates race conditions between hotkey events, cancellation signals, and the async transcribe/classify/paste pipeline.

States: `Idle → Recording → Processing → Idle`.

Inputs the coordinator handles:
- Hotkey down / hotkey up (push-to-talk) or hotkey tap (toggle)
- Cancel signal (cancellation hotkey or programmatic)
- Pipeline-stage completion events
- 30ms debounce on hotkey events to filter rapid-fire signals

### Action map

Each hotkey binding maps to an action. Each action has `start()` and `stop()` methods. Phase 1 ships two actions:

- `VoiceAtCursor` — record, transcribe, paste at cursor, log as `visibility=hidden`
- `LogCapture` — record, transcribe, classify, show overlay for confirmation, log as `visibility=visible`

Future actions (`Cancel`, `Test`, additional capture modes) plug into the same map.

### Module layout (Rust)

```
src-tauri/src/
├── main.rs                       # Tauri entry, wires managers
├── lib.rs                        # Library root, command registration
│
├── coordinator.rs                # Single-threaded mpsc state machine
├── actions/
│   ├── mod.rs                    # ACTION_MAP registry
│   ├── voice_at_cursor.rs        # Hidden, paste-at-cursor flow
│   └── log_capture.rs            # Visible, classify-and-confirm flow
│
├── audio/
│   ├── recorder.rs               # cpal-based capture, with VAD trim
│   ├── vad.rs                    # vad-rs wrapper
│   └── resample.rs               # rubato 48k→16k
│
├── asr/
│   ├── mod.rs                    # ASR trait
│   ├── parakeet.rs               # transcribe-rs Parakeet impl
│   └── model_manager.rs          # ASR model download/load lifecycle
│
├── llm/
│   ├── mod.rs                    # LlmProvider trait
│   ├── engine.rs                 # llama-cpp-2 wrapper, lazy load, unload timer
│   ├── registry.rs               # Bundled models.json + remote update fetch
│   ├── downloader.rs             # Streamed GGUF download + sha256 verify
│   ├── grammar.rs                # GBNF grammars for structured output
│   ├── apple_intelligence.rs     # macOS-only, behind cfg(target_os="macos") feature flag (future)
│   └── classifier.rs             # Prompt assembly, JSON parse, classification
│
├── db/
│   ├── mod.rs                    # Connection pool, migration runner
│   ├── migrations/               # SQL migration files
│   ├── items.rs                  # CRUD + FTS5 search for items
│   ├── projects.rs               # CRUD for projects
│   ├── tasks.rs                  # Task views over items
│   └── events.rs                 # Event log writer (file + DB index)
│
├── input/
│   ├── hotkeys.rs                # rdev wrapper, binding registration; supports single keys and combos with left/right modifier specificity
│   ├── binding.rs                # Hotkey binding type (keys + sides) + serialization
│   └── paste.rs                  # enigo wrapper for synthetic Cmd+V
│
├── ui/
│   ├── tray.rs                   # System tray + menu
│   └── overlay.rs                # Recording state + classification confirm
│
├── settings.rs                   # Tauri store wrapper, settings schema
└── commands/                     # Tauri #[command] handlers
    ├── items.rs                  # list_items, get_item, delete_item
    ├── projects.rs               # CRUD
    ├── tasks.rs                  # list_tasks, complete_task
    ├── search.rs                 # FTS query
    ├── classify.rs               # classify_now (manual reclassify)
    ├── models.rs                 # list/download/select models
    └── settings.rs               # get_settings, update_settings
```

### Frontend layout

```
src/
├── main.tsx
├── App.tsx                       # Router shell
├── api/
│   ├── tauri.ts                  # invoke() wrappers
│   └── events.ts                 # listen() wrappers
├── views/
│   ├── ActivityFeed.tsx
│   ├── Projects.tsx
│   ├── ProjectDetail.tsx
│   ├── Tasks.tsx
│   ├── Search.tsx
│   ├── Settings/
│   │   ├── Hotkeys.tsx
│   │   ├── AsrModel.tsx
│   │   ├── LlmModel.tsx
│   │   └── Projects.tsx
│   └── Onboarding.tsx
├── components/                   # Reusable UI
└── styles/
    └── globals.css               # Tailwind v4 config
```

---

## Hotkey bindings

Bindings are first-class objects, not strings. A `Binding` is either:
- A **single key** (e.g. `RightControl`)
- A **modifier-aware combo** (e.g. `RightCommand + RightShift + Period`)

Each modifier slot tracks whether the user wants the **left** key, the **right** key, or **either side**. Internally, `rdev` exposes `ControlLeft`/`ControlRight`, `ShiftLeft`/`ShiftRight`, `AltLeft`/`AltRight`, `MetaLeft`/`MetaRight` as distinct keys, so left/right specificity is preserved end-to-end.

```rust
enum ModifierSide { Left, Right, Either }

struct Binding {
    primary: rdev::Key,                            // The "main" key (Right Control, Period, F5, etc.)
    modifiers: Vec<(ModifierKind, ModifierSide)>,  // Empty for single-key bindings
}

enum ModifierKind { Control, Shift, Alt, Meta }
```

The settings UI's "Record new shortcut..." button captures the actual physical keys pressed (left vs right) and stores them verbatim. If the user wants "either side", they pick that explicitly in the editor.

Default bindings (overridable in settings):

| Action | Default binding |
|---|---|
| `VoiceAtCursor` | `RightControl` (single key, hold to talk) |
| `LogCapture` | `RightOption` / `RightAlt` (single key, hold to talk) |
| `Cancel` | `Escape` (only active while overlay is visible) |

Single-key bindings are valid because most users have a free modifier key (right Ctrl, right Option) that no other app maps. The user can always switch to a combo if they want.

---

## Pipelines

### VoiceAtCursor

```
hotkey down
  → coordinator: Idle → Recording
  → audio.recorder.start() (cpal + VAD)
  → tray icon → red

hotkey up (or VAD detects end-of-speech)
  → audio.recorder.stop() returns 16kHz mono samples
  → coordinator: Recording → Processing
  → asr.parakeet.transcribe(samples) → text
  → input.paste(text)                          [happens immediately, user feedback]
  → db.items.insert(text, visibility=hidden)
  → events.append("voice.captured", ...)
  → coordinator: Processing → Idle
  → tray icon → green
```

Latency target: paste happens within 1.5s of hotkey-up for clips under 5s. The persist step is async after paste.

### LogCapture

```
hotkey down
  → coordinator: Idle → Recording
  → audio.recorder.start()
  → tray icon → red, overlay shows "Listening..."

hotkey up (or VAD)
  → audio.recorder.stop()
  → coordinator: Recording → Processing
  → asr.parakeet.transcribe(samples) → text
  → overlay shows transcribed text + spinner "Classifying..."
  → llm.classifier.classify(text, context) → ClassificationResult
  → overlay shows classification: project, kind (note/task), tags, deadline
  → user accepts (auto-accepts after N seconds if confidence > threshold)
  → db.items.insert(text, classification, visibility=visible)
  → events.append("log.captured", ...)
  → coordinator: Processing → Idle
```

Cancellation: pressing the cancel hotkey or Esc during any stage aborts cleanly and discards the in-flight item.

---

## Data model

SQLite schema (Phase 1 scope):

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,                   -- ULID
  content TEXT NOT NULL,
  source TEXT NOT NULL,                  -- 'voice_at_cursor' | 'log_capture'
  visibility TEXT NOT NULL,              -- 'hidden' | 'visible'
  kind TEXT,                             -- 'note' | 'task' | NULL (hidden items)
  project_id TEXT REFERENCES projects(id),
  captured_at TEXT NOT NULL,             -- ISO 8601
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE item_tags (
  item_id TEXT REFERENCES items(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE tasks (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  deadline TEXT,                         -- ISO 8601, nullable
  completed_at TEXT
);

CREATE VIRTUAL TABLE items_fts USING fts5(
  content, content='items', content_rowid='rowid'
);
```

**Event log**: every state-changing action also writes a JSON event to `~/EchoScribe/events/YYYY/MM/<ulid>.json`. Events are the durable source of truth; SQLite is a projection rebuildable from events. Phase 1 keeps this discipline lightweight (write-event-then-project synchronously).

---

## LLM model management

### Bundled registry

A `models.json` shipped in the binary lists supported models:

```json
{
  "version": 1,
  "updated_at": "2026-05-01",
  "remote_update_url": "https://raw.githubusercontent.com/<owner>/<repo>/main/models.json",
  "models": [
    {
      "id": "gemma-4-4b-q4_k_m",
      "display_name": "Gemma 4 4B (Q4_K_M)",
      "family": "gemma-4",
      "size_bytes": 2700000000,
      "download_url": "PLACEHOLDER_REPLACE_BEFORE_RELEASE",
      "sha256": "PLACEHOLDER_REPLACE_BEFORE_RELEASE",
      "context_length": 8192,
      "recommended_for": ["classification"],
      "is_default": true
    }
  ]
}
```

Download path: `~/Library/Application Support/EchoScribe/models/<id>.gguf`.

### Engine lifecycle

- **Lazy load**: model is not loaded until first classification call.
- **Unload timer**: configurable (default 5 minutes idle). Model evicts from RAM after timeout.
- **Structured output**: classifier uses GBNF grammar to force valid JSON output. Falls back to JSON-mode prompting if grammar compilation fails for the model family.
- **Cancel-safe**: in-flight inference can be cancelled by the coordinator.

### Classification prompt structure

The classifier receives:
- The transcribed text
- The list of existing project names + ids
- The 5 most recent items (for short-term context)
- Current local datetime

Returns:
```json
{
  "kind": "note" | "task",
  "project_id": "<existing id>" | null,
  "new_project_name": "<string>" | null,
  "tags": ["..."],
  "deadline_iso": "..." | null,
  "confidence": 0.0
}
```

If `project_id` is null and `new_project_name` is set, the classifier is proposing a new project. The confirmation overlay surfaces this for user approval.

---

## Phased implementation plan

Each phase produces a working, testable artifact. Each phase ends with a tagged commit.

### Phase 0 — Tauri skeleton (½–1 day)

- `bun create tauri-app` with React+TS+Tailwind template
- Strip starter content
- Wire `rdev` global hotkey, `cpal` recording, `enigo` paste
- Use a hardcoded transcription string (`"hello world"`) — no real ASR yet
- Tray icon with red/green recording state
- Hotkey + record + paste loop works end-to-end

**Acceptance**: pressing the hotkey and releasing pastes "hello world" into TextEdit.

### Phase 1 — Real transcription (1 day)

- Integrate `transcribe-rs` with Parakeet V3
- ASR `model_manager` downloads Parakeet on first launch with progress UI
- `vad-rs` integration for smart end-of-speech
- Replace hardcoded text with real transcription

**Acceptance**: holding the hotkey while speaking pastes the transcribed text. VAD ends recording on natural pause.

### Phase 2 — Persistent storage (1 day)

- `rusqlite` + `refinery` migrations
- Schema above
- Event log writer
- `VoiceAtCursor` flow now persists every transcription as `visibility=hidden`
- Tauri command `list_items` for verification (no UI yet)

**Acceptance**: every dictation appears in `echo.db` and as a JSON file under `~/EchoScribe/events/`.

### Phase 3 — LLM model manager (1–2 days)

- `llama-cpp-2` integration with Metal acceleration
- `models.json` bundled, with one Gemma 4 entry as default
- Download flow with progress events + sha256 verify
- `llm.engine` with lazy load + unload timer
- Settings page: model picker, download button, "test inference" button

**Acceptance**: user downloads a model from settings, clicks "test inference", gets a response. Model unloads after the configured timeout.

### Phase 4 — Classifier + LogCapture action (1–2 days)

- `classifier.rs` with GBNF grammar for structured output
- `LogCapture` action joins `ACTION_MAP`
- Second hotkey binding wired
- Recording overlay shows transcript → classification → confirm UI
- Confirmation persists item with `visibility=visible` and classification

**Acceptance**: pressing the log-capture hotkey records, transcribes, classifies, shows the overlay. Accepting persists the classified item.

### Phase 5 — Echo Scribe UI (2–3 days)

- Activity feed (paginated, newest first, filter by project/visibility)
- Projects view (list, create, archive, see project items)
- Tasks view (filter to kind=task, sort by deadline, mark complete)
- Search view (FTS5 query against items)
- Settings: hotkey rebinding, ASR model, LLM model, project management

**Acceptance**: the app is usable as a second-brain reviewer, not just a dictation tool.

### Phase 6 — Polish (1 day)

- Onboarding flow: permissions → ASR model download → optional LLM model download → first hotkey
- Audio feedback sounds (start/stop, classification ready)
- Tray menu: Open, Pause hotkeys, Quit
- Crash logging
- Code-signing setup (separate task with the user's developer account)

**Acceptance**: a fresh-machine install walks the user through onboarding and lands on a working app.

---

## Migration of existing work

The current `main` branch contains Swift+Bun-sidecar work that is being thrown away wholesale and rebuilt on Tauri+Rust in the same repo.

1. Tag the current `main` head as `swift-archive` so the prior implementation stays accessible in git history.
2. Delete from `main`: `apps/`, `packages/`, `scripts/`, `bun.lock`, `biome.json`, top-level `package.json`, `tsconfig.json`, `_old/`, and any Swift/Xcode artifacts. Keep: `README.md`, `BUILD_PLAN.md` (mark as superseded), `CLAUDE.md`, `decisions/`, `docs/`.
3. Update `BUILD_PLAN.md` to reference this spec as the authoritative build plan.
4. Initialize the new Tauri project at the repo root.
5. Phase 0 starts from the deleted-and-reinitialized `main`.

No branching gymnastics. Git history preserves the old work; the working tree is clean.

---

## Confirmed defaults

| Decision | Default | Notes |
|---|---|---|
| Voice-at-cursor hotkey | `RightControl` (single key, hold) | User-rebindable to single key or combo |
| Log-capture hotkey | `RightOption` / `RightAlt` (single key, hold) | User-rebindable |
| Cancel hotkey | `Escape` (overlay-scoped) | Not a global hotkey |
| Default ASR model | Parakeet V3 | Per user direction |
| Default LLM model | Gemma 4 4B (Q4_K_M) | Placeholder GGUF URL in registry until user supplies real one |
| LLM model unload timeout | 5 minutes idle | Balance memory vs. latency |
| Push-to-talk vs. toggle | Push-to-talk default, toggle as setting | Mirrors Handy |
| Classification auto-accept | If confidence ≥ 0.85, auto-accept after 2s | Tunable after Phase 4 lands |
| Repo strategy | Wipe current `main` working tree, rebuild in place | `swift-archive` tag preserves prior work |
| Apple Intelligence | Future provider, macOS-only | Feature-flagged at compile time; non-Mac builds skip the option entirely without breaking |

---

## Open items for the user

The above defaults are decided. The only remaining open item:

1. **Real GGUF URL for the default Gemma 4 model** — registry will ship with a placeholder URL that fails-fast with a clear error ("default model URL not configured") until the user fills it in. Settings UI will let users add custom GGUF URLs in the meantime.

---

## Out of scope for this rebuild

These belong to later briefs:
- Multi-device sync (Phase 7+)
- Chat interface ("ask my second brain")
- Meeting capture (Core Audio process taps)
- Email / web ingestion
- iOS or Windows shipping
- Cloud LLM providers
- Auto-update / Sparkle integration
- App Store distribution

---

## Working agreement

- Conventional commits, one logical change per commit.
- Each phase ends with a `phase-N-tauri-complete` git tag.
- Acceptance criteria for each phase must pass before the next begins.
- If a step takes >2 hours of attempted work without progress, stop and ask.
- Decision documents in `decisions/` from the previous architecture remain informational; this spec supersedes them where they conflict.
