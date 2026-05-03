import { useEffect, useRef, useState } from "react";
import {
  chatWithMemory,
  createChatSession,
  deleteChatSession,
  listChatSessions,
  loadChatMessages,
  type ChatMessage,
  type ChatSession,
  type ContextSource,
  type Project,
} from "../../lib/api";

type Props = {
  projects: Project[];
};

export default function ChatView({ projects }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sourcesMap, setSourcesMap] = useState<Record<string, ContextSource[]>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadSessions();
    setActiveSessionId(null);
    setMessages([]);
  }, [projectFilter]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    loadChatMessages(activeSessionId).then(setMessages).catch(console.error);
  }, [activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const loadSessions = async () => {
    try {
      const s = await listChatSessions(projectFilter);
      setSessions(s);
    } catch (e) {
      console.error(e);
    }
  };

  const handleNewChat = async () => {
    try {
      const session = await createChatSession(projectFilter);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionId: string,
  ) => {
    e.stopPropagation();
    try {
      await deleteChatSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const send = async () => {
    if (!activeSessionId) return;
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const optimisticMsg: ChatMessage = {
      id: crypto.randomUUID(),
      session_id: activeSessionId,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setLoading(true);
    try {
      const { reply, sources } = await chatWithMemory(activeSessionId, text, projectFilter);
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        session_id: activeSessionId,
        role: "assistant",
        content: reply,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (sources.length > 0) {
        setSourcesMap((prev) => ({ ...prev, [assistantId]: sources }));
      }
      void loadSessions();
    } catch (e) {
      const errMsg: ChatMessage = {
        id: crypto.randomUUID(),
        session_id: activeSessionId,
        role: "assistant",
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
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
    <div className="flex h-full">
      {/* Session list panel */}
      <div className="flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/60">
        <div className="border-b border-neutral-800 p-3">
          {projects.length > 0 && (
            <select
              value={projectFilter ?? ""}
              onChange={(e) =>
                setProjectFilter(e.target.value === "" ? null : e.target.value)
              }
              className="mb-2 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 focus:border-neutral-500 focus:outline-none"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void handleNewChat()}
            className="w-full rounded-md bg-neutral-700 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-600"
          >
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-neutral-600">
              No conversations yet
            </p>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onClick={() => setActiveSessionId(s.id)}
                onDelete={(e) => void handleDeleteSession(e, s.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">
            {activeSessionId
              ? (sessions.find((s) => s.id === activeSessionId)?.name ?? "Chat")
              : "Chat"}
          </h1>
          <p className="mt-0.5 text-xs text-neutral-500">
            Ask questions about your notes and captures
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!activeSessionId ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-neutral-400">
                Chat with your memory
              </p>
              <p className="max-w-xs text-xs text-neutral-600">
                Start a new chat or select a previous conversation.
              </p>
            </div>
          ) : messages.length === 0 && !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-neutral-400">
                New conversation
              </p>
              <p className="max-w-xs text-xs text-neutral-600">
                Ask about your captures, notes, and tasks. Try "what did I
                capture today?"
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  sources={sourcesMap[msg.id]}
                />
              ))}
              {loading ? <ThinkingBubble /> : null}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="border-t border-neutral-800 bg-neutral-950/60 px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                activeSessionId
                  ? "Ask about your notes… (Enter to send)"
                  : "Start a new chat first"
              }
              rows={2}
              className="flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none disabled:opacity-40"
              disabled={loading || !activeSessionId}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || loading || !activeSessionId}
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
    </div>
  );
}

function SessionRow({
  session,
  active,
  onClick,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-800/60 ${
        active ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
      }`}
    >
      <span className="truncate">{session.name}</span>
      <span
        role="button"
        tabIndex={0}
        onClick={onDelete}
        onKeyDown={(e) =>
          e.key === "Enter" && onDelete(e as unknown as React.MouseEvent)
        }
        className="ml-1 shrink-0 rounded p-0.5 text-neutral-600 opacity-0 hover:bg-neutral-700 hover:text-neutral-300 group-hover:opacity-100"
        aria-label="Delete session"
      >
        ✕
      </span>
    </button>
  );
}

function MessageBubble({
  message,
  sources,
}: {
  message: ChatMessage;
  sources?: ContextSource[];
}) {
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
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
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
      {!isUser && sources && sources.length > 0 && (
        <SourcesPanel sources={sources} />
      )}
    </div>
  );
}

function SourcesPanel({ sources }: { sources: ContextSource[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-neutral-600 hover:text-neutral-400"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>
          {sources.length} source{sources.length !== 1 ? "s" : ""} used
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded border border-neutral-800 bg-neutral-950/80 p-2">
          {sources.map((s, i) => (
            <div key={i} className="text-[11px] text-neutral-400">
              <span className="font-medium text-neutral-500">
                {s.date} · {s.kind}
              </span>
              <p className="mt-0.5 leading-snug text-neutral-300">
                {s.content}
              </p>
            </div>
          ))}
        </div>
      )}
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
