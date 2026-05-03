# Echo Scribe — Code Structure

A reference for reusing this project architecture in future macOS menu-bar apps built with Tauri v2 + React + Rust.

---

## Desktop Framework — Tauri v2

- macOS minimum: 14.0
- `macOSPrivateApi: true` — required for tray-only mode and dock visibility toggling
- Main window uses `titleBarStyle: Overlay` + `hiddenTitle: true` for a native feel
- Window close is intercepted to hide instead of destroy (app stays in tray)
- Two windows: `main` (primary UI) and a floating `recording-overlay` (always-on-top, transparent)
- Plugins used: `tauri-plugin-shell`, `tauri-plugin-store`, `tauri-plugin-notification`, `tauri-plugin-autostart`
- Capabilities declared in `src-tauri/capabilities/default.json`
- Config: `src-tauri/tauri.conf.json`

## Frontend — React 19 + TypeScript

- Entry: `src/main.tsx` → `src/App.tsx`
- `App.tsx` is a simple state-machine router (no React Router): `checking → onboarding → main / settings`
- All `invoke()` calls are centralized in `src/lib/api.ts` with TypeScript types — components never call `invoke()` directly
- Tauri events subscribed globally in `App.tsx` (ASR errors, auto-filed captures, settings navigation)
- Views live in `src/views/`, shared components in `src/components/`
- Second window (recording overlay) has its own entry at `src/overlay/main.tsx`

## Styling — Tailwind CSS v4

- Tailwind v4 via `@tailwindcss/vite` plugin (no `tailwind.config.js` needed)
- Design tokens defined as CSS custom properties in `src/styles/globals.css`
- Semantic naming convention: `--color-canvas`, `--color-muted`, etc.
- Fonts: Inter Variable (`@fontsource-variable/inter`) + JetBrains Mono Variable (`@fontsource-variable/jetbrains-mono`)
- Icons: Lucide React

## Package Manager — Bun

```bash
bun tauri build --bundles app   # release .app bundle
bun run dev                     # frontend-only dev server
cd src-tauri && cargo test --lib  # Rust unit tests
```

## Backend — Rust (2021 edition)

- Entry: `src-tauri/src/main.rs` → `lib.rs` → `run()`
- All Tauri command handlers in `commands.rs`; shared state (`AppState`) defined there too
- `AppState` is injected via `app.manage()` and accessed in every command handler:
  - `asr: Arc<AsrPipeline>`, `llm: Arc<Llm>`, `db: Option<Db>`
  - `settings: SettingsStore`, hotkey bindings, tray handle, coordinator channel
- `coordinator.rs` manages the recording/transcription lifecycle as a tokio task receiving messages over an `mpsc` channel — commands send control messages rather than calling methods directly
- SQLite persistence via `rusqlite` (bundled, so FTS5 is always available)
- Schema migrations: custom in-code `(version, sql)` list applied sequentially, no external migration crate

## Runtime — Tokio

- `tokio` with `rt-multi-thread`, `sync`, `macros`, `time` features
- Background tasks: model idle-unload checkers (ASR + LLM), 24 h GitHub update poller
- Both `AsrPipeline` and `Llm` unload from memory after a configurable idle timeout and reload on next use

## LLM Inference — llama-cpp-2

- `llama-cpp-2 = { version = "0.1.146", features = ["metal"] }` — Metal GPU offload on Apple Silicon
- Model registry defined in `src-tauri/llm-models.json`; active model restored from persisted settings on startup
- Models downloaded as GGUF files to `~/Library/Application Support/EchoScribe/llm-models/` with SHA-256 verification
- `_exit(0)` on app quit bypasses C++ static destructors to avoid a llama.cpp Metal crash when inference is in flight

## Settings Persistence — tauri-plugin-store

- `SettingsStore` wraps `tauri-plugin-store` (JSON file in app data dir)
- Every user-facing setting persisted here — no in-memory-only state
- Typed getters/setters; no raw JSON access in command handlers

## Logging — tracing + tracing-appender

- Rolling daily log file: `~/Library/Logs/EchoScribe/echo-scribe.YYYY-MM-DD.log`
- Also mirrors to stdout
- Log level controlled via `RUST_LOG` env var (defaults to `info`)
- `WorkerGuard` stored in `AppState` to keep the async log appender alive for the full process lifetime
