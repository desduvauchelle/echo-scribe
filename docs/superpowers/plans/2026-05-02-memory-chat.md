# Memory Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Chat section to the main window where the user can have multi-turn conversations with their notes and captures, powered by the local Gemma 4 LLM and FTS5 retrieval.

**Architecture:** When the user sends a message, the backend does a keyword FTS5 search against the item store, injects the top 6 relevant items as a context block into the system prompt (RAG), then calls the local LLM with the full conversation history. The frontend keeps the chat history in React state and passes it with every request. No vector embeddings — SQLite FTS5 is fast enough and already present.

**Tech Stack:** Rust/llama-cpp-2 for LLM inference, rusqlite FTS5 for retrieval, React/TypeScript frontend, existing `Llm` + `Db` in `AppState`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/src/llm/prompt.rs` | Modify | Add `build_chat_messages` for multi-turn; keep `build_messages` as thin wrapper |
| `src-tauri/src/llm/engine.rs` | Modify | Add `history` field to `GenerateRequest`; call `build_chat_messages` |
| `src-tauri/src/commands.rs` | Modify | Add `ChatTurnInput` struct, `build_rag_query` helper, `chat_with_memory` command |
| `src-tauri/src/lib.rs` | Modify | Import and register `chat_with_memory` |
| `src/lib/api.ts` | Modify | Add `ChatTurn` type and `chatWithMemory` binding |
| `src/views/sections/ChatView.tsx` | Create | Chat UI: message bubbles, input, loading state |
| `src/views/Main.tsx` | Modify | Add `"chat"` to `MainSection`, sidebar nav item, and renderContent case |

---

## Task 1: Multi-turn messages in prompt.rs

**Files:**
- Modify: `src-tauri/src/llm/prompt.rs`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `#[cfg(test)] mod tests` block in `src-tauri/src/llm/prompt.rs`:

```rust
#[test]
fn build_chat_messages_includes_history() {
    let history = vec![
        ("user".to_string(), "hello".to_string()),
        ("assistant".to_string(), "hi there".to_string()),
    ];
    let msgs = build_chat_messages(Some("be helpful"), &history, "follow up").unwrap();
    // system + 2 history turns + user = 4
    assert_eq!(msgs.len(), 4);
}

#[test]
fn build_chat_messages_empty_history_matches_build_messages() {
    let a = build_messages(Some("sys"), "user msg").unwrap();
    let b = build_chat_messages(Some("sys"), &[], "user msg").unwrap();
    assert_eq!(a.len(), b.len());
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test llm::prompt -- --nocapture 2>&1 | tail -20
```

Expected: FAIL — `build_chat_messages` not found.

- [ ] **Step 3: Implement `build_chat_messages`**

Add this function to `src-tauri/src/llm/prompt.rs`, just before `build_messages`:

```rust
/// Build a multi-turn chat message vector.
///
/// `history` is `(role, content)` pairs — alternating "user" / "assistant"
/// from oldest to most recent, NOT including the current turn.
pub fn build_chat_messages(
    system: Option<&str>,
    history: &[(String, String)],
    user: &str,
) -> Result<Vec<LlamaChatMessage>, NewLlamaChatMessageError> {
    let mut msgs = Vec::new();
    if let Some(sys) = system {
        if !sys.is_empty() {
            msgs.push(LlamaChatMessage::new("system".to_string(), sys.to_string())?);
        }
    }
    for (role, content) in history {
        msgs.push(LlamaChatMessage::new(role.clone(), content.clone())?);
    }
    msgs.push(LlamaChatMessage::new("user".to_string(), user.to_string())?);
    Ok(msgs)
}
```

Update `build_messages` to be a thin wrapper (no logic change — callers stay unchanged):

```rust
pub fn build_messages(
    system: Option<&str>,
    user: &str,
) -> Result<Vec<LlamaChatMessage>, NewLlamaChatMessageError> {
    build_chat_messages(system, &[], user)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test llm::prompt -- --nocapture 2>&1 | tail -20
```

Expected: all prompt tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/prompt.rs
git commit -m "feat(llm): add build_chat_messages for multi-turn history"
```

---

## Task 2: Add `history` to GenerateRequest and wire engine

**Files:**
- Modify: `src-tauri/src/llm/engine.rs`

- [ ] **Step 1: Add `history` field to `GenerateRequest`**

In `src-tauri/src/llm/engine.rs`, find the `GenerateRequest` struct and add one field. The `Default` impl also needs updating.

Change the struct from:
```rust
pub struct GenerateRequest {
    pub system: Option<String>,
    pub user: String,
    pub max_tokens: usize,
    pub temperature: f32,
    pub stop_strings: Vec<String>,
    pub grammar_gbnf: Option<String>,
}
```
to:
```rust
pub struct GenerateRequest {
    pub system: Option<String>,
    pub user: String,
    /// Previous conversation turns as (role, content) pairs,
    /// oldest first. Role is "user" or "assistant".
    pub history: Vec<(String, String)>,
    pub max_tokens: usize,
    pub temperature: f32,
    pub stop_strings: Vec<String>,
    pub grammar_gbnf: Option<String>,
}
```

Change the `Default` impl block from:
```rust
impl Default for GenerateRequest {
    fn default() -> Self {
        Self {
            system: None,
            user: String::new(),
            max_tokens: 256,
            temperature: 0.7,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
        }
    }
}
```
to:
```rust
impl Default for GenerateRequest {
    fn default() -> Self {
        Self {
            system: None,
            user: String::new(),
            history: Vec::new(),
            max_tokens: 256,
            temperature: 0.7,
            stop_strings: Vec::new(),
            grammar_gbnf: None,
        }
    }
}
```

- [ ] **Step 2: Update `generate()` to use `build_chat_messages`**

In `src-tauri/src/llm/engine.rs`, find the `generate` method. Change the import at the top of the file:

```rust
use super::prompt::{build_chat_messages, strip_trailing_stops};
```

(Remove `build_messages` from this import line.)

Find the line in `generate()`:
```rust
let messages = build_messages(req.system.as_deref(), &req.user)
    .map_err(|e| EngineError::Request(format!("nul byte in prompt: {e}")))?;
```

Replace it with:
```rust
let messages = build_chat_messages(req.system.as_deref(), &req.history, &req.user)
    .map_err(|e| EngineError::Request(format!("nul byte in prompt: {e}")))?;
```

- [ ] **Step 3: Run all LLM tests**

```bash
cd src-tauri && cargo test llm -- --nocapture 2>&1 | tail -30
```

Expected: all pass. `GenerateRequest` with `history: Vec::new()` is backward compatible — all existing callers construct it with struct literal syntax so the compiler will tell you if any field is missing.

- [ ] **Step 4: Verify the classifier still compiles (it uses GenerateRequest)**

```bash
cd src-tauri && cargo check 2>&1 | grep -E "error|warning.*unused" | head -20
```

Expected: 0 errors. If the classifier (or any other code) creates `GenerateRequest { .. }` with all fields named, you'll get a compile error — add `history: Vec::new()` there.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/llm/engine.rs
git commit -m "feat(llm): add history to GenerateRequest for multi-turn chat"
```

---

## Task 3: `chat_with_memory` Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Write the failing test for `build_rag_query`**

Add these tests at the bottom of the `#[cfg(test)] mod tests` block in `src-tauri/src/commands.rs`:

```rust
#[test]
fn build_rag_query_extracts_long_words() {
    let q = build_rag_query("what did I say about the project meeting yesterday");
    // Should include words >= 4 chars: "about", "project", "meeting", "yesterday"
    assert!(q.contains("\"about\"") || q.contains("\"project\"") || q.contains("\"meeting\""));
    // Should NOT include short words
    assert!(!q.contains("\"did\""));
    assert!(!q.contains("\"the\""));
}

#[test]
fn build_rag_query_returns_empty_for_short_message() {
    assert_eq!(build_rag_query("hi"), "");
    assert_eq!(build_rag_query("ok go"), "");
}

#[test]
fn build_rag_query_strips_punctuation() {
    let q = build_rag_query("meeting! project?");
    assert!(q.contains("\"meeting\""));
    assert!(q.contains("\"project\""));
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test commands::tests::build_rag -- --nocapture 2>&1 | tail -10
```

Expected: FAIL — `build_rag_query` not found.

- [ ] **Step 3: Add `ChatTurnInput`, `build_rag_query`, and `chat_with_memory`**

Append the following at the end of `src-tauri/src/commands.rs`, just before the `#[cfg(test)]` block:

```rust
// ----- Memory chat -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurnInput {
    pub role: String,    // "user" | "assistant"
    pub content: String,
}

/// Extract FTS5-safe keywords from a natural-language message.
///
/// Keeps words of 4+ chars, strips non-alphanumeric chars, quotes each word
/// to prevent FTS5 syntax errors, and caps at 6 keywords joined with OR.
/// Returns an empty string when no usable keywords remain.
pub(crate) fn build_rag_query(message: &str) -> String {
    let keywords: Vec<String> = message
        .split_whitespace()
        .filter(|w| w.len() >= 4)
        .map(|w| {
            let clean: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
            clean
        })
        .filter(|w| w.len() >= 4)
        .take(6)
        .map(|w| format!("\"{}\"", w))
        .collect();
    keywords.join(" OR ")
}

#[tauri::command]
pub async fn chat_with_memory(
    state: State<'_, AppState>,
    message: String,
    history: Vec<ChatTurnInput>,
) -> Result<String, String> {
    if !state.llm.ready() {
        return Ok(
            "No local AI model is loaded. Please download one in Settings → AI Model.".to_string(),
        );
    }

    // FTS5 retrieval: find up to 6 items relevant to the user's message.
    let context_items: Vec<String> = if let Some(db) = &state.db {
        let rag_query = build_rag_query(&message);
        if rag_query.is_empty() {
            Vec::new()
        } else {
            db.with_conn(|c| db::search::search_items(c, &rag_query, 6))
                .unwrap_or_default()
                .into_iter()
                .map(|item| {
                    let kind = item.kind.as_deref().unwrap_or("note");
                    let date = &item.captured_at[..10.min(item.captured_at.len())];
                    format!("[{date}] ({kind}): {}", item.content)
                })
                .collect()
        }
    } else {
        Vec::new()
    };

    let system = if context_items.is_empty() {
        "You are a helpful assistant built into Echo Scribe, a voice note and task capture app. \
         No relevant notes were found for this question. Answer helpfully."
            .to_string()
    } else {
        format!(
            "You are a helpful assistant built into Echo Scribe. \
             Here are the user's relevant notes and captures:\n\n---\n{}\n---\n\n\
             Answer based on these notes when relevant. \
             If the notes don't address the question, say so and answer from general knowledge.",
            context_items.join("\n")
        )
    };

    let hist: Vec<(String, String)> = history
        .into_iter()
        .map(|t| (t.role, t.content))
        .collect();

    let req = GenerateRequest {
        system: Some(system),
        user: message,
        history: hist,
        max_tokens: 512,
        temperature: 0.7,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
    };

    state.llm.generate(req).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run the new tests**

```bash
cd src-tauri && cargo test commands::tests::build_rag -- --nocapture 2>&1 | tail -15
```

Expected: 3 tests PASS.

- [ ] **Step 5: Check it compiles**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): add chat_with_memory with FTS5 RAG retrieval"
```

---

## Task 4: Register the command in lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add import**

In `src-tauri/src/lib.rs`, find the `use crate::commands::{ ... }` block. It's a long multi-line import. Add `chat_with_memory, ChatTurnInput,` anywhere in the list (alphabetical order is fine but not required).

- [ ] **Step 2: Add to invoke_handler**

In the same file, find the `.invoke_handler(tauri::generate_handler![` block. Add `chat_with_memory,` to the list (after `test_llm_inference,` is a natural spot).

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Run all Rust tests**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): register chat_with_memory Tauri command"
```

---

## Task 5: Frontend API binding

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add type and function**

Open `src/lib/api.ts`. Find the `// ----- LLM -----` section. Below the `testLlmInference` export, add:

```typescript
// ----- Memory chat -----

export type ChatTurn = { role: "user" | "assistant"; content: string };

export const chatWithMemory = (
  message: string,
  history: ChatTurn[],
): Promise<string> => invoke("chat_with_memory", { message, history });
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add chatWithMemory binding and ChatTurn type"
```

---

## Task 6: Build ChatView component

**Files:**
- Create: `src/views/sections/ChatView.tsx`

- [ ] **Step 1: Create the file**

Create `src/views/sections/ChatView.tsx` with the following content:

```tsx
import { useEffect, useRef, useState } from "react";
import { chatWithMemory, type ChatTurn } from "../../lib/api";

export default function ChatView() {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userTurn: ChatTurn = { role: "user", content: text };
    const nextHistory = [...history, userTurn];
    setHistory(nextHistory);
    setLoading(true);
    try {
      const reply = await chatWithMemory(text, history);
      setHistory([...nextHistory, { role: "assistant", content: reply }]);
    } catch (e) {
      setHistory([
        ...nextHistory,
        {
          role: "assistant",
          content: `Error: ${e instanceof Error ? e.message : String(e)}`,
        },
      ]);
    } finally {
      setLoading(false);
      // Restore focus so the user can keep typing.
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Chat</h1>
        <p className="mt-0.5 text-xs text-neutral-500">
          Ask questions about your notes and captures
        </p>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {history.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-neutral-400">
              Chat with your memory
            </p>
            <p className="max-w-xs text-xs text-neutral-600">
              Ask about your captures, notes, and tasks. The AI searches your
              history to ground its answers.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {history.map((turn, i) => (
              <MessageBubble key={i} turn={turn} />
            ))}
            {loading ? <ThinkingBubble /> : null}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-neutral-800 bg-neutral-950/60 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about your notes… (Enter to send)"
            rows={2}
            className="flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            disabled={loading}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || loading}
            className="rounded-md bg-neutral-700 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <p className="mt-1 text-[10px] text-neutral-600">
          Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? "bg-neutral-700 text-neutral-100"
            : "bg-neutral-800/60 text-neutral-200"
        }`}
      >
        {!isUser ? (
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            Echo Scribe AI
          </p>
        ) : null}
        <p className="whitespace-pre-wrap">{turn.content}</p>
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg bg-neutral-800/60 px-3 py-2 text-sm text-neutral-500">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider">
          Echo Scribe AI
        </p>
        <p>Thinking…</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/views/sections/ChatView.tsx
git commit -m "feat(ui): ChatView component with RAG-backed message history"
```

---

## Task 7: Wire Chat into Main navigation

**Files:**
- Modify: `src/views/Main.tsx`

- [ ] **Step 1: Add import**

At the top of `src/views/Main.tsx`, add the ChatView import alongside the other section imports:

```tsx
import ChatView from "./sections/ChatView";
```

- [ ] **Step 2: Extend MainSection type**

Find:
```tsx
export type MainSection =
  | { kind: "activity" }
  | { kind: "tasks" }
  | { kind: "search" }
  | { kind: "project"; id: string };
```

Replace with:
```tsx
export type MainSection =
  | { kind: "activity" }
  | { kind: "tasks" }
  | { kind: "search" }
  | { kind: "chat" }
  | { kind: "project"; id: string };
```

- [ ] **Step 3: Add "Chat" nav item**

In the `<nav>` block inside the sidebar (right after the `SearchView` NavItem), add:

```tsx
<NavItem
  label="Chat"
  active={section.kind === "chat"}
  onClick={() => setSection({ kind: "chat" })}
/>
```

- [ ] **Step 4: Add renderContent case**

In `renderContent()`, add before the closing default/project case:

```tsx
case "chat":
  return <ChatView />;
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors. TypeScript will warn if the `switch` is non-exhaustive.

- [ ] **Step 6: Commit**

```bash
git add src/views/Main.tsx
git commit -m "feat(ui): add Chat section to main navigation"
```

---

## Task 8: Build and smoke-test

- [ ] **Step 1: Run all Rust unit tests**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 2: Build the release bundle**

```bash
bun tauri build --bundles app 2>&1 | tail -30
```

Expected: build succeeds, `.app` bundle emitted to `src-tauri/target/release/bundle/macos/`.

- [ ] **Step 3: Reinstall with TCC reset**

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
tccutil reset Microphone com.echoscribe.app
tccutil reset Accessibility com.echoscribe.app
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 4: Verify the Chat nav item appears**

Open Echo Scribe → confirm "Chat" appears in the left sidebar below "Search".

- [ ] **Step 5: Test happy path**

1. Click "Chat"
2. Type: `what did I capture recently?`
3. Press Enter
4. Verify: a "Thinking…" bubble appears, then the AI responds (if LLM model is downloaded)

- [ ] **Step 6: Test no-LLM fallback**

If no LLM model is downloaded, the AI should respond with the fallback message: _"No local AI model is loaded. Please download one in Settings → AI Model."_

- [ ] **Step 7: Test multi-turn**

Send two messages and confirm the second reply reflects context from the first exchange.

- [ ] **Step 8: Final commit (if any fixups needed)**

```bash
git add -p
git commit -m "fix(chat): address smoke-test issues"
```

---

## Self-Review

**Spec coverage:**
- ✅ New Chat page in the interface
- ✅ FTS5 search retrieves relevant notes from history
- ✅ Local LLM generates a response
- ✅ Multi-turn conversation maintained in React state
- ✅ No-LLM graceful fallback
- ✅ Chat section wired into existing sidebar nav

**Placeholder check:** None found.

**Type consistency:**
- `ChatTurn` in TS (`{ role, content }`) matches `ChatTurnInput` in Rust (`{ role, content }`) — Tauri serializes both correctly.
- `Vec<(String, String)>` for `history` in `GenerateRequest` matches how `chat_with_memory` builds it from `ChatTurnInput`.
- `build_chat_messages` in `prompt.rs` accepts `&[(String, String)]` — same shape.
