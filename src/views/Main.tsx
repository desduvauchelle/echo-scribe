import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CalendarDays,
  Folder,
  Hash,
  LayoutDashboard,
  MessageSquare,
  Mic,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import {
  getVoiceAtCursorBinding,
  listProjects,
  type JsBinding,
  type Project,
  type StatsCategoryKey,
} from "../lib/api";
import { formatBinding } from "../lib/binding";
import logoUrl from "../../src-tauri/icons/32x32.png";
import ActivityFeed from "./sections/ActivityFeed";
import ChatView from "./sections/ChatView";
import DashboardView from "./sections/DashboardView";
import DailyView from "./sections/DailyView";
import StatsView from "./sections/StatsView";
import ThemeToggle from "../components/ThemeToggle";
import SidebarRecordButton from "../components/SidebarRecordButton";
import ScreenRecordButton from "../components/ScreenRecordButton";

export type MainSection =
  | { kind: "chat" }
  | { kind: "dashboard" }
  | { kind: "stats"; category?: StatsCategoryKey }
  | { kind: "daily"; date?: string }
  | { kind: "project"; id: string };

type Props = {
  onOpenSettings: () => void;
};

export default function Main({ onOpenSettings }: Props) {
  const [section, setSection] = useState<MainSection>({ kind: "dashboard" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [binding, setBinding] = useState<JsBinding | null>(null);
  const [voiceRecordingActive, setVoiceRecordingActive] = useState(false);

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

  useEffect(() => {
    let unsubs: UnlistenFn[] = [];
    let cancelled = false;

    void Promise.all([
      listen("voice:recording_started", () => setVoiceRecordingActive(true)),
      listen("voice:recording_stopped", () => setVoiceRecordingActive(false)),
      listen("recorder:start_failed", () => setVoiceRecordingActive(false)),
    ]).then((fns) => {
      if (cancelled) fns.forEach((fn) => fn());
      else unsubs = fns;
    });

    return () => {
      cancelled = true;
      unsubs.forEach((fn) => fn());
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
        return (
          <DashboardView
            projects={projectMap}
            onOpenStats={(category) => setSection({ kind: "stats", category })}
          />
        );
      case "stats":
        return (
          <StatsView
            initialCategory={section.category}
            onBack={() => setSection({ kind: "dashboard" })}
          />
        );
      case "daily":
        return <DailyView initialDate={section.date} />;
    }
  };

  return (
    <div className="flex h-full bg-canvas text-fg">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-4 pb-3 pt-10">
          <div className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-fg">
            <img
              src={logoUrl}
              alt=""
              width={22}
              height={22}
              className="h-[22px] w-[22px] rounded-md"
              aria-hidden="true"
            />
            <span>Echo Scribe</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {binding ? (
              <div
                title={
                  voiceRecordingActive
                    ? `Dictating — release ${formatBinding(binding)} to stop`
                    : `Hold ${formatBinding(binding)} to dictate`
                }
                aria-label={
                  voiceRecordingActive
                    ? `Dictating. Release ${formatBinding(binding)} to stop.`
                    : `Hold ${formatBinding(binding)} to dictate.`
                }
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-elevated px-2 py-0.5 text-[10px] text-muted"
              >
                <span className="relative flex h-1.5 w-1.5">
                  {voiceRecordingActive ? (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                  ) : null}
                  <span
                    className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                      voiceRecordingActive ? "bg-accent" : "bg-faint"
                    }`}
                  />
                </span>
                <Mic
                  size={10}
                  strokeWidth={2}
                  className={voiceRecordingActive ? "text-accent" : "text-muted"}
                  aria-hidden="true"
                />
              </div>
            ) : null}
            <SidebarRecordButton />
            <ScreenRecordButton variant="sidebar" />
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          <NavItem
            icon={LayoutDashboard}
            label="Dashboard"
            active={section.kind === "dashboard" || section.kind === "stats"}
            onClick={() => setSection({ kind: "dashboard" })}
          />
          <NavItem
            icon={MessageSquare}
            label="Chat"
            active={section.kind === "chat"}
            onClick={() => setSection({ kind: "chat" })}
          />
          <NavItem
            icon={CalendarDays}
            label="Daily recaps"
            active={section.kind === "daily"}
            onClick={() => setSection({ kind: "daily" })}
          />
        </nav>

        <div className="mx-4 my-3 border-t border-line" />

        <div className="flex h-5 items-center justify-between px-5">
          <span className="text-[11px] font-medium uppercase leading-none tracking-[0.08em] text-muted">
            Projects
          </span>
          <span className="flex h-4 w-4 items-center justify-center">
            <Folder
              size={12}
              strokeWidth={2}
              className="text-faint"
              aria-hidden="true"
            />
          </span>
        </div>
        <nav aria-label="Projects" className="flex flex-col gap-0.5 px-2">
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
        </nav>

        <div className="mt-auto flex flex-col gap-2 border-t border-line p-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-fg"
              title="Open settings"
            >
              <SettingsIcon size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>Settings</span>
            </button>
            <ThemeToggle />
          </div>
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
      aria-current={active ? "page" : undefined}
      className={`group relative flex h-8 cursor-pointer items-center gap-2 truncate rounded-md pl-3 pr-2 text-left text-[13px] leading-none transition-colors ${
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
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <Icon
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className={
            active
              ? "text-accent"
              : "text-faint transition-colors group-hover:text-muted"
          }
        />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
