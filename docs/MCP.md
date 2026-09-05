# Tucky MCP server

Tucky includes a Model Context Protocol server for coding agents
(Claude Code, Codex CLI, Cursor, …). It runs entirely on the user's machine
and exposes curated tools instead of raw SQL access.

Every tool belongs to a **permission category** — one checkbox each in
**Settings → Coding Agents** (single source of truth:
`src-tauri/src/mcp_permissions.rs`). Permissions are re-checked on every tool
call, so unticking a box applies immediately, even for agents already
connected.

| Category | Tools | Default |
| --- | --- | --- |
| Search captures & notes | `search_tucky`, `list_projects`, `list_tasks` | on |
| Meetings & transcripts | `list_meetings`, `get_meeting`, `list_recipes` | on |
| Chats | `search_chats`, `list_chats`, `get_chat` | on |
| People & companies | `list_people`, `list_companies` | on |
| Screen recording (macOS) | `list_recording_sources`, `start_recording`, `stop_recording`, `get_recording_status` | **off** |

Read-only categories query the local database directly and work whether or
not the desktop app is running. Screen recording is forwarded to the running
app and is an explicit opt-in.

Settings → Coding Agents in the app shows the same install snippets as below
with copy buttons — plus one-click **Install** buttons for Claude Code and
Codex that run the agent's own CLI (`claude mcp add --scope user` /
`codex mcp add`), resolving it via the user's login shell and common install
locations.

## Connect an MCP client

Claude Code:

```bash
claude mcp add tucky -- "/Applications/Tucky.app/Contents/MacOS/echo-scribe" --mcp
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.tucky]
command = "/Applications/Tucky.app/Contents/MacOS/echo-scribe"
args = ["--mcp"]
```

Any other MCP client:

```json
{
  "mcpServers": {
    "tucky": {
      "command": "/Applications/Tucky.app/Contents/MacOS/echo-scribe",
      "args": ["--mcp"]
    }
  }
}
```

For a source build, replace the command with the absolute path to
`src-tauri/target/release/echo-scribe` (or the debug binary while developing).

The server uses newline-delimited JSON-RPC over standard input and output. The
client should negotiate MCP protocol version `2024-11-05`.

## Using it from an agent

There is no slash command — the agent discovers the tools and calls them when
a request needs them; mentioning "Tucky" nudges it to look there.
Example prompts:

- "List my windows with Tucky and record the Chrome window with system
  audio. Stop when I tell you and summarize what happened in the video."
- "Record my screen with mic on while I reproduce this bug, then stop and
  analyze the video for what went wrong."
- "Search my Tucky meetings for the pricing discussion and summarize
  the decisions."
- "What did I dictate last week about the onboarding flow?"

For recording, the app must be running with the Screen recording permission
ticked; `stop_recording` returns the video path so the agent can analyze the
file (frames via ffmpeg, transcript, etc.).

## Knowledge tools (read-only)

- `search_tucky` searches local captures.
- `list_meetings` and `get_meeting` read meetings, summaries, notes, and
  confirmed speaker labels.
- `search_chats`, `list_chats`, and `get_chat` search and read the app's
  chat conversations.
- `list_projects` and `list_tasks` read the current project and task state.
- `list_people` and `list_companies` read confirmed relationship records.
- `list_recipes` reads reusable meeting-analysis Recipes.

## Recording tools (macOS, opt-in)

Available only while the Tucky app is running, and only when the user
has ticked **Screen recording** in Settings → Coding Agents. The
`--mcp` process forwards these to the app over a local unix socket
(`~/Library/Application Support/EchoScribe/mcp-bridge.sock`, mode 0600); the
app owns the TCC permission grants and does the actual capture.

- `list_recording_sources` — windows and displays with ids, app names,
  titles, and sizes.
- `start_recording` — record one window (`window_id`) or display
  (`display_id`; omit both for the primary display), with `mic`
  (default off), `system_audio` (default on), and `camera` (default off)
  booleans. Mic and camera devices come from the user's recording
  preferences, falling back to the system defaults. The webcam is captured as
  a **separate** video file, never composited into the main video.
- `stop_recording` — finalizes the recording, saves it into the app's
  library (it shows up in Recordings like any other), and returns absolute
  paths: `video_path` (H.264 MP4 + AAC audio), plus `webcam_video_path` and
  `events_path` when present.
- `get_recording_status` — whether a recording is in progress / paused.

Recordings started over MCP behave exactly like UI-started ones: same output
folder, same database row, same tray indicator, same auto-denoise pass after
stop. Only one recording can run at a time.

## Logging

Tool names and timestamps are logged to
`~/Library/Logs/EchoScribe/mcp-access.log`; returned content is not written to
that log. Bridge requests are also logged by the app with `target: "mcp"` in
the daily `echo-scribe.log`. The MCP process opens the same local SQLite
database as the app and does not send data to a hosted service.

## Development smoke test

Set `ECHO_SCRIBE_MCP_DB` to point the MCP process at a temporary SQLite file
without touching the user's normal Tucky database:

```bash
ECHO_SCRIBE_MCP_DB=/tmp/echo-scribe-mcp.sqlite \
  src-tauri/target/debug/echo-scribe --mcp
```

`ECHO_SCRIBE_MCP_SETTINGS` similarly points the permission checks at an
alternative settings.json (the real one lives at
`~/Library/Application Support/com.echoscribe.app/settings.json`).

Recording tools ignore both overrides — they always talk to the running app,
which enforces the Screen recording permission against its live state.
