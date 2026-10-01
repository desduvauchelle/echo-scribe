import { BubbleSurface } from "../components/BubbleSurface";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { completeTask, getDailyFocusNote, getMorningFocusEnabled, listFocusTasks, listProjects, type Project, type DailyFocusNote, type FocusTask } from "../lib/api";
import { initTheme } from "../lib/theme";
import "../styles/speech-bubble.css";
import "./focus.css";
import { useBubbleTail } from "../lib/bubbleTail";

initTheme({ transparentBackground: true });

function localDay() {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}

function FocusBubble() {
  const [note, setNote] = useState<DailyFocusNote | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [tasks, setTasks] = useState<FocusTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<string | null>>(() => new Set());
  const [exiting, setExiting] = useState<Record<string, { x: number; y: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const bubbleRef = useRef<HTMLElement>(null);
  const pending = useRef(new Set<string>());
  const resizeStart = useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null);
  const resizeQueued = useRef<{ width: number; height: number } | null>(null);
  const resizeBusy = useRef(false);
  const resizeFinished = useRef<Promise<void> | null>(null);
  const tail = useBubbleTail();
  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout>;
    let unlisten: (() => void) | undefined;
    void win.onResized(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void invoke("desktop_pet_focus_save_size").catch(console.error), 300);
    }).then(fn => { unlisten = fn; }).catch(console.error);
    return () => { clearTimeout(timer); unlisten?.(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const loadNote = () => void Promise.all([getMorningFocusEnabled(), getDailyFocusNote(localDay())]).then(([on, value]) => {
      if (!cancelled) { setEnabled(on); setNote(on ? value : null); }
    }).catch(console.error);
    const loadTasks = () => void listFocusTasks().then((rows) => {
      if (!cancelled) setTasks(rows);
    }).catch(console.error);
    const loadProjects = () => void listProjects(true).then((rows) => {
      if (!cancelled) setProjects(rows);
    }).catch(console.error);
    loadNote();
    loadTasks();
    loadProjects();
    const timer = window.setInterval(() => { loadNote(); loadTasks(); loadProjects(); }, 30_000);
    let unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<DailyFocusNote>("daily-focus:changed", ({ payload }) => {
        if (payload.local_date === localDay()) setNote(payload.content ? payload : null);
      }),
      listen<boolean>("morning-focus:enabled-changed", ({ payload }) => {
        setEnabled(payload);
        if (payload) loadNote();
        else setNote(null);
      }),
      listen("focus:changed", loadTasks),
      listen("app:refresh", () => { loadTasks(); loadProjects(); }),
    ]).then((subscriptions) => {
      if (cancelled) subscriptions.forEach((unlisten) => unlisten());
      else unlisteners = subscriptions;
    }).catch(console.error);
    return () => { cancelled = true; window.clearInterval(timer); unlisteners.forEach((unlisten) => unlisten()); };
  }, []);
  const activeTasks = tasks.filter(task => !task.completed_at || exiting[task.item.id]);
  const groups = new Map<string | null, FocusTask[]>();
  for (const task of activeTasks) {
    const id = task.item.project_id ?? null;
    const group = groups.get(id) ?? [];
    group.push(task);
    groups.set(id, group);
  }
  const visibleNote = enabled ? note : null;
  const queueResize = (width: number, height: number) => {
    resizeQueued.current = { width, height };
    if (resizeBusy.current) return;
    resizeBusy.current = true;
    resizeFinished.current = (async () => {
      try {
        while (resizeQueued.current) {
          const next = resizeQueued.current;
          resizeQueued.current = null;
          await invoke("desktop_pet_focus_resize", next);
        }
      } catch (error) { console.error(error); }
      finally { resizeBusy.current = false; }
    })();
  };
  const finishResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    resizeStart.current = null;
    queueResize(start.width - (event.screenX - start.x), start.height - (event.screenY - start.y));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void resizeFinished.current?.then(() => invoke("desktop_pet_focus_save_size")).catch(console.error);
  };
  const finishTask = (task: FocusTask, button: HTMLButtonElement) => {
    const id = task.item.id;
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setError(null);
    const bubble = bubbleRef.current?.getBoundingClientRect();
    const circle = button.getBoundingClientRect();
    setExiting(previous => ({ ...previous, [id]: {
      x: bubble ? bubble.right - circle.left - 28 : 60,
      y: bubble ? bubble.bottom - circle.top - 4 : 60,
    } }));
    void completeTask(id).then(() => {
      window.setTimeout(() => void emit("desktop-pet:focus-task-saved").catch(console.error), 380);
      window.setTimeout(() => {
        setExiting(previous => { const next = { ...previous }; delete next[id]; return next; });
        pending.current.delete(id);
        void invoke("desktop_pet_focus_sync").catch(console.error);
      }, 600);
    }).catch(e => {
      setExiting(previous => { const next = { ...previous }; delete next[id]; return next; });
      pending.current.delete(id);
      setError(`Couldn't complete the task: ${String(e)}`);
    });
  };
  if (!visibleNote && activeTasks.length === 0) return null;
  return <BubbleSurface as="aside" ref={bubbleRef} className={`pet-focus-bubble`} tail={tail} aria-label="Today's focus">
    <div className="pet-focus-header">
      <span>Today's focus</span>
      <button type="button" aria-label="Hide today's focus" title="Hide today's focus"
        onClick={() => void invoke("desktop_pet_focus_set_visible", { visible: false }).catch(console.error)}>×</button>
    </div>
    <div className="pet-focus-content">
      {visibleNote && <button type="button" className="pet-focus-note" title="Open Tucky"
        onClick={() => void invoke("show_main_window").catch(console.error)}>{visibleNote.content}</button>}
      {activeTasks.length > 0 && <section className="pet-focus-tasks" aria-label="Focus tasks">
        {[...groups].map(([projectId, rows]) => {
          const project = projects.find((entry) => entry.id === projectId);
          const name = projectId === null ? "No project" : project?.name ?? "Unknown project";
          const expanded = expandedProjects.has(projectId);
          return <section className="pet-focus-project" key={projectId ?? "no-project"} aria-label={name}>
            <h2><i aria-hidden="true" style={{ background: project?.emoji ? "transparent" : project?.color ?? "var(--bubble-accent)" }}>{project?.emoji}</i>{name}</h2>
            <ul>{(expanded ? rows : rows.slice(0, 3)).map((task) => <li key={task.item.id} className={exiting[task.item.id] ? "is-exiting" : undefined}
              style={exiting[task.item.id] ? { "--fly-x": `${exiting[task.item.id].x}px`, "--fly-y": `${exiting[task.item.id].y}px` } as React.CSSProperties : undefined}>
              <button type="button" className="pet-focus-task-button" aria-label={`Complete ${task.item.content}`}
                disabled={!!exiting[task.item.id]}
                onClick={event => finishTask(task, event.currentTarget)}>
                <span className="pet-focus-complete" aria-hidden="true">✓</span>
                <span className="pet-focus-task-text">{task.item.content}</span>
              </button>
              {exiting[task.item.id] && <><span className="pet-focus-flight" aria-hidden="true">✓</span><span className="pet-focus-sparkles" aria-hidden="true">✦</span></>}
            </li>)}</ul>
            {rows.length > 3 && <button type="button" className="pet-focus-more" aria-expanded={expanded}
              aria-label={expanded ? `Show fewer tasks in ${name}` : `Show ${rows.length - 3} more tasks in ${name}`}
              onClick={() => setExpandedProjects(previous => {
                const next = new Set(previous);
                if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
                return next;
              })}>{expanded ? "Show fewer" : `+${rows.length - 3} more`}</button>}
          </section>;
        })}
      </section>}
    </div>
    {error && <p className="pet-focus-error" role="alert">{error}</p>}
    <button type="button" className="pet-focus-resize" aria-label="Resize today's focus from top left" title="Drag to resize today's focus"
      onPointerDown={event => {
        event.stopPropagation();
        if (event.button !== 0) return;
        resizeStart.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, width: window.innerWidth, height: window.innerHeight };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = resizeStart.current;
        if (!start || start.pointerId !== event.pointerId) return;
        queueResize(start.width - (event.screenX - start.x), start.height - (event.screenY - start.y));
      }}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}>◤</button>
  </BubbleSurface>;
}

createRoot(document.getElementById("root")!).render(<FocusBubble />);
