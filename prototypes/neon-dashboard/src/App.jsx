import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Bell as BellSimple,
  CalendarDays as CalendarDots,
  Check,
  Command,
  Folder,
  Settings as GearSix,
  Hash,
  Headphones,
  LayoutDashboard,
  MessageSquare,
  Mic as Microphone,
  MonitorUp,
  Moon,
  Play,
  Plus,
  Sparkles as Sparkle,
  Sun,
  Users as UsersThree,
  AudioWaveform as Waveform,
  X,
} from "lucide-react";

const activity = [
  { title: "Product sync", meta: "18 min  ·  4 speakers", icon: UsersThree, tone: "blue" },
  { title: "Voice note", meta: "6 min  ·  3 tasks found", icon: Microphone, tone: "pink" },
  { title: "Customer call", meta: "42 min  ·  Summary ready", icon: Headphones, tone: "violet" },
];

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Chat", icon: MessageSquare },
  { label: "Daily recaps", icon: CalendarDots },
  { label: "People & companies", icon: UsersThree },
];

const projects = ["Echo Scribe", "LiveCase", "PFFC", "Recursive Solutions"];

export function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("neon-dashboard-theme") || "dark");
  const [active, setActive] = useState("Dashboard");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState(3);
  const [updateVisible, setUpdateVisible] = useState(true);
  const [updateStatus, setUpdateStatus] = useState("Restart Now");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("neon-dashboard-theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand" aria-label="Echo Scribe">
          <span className="brand-mark"><Command size={22} /></span>
          <span>Echo Scribe</span>
        </div>

        <div className="capture-shortcuts" aria-label="Capture shortcuts">
          <button aria-label="Voice dictation"><span className="shortcut-dot" /><Microphone size={11} /></button>
          <button onClick={() => setRecording(true)}><span className="shortcut-dot" />Record</button>
          <button><MonitorUp size={11} />Screen</button>
        </div>

        <nav className="main-nav">
          {navItems.map(({ label, icon: Icon }) => (
            <button
              className={`nav-item ${active === label ? "active" : ""}`}
              key={label}
              onClick={() => setActive(label)}
              aria-current={active === label ? "page" : undefined}
            >
              <Icon size={21} weight={active === label ? "fill" : "regular"} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-divider" />

        <div className="projects-heading">
          <span>Projects</span>
          <Folder size={14} />
        </div>
        <nav className="project-nav" aria-label="Projects">
          {projects.map((project) => (
            <button
              className={`nav-item project-item ${active === project ? "active" : ""}`}
              key={project}
              onClick={() => setActive(project)}
              aria-current={active === project ? "page" : undefined}
            >
              <Hash size={17} />
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
              <button className="restart-button" onClick={() => setUpdateStatus("Restarting…")}>{updateStatus}</button>
            </div>
          )}
          <div className="settings-row">
            <button className={`nav-item ${active === "Settings" ? "active" : ""}`} onClick={() => setActive("Settings")}>
              <GearSix size={18} />
              <span>Settings</span>
            </button>
            <button
              className="icon-button theme-toggle sidebar-theme-toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              <Sun className="sun" size={17} />
              <Moon className="moon" size={17} />
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
              <BellSimple size={20} />
              {notice > 0 && <span>{notice}</span>}
            </button>
            <button className="primary-button" onClick={() => setRecording(true)}>
              <Plus size={18} /> New capture
            </button>
          </div>
        </header>

        <section className="hero-card" aria-labelledby="hero-title">
          <div className="hero-copy">
            <span className="status-pill"><Sparkle size={14} /> Ready to listen</span>
            <h2 id="hero-title">Turn every conversation<br />into something useful.</h2>
            <p>Capture a thought, meeting, or call. Echo turns it into notes and next steps while you keep moving.</p>
            <button className={`record-button ${recording ? "is-recording" : ""}`} onClick={() => setRecording(!recording)}>
              <span className="record-icon">{recording ? <Waveform size={22} /> : <Microphone size={22} />}</span>
              <span><strong>{recording ? "Listening…" : "Start capture"}</strong><small>{recording ? "Tap to finish" : "⌘  Shift  Space"}</small></span>
            </button>
          </div>

          <div className={`orb-stage ${recording ? "is-live" : ""}`} aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="sound-orb"><Waveform size={48} /></div>
            <span className="floating-chip chip-one"><Check size={14} /> Notes ready</span>
            <span className="floating-chip chip-two">12 tasks</span>
          </div>
        </section>

        <section className="metric-grid" aria-label="Capture statistics">
          <article className="metric-card">
            <span className="metric-icon blue"><Waveform size={21} /></span>
            <div><p>Captured this week</p><strong>4h 28m</strong></div>
            <span className="trend">+18%</span>
          </article>
          <article className="metric-card">
            <span className="metric-icon pink"><Check size={21} /></span>
            <div><p>Tasks discovered</p><strong>26</strong></div>
            <span className="trend">+7</span>
          </article>
          <article className="metric-card focus-card">
            <div><p>Focus score</p><strong>86<span>%</span></strong></div>
            <div className="progress-ring" aria-label="Focus score 86 percent"><span>86</span></div>
          </article>
        </section>

        <section className="lower-grid">
          <div className="activity-panel panel">
            <div className="section-heading"><div><p className="eyebrow">RECENT</p><h3>Your activity</h3></div><button>View all</button></div>
            <div className="activity-list">
              {activity.map(({ title, meta, icon: Icon, tone }, index) => (
                <button className="activity-row" key={title}>
                  <span className={`activity-icon ${tone}`}><Icon size={20} /></span>
                  <span className="activity-copy"><strong>{title}</strong><small>{meta}</small></span>
                  <span className="activity-time">{index === 0 ? "10:42" : index === 1 ? "Yesterday" : "Mon"}</span>
                  <span className="play"><Play size={14} /></span>
                </button>
              ))}
            </div>
          </div>

          <aside className="insight-card panel">
            <div className="insight-top"><span><Sparkle size={18} /></span><small>WEEKLY INSIGHT</small></div>
            <h3>Your clearest ideas arrive before noon.</h3>
            <p>Morning captures are 32% more likely to become completed tasks.</p>
            <div className="mini-chart" aria-hidden="true">
              {[34, 62, 84, 56, 72, 45, 30].map((height, i) => <span key={i} style={{ height: `${height}%` }} />)}
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
