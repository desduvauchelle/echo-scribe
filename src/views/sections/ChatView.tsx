import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  X,
} from "lucide-react";
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full">
      {/* Session list panel */}
      <div className="flex w-52 shrink-0 flex-col border-r border-line bg-canvas/60">
        <div className="border-b border-line p-3">
          {projects.length > 0 && (
            <select
              value={projectFilter ?? ""}
              onChange={(e) =>
                setProjectFilter(e.target.value === "" ? null : e.target.value)
              }
              aria-label="Filter by project"
              className="mb-2 w-full rounded border border-line bg-surface px-2 py-1 text-xs text-muted focus:border-accent focus:outline-none"
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
            className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent-soft py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25"
          >
            <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted">
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
        <div className="border-b border-line bg-canvas/40 px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight text-fg">
            {activeSessionId
              ? (sessions.find((s) => s.id === activeSessionId)?.name ?? "Chat")
              : "Chat"}
          </h1>
          <p className="mt-0.5 text-xs text-muted">
            Ask questions about your notes and captures
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4" aria-live="polite">
          {!activeSessionId ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <MessageSquare size={20} strokeWidth={1.75} aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-fg">
                Chat with your memory
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-muted">
                Start a new chat or select a previous conversation.
              </p>
            </div>
          ) : messages.length === 0 && !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-fg">
                New conversation
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-muted">
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

        <div className="border-t border-line bg-canvas/60 px-4 py-3">
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
              aria-label="Message"
              className="flex-1 resize-none rounded-md border border-line bg-canvas px-3 py-2 text-sm focus:border-accent focus:outline-none disabled:opacity-40"
              disabled={loading || !activeSessionId}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || loading || !activeSessionId}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={12} strokeWidth={2.25} aria-hidden="true" />
              Send
            </button>
          </div>
          <p className="mt-1 text-[10px] text-faint">
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
    <div
      className={`group flex w-full items-center justify-between px-3 py-2 text-xs hover:bg-elevated/60 ${
        active ? "bg-elevated text-fg" : "text-muted"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 cursor-pointer truncate text-left"
      >
        {session.name}
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="ml-1 inline-flex shrink-0 cursor-pointer items-center rounded p-0.5 text-faint opacity-0 transition-colors hover:bg-elevated hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        aria-label="Delete session"
      >
        <X size={11} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </div>
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
            ? "bg-elevated text-fg"
            : "bg-elevated/60 text-fg"
        }`}
      >
        {!isUser ? (
          <p className="mb-1 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-accent/80">
            <Sparkles size={9} strokeWidth={2.5} aria-hidden="true" />
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
        className="flex cursor-pointer items-center gap-1 text-[10px] text-faint transition-colors hover:text-muted"
      >
        {open ? (
          <ChevronDown size={10} strokeWidth={2.25} aria-hidden="true" />
        ) : (
          <ChevronRight size={10} strokeWidth={2.25} aria-hidden="true" />
        )}
        <span>
          {sources.length} source{sources.length !== 1 ? "s" : ""} used
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded border border-line bg-canvas/80 p-2">
          {sources.map((s, i) => (
            <div key={i} className="text-[11px] text-muted">
              <span className="font-medium text-faint">
                {s.date} · {s.kind}
              </span>
              <p className="mt-0.5 leading-snug text-muted">
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
      <div className="rounded-lg bg-elevated/60 px-3 py-2 text-sm text-muted">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider">
          Echo Scribe AI
        </p>
        <p>Thinking…</p>
      </div>
    </div>
  );
}
