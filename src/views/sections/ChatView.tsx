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
      <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Chat</h1>
        <p className="mt-0.5 text-xs text-neutral-500">
          Ask questions about your notes and captures
        </p>
      </div>

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
