# Phase 1 — Parakeet Transcription Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the hardcoded `"hello world"` with real Parakeet transcription. Holding the shortcut, speaking, and releasing pastes the user's actual words at the cursor in any app. Three model size variants are user-selectable, downloaded on demand from the onboarding flow.

**Tech additions:** `transcribe-rs` (Parakeet inference), `rubato` (sample-rate conversion to 16kHz mono), `core-graphics` + `objc2-core-graphics` (CGEventTap for keystroke consumption), `reqwest` (model download), `sha2` (verification).

**Carry-overs from Phase 0**: hotkey trigger keys leak through the OS to focused apps (`=` typed before `hello world`). Switching from `rdev::listen` (observe-only) to CGEventTap (can consume) fixes this. Bundled into Phase 1.

---

## File structure changes

```
src-tauri/src/
├── input/
│   ├── binding.rs                (unchanged)
│   ├── hotkeys.rs                (REWRITE — CGEventTap-based)
│   └── paste.rs                  (unchanged)
├── audio/
│   ├── recorder.rs               (unchanged)
│   └── resample.rs               NEW — rubato wrapper
├── asr/                          NEW
│   ├── mod.rs
│   ├── registry.rs               (bundled models.json + parsing)
│   ├── downloader.rs             (HTTP download with progress events)
│   ├── parakeet.rs               (transcribe-rs wrapper)
│   └── pipeline.rs               (samples → text, with resample)
├── coordinator.rs                (MODIFY — call asr::pipeline instead of hardcoded text)
├── commands.rs                   (ADD — list_speech_models, download_speech_model, get_active_speech_model, set_active_speech_model)
└── lib.rs                        (register new commands + state)
```

```
src-tauri/models.json             NEW — bundled at build time
```

```
src/
├── views/
│   ├── Onboarding.tsx            (MODIFY — add Speech model row)
│   └── Settings.tsx              (MODIFY — add model picker section)
├── components/
│   ├── HotkeyRebinder.tsx        (unchanged)
│   └── SpeechModelPicker.tsx     NEW — shared between Onboarding + Settings
└── lib/
    ├── api.ts                    (ADD — speech model commands)
    └── binding.ts                (unchanged)
```

---

## Task list

### Task 1 — Hotkey event swallowing (CGEventTap)

Replace `rdev::listen` with a CGEventTap that:
- Sees every key press/release globally (same as rdev did)
- Detects when the current `Binding` is satisfied (using existing `Binding::is_satisfied_by`)
- Emits `HotkeyEvent::Pressed` / `Released` over the existing mpsc channel (unchanged downstream)
- Returns `null` from the callback for events that match the binding's keys, swallowing them so the OS doesn't deliver to the focused app
- Forwards every other event unchanged

API kept the same so coordinator.rs and lib.rs callers don't change:
```rust
pub fn spawn_listener(binding: Arc<RwLock<Binding>>, tx: mpsc::UnboundedSender<HotkeyEvent>);
```

The implementation lives in `input/hotkeys.rs` (full rewrite). Use `core-graphics` + `objc2-core-foundation` for the tap. Run the tap on a dedicated thread with its own runloop — `CFMachPortCreateRunLoopSource` + `CFRunLoopAddSource` + `CFRunLoopRun`.

Drop the `rdev` dependency from Cargo.toml (we keep the `Key` enum from rdev though — see note below).

**Note on Key enum**: `rdev::Key` is what `Binding` uses. We need a key-enumeration that works without rdev's listener. Two options:
- Keep `rdev` as a dep just for the `Key` enum (and stop calling `rdev::listen`). Lightweight.
- Replace `rdev::Key` with a vendored enum and key-from-keycode/code-from-key tables.

Take option 1 — keep rdev as a "types only" dep — it's simpler and our code already uses those variants.

Map CGEvent's `kCGKeyboardEventKeycode` (CGKeyCode = u16) to `rdev::Key` via a translation table. Modifier flags from `CGEventFlags` distinguish left/right via the specific keycode (left/right Cmd are different keycodes).

### Task 2 — Resample pipeline

`audio/resample.rs`: takes `(samples: &[f32], from_rate: u32, to_rate: u32, channels: u16) -> Vec<f32>` and returns 16kHz mono samples.

Use `rubato`'s `SincFixedIn` resampler. Mix down stereo → mono by averaging channels first, then resample.

Add unit tests for: 48kHz mono → 16kHz mono (length should be ~1/3), 48kHz stereo → 16kHz mono (channels averaged), no-op when from == to.

### Task 3 — Speech model registry

`asr/registry.rs`: parses `src-tauri/models.json` (bundled via `include_str!`).

Schema:
```json
{
  "version": 1,
  "models": [
    { "id": "...", "display_name": "...", "size_label": "Small|Medium|Large",
      "size_bytes": 0, "download_url": "...", "sha256": "...",
      "is_default": true|false }
  ]
}
```

Three model entries to ship:
- **Small** — `nemo-parakeet-tdt-0.6b-v2-q4` or smallest available quantization (~150-300 MB target)
- **Medium** — `nemo-parakeet-tdt-0.6b-v2` full precision (~600-700 MB)
- **Large** — `nemo-parakeet-tdt-1.1b` (~1.1-1.5 GB)

Use HuggingFace direct-download URLs. Do real research at implementation time — pick what `transcribe-rs` actually accepts. If `transcribe-rs` has only one supported variant, populate three entries with placeholder URLs and document the limitation.

API:
```rust
pub struct ModelEntry { /* same shape as JSON */ }
pub fn registry() -> &'static [ModelEntry];
pub fn default_id() -> &'static str;
pub fn lookup(id: &str) -> Option<&'static ModelEntry>;
```

### Task 4 — Model downloader

`asr/downloader.rs`: streamed download with progress events.

```rust
pub async fn download_model(
    entry: &ModelEntry,
    on_progress: impl Fn(DownloadProgress) + Send + 'static,
) -> Result<PathBuf, DownloadError>;
```

`DownloadProgress { bytes_downloaded: u64, bytes_total: u64 }`. Storage path: `dirs::data_dir()/EchoScribe/models/<id>/<filename>` (typically `~/Library/Application Support/EchoScribe/models/<id>/` on macOS).

Use `reqwest` + `tokio::io::AsyncWriteExt` to stream-write. SHA256 verify after the write completes. Delete the partial file on failure.

Errors: `Network`, `HashMismatch`, `Io`, `Cancelled`.

Emit progress to the frontend via Tauri events: `app.emit("speech_model:progress", { id, bytes_downloaded, bytes_total })`.

### Task 5 — Parakeet inference wrapper

`asr/parakeet.rs`: thin wrapper around `transcribe-rs`.

```rust
pub struct ParakeetEngine { /* model + tokenizer */ }
impl ParakeetEngine {
    pub fn load(model_dir: &Path) -> Result<Self, EngineError>;
    pub fn transcribe(&mut self, samples_16k_mono: &[f32]) -> Result<String, EngineError>;
}
```

Lazy-load: model not loaded until first `transcribe` call. Keep loaded in memory for subsequent calls (no per-call reload).

Add a configurable unload-after-idle timer in a later phase; for now keep it simple — once loaded, stays loaded for app lifetime.

### Task 6 — ASR pipeline + coordinator wiring

`asr/pipeline.rs`: glue that combines `resample` + `parakeet`.

```rust
pub struct AsrPipeline { engine: Arc<Mutex<Option<ParakeetEngine>>>, model_dir: PathBuf }
impl AsrPipeline {
    pub fn new(model_dir: PathBuf) -> Self;
    pub async fn transcribe(&self, samples: Vec<f32>, from_rate: u32, channels: u16) -> Result<String, AsrError>;
}
```

Internally: spawn_blocking → resample → spawn_blocking → engine.transcribe. The two `spawn_blocking`s avoid blocking the coordinator's local-set-task while heavy CPU work runs.

In `coordinator.rs`, replace:
```rust
let text = "hello world";
```
with:
```rust
let text = match asr_pipeline.transcribe(samples, sample_rate, 1).await {
    Ok(t) => t,
    Err(e) => { error!(?e, "transcription failed"); return; }
};
```

Coordinator gets `asr_pipeline: Arc<AsrPipeline>` injected at construction.

### Task 7 — Tauri commands for model management

In `commands.rs` add:
```rust
#[tauri::command] fn list_speech_models() -> Vec<SpeechModelStatus>;
// SpeechModelStatus { id, display_name, size_label, size_bytes, downloaded, active }

#[tauri::command]
async fn download_speech_model(state: tauri::State<AppState>, app: AppHandle, id: String) -> Result<(), String>;
// Streams progress via "speech_model:progress" events.

#[tauri::command]
fn get_active_speech_model_id(state: tauri::State<AppState>) -> String;

#[tauri::command]
fn set_active_speech_model(state: tauri::State<AppState>, id: String) -> Result<(), String>;
// Persists to settings store; reloads ParakeetEngine if currently loaded.

#[tauri::command]
fn delete_speech_model(id: String) -> Result<(), String>;
```

Persist active model id in `SettingsStore` alongside the binding.

### Task 8 — Onboarding flow update

`src/views/Onboarding.tsx`: add a new row BEFORE "Dictation shortcut":

**Speech model**
- Subtitle: "Echo Scribe transcribes your voice on-device using Parakeet."
- Body: `<SpeechModelPicker />` component
- "Start Echo Scribe" button gated on: both permissions green AND a model is active+downloaded.

`src/components/SpeechModelPicker.tsx`: new shared component.
- Three radio buttons / cards: Small / Medium / Large (read from `list_speech_models`)
- Each shows: name, size, "Download" button (disabled while downloading) or "Active" / "Downloaded" pill
- Active radio binding writes via `set_active_speech_model`
- Download progress bar listens to `speech_model:progress` events
- Errors surfaced inline

Settings.tsx: add a "Speech model" section that uses the same `<SpeechModelPicker />`.

### Task 9 — App.tsx routing — gate auto-start

App.tsx auto-starts pipeline if permissions are green. Update gate: also require an active model that's downloaded. If permissions ok but no model, show onboarding (don't skip).

### Task 10 — Manual verification (user)

Acceptance:
- [ ] Onboarding offers three model sizes
- [ ] Selecting one starts a download with progress
- [ ] After download completes, Start Echo Scribe enables
- [ ] Holding the shortcut, speaking, releasing → spoken text pastes (not "hello world")
- [ ] The trigger key (e.g. `=`) does NOT leak through to the focused app
- [ ] Quitting and relaunching skips onboarding (auto-start with same model)
- [ ] Settings → switch to a different model size, hot-swap works

---

## Hard constraints

- All 10 existing unit tests must still pass.
- `bun tauri build --bundles app` must succeed.
- No new top-level config files; reuse `tauri.conf.json` + Cargo.toml + package.json.
- Conventional commits, one logical chunk per commit.

## Out of scope for Phase 1

- VAD-based auto-stop (deferred — user preference)
- Whisper as alternative ASR (Phase 1+ optional)
- LLM/classifier (Phase 3)
- SQLite persistence (Phase 2)
- Cancel hotkey (Phase 3)
