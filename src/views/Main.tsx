import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Folder,
  Phone,
  Hash,
  LayoutDashboard,
  MessageSquare,
  Mic,
  Settings as SettingsIcon,
  Video,
  type LucideIcon,
} from "lucide-react";
import {
  getVoiceAtCursorBinding,
  listProjects,
  type JsBinding,
  type Project,
} from "../lib/api";
import { formatBinding } from "../lib/binding";
import ActivityFeed from "./sections/ActivityFeed";
import { MeetingsView } from "./sections/MeetingsView";
import { RecordingsView } from "./sections/RecordingsView";
import ChatView from "./sections/ChatView";
import DashboardView from "./sections/DashboardView";
import DailyView from "./sections/DailyView";
import ThemeToggle from "../components/ThemeToggle";

export type MainSection =
  | { kind: "chat" }
  | { kind: "dashboard" }
  | { kind: "daily"; date?: string }
  | { kind: "meetings" }
  | { kind: "recordings" }
  | { kind: "project"; id: string };

type Props = {
  onOpenSettings: () => void;
};

export default function Main({ onOpenSettings }: Props) {
  const [section, setSection] = useState<MainSection>({ kind: "dashboard" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [binding, setBinding] = useState<JsBinding | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const ps = await listProjects(false);
      setProjects(ps);
    } catch {
      /* surfaced elsewhere */
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await getVoiceAtCursorBinding();
        if (!cancelled) setBinding(b);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const visibleProjects = showAllProjects ? projects : projects.slice(0, 8);

  const renderContent = () => {
    switch (section.kind) {
      case "project": {
        const project = projectMap.get(section.id) ?? null;
        return (
          <ActivityFeed
            project={project}
            projects={projectMap}
            onProjectsChanged={refreshProjects}
            onProjectArchived={() => setSection({ kind: "dashboard" })}
          />
        );
      }
      case "chat":
        return <ChatView projects={projects} />;
      case "dashboard":
        return <DashboardView projects={projectMap} />;
      case "daily":
        return <DailyView initialDate={section.date} />;
      case "meetings":
        return <MeetingsView />;
      case "recordings":
        return <RecordingsView />;
    }
  };

  return (
    <div className="flex h-full bg-canvas text-fg">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-4 pb-3 pt-10">
          <div className="text-[13px] font-semibold tracking-tight text-fg">
            Echo Scribe
          </div>
          {binding ? (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-elevated px-2 py-0.5 text-[10px] text-muted">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              <Mic size={10} strokeWidth={2} className="text-accent" />
              <span className="font-medium text-fg">
                {formatBinding(binding)}
              </span>
              <span>to dictate</span>
            </div>
          ) : null}
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          <NavItem
            icon={LayoutDashboard}
            label="Dashboard"
            active={section.kind === "dashboard"}
            onClick={() => setSection({ kind: "dashboard" })}
          />
          <NavItem
            icon={MessageSquare}
            label="Chat"
            active={section.kind === "chat"}
            onClick={() => setSection({ kind: "chat" })}
          />
          <NavItem
            icon={Phone}
            label="Meetings"
            active={section.kind === "meetings"}
            onClick={() => setSection({ kind: "meetings" })}
          />
          <NavItem
            icon={Video}
            label="Recordings"
            active={section.kind === "recordings"}
            onClick={() => setSection({ kind: "recordings" })}
          />
          <NavItem
            icon={CalendarDays}
            label="Daily"
            active={section.kind === "daily"}
            onClick={() => setSection({ kind: "daily" })}
          />
        </nav>

        <div className="mx-4 my-3 border-t border-line" />

        <div className="flex items-center justify-between px-4 pb-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Projects
          </span>
          <Folder size={11} strokeWidth={2} className="text-faint" />
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {visibleProjects.length === 0 ? (
            <div className="px-3 py-1 text-xs text-muted">No projects yet</div>
          ) : (
            visibleProjects.map((p) => (
              <NavItem
                key={p.id}
                icon={Hash}
                label={p.name}
                active={section.kind === "project" && section.id === p.id}
                onClick={() => setSection({ kind: "project", id: p.id })}
              />
            ))
          )}
          {projects.length > 8 ? (
            <button
              type="button"
              onClick={() => setShowAllProjects((v) => !v)}
              className="mx-2 mt-1 cursor-pointer text-left text-[11px] text-faint transition-colors hover:text-muted"
            >
              {showAllProjects ? "Show fewer" : `Show all (${projects.length})`}
            </button>
          ) : null}
        </div>

        <div className="mt-auto flex items-center gap-1 border-t border-line p-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-fg"
            title="Open settings"
          >
            <SettingsIcon size={14} strokeWidth={1.75} />
            <span>Settings</span>
          </button>
          <ThemeToggle />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">{renderContent()}</main>
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex cursor-pointer items-center gap-2 truncate rounded-md py-1.5 pl-3 pr-2 text-left text-[13px] transition-colors ${
        active
          ? "bg-accent-soft text-fg"
          : "text-muted hover:bg-elevated hover:text-fg"
      }`}
      title={label}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-accent"
        />
      ) : null}
      <Icon
        size={14}
        strokeWidth={1.75}
        className={
          active
            ? "text-accent"
            : "text-faint transition-colors group-hover:text-muted"
        }
      />
      <span className="truncate">{label}</span>
    </button>
  );
}
