# Echo Scribe MCP server

Echo Scribe includes a read-only Model Context Protocol server for querying the
local knowledge stored by the desktop app. It runs entirely on the user's
machine and exposes curated tools instead of raw SQL access.

## Connect an MCP client

An installed macOS app can be configured with:

```json
{
  "mcpServers": {
    "echo-scribe": {
      "command": "/Applications/Echo Scribe.app/Contents/MacOS/echo-scribe",
      "args": ["--mcp"]
    }
  }
}
```

For a source build, replace `command` with the absolute path to
`src-tauri/target/release/echo-scribe` (or the debug binary while developing).

The server uses newline-delimited JSON-RPC over standard input and output. The
client should negotiate MCP protocol version `2024-11-05`.

## Available tools

- `search_echoscribe` searches local captures.
- `list_meetings` and `get_meeting` read meetings, summaries, notes, and
  confirmed speaker labels.
- `list_projects` and `list_tasks` read the current project and task state.
- `list_people` and `list_companies` read confirmed relationship records.
- `list_recipes` reads reusable meeting-analysis Recipes.

All tools are read-only. Tool names and timestamps are logged to
`~/Library/Logs/EchoScribe/mcp-access.log`; returned content is not written to
that log. The MCP process opens the same local SQLite database as the app and
does not send data to a hosted service.

## Development smoke test

Set `ECHO_SCRIBE_MCP_DB` to point the MCP process at a temporary SQLite file
without touching the user's normal Echo Scribe database:

```bash
ECHO_SCRIBE_MCP_DB=/tmp/echo-scribe-mcp.sqlite \
  src-tauri/target/debug/echo-scribe --mcp
```
