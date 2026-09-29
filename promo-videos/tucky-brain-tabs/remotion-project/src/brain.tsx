import React, { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, Img, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_HAND, FONT_MONO } from "./fonts";
import { C, clamp } from "./theme";
import { FPS, TABS } from "./timeline";

// ---------- thought bubble ----------
// Positions are the bubble's centre. `pos` can override x/y per frame (orbits, drifts).
export type ThoughtProps = {
  text: string; x: number; y: number; at: number; popAt?: number; hideAt?: number; size?: number; hl?: boolean;
  stamp?: string; seed?: string; pos?: (f: number) => { x: number; y: number }; tail?: "left" | "right"; dark?: boolean;
};
export const Thought: React.FC<ThoughtProps> = ({ text, x, y, at, popAt, hideAt, size = 30, hl = false, stamp, seed = text, pos, tail = "left" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  if (popAt !== undefined && frame > popAt + 16) return null;
  if (hideAt !== undefined && frame > hideAt + 10) return null;
  const p = spring({ frame: frame - at, fps, config: { damping: 10, stiffness: 220, mass: 0.7 } });
  const t = frame / fps;
  const wob = Math.sin(t * 2.1 + random(seed) * 6) * 5;
  const rot = Math.sin(t * 1.4 + random(seed + "r") * 6) * 1.8 + (random(seed + "a") - 0.5) * 5;
  const base = pos ? pos(frame) : { x, y };
  const popping = popAt !== undefined && frame >= popAt;
  const pp = popping ? interpolate(frame - popAt!, [0, 7], [0, 1], clamp) : 0;
  const hide = hideAt !== undefined ? interpolate(frame, [hideAt, hideAt + 10], [1, 0], clamp) : 1;
  const scale = interpolate(p, [0, 1], [0.3, 1]) * (1 + 0.4 * pp);
  const op = interpolate(p, [0, 0.4], [0, 1], clamp) * (1 - pp) * hide;
  return (
    <div style={{ position: "absolute", left: base.x, top: base.y + wob, transform: `translate(-50%, -50%)`, zIndex: hl ? 25 : 20 }}>
      <div style={{ position: "relative", transform: `scale(${scale}) rotate(${rot}deg)`, opacity: op }}>
        <div style={{ padding: `${size * 0.5}px ${size * 0.85}px`, borderRadius: size * 1.2, background: hl ? "#fff1d2" : "#fff8ea", border: `3px solid ${hl ? C.amber : C.amberSoft}`, boxShadow: hl ? `0 0 0 8px rgba(233,172,66,0.25), 0 24px 50px rgba(120,80,20,0.25)` : "0 18px 40px rgba(120,80,20,0.18)", fontFamily: FONT_BODY, fontWeight: 700, fontSize: size, color: C.ink, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>{text}</div>
        <div style={{ position: "absolute", [tail]: size * 0.9, bottom: -size * 0.55, width: size * 0.5, height: size * 0.5, borderRadius: "50%", background: "#fff8ea", border: `3px solid ${C.amberSoft}` }} />
        <div style={{ position: "absolute", [tail]: size * 0.55, bottom: -size * 1.0, width: size * 0.28, height: size * 0.28, borderRadius: "50%", background: "#fff8ea", border: `3px solid ${C.amberSoft}` }} />
        {stamp && <div style={{ position: "absolute", right: -size * 0.6, top: -size * 0.8, padding: "6px 14px", borderRadius: 999, background: C.red, color: "#fff", fontFamily: FONT_MONO, fontWeight: 700, fontSize: size * 0.55, transform: "rotate(6deg)", whiteSpace: "nowrap" }}>{stamp}</div>}
      </div>
      {popping && <Burst frame={frame - popAt!} seed={seed} />}
    </div>
  );
};

const Burst: React.FC<{ frame: number; seed: string }> = ({ frame, seed }) => {
  const p = interpolate(frame, [0, 14], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const o = interpolate(frame, [0, 4, 16], [0, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: "50%", top: "50%" }}>
      {Array.from({ length: 10 }).map((_, i) => {
        const a = (i / 10) * Math.PI * 2 + random(seed + i) * 0.4;
        const d = 60 + 110 * p * (0.7 + 0.5 * random(seed + "d" + i));
        return <div key={i} style={{ position: "absolute", left: Math.cos(a) * d - 7, top: Math.sin(a) * d - 7, width: 14, height: 14, borderRadius: "50%", background: i % 2 ? C.mint : C.amberSoft, opacity: o, transform: `scale(${1 - p * 0.6})` }} />;
      })}
    </div>
  );
};

// ---------- tab counter (global overlay, absolute time) ----------
export const tabsAt = (t: number) => {
  let i = 0;
  while (i + 1 < TABS.length && TABS[i + 1][0] <= t) i++;
  const [ti, v] = TABS[i];
  const prev = i > 0 ? TABS[i - 1][1] : v;
  const p = interpolate(t - ti, [0, Math.abs(v - prev) > 10 ? 0.8 : 0.3], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  return { value: Math.round(prev + (v - prev) * p), changedAt: ti };
};
export const TabCounter: React.FC<{ hideFrom: number }> = ({ hideFrom }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const { value, changedAt } = tabsAt(t);
  const bump = spring({ frame: frame - Math.round(changedAt * FPS), fps: FPS, config: { damping: 8, stiffness: 300, mass: 0.6 } });
  const kick = changedAt > 0 ? interpolate(bump, [0, 0.5, 1], [1, 1.14, 1]) : 1;
  const out = interpolate(frame, [hideFrom - 8, hideFrom], [1, 0], clamp);
  const enter = interpolate(frame, [6, 18], [0, 1], clamp);
  if (out <= 0) return null;
  const hot = value >= 30, calm = value <= 5;
  const bg = hot ? "#b42318" : calm ? C.green : "#8a4b12";
  return (
    <div style={{ position: "absolute", right: 48, top: 62, zIndex: 45, opacity: out * enter, transform: `scale(${kick})`, transformOrigin: "100% 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 26px 12px 18px", borderRadius: 999, background: bg, color: "#fff", fontFamily: FONT_BODY, fontWeight: 800, fontSize: 30, boxShadow: "0 16px 40px rgba(0,0,0,0.25)" }}>
        <span style={{ fontSize: 34 }}>🧠</span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 32, minWidth: 44, textAlign: "right" }}>{value}</span>
        <span>{value === 1 ? "tab open" : "tabs open"}</span>
      </div>
    </div>
  );
};

// ---------- mac chrome ----------
export const MenuBar: React.FC<{ app?: string; clock: string; dark?: boolean }> = ({ app = "Docs", clock, dark = false }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 40, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 26px", background: dark ? "rgba(20,24,21,0.7)" : "rgba(255,255,255,0.55)", backdropFilter: "blur(20px)", fontFamily: FONT_BODY, fontSize: 19, fontWeight: 600, color: dark ? "#e8efe9" : C.ink, zIndex: 40 }}>
    <div style={{ display: "flex", gap: 26 }}><span style={{ fontWeight: 800 }}>{app}</span><span style={{ opacity: 0.6 }}>File</span><span style={{ opacity: 0.6 }}>Edit</span><span style={{ opacity: 0.6 }}>View</span></div>
    <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
      <Img src={staticFile("brand/tucky.jpeg")} style={{ width: 22, height: 22, borderRadius: 6 }} />
      <span style={{ fontFamily: FONT_MONO, fontWeight: 700 }}>{clock}</span>
    </div>
  </div>
);

export const Win: React.FC<{ width: number; height: number; title: string; children: ReactNode; style?: CSSProperties; tabs?: ReactNode }> = ({ width, height, title, children, style, tabs }) => (
  <div style={{ width, height, borderRadius: 18, overflow: "hidden", background: C.white, boxShadow: "0 50px 120px rgba(32,51,41,0.28), 0 10px 30px rgba(32,51,41,0.12)", border: "1px solid rgba(32,51,41,0.08)", ...style }}>
    <div style={{ height: 52, background: "#f1efe8", display: "flex", alignItems: "center", paddingLeft: 20, gap: 9, borderBottom: "1px solid rgba(32,51,41,0.08)" }}>
      {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c }} />)}
      {tabs ?? <div style={{ marginLeft: 16, fontFamily: FONT_BODY, fontSize: 19, fontWeight: 600, color: C.slate }}>{title}</div>}
    </div>
    <div style={{ position: "relative", width, height: height - 52 }}>{children}</div>
  </div>
);

// The doc the human is trying to write.
export const PitchDoc: React.FC<{ body?: ReactNode; width?: number; height?: number }> = ({ body, width = 1180, height = 720 }) => (
  <Win width={width} height={height} title="Q4 pitch — Docs">
    <div style={{ position: "absolute", inset: 0, padding: "70px 110px", fontFamily: FONT_BODY, color: C.ink }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 76, letterSpacing: "-0.035em" }}>Q4 pitch</div>
      <div style={{ marginTop: 34, fontSize: 34, lineHeight: 1.5 }}>{body}</div>
      <div style={{ position: "absolute", left: 110, right: 110, bottom: 70, display: "flex", flexDirection: "column", gap: 18, opacity: 0.5 }}>
        {[0.92, 0.75, 0.84].map((w, i) => <div key={i} style={{ height: 14, width: `${w * 100}%`, borderRadius: 7, background: "#efece4" }} />)}
      </div>
    </div>
  </Win>
);

// ---------- capture pieces ----------
export const Caption: React.FC<{ text: string; start: number; cps?: number }> = ({ text, start, cps = 16 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < start) return null;
  const n = Math.min(text.length, Math.floor(((frame - start) / fps) * cps));
  return <div style={{ fontFamily: FONT_BODY, fontWeight: 600, fontSize: 34, color: C.ink, background: "rgba(255,255,255,0.92)", padding: "16px 28px", borderRadius: 18, boxShadow: "0 18px 50px rgba(32,51,41,0.16)", maxWidth: 1100 }}>“{text.slice(0, n)}{n < text.length ? "" : "”"}</div>;
};

export type Kind = "task" | "note" | "idea";
export const KIND = { task: { l: "TASK", c: C.amber }, note: { l: "NOTE", c: C.green2 }, idea: { l: "IDEA", c: "#7c5cff" } } as const;

export const Card: React.FC<{ kind: Kind; text: string; at: number; from?: { x: number; y: number } }> = ({ kind, text, at, from }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const p = spring({ frame: frame - at, fps, config: { damping: 15, stiffness: 160, mass: 0.8 } });
  const dx = from ? interpolate(p, [0, 1], [from.x, 0]) : 0;
  const dy = from ? interpolate(p, [0, 1], [from.y, 0]) : interpolate(p, [0, 1], [20, 0]);
  const land = interpolate(frame - at, [8, 12, 18], [0, 1, 0], clamp);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 18px", borderRadius: 16, background: C.white, border: `2px solid ${land > 0 ? C.mint : "rgba(32,51,41,0.08)"}`, boxShadow: `0 ${10 + 20 * (1 - p)}px ${30 + 30 * (1 - p)}px rgba(32,51,41,${0.1 + 0.1 * (1 - p)})`, transform: `translate(${dx}px, ${dy}px) rotate(${(1 - p) * -6}deg) scale(${1 + land * 0.04})`, opacity: interpolate(p, [0, 0.2], [0, 1], clamp), fontFamily: FONT_BODY }}>
      <div style={{ alignSelf: "flex-start", padding: "4px 10px", borderRadius: 8, background: KIND[kind].c, color: "#fff", fontSize: 14, fontWeight: 800, letterSpacing: "0.12em" }}>{KIND[kind].l}</div>
      <div style={{ fontSize: 23, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>{text}</div>
    </div>
  );
};

export const Column: React.FC<{ name: string; color: string; children?: ReactNode; width?: number }> = ({ name, color, children, width = 300 }) => (
  <div style={{ width, display: "flex", flexDirection: "column", gap: 14, padding: 18, borderRadius: 22, background: "rgba(255,255,255,0.6)", border: "1px solid rgba(32,51,41,0.08)", minHeight: 560 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 24, color: C.ink, padding: "4px 4px 6px" }}>
      <div style={{ width: 14, height: 14, borderRadius: 4, background: color }} />{name}
    </div>
    {children}
  </div>
);

// ---------- focus ----------
export type FocusGroup = { project: string; color: string; tasks: { text: string; doneAt?: number }[] };

// The desktop pet's "Today's focus" bubble (src/desktop-pet/focus.tsx), scaled up for 1080p.
export const FocusBubble: React.FC<{ note: string; groups: FocusGroup[]; wiggleAt?: number; width?: number }> = ({ note, groups, wiggleAt, width = 520 }) => {
  const frame = useCurrentFrame();
  const w = wiggleAt !== undefined && frame >= wiggleAt ? Math.sin((frame - wiggleAt) * 1.3) * interpolate(frame - wiggleAt, [0, 24], [5, 0], clamp) : 0;
  return (
    <div style={{ position: "relative", width, padding: "24px 28px", borderRadius: "28px 28px 8px 28px", background: "#fffdf7", border: "1.5px solid rgba(23,107,80,0.22)", boxShadow: "0 24px 60px rgba(32,51,41,0.2)", fontFamily: FONT_BODY, color: C.ink, transform: `rotate(${w}deg)`, transformOrigin: "100% 100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ color: C.green2, fontSize: 17, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase" }}>Today's focus</span>
        <span style={{ color: C.slateLight, fontSize: 28, lineHeight: 1 }}>×</span>
      </div>
      <p style={{ margin: 0, fontSize: 23, lineHeight: 1.45 }}>{note}</p>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1.5px solid rgba(23,107,80,0.15)" }}>
        <span style={{ display: "block", color: C.green2, fontSize: 15, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Focus tasks</span>
        {groups.map((g, gi) => (
          <div key={g.project} style={{ marginTop: gi ? 12 : 0, paddingTop: gi ? 10 : 0, borderTop: gi ? "1.5px solid rgba(23,107,80,0.1)" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, color: C.green2, fontSize: 18, fontWeight: 700, marginBottom: 4 }}><i style={{ width: 13, height: 13, borderRadius: 4, background: g.color }} />{g.project}</div>
            {g.tasks.map((t) => {
              const done = t.doneAt !== undefined && frame >= t.doneAt;
              const pp = done ? spring({ frame: frame - t.doneAt!, fps: FPS, config: { damping: 10, stiffness: 260, mass: 0.6 } }) : 0;
              return (
                <div key={t.text} style={{ display: "flex", alignItems: "center", gap: 12, padding: "3px 0", fontSize: 21, color: done ? C.slateLight : C.ink, textDecoration: done ? "line-through" : "none" }}>
                  <span style={{ width: 18, display: "inline-flex", justifyContent: "center", color: C.green2, fontWeight: 800, transform: `scale(${done ? 0.6 + 0.4 * pp : 1})` }}>{done ? "✓" : <span style={{ width: 10, height: 10, borderRadius: "50%", border: `1.5px solid ${C.green2}` }} />}</span>
                  {t.text}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

// Handwritten sticky note
export const Sticky: React.FC<{ text: string; style?: CSSProperties; size?: number }> = ({ text, style, size = 220 }) => (
  <div style={{ width: size, height: size, background: "linear-gradient(180deg, #fff27a 0%, #ffe95c 100%)", boxShadow: "0 18px 30px rgba(0,0,0,0.22)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_HAND, fontWeight: 700, fontSize: size * 0.2, color: "#2a2a2a", ...style }}>
    <span style={{ transform: "rotate(-4deg)", textDecoration: "underline", textDecorationThickness: 3 }}>{text}</span>
  </div>
);

export const Screen: React.FC<{ children: ReactNode; bg?: string }> = ({ children, bg }) => <AbsoluteFill style={{ background: bg }}>{children}</AbsoluteFill>;
