import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Bell,
  CalendarDays,
  Check,
  Command,
  Folder,
  Hash,
  CheckSquare,
  LayoutDashboard,
  MessageSquare,
  Mic,
  MonitorUp,
  Moon,
  MoreHorizontal,
  Phone,
  Play,
  Plus,
  Settings,
  StickyNote,
  Sun,
  Users,
  Video,
  X,
} from "lucide-react";

const logItems = [
  {
    id: "transcription-1",
    kind: "transcription",
    label: "Transcription",
    title: "Can we make the version checker compare the installed build before asking to update?",
    meta: "Voice at cursor · 186 words",
    project: "Echo Scribe",
    time: "3 min ago",
    icon: Mic,
  },
  {
    id: "meeting-1",
    kind: "meeting",
    label: "Meeting",
    title: "Product delivery sync",
    meta: "Google Meet · 38 min · 4 speakers · 3 action items",
    project: "Recursive Solutions",
    time: "10:42",
    icon: Phone,
  },
  {
    id: "note-1",
    kind: "note",
    label: "Note",
    title: "Keep the dashboard calm and let the content establish the hierarchy.",
    meta: "Quick note · #design-review",
    project: "Echo Scribe",
    time: "Yesterday",
    icon: StickyNote,
  },
  {
    id: "recording-1",
    kind: "recording",
    label: "Recording",
    title: "Dashboard walkthrough",
    meta: "12:48 · 186.4 MB · Saved locally",
    project: "LiveCase",
    time: "Monday",
    icon: Video,
  },
  {
    id: "task-1",
    kind: "task",
    label: "Task",
    title: "Review notification collision handling in the desktop shell",
    meta: "Open · Created from Product delivery sync",
    project: "PFFC",
    time: "Monday",
    icon: CheckSquare,
  },
];

const logFilters = [
  { value: "all", label: "All", icon: LayoutDashboard },
  { value: "transcription", label: "Transcriptions", icon: Mic },
  { value: "note", label: "Notes", icon: StickyNote },
  { value: "task", label: "Tasks", icon: CheckSquare },
  { value: "meeting", label: "Meetings", icon: Phone },
  { value: "recording", label: "Recordings", icon: Video },
];

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Chat", icon: MessageSquare },
  { label: "Daily recaps", icon: CalendarDays },
  { label: "People & companies", icon: Users },
];

const projects = ["Echo Scribe", "LiveCase", "PFFC", "Recursive Solutions"];

export function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("wireframe-dashboard-theme") || "light");
  const [active, setActive] = useState("Dashboard");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState(3);
  const [updateVisible, setUpdateVisible] = useState(true);
  const [logFilter, setLogFilter] = useState("all");

  const visibleLogs = logFilter === "all"
    ? logItems
    : logItems.filter((item) => item.kind === logFilter);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("wireframe-dashboard-theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark"><Command size={17} /></span>
          <span>Echo Scribe</span>
        </div>

        <div className="capture-shortcuts" aria-label="Capture shortcuts">
          <button aria-label="Voice dictation"><Mic size={13} /></button>
          <button onClick={() => setRecording(true)}><span className="shortcut-dot" /> Record</button>
          <button><MonitorUp size={12} /> Screen</button>
        </div>

        <nav className="main-nav">
          {navItems.map(({ label, icon: Icon }) => (
            <button
              className={`nav-item ${active === label ? "active" : ""}`}
              key={label}
              onClick={() => setActive(label)}
              aria-current={active === label ? "page" : undefined}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-divider" />

        <div className="projects-heading">
          <span>Projects</span>
          <Folder size={13} />
        </div>
        <nav className="project-nav" aria-label="Projects">
          {projects.map((project) => (
            <button
              className={`nav-item project-item ${active === project ? "active" : ""}`}
              key={project}
              onClick={() => setActive(project)}
              aria-current={active === project ? "page" : undefined}
            >
              <Hash size={14} />
              <span>{project}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          {updateVisible && (
            <div className="update-card" role="status">
              <button className="update-dismiss" onClick={() => setUpdateVisible(false)} aria-label="Dismiss update"><X size={12} /></button>
              <strong><ArrowDownToLine size={13} /> Update ready</strong>
              <small>Echo Scribe 1.0.3</small>
              <button className="restart-button">Restart now</button>
            </div>
          )}
          <div className="settings-row">
            <button className={`nav-item ${active === "Settings" ? "active" : ""}`} onClick={() => setActive("Settings")}>
              <Settings size={16} />
              <span>Settings</span>
            </button>
            <button
              className="theme-toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow">Wednesday, July 29</p>
            <h1>{active}</h1>
          </div>
          <div className="top-actions">
            <button className="icon-button notification" onClick={() => setNotice(0)} aria-label="Notifications">
              <Bell size={18} />
              {notice > 0 && <span>{notice}</span>}
            </button>
            <button className="primary-button" onClick={() => setRecording(true)}>
              <Plus size={16} /> New capture
            </button>
          </div>
        </header>

        <section className="capture-panel" aria-labelledby="capture-title">
          <div>
            <p className="section-label">Capture</p>
            <h2 id="capture-title">What do you want to remember?</h2>
            <p>Record a meeting, dictate a thought, or capture your screen.</p>
          </div>
          <button className={`capture-button ${recording ? "is-recording" : ""}`} onClick={() => setRecording(!recording)}>
            <Mic size={17} />
            <span>{recording ? "Stop capture" : "Start capture"}</span>
            <kbd>⌘ ⇧ Space</kbd>
          </button>
        </section>

        <section className="metric-grid" aria-label="Capture statistics">
          <article className="metric-card">
            <p>Captured this week</p>
            <strong>4h 28m</strong>
            <span>+18%</span>
          </article>
          <article className="metric-card">
            <p>Tasks discovered</p>
            <strong>26</strong>
            <span>+7</span>
          </article>
          <article className="metric-card">
            <p>Focus score</p>
            <strong>86%</strong>
            <span>Good</span>
          </article>
        </section>

        <section className="lower-grid">
          <div className="activity-panel panel">
            <div className="section-heading">
              <div><p className="section-label">Recent</p><h3>Activity log</h3></div>
              <button>View all</button>
            </div>
            <div className="filter-badges" aria-label="Filter activity">
              {logFilters.map(({ value, label, icon: Icon }) => (
                <button
                  className={`filter-badge ${logFilter === value ? "active" : ""}`}
                  key={value}
                  aria-pressed={logFilter === value}
                  onClick={() => setLogFilter(value)}
                >
                  <Icon size={11} />
                  {label}
                </button>
              ))}
            </div>
            <div className="activity-list">
              {visibleLogs.map(({ id, label, title, meta, project, time, icon: Icon, kind }) => (
                <button className="activity-row" key={id}>
                  <span className={`activity-icon ${kind}`}><Icon size={15} /></span>
                  <span className="activity-copy">
                    <span className="activity-kind">{label}</span>
                    <strong>{title}</strong>
                    <small>{meta} <span className="project-badge">{project}</span></small>
                  </span>
                  <span className="activity-time">{time}</span>
                  <span className="log-action">{kind === "transcription" || kind === "recording" ? <Play size={12} /> : <MoreHorizontal size={14} />}</span>
                </button>
              ))}
            </div>
          </div>

          <aside className="summary-panel panel">
            <p className="section-label">This week</p>
            <h3>At a glance</h3>
            <dl>
              <div><dt>Meetings</dt><dd>5</dd></div>
              <div><dt>Notes created</dt><dd>12</dd></div>
              <div><dt>Tasks completed</dt><dd>18</dd></div>
            </dl>
            <p className="summary-note"><Check size={14} /> You are caught up.</p>
          </aside>
        </section>
      </main>
    </div>
  );
}
