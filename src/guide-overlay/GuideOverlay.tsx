import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type KeyPoint = { id: string; label: string; status: "covered" | "partial" | "open" | string };
type GuidePayload = {
  meetingId: string;
  templateName?: string;
  goal?: string;
  mode: "auto" | "on_demand";
  keyPoints: KeyPoint[];
  suggestions: string[];
  updatedAt: string;
};

function statusMarker(s: string): string {
  if (s === "covered") return "✓";
  if (s === "partial") return "…";
  return "○";
}

function relativeAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  return `${m}m ago`;
}

export default function GuideOverlay() {
  const [payload, setPayload] = useState<GuidePayload | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let unlistenUpdate: UnlistenFn | undefined;
    let unlistenStatus: UnlistenFn | undefined;
    listen<GuidePayload>("guide-update", (e) => setPayload(e.payload)).then(
      (u) => (unlistenUpdate = u),
    );
    // Self-close: when the meeting moves past recording, the HUD is no
    // longer meaningful.
    listen<{ id: string; status: string }>("meeting-status", (e) => {
      if (
        e.payload.status === "transcribing" ||
        e.payload.status === "summarizing" ||
        e.payload.status === "complete"
      ) {
        setPayload(null);
      }
    }).then((u) => (unlistenStatus = u));
    return () => {
      unlistenUpdate?.();
      unlistenStatus?.();
    };
  }, []);

  // Tick once a second so the staleness label updates without re-emit.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const onToggleMode = useCallback(async () => {
    if (!payload) return;
    const next = payload.mode === "auto" ? "on_demand" : "auto";
    try {
      await invoke("guide_set_mode", { mode: next });
      setPayload({ ...payload, mode: next });
    } catch {
      /* swallow */
    }
  }, [payload]);

  const onTriggerNow = useCallback(async () => {
    try {
      await invoke("guide_trigger_now");
    } catch {
      /* swallow */
    }
  }, []);

  const onEnd = useCallback(async () => {
    try {
      await invoke("guide_end");
    } catch {
      /* swallow */
    }
  }, []);

  if (!payload) return null;

  return (
    <div className={`hud ${collapsed ? "collapsed" : ""}`}>
      <header data-tauri-drag-region>
        <span className="label" data-tauri-drag-region>
          GUIDE · {payload.templateName ?? "Session"}
        </span>
        <span className="controls">
          <button onClick={() => setCollapsed((c) => !c)} title="Collapse">
            {collapsed ? "□" : "─"}
          </button>
          <button className="end" onClick={onEnd} title="End session">
            ×
          </button>
        </span>
      </header>
      <section>
        {payload.goal && <div className="goal">{payload.goal}</div>}
        {payload.keyPoints.map((p) => (
          <div key={p.id} className={`point ${p.status}`}>
            <span className="marker">{statusMarker(p.status)}</span>
            <span>{p.label}</span>
          </div>
        ))}
        {payload.suggestions.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 8 }}>SUGGEST NOW</div>
            {payload.suggestions.slice(0, 3).map((s, i) => (
              <div key={i} className="suggest">{s}</div>
            ))}
          </>
        )}
      </section>
      <div className="footer">
        <span>updated {relativeAge(payload.updatedAt, now)}</span>
        {payload.mode === "auto" ? (
          <button className="mode" onClick={onToggleMode}>
            Auto ▾
          </button>
        ) : (
          <span>
            <button className="mode" onClick={onTriggerNow}>Guide me now</button>
            {" · "}
            <button className="mode" onClick={onToggleMode}>On-demand ▾</button>
          </span>
        )}
      </div>
    </div>
  );
}
