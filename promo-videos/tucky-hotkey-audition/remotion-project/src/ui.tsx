import React, { CSSProperties, ReactNode } from "react";
import { Easing, Img, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "./fonts";
import { C, GRAD, clamp } from "./theme";
import { Typewriter, Words } from "./text";

export const pop = (frame: number, fps: number, start: number, cfg: { damping: number; stiffness: number; mass?: number } = { damping: 14, stiffness: 170, mass: 0.8 }) => spring({ frame: frame - start, fps, config: cfg });

export const Pop: React.FC<{ start: number; children: ReactNode; style?: CSSProperties; from?: number; y?: number; origin?: string }> = ({ start, children, style, from = 0.9, y = 18, origin = "50% 100%" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, start);
  if (frame < start) return null;
  return <div style={{ transform: `translateY(${interpolate(p, [0, 1], [y, 0])}px) scale(${interpolate(p, [0, 1], [from, 1])})`, opacity: interpolate(p, [0, 0.5], [0, 1], clamp), transformOrigin: origin, ...style }}>{children}</div>;
};

// ---------- chapter question ----------
export const Question: React.FC<{ text: string; at: number; hold?: number; n: number; dark?: boolean; size?: number }> = ({ text, at, hold = 70, n, dark = false, size = 96 }) => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [at + hold, at + hold + 14], [1, 0], { ...clamp, easing: Easing.in(Easing.quad) });
  if (frame < at || frame > at + hold + 14) return null;
  const color = dark ? C.cream : C.ink;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26, opacity: out, zIndex: 40, pointerEvents: "none" }}>
      <div style={{ position: "absolute", inset: 0, background: dark ? "rgba(11,23,18,0.72)" : "rgba(251,246,234,0.82)", backdropFilter: "blur(8px)" }} />
      <div style={{ position: "relative", fontFamily: FONT_MONO, fontSize: 22, fontWeight: 700, letterSpacing: "0.22em", color: dark ? C.mintSoft : C.green2, opacity: interpolate(frame - at, [0, 10], [0, 1], clamp) }}>CHAPTER {n}</div>
      <div style={{ position: "relative", maxWidth: 1500, padding: "0 60px" }}>
        <Words text={text} delay={at + 4} size={size} color={color} weight={900} stagger={3} lineHeight={1.05} style={{ fontStyle: "italic", letterSpacing: "-0.035em" }} />
      </div>
    </div>
  );
};

export const DayStamp: React.FC<{ label: string; at: number; x?: number; y?: number; dark?: boolean }> = ({ label, at, x = 120, y = 60, dark = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, at, { damping: 12, stiffness: 240, mass: 0.7 });
  if (frame < at) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, padding: "12px 24px", borderRadius: 999, background: dark ? C.mintSoft : C.ink, color: dark ? C.ink : C.cream, fontFamily: FONT_MONO, fontWeight: 700, fontSize: 26, letterSpacing: "0.12em", opacity: interpolate(p, [0, 0.5], [0, 1], clamp), transform: `scale(${interpolate(p, [0, 1], [0.7, 1])})`, transformOrigin: "0 50%", zIndex: 30, boxShadow: "0 16px 40px rgba(32,51,41,0.25)" }}>{label}</div>
  );
};

// ---------- windows ----------
export const MacWindow: React.FC<{ width: number; height: number; title?: string; children: ReactNode; dark?: boolean; style?: CSSProperties; radius?: number; accent?: string }> = ({ width, height, title, children, dark = false, style, radius = 18, accent }) => (
  <div style={{ width, height, borderRadius: radius, overflow: "hidden", background: dark ? "#161b17" : C.white, boxShadow: "0 50px 120px rgba(32,51,41,0.28), 0 10px 30px rgba(32,51,41,0.12)", border: dark ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(32,51,41,0.08)", ...style }}>
    <div style={{ height: 52, background: dark ? "#1f2621" : "#f1efe8", display: "flex", alignItems: "center", paddingLeft: 20, gap: 9, borderBottom: dark ? "1px solid rgba(255,255,255,0.06)" : "1px solid rgba(32,51,41,0.08)" }}>
      {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c }} />)}
      {title && <div style={{ marginLeft: 16, fontFamily: FONT_BODY, fontSize: 19, fontWeight: 600, color: dark ? "rgba(255,255,255,0.7)" : C.slate, display: "flex", alignItems: "center", gap: 10 }}>{accent && <div style={{ width: 12, height: 12, borderRadius: 3, background: accent }} />}{title}</div>}
    </div>
    <div style={{ position: "relative", width, height: height - 52 }}>{children}</div>
  </div>
);

// Dark pill: "Listening…  ^ Space" with breathing bars
export const ListeningPill: React.FC<{ start: number; label?: string; scale?: number; stopAt?: number }> = ({ start, label = "Listening…", scale = 1, stopAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, start, { damping: 12, stiffness: 220, mass: 0.7 });
  if (frame < start) return null;
  const out = stopAt !== undefined ? interpolate(frame, [stopAt, stopAt + 8], [1, 0], clamp) : 1;
  if (out <= 0) return null;
  const t = (frame - start) / fps;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 22, padding: "18px 34px 18px 30px", borderRadius: 999, background: "#111411", boxShadow: "0 24px 60px rgba(0,0,0,0.35)", opacity: interpolate(p, [0, 0.5], [0, 1], clamp) * out, transform: `scale(${interpolate(p, [0, 1], [0.8, 1]) * scale})`, fontFamily: FONT_BODY }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 40 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => { const h = 10 + 28 * Math.abs(Math.sin(t * 7 + i * 1.1)) * (0.5 + 0.5 * Math.abs(Math.sin(t * 2.3 + i))); return <div key={i} style={{ width: 7, height: h, borderRadius: 4, background: C.mint }} />; })}
      </div>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: 30 }}>{label}</div>
    </div>
  );
};

// Generic "AI chat" prompt box (ChatGPT / Claude flavored)
export const PromptBox: React.FC<{ width?: number; children?: ReactNode; placeholder?: string; brand?: "gpt" | "claude"; style?: CSSProperties; sent?: boolean }> = ({ width = 900, children, placeholder = "Message", brand = "gpt", style, sent }) => (
  <div style={{ width, borderRadius: 26, background: brand === "gpt" ? "#2f2f2f" : "#fff", border: brand === "gpt" ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(32,51,41,0.14)", padding: "22px 26px 18px", fontFamily: FONT_BODY, fontSize: 30, color: brand === "gpt" ? "#ececec" : C.ink, boxShadow: brand === "gpt" ? "0 30px 80px rgba(0,0,0,0.5)" : "0 24px 60px rgba(32,51,41,0.14)", minHeight: 120, display: "flex", flexDirection: "column", justifyContent: "space-between", ...style }}>
    <div style={{ lineHeight: 1.4, minHeight: 44 }}>{children ?? <span style={{ opacity: 0.45 }}>{placeholder}</span>}</div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
      <div style={{ display: "flex", gap: 10 }}><div style={{ width: 36, height: 36, borderRadius: "50%", border: `1.5px solid ${brand === "gpt" ? "rgba(255,255,255,0.35)" : "rgba(32,51,41,0.3)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, color: "inherit", opacity: 0.7 }}>+</div></div>
      <div style={{ width: 44, height: 44, borderRadius: "50%", background: sent ? C.mint : brand === "gpt" ? "#fff" : C.ink, display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={brand === "gpt" && !sent ? "#000" : "#fff"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg></div>
    </div>
  </div>
);

export const Cursor: React.FC<{ blink?: boolean; color?: string }> = ({ blink = true, color = "currentColor" }) => {
  const frame = useCurrentFrame();
  const on = !blink || Math.floor(frame / 16) % 2 === 0;
  return <span style={{ display: "inline-block", width: "0.08em", height: "1.05em", background: color, marginLeft: 3, verticalAlign: "-0.15em", opacity: on ? 1 : 0 }} />;
};

// Text typed then partially deleted: [type n chars] [pause] [delete m chars]
export const Hesitation: React.FC<{ text: string; start: number; cps?: number; deleteAt: number; deleteCount: number; retypeAt?: number; retype?: string; color?: string }> = ({ text, start, cps = 12, deleteAt, deleteCount, retypeAt, retype = "", color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < start) return null;
  const typedAt = (f: number) => Math.min(text.length, Math.floor(((f - start) / fps) * cps));
  let n = typedAt(Math.min(frame, deleteAt));
  if (frame >= deleteAt) n = Math.max(0, n - Math.min(deleteCount, Math.floor(((frame - deleteAt) / fps) * 18)));
  let shown = text.slice(0, n);
  if (retypeAt !== undefined && frame >= retypeAt) shown = text.slice(0, Math.max(0, text.length - deleteCount)) + retype.slice(0, Math.floor(((frame - retypeAt) / fps) * cps));
  return <span style={{ color }}>{shown}<Cursor /></span>;
};

// Small app window (Gmail / Slack / VS Code / Claude look-alikes)
export const AppWindow: React.FC<{ kind: "gmail" | "slack" | "code" | "claude" | "notes"; width: number; height: number; children?: ReactNode }> = ({ kind, width, height, children }) => {
  const cfg = { gmail: { title: "Gmail — New message", accent: "#EA4335", dark: false }, slack: { title: "Slack — #product", accent: "#611f69", dark: false }, code: { title: "VS Code — billing.ts", accent: "#3b82f6", dark: true }, claude: { title: "AI chat", accent: "#5bc7a2", dark: false }, notes: { title: "Notes", accent: "#f59e0b", dark: false } }[kind];
  return (
    <MacWindow width={width} height={height} title={cfg.title} accent={cfg.accent} dark={cfg.dark}>
      <div style={{ position: "absolute", inset: 0, padding: 28, fontFamily: kind === "code" ? FONT_MONO : FONT_BODY, fontSize: kind === "code" ? 22 : 26, color: cfg.dark ? "#d4d4d4" : C.ink, lineHeight: 1.45 }}>
        {kind === "gmail" && <div style={{ fontSize: 18, color: C.slateLight, marginBottom: 14 }}>To: <span style={{ color: C.ink }}>sam@northwind.co</span> · Subject: <span style={{ color: C.ink }}>Re: launch timing</span></div>}
        {kind === "slack" && <div style={{ fontSize: 18, color: C.slateLight, marginBottom: 14 }}>Message #product</div>}
        {kind === "code" && <div style={{ fontSize: 18, color: "#6a9955", marginBottom: 10 }}>{"// billing.ts · line 142"}</div>}
        {kind === "claude" && <div style={{ fontSize: 18, color: C.slateLight, marginBottom: 14 }}>New chat</div>}
        {children}
      </div>
    </MacWindow>
  );
};

// ---------- library / captures ----------
export const CaptureRow: React.FC<{ at: number; kind: "note" | "task" | "idea" | "meeting" | "screen"; text: string; time: string; project?: string }> = ({ at, kind, text, time, project }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, at, { damping: 14, stiffness: 190 });
  if (frame < at) return null;
  const cfg = { note: { l: "NOTE", c: C.green2 }, task: { l: "TASK", c: C.amber }, idea: { l: "IDEA", c: "#7c5cff" }, meeting: { l: "MEETING", c: "#c2410c" }, screen: { l: "SCREEN", c: "#0ea5e9" } }[kind];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "16px 20px", borderRadius: 16, background: C.white, border: "1px solid rgba(32,51,41,0.08)", opacity: interpolate(p, [0, 0.5], [0, 1], clamp), transform: `translateY(${interpolate(p, [0, 1], [16, 0])}px)`, fontFamily: FONT_BODY }}>
      <div style={{ padding: "5px 10px", borderRadius: 8, background: cfg.c, color: "#fff", fontSize: 13, fontWeight: 800, letterSpacing: "0.12em", flexShrink: 0, minWidth: 74, textAlign: "center" }}>{cfg.l}</div>
      <div style={{ flex: 1, fontSize: 22, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</div>
      {project && <div style={{ padding: "4px 12px", borderRadius: 999, background: C.mintPale, color: C.green2, fontSize: 15, fontWeight: 700 }}>{project}</div>}
      <div style={{ fontFamily: FONT_MONO, fontSize: 16, color: C.slateLight, flexShrink: 0 }}>{time}</div>
    </div>
  );
};

export const Toast: React.FC<{ start: number; title: string; sub?: string; actions?: string[]; chosenAt?: number; icon?: ReactNode; width?: number }> = ({ start, title, sub, actions = [], chosenAt, icon, width = 520 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, start, { damping: 13, stiffness: 200 });
  if (frame < start) return null;
  const chosen = chosenAt !== undefined && frame >= chosenAt;
  return (
    <div style={{ width, background: "#fff", borderRadius: 22, padding: "18px 22px", boxShadow: "0 30px 80px rgba(32,51,41,0.25)", border: "1px solid rgba(32,51,41,0.08)", opacity: interpolate(p, [0, 0.5], [0, 1], clamp), transform: `translateY(${interpolate(p, [0, 1], [-30, 0])}px) scale(${interpolate(p, [0, 1], [0.9, 1])})`, fontFamily: FONT_BODY }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {icon ?? <Img src={staticFile("brand/tucky.jpeg")} style={{ width: 44, height: 44, borderRadius: 12 }} />}
        <div><div style={{ fontSize: 22, fontWeight: 700, color: C.ink }}>{title}</div>{sub && <div style={{ fontSize: 17, color: C.slate }}>{sub}</div>}</div>
      </div>
      {actions.length > 0 && <div style={{ display: "flex", gap: 10, marginTop: 14 }}>{actions.map((a, i) => <div key={a} style={{ flex: 1, textAlign: "center", padding: "10px 0", borderRadius: 12, background: i === 0 ? (chosen ? C.mint : C.green) : "#f1efe8", color: i === 0 ? "#fff" : C.ink, fontWeight: 700, fontSize: 18, transform: chosen && i === 0 && frame < chosenAt! + 6 ? "scale(0.95)" : "scale(1)" }}>{chosen && i === 0 ? "Recording ●" : a}</div>)}</div>}
    </div>
  );
};

export const GuideItem: React.FC<{ text: string; done?: boolean; suggested?: boolean; at?: number }> = ({ text, done, suggested, at = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, at, { damping: 12, stiffness: 240 });
  const isDone = done && frame >= at;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderRadius: 12, background: suggested && frame >= at ? "#fff7e8" : "transparent", border: suggested && frame >= at ? `2px solid ${C.amberSoft}` : "2px solid transparent", fontFamily: FONT_BODY, fontSize: 20, fontWeight: 600, color: isDone ? C.slateLight : C.ink, textDecoration: isDone ? "line-through" : "none", transform: suggested && frame >= at ? `scale(${0.96 + 0.04 * p})` : "none" }}>
      <div style={{ width: 26, height: 26, borderRadius: 8, border: `2px solid ${isDone ? C.mint : suggested && frame >= at ? C.amber : "#d6d1c4"}`, background: isDone ? C.mint : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transform: isDone ? `scale(${0.6 + 0.4 * p})` : "none" }}>{isDone && <svg width="14" height="14" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}</div>
      {text}
      {suggested && frame >= at && <div style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, letterSpacing: "0.14em", color: C.amber }}>ASK NEXT</div>}
    </div>
  );
};

export const Mascot: React.FC<{ pose: "mic" | "bag" | "laptop"; start: number; width?: number; style?: CSSProperties; bounce?: boolean }> = ({ pose, start, width = 260, style, bounce = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - start, fps, config: { damping: 9, stiffness: 180, mass: 0.8 } });
  if (frame < start) return null;
  const t = (frame - start) / fps;
  const bob = bounce ? Math.sin(t * 2.2) * 6 : 0;
  return <Img src={staticFile(`brand/tucky-${pose}-t.png`)} style={{ width, transform: `translateY(${interpolate(p, [0, 1], [60, 0]) + bob}px) scale(${interpolate(p, [0, 1], [0.6, 1])})`, opacity: interpolate(p, [0, 0.4], [0, 1], clamp), transformOrigin: "50% 100%", ...style }} />;
};

export const Logo: React.FC<{ size?: number; color?: string; style?: CSSProperties }> = ({ size = 120, color = C.ink, style }) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.22, ...style }}>
    <Img src={staticFile("brand/tucky.jpeg")} style={{ width: size, height: size, borderRadius: size * 0.24, boxShadow: "0 20px 50px rgba(32,51,41,0.25)" }} />
    <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: size * 0.95, letterSpacing: "-0.04em", color }}>Tucky</div>
  </div>
);

export const Bullet: React.FC<{ at: number; children: ReactNode; color?: string; size?: number }> = ({ at, children, color = C.mint, size = 26 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, at);
  if (frame < at) return null;
  return <div style={{ display: "flex", alignItems: "flex-start", gap: 14, fontFamily: FONT_BODY, fontSize: size, color: C.ink, lineHeight: 1.35, opacity: interpolate(p, [0, 0.5], [0, 1], clamp), transform: `translateX(${interpolate(p, [0, 1], [20, 0])}px)` }}><div style={{ width: 10, height: 10, borderRadius: "50%", background: color, marginTop: size * 0.55, flexShrink: 0 }} />{children}</div>;
};

export { Typewriter, GRAD };
