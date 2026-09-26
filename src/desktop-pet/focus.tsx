import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getDailyFocusNote, getMorningFocusEnabled, listFocusTasks, type DailyFocusNote, type FocusTask } from "../lib/api";
import { initTheme } from "../lib/theme";
import "../styles/speech-bubble.css";
import "./focus.css";

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
  useEffect(() => {
    let cancelled = false;
    const loadNote = () => void Promise.all([getMorningFocusEnabled(), getDailyFocusNote(localDay())]).then(([on, value]) => {
      if (!cancelled) { setEnabled(on); setNote(on ? value : null); }
    }).catch(console.error);
    const loadTasks = () => void listFocusTasks().then((rows) => {
      if (!cancelled) setTasks(rows);
    }).catch(console.error);
    loadNote();
    loadTasks();
    const timer = window.setInterval(() => { loadNote(); loadTasks(); }, 30_000);
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
      listen("app:refresh", loadTasks),
    ]).then((subscriptions) => {
      if (cancelled) subscriptions.forEach((unlisten) => unlisten());
      else unlisteners = subscriptions;
    }).catch(console.error);
    return () => { cancelled = true; window.clearInterval(timer); unlisteners.forEach((unlisten) => unlisten()); };
  }, []);
  const visibleNote = enabled ? note : null;
  if (!visibleNote && tasks.length === 0) return null;
  return <aside className="pet-focus-bubble" aria-label="Today's focus">
    <div className="pet-focus-header">
      <span>Today's focus</span>
      <button type="button" aria-label="Hide today's focus" title="Hide today's focus"
        onClick={() => void invoke("desktop_pet_focus_set_visible", { visible: false }).catch(console.error)}>×</button>
    </div>
    <div className="pet-focus-content">
      {visibleNote && <p>{visibleNote.content}</p>}
      {tasks.length > 0 && <section className="pet-focus-tasks" aria-label="Focus tasks">
        {visibleNote && <span>Focus tasks</span>}
        <ul>{tasks.map((task) => <li key={task.item.id} className={task.completed_at ? "is-done" : undefined}>
          {task.item.content}
        </li>)}</ul>
      </section>}
    </div>
  </aside>;
}

createRoot(document.getElementById("root")!).render(<FocusBubble />);
