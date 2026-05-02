> **SUPERSEDED 2026-05-01.** This brief described the original Swift+Bun-sidecar architecture. The authoritative design is now `docs/superpowers/specs/2026-05-01-tauri-rebuild-design.md` and the current build plan is `docs/superpowers/plans/2026-05-01-phase-0-tauri-skeleton.md`. This file is preserved for historical context only — do not implement against it.

---

# Echo Scribe — Build Plan for Claude Code

This document is the working brief for the agent that will scaffold and build Echo Scribe. It covers **Phase 0** (skeleton + hello-world end-to-end) and **Phase 1** (voice-to-text at cursor on Mac). Beyond Phase 1, stop and ask the user — we will iterate based on what the build actually feels like.

---

## How to use this document

1. **Read these first, in this order:**
   - `CLAUDE.md` — the product vision and the full feature surface.
   - `decisions/004-repo-structure.md` — repo layout and runtime topology. This is the authoritative architectural reference.
   - `decisions/001-storage-architecture.md` — only the §"Operating disciplines" and §"What ships in Phase 1" sections matter for the early build.
   - `decisions/002-classifier-approach.md` — informational; classifier doesn't ship until Phase 2.
   - `decisions/003-mac-meeting-audio.md` — informational; meeting audio doesn't ship until Phase 4.

2. **Work strictly in phase order.** Do not start Phase 1 until Phase 0 passes its acceptance criteria. Do not start Phase 2+ at all — that's a separate brief.

3. **If anything in this doc contradicts `CLAUDE.md` or a decision doc, ask the user before deviating.** The decision docs are the source of truth for *what* to build; this doc is the source of truth for *how to build it in what order*.

4. **Do not invent features.** If a Phase 0 or Phase 1 step does not require a piece of functionality, do not add it as a "while I'm here" extra.

5. **Commit per step.** Each numbered step in a phase is its own commit, with a short conventional-commits message (`feat:`, `chore:`, `build:` etc.). One step → one commit.

6. **Ask the user when stuck for >30 minutes** on a step, or whenever you would otherwise have to make an architectural choice that isn't already in the decision docs.

---

## Project context (one paragraph)

Echo Scribe is a voice-first personal "second brain" for macOS (Windows and iOS later). Two global keyboard shortcuts: one inserts dictated text at the cursor in any app (and silently logs it as "hidden"), the other captures dictated text into Echo Scribe itself as a visible log entry. Captured items are auto-classified into the user's projects, searchable via a chat interface, and surface as tasks when they express deadlines. Future phases add automatic meeting transcription, email/web ingestion, and chat/social bridges. The architecture is a shared TypeScript "core" running as a sidecar process inside thin native shells, so the same core runs on every platform.

---

## Architecture at a glance

(Full detail in `decisions/004-repo-structure.md`. Repeated here so this brief is self-contained.)

- **Monorepo, Bun workspaces.** Packages: `core`, `protocol`, `ui`. Apps: `mac`, `core-runtime` (sidecar binary), later `win` and `ios`.
- **Core runs as a sidecar** spawned by the native shell. Compiled with `bun build --compile`. Communicates over JSON-RPC 2.0 on a local WebSocket.
- **Two UI surfaces on Mac.** Native menubar (Swift) + main window via WKWebView hosting the React+Tailwind app. Both connect as independent WebSocket clients of the same core.
- **React talks to core directly over WebSocket.** No round-trip through Swift.
- **Storage is an event log + SQLite projection.** Single write path through `append(event)`. Phase 0 sets the structure up; Phase 1 has nothing to store yet beyond hidden voice captures, which use the same path.
- **iOS and Windows are out of scope** for this brief.

---

## Tech stack (committed — do not deviate without asking)

**TypeScript / Bun side:**
- **Bun** (latest stable). Package manager, runtime, test runner, bundler.
- **TypeScript** with `strict: true`, `noUncheckedIndexedAccess: true`, target `ES2023`.
- **Biome** for lint + format. Zero-config; configure at the workspace root.
- **bun:test** for tests.
- **Vite** for the React UI dev server and production build.
- **React 18** (or 19 if stable in May 2026).
- **Tailwind CSS v4**.
- **zod** for runtime validation of RPC messages crossing the boundary.

**Swift side (Mac):**
- **Xcode project**, Swift 5.10+, Apple Silicon (`arm64`), macOS 14.4+ deployment target. (14.4 because future phases need Core Audio process taps; no reason to support older.)
- **HotKey** (Swift Package Manager) for global keyboard shortcuts: `https://github.com/soffes/HotKey`.
- **AVFoundation** for microphone capture (built-in).
- **Speech framework** (`SFSpeechRecognizer`) for on-device transcription in Phase 1 (built-in, no API key, free).
- **WKWebView** (built-in) for the main window.

**Things you do NOT need yet (do not install):**
- SQLite client libraries (Bun's `bun:sqlite` is built-in; not used until Phase 2).
- Any LLM SDK (no LLM in Phase 0/1).
- Any cloud transcription provider.
- Tailscale, Bonjour, mTLS — iOS is out of scope.
- Whisper, Parakeet, or any other transcription model — Phase 1 uses Apple's built-in.

---

## Conventions

- **File names:** kebab-case for TS files (`rpc-client.ts`), PascalCase for Swift files (`HotkeyManager.swift`), kebab-case for folders.
- **No barrel `index.ts` files** unless they earn their keep. Import from the file directly.
- **No default exports** in TS. Named exports only.
- **Errors are typed.** Throw `Error` subclasses with meaningful names (`TranscriptionFailedError`, `HotkeyConflictError`). Don't throw strings.
- **Logging:** TypeScript side uses `console.log` for now (a real logger arrives later). Swift side uses `os.Logger` from the `os` framework — never `print()` outside debug-only code.
- **No comments that just restate code.** Comments explain *why*, not *what*. (Skill issue if you write `// loop over items`.)
- **Every public function in `packages/core` has a JSDoc block** that describes purpose, params, and returns. Internal helpers do not.
- **No `any`.** Use `unknown` and narrow.
- **No emoji in code, file names, commit messages, or UI strings.** (Echo Scribe is a serious tool.)

---

## Phase 0 — Skeleton and hello-world

### Goal

Stand up the entire architecture end-to-end with no real features. The Mac app launches, spawns the sidecar, opens a WKWebView, the React app inside the WKWebView opens its own WebSocket to the sidecar, calls `system.ping`, and renders the response. The native menubar shows a status indicator that updates from a sidecar event.

### Acceptance criteria (all must pass before starting Phase 1)

1. `bun install` from the repo root succeeds.
2. `bun run dev` starts the Vite dev server, the core sidecar, and a watcher that recompiles on changes — all from one command.
3. Opening the Mac app in Xcode and hitting Run launches the app.
4. The Mac app's main window shows a single-page React UI that displays "Core says: pong" — the result of calling `system.ping` against the sidecar.
5. The Mac app's menubar shows a status icon that displays a green dot when the sidecar reports healthy, gray when it's down. Killing the sidecar process turns the dot gray within 5 seconds; restarting it turns it back green.
6. Quitting the Mac app cleanly stops the sidecar (no orphaned process).
7. `bun test` runs and passes (even if the tests are trivial).

### Step 0.1 — Repo init

```bash
cd "Echo Scribe"
git init
bun init -y
```

Edit the root `package.json` to be a Bun workspace root:

```json
{
  "name": "echo-scribe",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev": "bun run scripts/dev.ts",
    "build": "bun run scripts/build.ts",
    "lint": "biome check .",
    "format": "biome format --write .",
    "test": "bun test"
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "typescript": "^5.5.0"
  }
}
```

Add `tsconfig.json` at root with project references and the strict flags above. Add `biome.json` with workspace-wide config (2-space indent, single quotes, semicolons, line width 100).

Create a `.gitignore` covering `node_modules/`, `dist/`, `*.log`, `apps/mac/build/`, `apps/mac/DerivedData/`, `~/Library/Application Support/EchoScribe/` is *not* in this repo so doesn't need ignoring, but add `.DS_Store`.

Commit: `chore: initial bun workspace`.

### Step 0.2 — Empty packages and apps

Create the directory skeleton from `decisions/004-repo-structure.md` §"Repo layout":

```
packages/
  core/         (package.json, tsconfig.json, src/main.ts with `console.log("core booted")`)
  protocol/     (package.json, tsconfig.json, src/index.ts exporting nothing yet)
  ui/           (package.json, tsconfig.json, src/main.tsx with a placeholder React app)
apps/
  mac/          (empty for now — Xcode project comes in Step 0.6)
  core-runtime/ (package.json, src/main.ts that imports core and starts the RPC server)
```

Each package/app has its own `package.json` declaring its name (`@echo-scribe/core`, `@echo-scribe/protocol`, `@echo-scribe/ui`, `@echo-scribe/core-runtime`) and `type: "module"`.

Inter-package deps go in `package.json`:
- `core` depends on `protocol`
- `core-runtime` depends on `core` and `protocol`
- `ui` depends on `protocol`

Run `bun install` from root. Verify the workspace symlinks are correct.

Commit: `chore: scaffold workspace packages`.

### Step 0.3 — Protocol package

In `packages/protocol/src/`:

`domain.ts`:
```ts
import { z } from "zod";

export const ItemId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID");
export type ItemId = z.infer<typeof ItemId>;

// Stub types — fleshed out in later phases.
// Phase 0 only needs IDs and a couple of shapes for the ping flow.

export const PingRequest  = z.object({});
export const PingResponse = z.object({ message: z.literal("pong"), bootedAt: z.string() });

export const CoreStatus = z.object({
  healthy: z.boolean(),
  uptimeSec: z.number(),
});
```

`methods.ts`:
```ts
import { z } from "zod";
import { PingRequest, PingResponse } from "./domain.ts";

// Each method declares its params and result schemas.
export const Methods = {
  "system.ping": { params: PingRequest, result: PingResponse },
} as const;

export type MethodName = keyof typeof Methods;
```

`events.ts`:
```ts
import { z } from "zod";
import { CoreStatus } from "./domain.ts";

export const Events = {
  "core.status": CoreStatus,
} as const;

export type EventName = keyof typeof Events;
```

`index.ts` re-exports these. (Yes, this is a barrel — earned because external consumers always need all three.)

Add `zod` to `packages/protocol/package.json` deps.

Commit: `feat(protocol): initial RPC method and event schemas`.

### Step 0.4 — Core RPC server

In `packages/core/src/`:

`rpc/server.ts` — a JSON-RPC 2.0 server implemented on `Bun.serve()`'s WebSocket support. Responsibilities:
- Accept multiple concurrent client connections.
- Validate inbound requests against the `Methods` schema in `protocol`.
- Dispatch to a registered handler and return the result.
- Broadcast events to all connected clients.

Sketch:
```ts
import { Methods, Events, type MethodName, type EventName } from "@echo-scribe/protocol";

type Handler<M extends MethodName> = (
  params: z.infer<(typeof Methods)[M]["params"]>
) => Promise<z.infer<(typeof Methods)[M]["result"]>>;

export class RpcServer {
  private handlers = new Map<MethodName, Handler<any>>();
  private clients = new Set<WebSocket>();

  register<M extends MethodName>(method: M, handler: Handler<M>): void { /* ... */ }
  start(port: number): { actualPort: number } { /* Bun.serve, attach upgrade handler */ }
  broadcast<E extends EventName>(event: E, payload: z.infer<(typeof Events)[E]>): void { /* ... */ }
}
```

`main.ts` — wires up the server, registers `system.ping`, and starts an interval that broadcasts `core.status` every 2 seconds:
```ts
import { RpcServer } from "./rpc/server.ts";

const server = new RpcServer();
const bootedAt = new Date().toISOString();

server.register("system.ping", async () => ({ message: "pong" as const, bootedAt }));

const { actualPort } = server.start(0); // 0 = OS picks free port
console.log(JSON.stringify({ port: actualPort })); // first line of stdout for the supervisor

setInterval(() => {
  server.broadcast("core.status", {
    healthy: true,
    uptimeSec: Math.floor((Date.now() - new Date(bootedAt).getTime()) / 1000),
  });
}, 2000);
```

Notes:
- Port discovery: the supervisor reads the first JSON line from the sidecar's stdout to get the port. Document this contract in a comment at the top of `main.ts`.
- Bind to `127.0.0.1` only — never `0.0.0.0`. iOS-as-remote-client comes much later and will need an opt-in.

`apps/core-runtime/src/main.ts` simply imports and runs `packages/core/src/main.ts`. (The runtime app exists so that `bun build --compile` has a single entrypoint to bundle.)

Add a trivial test in `packages/core/src/rpc/server.test.ts` that starts the server, makes a ping call via a real WebSocket, and asserts the response.

Commit: `feat(core): JSON-RPC server with system.ping and core.status events`.

### Step 0.5 — UI package

In `packages/ui/`:

- Vite + React + Tailwind v4 project structure. `bun create vite` then prune what isn't needed.
- `src/rpc-client.ts` — typed WebSocket client that uses the schemas from `protocol`. Reads `(window as any).__ECHO_SCRIBE__` to get `{ host, port }`. Reconnects with backoff if the socket closes.
- `src/App.tsx` — single page that:
  - On mount, calls `system.ping` and shows the result.
  - Subscribes to `core.status` events and shows the latest uptime.
  - Renders both with simple Tailwind styles. No design system yet. Plain text on a clean page is fine.
- `src/main.tsx` — Vite entrypoint.
- `index.html` at the package root with the Vite shell.

The app must work in two modes:
- **Dev mode:** Vite dev server on `http://localhost:5173`. The Mac app's WKWebView points at that URL. Hot reload works.
- **Prod mode:** `bun run build` produces a `dist/` folder of static assets. The Mac app loads from disk via `loadFileURL`.

Neither mode hardcodes the sidecar port. Both rely on `window.__ECHO_SCRIBE__` being injected by the WKWebView host before any script runs.

Commit: `feat(ui): React+Tailwind hello-world consuming core RPC`.

### Step 0.6 — Mac app skeleton

In `apps/mac/`, create an Xcode project (`EchoScribe.xcodeproj`):

- Target: macOS app, SwiftUI lifecycle, Swift 5.10, deployment target 14.4.
- Bundle ID: `com.echoscribe.app` (placeholder; user can rename later).
- Hardened runtime ON, sandbox OFF for now (sandbox interacts with subprocess spawn — revisit before shipping).

Source files under `apps/mac/EchoScribe/`:

`App.swift` — `@main` SwiftUI app. Two scenes:
1. The main window, which contains the WKWebView.
2. A `MenuBarExtra` (macOS 13+ API) showing the status indicator.

`CoreSupervisor/CoreSupervisor.swift` — owns the sidecar lifecycle:
- `start()`: spawn the bundled `core-runtime` binary as a child `Process`. Read the first line of stdout, parse the JSON, store the port.
- `stop()`: send SIGTERM, wait 2s, SIGKILL.
- Restart on unexpected exit with exponential backoff (1s, 2s, 4s, capped at 30s).
- Publishes `@Published var status: CoreStatus` via Combine for UI binding.
- For Phase 0 dev iteration: if the binary doesn't exist (e.g. you haven't run `bun build --compile` yet), supervisor falls back to spawning `bun run apps/core-runtime/src/main.ts` from the repo root. This makes development much faster.

`WebView/WebViewHost.swift` — `NSViewRepresentable` wrapping `WKWebView`:
- Injects `window.__ECHO_SCRIBE__ = { host: "127.0.0.1", port: <supervisor.port> }` via `WKUserScript` at document start.
- In dev (`#if DEBUG`), loads `http://localhost:5173`.
- In release, loads the bundled `dist/index.html` from the app bundle.

`MenuBar/MenuBarView.swift` — SwiftUI view for the menubar:
- A circle (Image symbol) tinted green/gray based on `supervisor.status.healthy`.
- A click reveals a dropdown with "Open Echo Scribe" and "Quit."

That is the entire Mac app for Phase 0. No hotkeys, no audio, no permissions prompts.

Scripts required at the repo root:
- `scripts/dev.ts` — concurrently runs `bun run --cwd packages/ui dev` and the sidecar in fallback mode. Used by `bun run dev`.
- `scripts/build.ts` — builds the sidecar binary (`bun build --compile --target=bun-darwin-arm64 apps/core-runtime/src/main.ts --outfile apps/mac/EchoScribe/Resources/core-runtime`), builds the React UI (`bun run --cwd packages/ui build`), copies UI dist into the Mac app's Resources, and then invokes `xcodebuild`.

Commit: `feat(mac): app skeleton with WKWebView, sidecar supervisor, menubar dot`.

### Step 0.7 — Verify the hello-world flow

Manual checklist:

1. From repo root: `bun install` succeeds.
2. `bun run dev` starts Vite and the sidecar. You should see `{"port":<n>}` printed to the console.
3. Open Xcode, build and run the Mac app.
4. The main window opens. Within ~1 second, it shows "Core says: pong" and "Uptime: 1s" updating every 2s.
5. The menubar shows a green dot.
6. Kill the sidecar process from the terminal (`kill <pid>`). The dot turns gray within 5s. The supervisor restarts the sidecar; the dot turns green again. The React UI's WebSocket reconnects and resumes showing uptime.
7. Quit the Mac app via Cmd+Q. Verify no orphaned `bun` or `core-runtime` process remains (`ps aux | grep echo`).

If all 7 pass, Phase 0 is done. Tag the commit: `git tag phase-0-complete`.

Commit (only if any fixes were needed): `chore: phase 0 verification fixes`.

### Step 0.8 — (Optional but encouraged) Two trivial tests

- `packages/core/src/rpc/server.test.ts` — already added in 0.4. Verify it still passes.
- `packages/ui/src/rpc-client.test.ts` — start a fake WebSocket server, instantiate the client, call ping, assert the result. Use Bun's built-in `bun:test`.

`bun test` from root should run both.

---

## Phase 1 — Voice-to-text at cursor

### Goal

The user holds a global keyboard shortcut (default: `⌘⇧Space`). While held, Echo Scribe captures microphone audio. On release, it transcribes the audio using Apple's `SFSpeechRecognizer` (on-device) and pastes the transcribed text into whatever text field has focus in any application. The same transcription is also logged to the core as a hidden item.

This is the entire scope of Phase 1. No projects, no classifier, no UI for browsing items, no settings UI.

### Acceptance criteria

1. First launch prompts the user for Microphone, Speech Recognition, and Accessibility (for synthetic key events) permissions, with clear `Info.plist` strings.
2. Holding `⌘⇧Space` in any app starts recording. The menubar status icon turns red while recording.
3. Releasing `⌘⇧Space` stops recording. Within 1.5 seconds for short clips (<5s), the transcribed text appears at the cursor in the focused app.
4. The transcribed text is also delivered to the core via `voice.captured` and appears in `~/EchoScribe/events/` as a `voice.captured` event with `visibility: "hidden"`.
5. Recording fails gracefully if no mic is available, with a system notification explaining what's wrong.
6. The hotkey can be changed via a Settings pane in the React UI (basic functionality only — a single text field showing the current hotkey and a "Record new..." button).

### Step 1.1 — Add HotKey + permission strings

- Add `HotKey` via Swift Package Manager.
- Add to `Info.plist`:
  - `NSMicrophoneUsageDescription`: "Echo Scribe needs microphone access to transcribe what you say."
  - `NSSpeechRecognitionUsageDescription`: "Echo Scribe transcribes your voice on-device using Apple's Speech framework."
  - `NSAppleEventsUsageDescription` may be needed for paste-at-cursor via AppleScript fallback.
- Create `Hotkeys/HotkeyManager.swift` that registers `⌘⇧Space` and exposes `onPressDown` / `onPressUp` callbacks.

Hotkey conflict handling: if registration fails (another app owns the combo), surface a notification ("hotkey unavailable") and let the user pick a different one in Settings.

Commit: `feat(mac): global hotkey registration`.

### Step 1.2 — Audio capture

`AudioCapture/MicRecorder.swift`:
- `start()` initializes `AVAudioEngine`, taps the input node at 16 kHz mono PCM, writes to a temp `wav` file in `~/Library/Application Support/EchoScribe/scratch/audio/<ULID>.wav`.
- `stop()` flushes, returns the file path.
- Permissions: requests microphone access via `AVCaptureDevice.requestAccess(for: .audio)` on first use.

Recording starts on hotkey-down, stops on hotkey-up. Maximum recording length: 60 seconds (hard cap, abort with notification if exceeded).

Commit: `feat(mac): mic capture via AVAudioEngine`.

### Step 1.3 — Transcription via SFSpeechRecognizer

`Transcription/AppleTranscriber.swift`:
- Wraps `SFSpeechRecognizer` configured for the user's locale (auto-detect; default `en_US`).
- Forces on-device recognition: `recognitionRequest.requiresOnDeviceRecognition = true`. (No network round-trip, no Apple-side processing.)
- Async function `transcribe(audioPath: URL) -> String`.
- Handles errors: `noSpeechDetected`, `notAuthorized`, etc. — log to `os.Logger` and surface via notification on failure.

Wire the flow in a new `Pipeline/VoiceToTextPipeline.swift`:
1. Hotkey down → `MicRecorder.start()` + UI: menubar icon → red recording state.
2. Hotkey up → `MicRecorder.stop()` returns audio path.
3. `AppleTranscriber.transcribe(audioPath)` returns text.
4. Delete the audio file from `scratch/` (per decision 001 — audio is transient).
5. Hand the text to the cursor inserter (next step) AND to the core via RPC.

Commit: `feat(mac): on-device transcription via SFSpeechRecognizer`.

### Step 1.4 — Paste at cursor

`Cursor/CursorInserter.swift`:
- Approach: copy text to `NSPasteboard.general`, then synthesize a `Cmd+V` keystroke using `CGEvent`.
- Save and restore the previous pasteboard contents so we don't clobber the user's clipboard.
- Synthesizing `Cmd+V` requires Accessibility permission. On first use, if `AXIsProcessTrusted()` returns false, open `System Settings → Privacy & Security → Accessibility` deep-link and show a one-screen onboarding explaining why.

Why pasteboard + simulated paste rather than the Accessibility API directly: simpler, more reliable across apps, doesn't require finding the focused element. Tradeoff: brief pasteboard overwrite.

Commit: `feat(mac): paste-at-cursor via NSPasteboard + simulated Cmd+V`.

### Step 1.5 — Wire through to core for hidden logging

Extend `protocol`:

`domain.ts` — add:
```ts
export const CaptureSource = z.enum(["voice_at_cursor", "log_capture", "meeting", "web", "email"]);
export const Visibility = z.enum(["hidden", "visible"]);

export const VoiceCapturedParams = z.object({
  text: z.string(),
  source: CaptureSource,
  visibility: Visibility,
  capturedAt: z.string(), // ISO timestamp
});
```

`methods.ts` — add:
```ts
"voice.captured": { params: VoiceCapturedParams, result: z.object({ itemId: ItemId }) },
```

In `core/`, implement the `voice.captured` handler:
- Generate a ULID.
- Write a `voice.captured` event to the events folder (this is the first real event the system writes — it forces you to actually implement the event-log writer described in decision 001).
- Project the event into the SQLite `items` table (also the first real projection).
- Return the new item ID.

For Phase 1, implement the bare-minimum event log + SQLite projection per decision 001 §"What ships in Phase 1":
- `~/EchoScribe/events/YYYY/MM/<ulid>.json` for each event.
- `~/Library/Application Support/EchoScribe/echo.db` SQLite file.
- `items` table: `id TEXT PRIMARY KEY, content TEXT, source TEXT, visibility TEXT, captured_at TEXT, created_at TEXT, deleted_at TEXT NULL`.
- FTS5 virtual table on `items.content`.
- ULID generation: there's no "official" Bun ULID lib — use `ulidx` from npm or write a 30-line implementation.

Do not implement the full catch-up / replay loop yet. For Phase 1, write-event-then-project-synchronously is fine. The catch-up loop matters once a second device exists (Phase 2b).

In the Mac shell, after transcription succeeds, call `voice.captured(text, source: "voice_at_cursor", visibility: "hidden", capturedAt: <now>)` via the RPC client.

Commit: `feat(core): voice.captured RPC + minimal event log + SQLite projection`.
Commit: `feat(mac): wire transcription pipeline to core for hidden logging`.

### Step 1.6 — Settings pane for hotkey

In `packages/ui/src/pages/Settings.tsx`:
- A single section titled "Voice-to-text shortcut."
- Shows the current hotkey (read from `system.getSettings`).
- A "Record new shortcut..." button that captures the next key combo and saves via `system.updateSettings`.

Add to `protocol`:
```ts
"system.getSettings": { params: z.object({}), result: SettingsSchema },
"system.updateSettings": { params: z.object({ patch: SettingsPatchSchema }), result: SettingsSchema },
```

Settings persist in `~/EchoScribe/config.json` per decision 001's folder layout.

The Mac shell subscribes to a `settings.changed` event and re-registers the hotkey when the binding changes.

Commit: `feat(ui): settings pane for voice-to-text hotkey`.
Commit: `feat(core): settings persistence + change events`.

### Step 1.7 — Verify end-to-end

Manual test script:

1. Fresh launch → permissions prompts appear in order: microphone, speech recognition, accessibility. Grant all.
2. Open TextEdit. Click in the document.
3. Hold `⌘⇧Space`, say "hello world this is a test", release.
4. Within ~1.5s, "hello world this is a test" appears in TextEdit at the cursor.
5. Open Echo Scribe's main window. Open the database with `sqlite3 ~/Library/Application\ Support/EchoScribe/echo.db "SELECT * FROM items"`. The capture should be there with `visibility=hidden`.
6. Inspect `~/EchoScribe/events/` — there should be a corresponding `voice.captured.json` event file.
7. Inspect `~/Library/Application Support/EchoScribe/scratch/audio/` — should be empty (audio deleted after transcription).
8. Open Settings, change the hotkey to `⌘⇧.`, close Settings. The new hotkey works; the old one no longer triggers recording.
9. Cmd+Q the app. No orphaned processes.

If all 9 pass, Phase 1 is done. Tag the commit: `git tag phase-1-complete`.

---

## What's explicitly NOT in Phase 0 or Phase 1

These are real features but they belong to later phases. **Do not build them as part of this brief**, even if you have time:

- The "log capture" hotkey (Phase 2 — needs projects + classifier UI to make sense).
- Projects, classifier, classifier confirmation UI (Phase 2).
- Embedding pipeline (Phase 2).
- Multi-device sync (Phase 2b).
- The chat interface (Phase 3).
- Meeting capture (Phase 4).
- Tasks & reminders (Phase 5).
- Email integration (Phase 6).
- Permissions / policy engine (lands when the first integration that needs it does — Phase 6).
- Anything iOS or Windows.
- Cloud transcription, cloud LLM, OpenAI/Anthropic SDKs.
- Code signing for distribution (development cert is fine).
- Auto-update mechanism.

---

## Open items where you may need to ask the user

If any of these come up, ask before deciding:

1. **Bun's `bun build --compile` cross-compile to `arm64-darwin`** — verify this actually produces a working standalone binary in your Bun version. If it doesn't, fall back to shipping the Mac app with a bundled `bun` binary plus the source. Either way, ask before changing the runtime story.
2. **Apple Developer account** — code signing the bundled sidecar binary may need entitlements you can't add without a paid account. Ask the user about their dev account status before getting blocked on signing issues.
3. **Hardened runtime + library validation** with the bundled sidecar — known finicky. If the spawned sidecar fails to launch from inside the app bundle with a Gatekeeper error, ask before attempting fixes.
4. **macOS Speech framework on-device requirement** — if the user's locale doesn't support on-device recognition (some non-English locales), `requiresOnDeviceRecognition = true` will fail. Ask the user whether to fall back to server recognition (sends audio to Apple) or surface an error.
5. **Hotkey conflicts** — `⌘⇧Space` might already be taken on the user's machine. If hotkey registration fails, ask what the default should be.

---

## Working agreement

- Conventional commits, one logical change per commit.
- Push to a feature branch; do not commit directly to `main` for any phase work.
- After each phase, open a PR back to `main` titled `Phase N — <summary>`. PR description lists what changed, what was tested, and any deferred items.
- If a step takes more than a few hours of attempted work without progress, stop and ask. Do not silently scope down or work around the architecture.

When Phase 1 is complete and tagged, stop and notify the user. Phase 2 needs its own brief — the classifier, the second hotkey, the project UI, and the embedding pipeline are substantial enough work that scoping them deserves a fresh conversation with the user.
