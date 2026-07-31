import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CalendarDays,
  Folder,
  Hash,
  LayoutDashboard,
  MessageSquare,
  Mic,
  Search,
  Users,
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
import RelationshipsView from "./sections/RelationshipsView";
import ThemeToggle from "../components/ThemeToggle";
import SidebarRecordButton from "../components/SidebarRecordButton";
import ScreenRecordButton from "../components/ScreenRecordButton";
import PermissionWarningBanner from "../components/PermissionWarningBanner";
import UpdateBanner from "../components/UpdateBanner";

export type MainSection =
  | { kind: "chat" }
  | { kind: "dashboard" }
  | { kind: "stats"; category?: StatsCategoryKey }
  | { kind: "daily"; date?: string }
  | { kind: "relationships" }
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
  const [dashboardSearchRequest, setDashboardSearchRequest] = useState(0);

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
            searchRequest={dashboardSearchRequest}
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
      case "relationships":
        return <RelationshipsView />;
    }
  };

  const sectionTitle = (() => {
    switch (section.kind) {
      case "dashboard": return "Dashboard";
      case "chat": return "Chat";
      case "daily": return "Daily recaps";
      case "relationships": return "People & companies";
      case "stats": return "Statistics";
      case "project": return projectMap.get(section.id)?.name ?? "Project";
    }
  })();

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="echo-app-shell flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-fg">
      <header className="echo-app-toolbar flex h-12 shrink-0 items-stretch border-b border-line">
        <div className="echo-app-toolbar-sidebar flex w-[232px] shrink-0 items-center border-r border-line px-3" data-tauri-drag-region>
          <span className="w-[72px] shrink-0" aria-hidden="true" data-tauri-drag-region />
          <div className="pointer-events-none flex min-w-0 items-center gap-1.5 text-[12px] font-semibold tracking-tight text-fg">
            <img
              src={logoUrl}
              alt=""
              width={18}
              height={18}
              className="echo-brand-icon h-[18px] w-[18px]"
              aria-hidden="true"
            />
            <span className="truncate">Echo Scribe</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-3 px-3">
          <div className="min-w-0" data-tauri-drag-region>
            <h1 className="truncate text-[12px] font-semibold leading-tight">{sectionTitle}</h1>
            <div className="truncate text-[9px] leading-tight text-faint">{today}</div>
          </div>
          <div
            className="echo-toolbar-drag-region h-full min-w-12 flex-1"
            data-tauri-drag-region
          />
          {section.kind === "dashboard" ? (
            <button
              type="button"
              onClick={() => setDashboardSearchRequest((value) => value + 1)}
              aria-label="Search"
              className="echo-toolbar-search native-toolbar-button flex h-7 w-36 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-[11px] text-faint hover:text-muted"
            >
              <Search size={12} aria-hidden="true" />
              <span>Search</span>
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="echo-sidebar flex h-full min-h-0 w-[232px] shrink-0 flex-col overflow-hidden border-r border-line bg-surface">
        <div className="shrink-0 px-4 pb-3 pt-3">
          <div className="flex flex-wrap items-center gap-1.5">
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

        <nav className="flex shrink-0 flex-col gap-0.5 px-2">
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
          <NavItem
            icon={Users}
            label="People & companies"
            active={section.kind === "relationships"}
            onClick={() => setSection({ kind: "relationships" })}
          />
        </nav>

        <div className="mx-4 my-3 shrink-0 border-t border-line" />

        <div className="flex h-5 shrink-0 items-center justify-between px-5">
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
        <nav
          aria-label="Projects"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2"
        >
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

        <div className="echo-sidebar-bottom flex shrink-0 flex-col gap-3 border-t border-line px-2 pb-2 pt-3">
          <PermissionWarningBanner onOpenSettings={onOpenSettings} />
          <UpdateBanner variant="sidebar" />
          <div className="echo-settings-row flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenSettings}
              className="echo-nav-item flex flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:text-fg"
              title="Open settings"
            >
              <SettingsIcon size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>Settings</span>
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {renderContent()}
      </main>
      </div>
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
      className={`echo-nav-item group relative flex h-8 shrink-0 cursor-pointer items-center gap-2 truncate rounded-md pl-3 pr-2 text-left text-[13px] leading-none ${
        active
          ? "is-active text-fg"
          : "text-muted hover:text-fg"
      }`}
      title={label}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <Icon
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className={
            active
              ? "text-fg"
              : "text-faint transition-colors group-hover:text-muted"
          }
        />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
