import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getVoiceAtCursorBinding,
  listProjects,
  type JsBinding,
  type Project,
} from "../lib/api";
import { formatBinding } from "../lib/binding";
import ActivityFeed from "./sections/ActivityFeed";
import TasksView from "./sections/TasksView";
import SearchView from "./sections/SearchView";
import ChatView from "./sections/ChatView";

export type MainSection =
  | { kind: "activity" }
  | { kind: "tasks" }
  | { kind: "search" }
  | { kind: "chat" }
  | { kind: "project"; id: string };

type Props = {
  onOpenSettings: () => void;
};

export default function Main({ onOpenSettings }: Props) {
  const [section, setSection] = useState<MainSection>({ kind: "activity" });
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
      case "activity":
        return (
          <ActivityFeed
            projects={projectMap}
            onProjectsChanged={refreshProjects}
          />
        );
      case "project": {
        const project = projectMap.get(section.id) ?? null;
        return (
          <ActivityFeed
            project={project}
            projects={projectMap}
            onProjectsChanged={refreshProjects}
            onProjectArchived={() => setSection({ kind: "activity" })}
          />
        );
      }
      case "tasks":
        return <TasksView projects={projectMap} />;
      case "search":
        return <SearchView projects={projectMap} />;
      case "chat":
        return <ChatView projects={projects} />;
    }
  };

  return (
    <div className="flex h-full bg-neutral-950 text-neutral-100">
      <aside className="flex w-[210px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40">
        <div className="px-4 pb-3 pt-10">
          <div className="text-sm font-semibold tracking-tight">
            Echo Scribe
          </div>
          {binding ? (
            <p className="mt-0.5 truncate text-[10px] text-neutral-500">
              Hold {formatBinding(binding)} to dictate
            </p>
          ) : null}
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          <NavItem
            label="Activity"
            active={section.kind === "activity"}
            onClick={() => setSection({ kind: "activity" })}
          />
          <NavItem
            label="Tasks"
            active={section.kind === "tasks"}
            onClick={() => setSection({ kind: "tasks" })}
          />
          <NavItem
            label="Search"
            active={section.kind === "search"}
            onClick={() => setSection({ kind: "search" })}
          />
          <NavItem
            label="Chat"
            active={section.kind === "chat"}
            onClick={() => setSection({ kind: "chat" })}
          />
        </nav>

        <div className="mt-5 px-4 text-[10px] uppercase tracking-wider text-neutral-500">
          Projects
        </div>
        <div className="flex flex-col gap-0.5 px-2 pt-1">
          {visibleProjects.length === 0 ? (
            <div className="px-2 py-1 text-xs text-neutral-500">
              No projects yet
            </div>
          ) : (
            visibleProjects.map((p) => (
              <NavItem
                key={p.id}
                label={p.name}
                indent
                active={section.kind === "project" && section.id === p.id}
                onClick={() => setSection({ kind: "project", id: p.id })}
              />
            ))
          )}
          {projects.length > 8 ? (
            <button
              type="button"
              onClick={() => setShowAllProjects((v) => !v)}
              className="mx-2 mt-1 text-left text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              {showAllProjects ? "Show fewer" : `Show all (${projects.length})`}
            </button>
          ) : null}
        </div>

        <div className="mt-auto border-t border-neutral-800 px-2 py-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            title="Open settings"
          >
            <span>Settings</span>
            <span aria-hidden="true">⚙</span>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">{renderContent()}</main>
    </div>
  );
}

function NavItem({
  label,
  active,
  onClick,
  indent,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`truncate rounded-md ${indent ? "pl-4" : "pl-2"} pr-2 py-1.5 text-left text-sm ${
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-300 hover:bg-neutral-800/60"
      }`}
      title={label}
    >
      {label}
    </button>
  );
}
