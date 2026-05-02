# Chat Sessions Design

**Date:** 2026-05-02  
**Status:** Approved

## Goal

Persist chat conversations across app restarts, support multiple named sessions with session management (new, delete), and improve RAG retrieval with automatic temporal intent parsing so the AI can answer questions like "tell me everything I did today" or "what did I block this week."

## Background

The existing chat feature (`ChatView.tsx` + `chat_with_memory` command) works but is ephemeral — history lives only in React state and is lost on app close. Items are stored in SQLite with a `captured_at` timestamp and a `source` field (`voice_at_cursor` | `log_capture`), but the search command only accepts a text query and limit — no date filtering. The ChatView already has a project filter; this design keeps and extends that.

## Database Schema (Migration v2)

Two new tables:

```sql
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
CREATE INDEX idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
```

`ON DELETE CASCADE` means deleting a session wipes its messages automatically. Sessions are ordered by `updated_at DESC` so the most recently active is always at the top. `project_id` on the session matches the existing project filter in ChatView.

## Temporal Intent Parsing

A pure Rust function `extract_date_window(message: &str, now: DateTime<Utc>) -> Option<(String, String)>` returns an optional `(from, to)` ISO-8601 pair. No LLM call — deterministic pattern matching.

| Phrase detected | Window |
|----------------|--------|
| "today" | start of today → now |
| "yesterday" | start of yesterday → end of yesterday |
| "this week" | last Monday 00:00 → now |
| "last week" | Monday 00:00 → Sunday 23:59 of previous week |
| "this month" | 1st of current month 00:00 → now |
| "last month" | 1st 00:00 → last day 23:59 of previous month |

When a window is found, it is injected into the FTS5 search as `AND items.captured_at >= ? AND items.captured_at <= ?`. When no window is found, the query runs without a date filter (existing behavior). Both `voice_at_cursor` and `log_capture` items are always searched — source filtering is not applied, giving the AI the richest context.

The current date is injected into the system prompt so the AI can reference it in its answer (e.g. "Here is what you did today, May 2nd…").

## Backend Commands

### New commands

| Command | Parameters | Returns |
|---------|-----------|---------|
| `create_chat_session` | `project_id: Option<String>` | `ChatSession` |
| `list_chat_sessions` | `project_id: Option<String>` | `Vec<ChatSession>` |
| `load_chat_messages` | `session_id: String` | `Vec<ChatMessage>` |
| `delete_chat_session` | `session_id: String` | `()` |
| `rename_chat_session` | `session_id: String`, `name: String` | `()` |

### Modified command

`chat_with_memory` gains a `session_id: String` parameter. On each call it:
1. Persists the user message to `chat_messages`
2. Runs `extract_date_window` on the message
3. Runs the enhanced FTS5 search (with optional date window)
4. Builds system prompt with context items + current date
5. Calls LLM with history loaded from DB (capped at the last 20 messages to stay within context limits)
6. Persists the assistant reply to `chat_messages`
7. Updates `chat_sessions.updated_at`
8. On the first message of a session (name is "New Chat"), auto-renames the session by truncating the user message to 50 chars

### New DB query

`search_items_with_date_window(conn, query, from, to, limit)` — extends existing FTS5 search with optional date range. Falls back to `search_items` when no window is provided.

## Frontend

### Layout

Two-panel layout within `ChatView`:

- **Left panel (~220px, fixed width):** "New Chat" button at top; scrollable session list sorted by `updated_at DESC`; each row shows session name + trash icon on hover; active session highlighted. Filtered by current `projectFilter`.
- **Right panel (flex-1):** Existing chat bubble UI. Header shows current session name. Empty state when no session selected: "Select a session or start a new chat."

### State

```ts
const [sessions, setSessions] = useState<ChatSession[]>([]);
const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
const [messages, setMessages] = useState<ChatMessage[]>([]);
```

On mount: load sessions list. On session select: load messages for that session. On "New Chat": call `create_chat_session`, add to list, select it, clear messages. On delete: call `delete_chat_session`, remove from list, clear active if it was the deleted one.

### Session naming flow

"New Chat" is the placeholder name. After the first assistant reply arrives, the frontend calls `rename_chat_session` with the first user message truncated to 50 chars. The session list updates in place.

### API additions (`src/lib/api.ts`)

```ts
export type ChatSession = { id: string; name: string; project_id: string | null; created_at: string; updated_at: string };
export type ChatMessage = { id: string; session_id: string; role: "user" | "assistant"; content: string; created_at: string };

export const createChatSession: (projectId: string | null) => Promise<ChatSession>
export const listChatSessions: (projectId: string | null) => Promise<ChatSession[]>
export const loadChatMessages: (sessionId: string) => Promise<ChatMessage[]>
export const deleteChatSession: (sessionId: string) => Promise<void>
export const renameChatSession: (sessionId: string, name: string) => Promise<void>
// chatWithMemory gains sessionId parameter
```

## File Map

| File | Action |
|------|--------|
| `src-tauri/src/db/schema.rs` | Add migration v2 with `chat_sessions` + `chat_messages` tables |
| `src-tauri/src/db/chat.rs` | New — CRUD for sessions and messages |
| `src-tauri/src/db/mod.rs` | Export `chat` module |
| `src-tauri/src/db/search.rs` | Add `search_items_with_date_window` |
| `src-tauri/src/temporal.rs` | New — `extract_date_window` with unit tests |
| `src-tauri/src/commands.rs` | Add 5 new commands; update `chat_with_memory` |
| `src-tauri/src/lib.rs` | Register new commands |
| `src/lib/api.ts` | Add `ChatSession`, `ChatMessage` types + 5 new bindings; update `chatWithMemory` signature |
| `src/views/sections/ChatView.tsx` | Refactor to two-panel layout with session list |

## Out of Scope

- Search within chat history (searching past conversations by keyword)
- Export / share sessions
- Editing or deleting individual messages
- Session folders or tags
