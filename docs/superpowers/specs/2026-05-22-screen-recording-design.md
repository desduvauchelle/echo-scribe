# Screen Recording + Drive Sharing — Design

Date: 2026-05-22
Status: Approved (brainstorm), pending implementation plan

## Summary

Add Loom/Screen-Studio-style screen recording to Echo Scribe: pick a screen or
window, record it (with system audio and/or microphone), save an H.264 MP4
locally, export at multiple quality levels on demand, and optionally auto-upload
to Google Drive with a shareable link. A new Recordings library view lists all
recordings; each upload also appears as a new `recording` activity in the
dashboard feed.

This is a self-contained, standalone feature, separate from the existing meeting
recording pipeline. It reuses the proven sidecar supervision pattern
(`src-tauri/src/meeting/syscap.rs`) and the overlay-webview-window pattern, but
runs in its own dedicated Swift sidecar so it never contends with meeting audio
capture.

## Goals

- Record entire screen or a specific window to an MP4 at native resolution.
- Capture video + cursor, plus user-selectable audio: system audio and/or
  microphone (with mic device selection). Audio choices persist (remember last
  used).
- Export presets on demand: Original / 1080p / 720p / 480p (H.264).
- Optional auto-upload to Google Drive after stop, default quality 1080p
  (configurable); share link copied to clipboard and surfaced in the dashboard
  feed.
- A Recordings library view: thumbnail, play, export, upload/copy-link, delete,
  reveal in Finder.

## Non-goals (v1)

- No camera/webcam bubble or compositing.
- No pause/resume mid-recording.
- No countdown timer before recording.
- No forced 16:9 conform — record at the source's native aspect ratio. (16:9
  letterbox could become an optional export preset later.)
- No editing/trimming.
- No cloud targets other than Google Drive.

## Decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Encode path | ScreenCaptureKit → AVAssetWriter → H.264 MP4 | Keeps macOS 14 floor; full audio-mix + cursor control. (SCRecordingOutput needs macOS 15; FFmpeg is heavy + licensing.) |
| Capture inputs | Video + cursor always; system audio + mic optional, mic device selectable | Per user; audio toggles persist (last used). |
| Aspect ratio | Native | Per user; no conform step. |
| Quality model | Record high (native), export on demand | One source file; transcode only when needed. |
| Drive scope | `drive.file` | App only sees files it created; lightest Google verification. |
| OAuth client | Bundled client by default + BYO client-ID override | Zero-setup default; BYO removes unverified-app warning + 100-user cap. |
| OAuth flow | Loopback redirect + PKCE | Correct flow for an installed/unsigned desktop app; no usable client secret needed. |
| Controls | Global hotkey + setup window before record; menubar icon → red stop icon while recording | Per user. No floating control bar; menubar is the in-recording stop. |
| Upload trigger | Auto-upload after stop (configurable), default 1080p (configurable) | Per user; link to clipboard + dashboard activity. |

## Architecture

```
Setup window (webview)          Menubar (red stop icon)      Recordings library view
   pick screen/window              click/hotkey = stop          grid · play · export · upload · delete
   mic device + toggle                    │                            │
   system-audio toggle                    ▼                            ▼
        │  Start                  ┌──────────────────────┐      Dashboard feed
        ▼                         │ screenrec (Rust mod)  │      new "recording" activity + link
 echo-scribe-screenrec  ───────▶  │ supervises sidecar,   │
 (new Swift sidecar)              │ writes DB, drives      │
  SCKit → AVAssetWriter           │ export + upload        │
  H.264 MP4 @ native res          └──────────┬───────────┘
  --list-sources (JSON)                      │
                              ┌──────────────┼───────────────┐
                              ▼              ▼               ▼
                       recordings DB    export op       Drive module
                       table            AVAssetExport-  OAuth loopback+PKCE,
                                        Session →       resumable upload,
                                        1080/720/480    anyone-w/link, webViewLink
                                                        bundled client + BYO override
```

### Components

1. **`echo-scribe-screenrec` — new Swift sidecar** (`src-tauri/screenrec/`,
   built like `src-tauri/syscap/` via a `scripts/build-screenrec.sh`).
   Responsibilities: enumerate sources, capture+encode, export-transcode.
   Self-contained; does not run during meetings.

2. **`src-tauri/src/screenrec/` — Rust module.** Supervises the sidecar
   (mirrors `meeting/syscap.rs`: spawn, read stderr JSON events, SIGTERM stop,
   respawn-never). Orchestrates: start/stop, write DB row, kick export, kick
   upload, emit activity. Exposes Tauri commands.

3. **Drive module** (`src-tauri/src/screenrec/drive.rs` or `src-tauri/src/drive/`).
   OAuth (loopback+PKCE), token storage, resumable upload, permission set, link
   fetch. Bundled-client default + BYO override.

4. **`recordings` DB table** (new migration in `src-tauri/src/db/`).

5. **Frontend:** setup window (webview), Recordings library view (new section),
   settings additions (Drive connect/disconnect, auto-upload toggle, default
   upload quality, BYO client ID), red menubar state, global hotkey binding.

6. **Dashboard feed:** new `recording` activity type in `ActivityPanel`.

## Sidecar protocol

JSON events on stderr (line-delimited), like syscap. stdout reserved for
structured output where noted. Control via process args + SIGTERM.

- `--list-sources`
  One-shot. Prints one JSON object on stdout, exit 0:
  ```json
  {
    "displays": [{ "id": "37D8832A", "width": 3456, "height": 2234, "label": "Built-in Retina Display" }],
    "windows":  [{ "id": 142, "app": "Safari", "title": "GitHub — page", "width": 1280, "height": 800 }],
    "mics":     [{ "uid": "BuiltInMic", "name": "MacBook Pro Microphone" }]
  }
  ```
  (Mic enumeration may instead live in the existing audio module if simpler;
  decided at plan time.)

- `record --out <path> (--display <id> | --window <id>) [--mic <deviceUID>] [--sysaudio]`
  Captures to `<path>` (MP4). Emits: `ready`, `heartbeat {ts, bytes, dur_ms}`,
  `error {kind, msg}`, and on SIGTERM does a clean stop: finalize
  `AVAssetWriter.finishWriting()`, write a poster-frame thumbnail JPG next to the
  MP4, then emit `stopped {path, thumb, dur_ms, width, height, size}` and exit 0.

- `export --in <path> --out <path> --quality <1080|720|480>`
  AVAssetExportSession transcode. Emits `progress {pct}`, then `done {path, size}`
  or `error {kind, msg}`.

### Audio mixing (hardest part)

System audio (SCStream `.audio`) and microphone are separate sources and must be
**summed into a single audio track** before AVAssetWriter writes it
(AVAssetWriter accepts one input per track; even macOS 15's separate
`.microphone` stream still requires mixing). Approach:

- Resample both sources to a common format (reuse the AVAudioConverter pattern
  already in `syscap/main.swift`).
- Sum sample-by-sample with clamping to avoid Int16 overflow/clipping artifacts.
- Feed the mixed buffer to a single AVAssetWriterInput (audio), alongside the
  video AVAssetWriterInput (frames from SCStream `.screen`).
- If only one audio source is enabled, pass it through (no summing). If neither,
  write a video-only file.

Mic capture on macOS 14 comes from AVCaptureDevice/AVAudioEngine (SCStream
`.microphone` is macOS 15+); the sidecar abstracts the source so the mixer is
identical either way.

## Drive integration

1. **Connect** (Settings → Drive → Connect): start a loopback HTTP listener on
   `http://127.0.0.1:<ephemeral-port>`, open the system browser to Google's auth
   URL with PKCE `code_challenge`, scope `https://www.googleapis.com/auth/drive.file`.
   Receive `code` on the loopback, exchange for tokens with `code_verifier`.
   - Default: bundled client ID. If the user set a BYO client ID in settings, use
     that instead (BYO removes the unverified-app warning + 100-user cap).
2. **Token storage:** `refresh_token` in the macOS Keychain (Security framework);
   `access_token` cached in memory with expiry. Silent refresh on expiry.
3. **Upload:** resumable upload session (survives large files / transient network
   drops; retry the session on failure). Target an "Echo Scribe" folder in Drive
   (create once, store folder id).
4. **Share link:** after upload, PATCH permissions `{ role: "reader", type: "anyone" }`,
   then read `webViewLink`. Store `drive_file_id` + `drive_link` on the row.
5. **Auto-upload:** if enabled (default on, configurable), on `stopped`:
   export to the default upload quality (1080p, configurable) → upload → copy
   link to clipboard → emit a `recording` activity into the dashboard feed.
   If disabled, recordings stay local; user uploads manually from the library
   (picks quality, gets link then).

## Data model — `recordings` table

```
id            TEXT PRIMARY KEY     -- uuid
created_at    INTEGER NOT NULL     -- epoch ms
file_path     TEXT NOT NULL        -- source MP4, native res
duration_ms   INTEGER
width         INTEGER
height        INTEGER
size_bytes    INTEGER
source_label  TEXT                 -- "Entire screen" / "Safari — <title>"
has_mic       INTEGER NOT NULL     -- 0/1
has_sysaudio  INTEGER NOT NULL     -- 0/1
thumb_path    TEXT                 -- poster-frame JPG
drive_file_id TEXT                 -- nullable
drive_link    TEXT                 -- nullable
upload_status TEXT NOT NULL        -- none | uploading | done | error
upload_error  TEXT                 -- nullable
exports       TEXT                 -- JSON: [{ "quality": "1080", "path": "...", "size": 123 }]
```

Storage root: `~/Library/Application Support/EchoScribe/recordings/`.

## Settings additions

- `screenrec.audio.system` (bool, last-used) — default on
- `screenrec.audio.mic` (bool, last-used) — default off
- `screenrec.audio.mic_device` (string UID, last-used)
- `screenrec.hotkey` (string)
- `drive.auto_upload` (bool) — default on
- `drive.upload_quality` ("original"|"1080"|"720"|"480") — default "1080"
- `drive.client_id` (string, optional BYO; empty = bundled)
- Drive connection state (connected account email, folder id) — derived/stored

All persist via the existing settings store (per project rule: every user-facing
setting persists).

## Error handling

- **Sidecar crash mid-record:** supervisor never gets `stopped`; if AVAssetWriter
  had flushed, keep the partial file and mark row usable, else mark `error`.
  Surface a toast. No auto-respawn (a dropped recording can't be resumed).
- **Disk full:** sidecar emits `error {kind: "disk"}` and stops; surface toast.
- **Screen Recording permission missing:** same canonical signal as syscap
  (`stream_stopped` / "no displays or windows to capture"); prompt the user to
  grant it. (Permission likely already held since meetings use it.)
- **Mic permission missing:** TCC mic prompt (sidecar runs under the app bundle,
  inherits grant from dictation); if denied, record without mic + warn.
- **Drive token expired:** silent refresh; if refresh fails, set
  `upload_status = error`, show "Reconnect Drive" in settings.
- **Upload network failure:** resumable session retry; on give-up mark
  `upload_status = error` with `upload_error`, offer manual retry from library.

## Permissions / build notes

- Screen Recording + Microphone TCC: already declared (meetings + dictation).
  Adding the screenrec sidecar does not change Info.plist usage strings, so per
  CLAUDE.md the default skip-TCC reinstall applies — **unless** a new entitlement
  or capability is needed for the sidecar/webview, in which case do a full TCC
  reset.
- New webview window (setup window) → add to `src-tauri/capabilities/*.json`
  (capability change → TCC reset on that build).
- New sidecar binary → bundle like `echo-scribe-syscap` (per-arch naming,
  resolved via `current_exe().parent()`), add a `scripts/build-screenrec.sh`,
  wire into the Tauri bundle + `release.yml`.

## Testing

- **Rust unit:** supervisor lifecycle (spawn/stop/event-parse), `recordings` DB
  CRUD + migration, Drive PKCE generation, token refresh (mock HTTP), upload
  state machine (mock HTTP).
- **Swift sidecar:** `--list-sources` smoke test (returns JSON, exit 0); a short
  `record` produces a valid MP4 with duration > 0 (verify via AVAsset/ffprobe);
  `export` produces a smaller file at target resolution.
- **Audio mix unit:** sum + clamp of two PCM buffers (no overflow; mono-source
  passthrough).
- **Drive upload:** integration test behind a feature flag against a real test
  account; excluded from CI.

## Phasing (single spec, sequenced implementation)

1. **Capture core** — screenrec sidecar (`record` → MP4 + thumbnail), Rust
   supervisor, `recordings` table, Recordings library view (list/play/delete/
   reveal). Video + (single) audio source first.
2. **Capture UX** — setup window (source picker, mic select + toggle, sysaudio
   toggle), mic+system audio mixing, menubar red-stop state, global hotkey.
3. **Export presets** — `export` sub-op + library export UI (Original/1080/720/480).
4. **Drive** — OAuth loopback+PKCE (bundled + BYO), resumable upload, share link,
   auto-upload toggle + default quality, `recording` activity in dashboard feed.

Each phase is independently testable and leaves the app in a working state.

## Open items to resolve at plan time

- Mic enumeration: in the sidecar (`--list-sources`) vs reuse an existing audio
  device list in `src-tauri/src/audio/`.
- Thumbnail capture: poster frame at stop vs first decodable frame.
- Bundled OAuth client ID: register a Google Cloud Desktop client; document the
  unverified-app + 100-user-cap constraints in user docs and in-app copy.
- Exact `recording` activity payload shape — match the existing `ActivityPanel`
  activity type union.
```
