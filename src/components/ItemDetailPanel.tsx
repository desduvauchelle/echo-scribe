import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  listItemEvents,
  listSessionsForItem,
  loadChatMessages,
  listClaudeSessions,
  loadClaudeSession,
  type ItemEvent,
  type ChatSession,
  type ChatMessage,
  type ClaudeSessionSummary,
  type ClaudeSessionMessage,
} from "../lib/api";
import { relativeTime } from "../lib/format";

type Tab = "activity" | "sessions";

type Props = {
  itemId: string;
};

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  deleted: "Deleted",
  restored: "Restored",
  content_edited: "Content edited",
  kind_changed: "Kind changed",
  project_changed: "Project changed",
  tags_changed: "Tags updated",
  classified: "Auto-classified",
};

export default function ItemDetailPanel({ itemId }: Props) {
  const [tab, setTab] = useState<Tab>("activity");

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-2 flex gap-1">
        <TabButton
          active={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          Activity
        </TabButton>
        <TabButton
          active={tab === "sessions"}
          onClick={() => setTab("sessions")}
        >
          Sessions
        </TabButton>
      </div>

      {tab === "activity" ? (
        <ActivityTab itemId={itemId} />
      ) : (
        <SessionsTab itemId={itemId} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
        active
          ? "bg-fg text-canvas"
          : "text-muted hover:bg-elevated hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function ActivityTab({ itemId }: { itemId: string }) {
  const [events, setEvents] = useState<ItemEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listItemEvents(itemId).then((evts) => {
      if (!cancelled) {
        setEvents(evts);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [itemId]);

  if (loading) {
    return <div className="text-[11px] text-faint">Loading...</div>;
  }

  if (events.length === 0) {
    return (
      <div className="text-[11px] text-faint">No activity recorded.</div>
    );
  }

  return (
    <div className="space-y-1.5">
      {events.map((ev) => (
        <div key={ev.id} className="flex items-start gap-2 text-[11px]">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
          <div className="min-w-0">
            <span className="font-medium text-muted">
              {EVENT_LABELS[ev.event_type] ?? ev.event_type}
            </span>
            {ev.detail ? (
              <span className="ml-1 text-faint">{ev.detail}</span>
            ) : null}
            <span className="ml-2 text-faint">
              {relativeTime(ev.created_at)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionsTab({ itemId }: { itemId: string }) {
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedChat, setExpandedChat] = useState<string | null>(null);
  const [expandedClaude, setExpandedClaude] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [claudeMessages, setClaudeMessages] = useState<ClaudeSessionMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listSessionsForItem(itemId).catch(() => [] as ChatSession[]),
      listClaudeSessions().catch(() => [] as ClaudeSessionSummary[]),
    ]).then(([chat, claude]) => {
      if (!cancelled) {
        setChatSessions(chat);
        setClaudeSessions(claude);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [itemId]);

  const handleExpandChat = async (sessionId: string) => {
    if (expandedChat === sessionId) {
      setExpandedChat(null);
      return;
    }
    setExpandedChat(sessionId);
    setExpandedClaude(null);
    try {
      const msgs = await loadChatMessages(sessionId);
      setChatMessages(msgs);
    } catch {
      setChatMessages([]);
    }
  };

  const handleExpandClaude = async (sessionId: string) => {
    if (expandedClaude === sessionId) {
      setExpandedClaude(null);
      return;
    }
    setExpandedClaude(sessionId);
    setExpandedChat(null);
    try {
      const msgs = await loadClaudeSession(sessionId);
      setClaudeMessages(msgs);
    } catch {
      setClaudeMessages([]);
    }
  };

  if (loading) {
    return <div className="text-[11px] text-faint">Loading...</div>;
  }

  const hasChatSessions = chatSessions.length > 0;
  const hasClaudeSessions = claudeSessions.length > 0;

  if (!hasChatSessions && !hasClaudeSessions) {
    return (
      <div className="text-[11px] text-faint">
        No linked sessions found.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {hasChatSessions && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-faint">
            Echo Scribe Chat
          </div>
          {chatSessions.map((s) => (
            <div key={s.id}>
              <button
                type="button"
                onClick={() => void handleExpandChat(s.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-elevated"
              >
                <span className="text-faint">
                  {expandedChat === s.id ? (
                    <ChevronDown size={11} strokeWidth={2.25} />
                  ) : (
                    <ChevronRight size={11} strokeWidth={2.25} />
                  )}
                </span>
                <span className="truncate font-medium text-muted">
                  {s.name}
                </span>
                <span className="ml-auto shrink-0 text-faint">
                  {relativeTime(s.updated_at)}
                </span>
              </button>
              {expandedChat === s.id && (
                <div className="ml-4 mt-1 max-h-48 space-y-1 overflow-y-auto rounded border border-line bg-canvas/80 p-2">
                  {chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`text-[11px] ${
                        msg.role === "user"
                          ? "text-accent"
                          : "text-muted"
                      }`}
                    >
                      <span className="font-medium">
                        {msg.role === "user" ? "You" : "AI"}:
                      </span>{" "}
                      <span className="whitespace-pre-wrap">
                        {msg.content.length > 300
                          ? `${msg.content.slice(0, 300)}...`
                          : msg.content}
                      </span>
                    </div>
                  ))}
                  {chatMessages.length === 0 && (
                    <div className="text-[11px] text-faint">
                      No messages.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {hasClaudeSessions && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-faint">
            Claude Code Sessions
          </div>
          {claudeSessions.slice(0, 10).map((s) => (
            <div key={s.session_id}>
              <button
                type="button"
                onClick={() => void handleExpandClaude(s.session_id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-elevated"
              >
                <span className="text-faint">
                  {expandedClaude === s.session_id ? (
                    <ChevronDown size={11} strokeWidth={2.25} />
                  ) : (
                    <ChevronRight size={11} strokeWidth={2.25} />
                  )}
                </span>
                <span className="truncate font-medium text-muted">
                  {s.preview || s.session_id.slice(0, 12)}
                </span>
                <span className="ml-auto shrink-0 text-faint">
                  {s.message_count} msgs
                </span>
              </button>
              {expandedClaude === s.session_id && (
                <div className="ml-4 mt-1 max-h-48 space-y-1 overflow-y-auto rounded border border-line bg-canvas/80 p-2">
                  {claudeMessages.map((msg, i) => (
                    <div
                      key={i}
                      className={`text-[11px] ${
                        msg.role === "human" || msg.role === "user"
                          ? "text-accent"
                          : "text-muted"
                      }`}
                    >
                      <span className="font-medium">
                        {msg.role === "human" || msg.role === "user"
                          ? "You"
                          : "Claude"}
                        :
                      </span>{" "}
                      <span className="whitespace-pre-wrap">
                        {msg.content.length > 300
                          ? `${msg.content.slice(0, 300)}...`
                          : msg.content}
                      </span>
                    </div>
                  ))}
                  {claudeMessages.length === 0 && (
                    <div className="text-[11px] text-faint">
                      No messages.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
