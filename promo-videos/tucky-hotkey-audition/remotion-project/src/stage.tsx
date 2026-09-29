import React, { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "./fonts";
import { C, clamp } from "./theme";
import { Thought } from "./brain";

// ---------- the stage ----------
const CURTAIN = "repeating-linear-gradient(90deg, #7a0f1c 0px, #a3182b 22px, #c42a3c 34px, #a3182b 46px, #7a0f1c 68px)";
export const Stage: React.FC<{ spotX?: number; spotW?: number; spotOn?: number; dim?: number }> = ({ spotX = 960, spotW = 520, spotOn = 1, dim = 0 }) => (
  <>
    <AbsoluteFill style={{ background: "radial-gradient(1400px 800px at 50% 30%, #2a1d24 0%, #120c10 70%)" }} />
    {/* floor */}
    <div style={{ position: "absolute", left: -200, right: -200, top: 690, height: 500, background: "linear-gradient(180deg, #3a2419 0%, #1c110c 100%)", borderTop: "3px solid #5a3a26" }} />
    {/* spotlight cone + pool */}
    <div style={{ position: "absolute", left: spotX - spotW / 2 - 140, top: -40, width: spotW + 280, height: 820, clipPath: `polygon(38% 0, 62% 0, 100% 100%, 0 100%)`, background: "linear-gradient(180deg, rgba(255,244,214,0.34) 0%, rgba(255,244,214,0.08) 100%)", opacity: spotOn }} />
    <div style={{ position: "absolute", left: spotX - spotW / 2 - 60, top: 690, width: spotW + 120, height: 150, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(255,240,200,0.45), rgba(255,240,200,0))", opacity: spotOn }} />
    {/* curtains */}
    <div style={{ position: "absolute", left: 0, top: 0, width: 240, height: 1080, background: CURTAIN, boxShadow: "inset -40px 0 60px rgba(0,0,0,0.5)" }} />
    <div style={{ position: "absolute", right: 0, top: 0, width: 240, height: 1080, background: CURTAIN, boxShadow: "inset 40px 0 60px rgba(0,0,0,0.5)" }} />
    <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 90, background: CURTAIN, boxShadow: "0 16px 40px rgba(0,0,0,0.5)", borderBottom: "6px solid #d4a64a" }} />
    {dim > 0 && <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} />}
  </>
);

// ---------- contestant tiles (generic, no copied logos) ----------
export type Contestant = "sw" | "wf";
const TILE = {
  sw: { name: "Superwhisper", bg: "linear-gradient(145deg, #2b2f3a 0%, #0d0f14 100%)", glyph: "#e8e8ee" },
  wf: { name: "Wispr Flow", bg: "linear-gradient(145deg, #efe9ff 0%, #c9bdf5 100%)", glyph: "#3a2f6b" },
};
export const Tile: React.FC<{ who: Contestant; size?: number; bowAt?: number[]; loopBow?: boolean; name?: boolean }> = ({ who, size = 280, bowAt = [], loopBow = false, name = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let bow = 0;
  for (const b of bowAt) if (frame >= b) bow = Math.max(bow, interpolate(frame - b, [0, 8, 26, 36], [0, 1, 1, 0], clamp));
  if (loopBow) bow = Math.max(bow, Math.max(0, Math.sin(frame / fps * 2.4)) ** 2);
  const t = TILE[who];
  const bars = [0.4, 0.75, 1, 0.6, 0.85, 0.5];
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size * 0.08 }}>
      <div style={{ perspective: 800 }}>
        <div style={{ width: size, height: size, borderRadius: size * 0.23, background: t.bg, boxShadow: "0 30px 60px rgba(0,0,0,0.55), inset 0 2px 0 rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", gap: size * 0.035, transform: `rotateX(${bow * 38}deg) translateY(${bow * size * 0.06}px)`, transformOrigin: "50% 100%" }}>
          {who === "sw"
            ? bars.map((h, i) => <div key={i} style={{ width: size * 0.05, height: size * 0.45 * h, borderRadius: size * 0.03, background: t.glyph }} />)
            : [0, 1, 2].map((i) => <div key={i} style={{ position: "absolute", width: size * 0.55, height: size * 0.1, marginTop: (i - 1) * size * 0.2, borderRadius: size, borderTop: `${size * 0.035}px solid ${t.glyph}`, transform: `translateX(${(i - 1) * size * 0.04}px)` }} />)}
        </div>
      </div>
      {name && <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: size * 0.15, color: "#fff4dc", letterSpacing: "-0.02em", textShadow: "0 6px 20px rgba(0,0,0,0.6)" }}>{t.name}</div>}
    </div>
  );
};

// Name card that slides in under a contestant: "CONTESTANT #1"
export const NameCard: React.FC<{ n: number; name: string; at: number; style?: CSSProperties }> = ({ n, name, at, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const p = spring({ frame: frame - at, fps, config: { damping: 14, stiffness: 200, mass: 0.8 } });
  return (
    <div style={{ position: "absolute", transform: `translateX(${interpolate(p, [0, 1], [-60, 0])}px)`, opacity: interpolate(p, [0, 0.4], [0, 1], clamp), ...style }}>
      <div style={{ background: "#fff4dc", padding: "10px 22px 12px", borderRadius: 10, boxShadow: "0 20px 40px rgba(0,0,0,0.45)", borderLeft: "8px solid #d4a64a" }}>
        <div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 18, letterSpacing: "0.18em", color: "#a3182b" }}>CONTESTANT #{n}</div>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 44, color: "#1c1317", letterSpacing: "-0.03em" }}>{name}</div>
      </div>
    </div>
  );
};

// ---------- judges ----------
export type Cat = "sleep" | "eye" | "awake" | "ovation";
export type ScoreEvent = { at: number; judge: 0 | 1 | 2; value: string };
const JUDGE_X = [640, 960, 1280];
export const Judges: React.FC<{ enterAt?: number; cat: Cat; catAt?: number; scores?: ScoreEvent[]; brain?: { text: string; at: number; popAt?: number; hideAt?: number }[] }> = ({ enterAt = -30, cat, scores = [], brain = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - enterAt, fps, config: { damping: 16, stiffness: 150, mass: 0.9 } });
  const t = frame / fps;
  const faces = ["🙂", "🧠", cat === "sleep" ? "😴" : cat === "eye" ? "😑" : cat === "awake" ? "😼" : "😻"];
  const names = ["YOU", "YOUR BRAIN", "CAT"];
  if (frame < enterAt) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 250, transform: `translateY(${interpolate(p, [0, 1], [260, 0])}px)`, zIndex: 30 }}>
      {JUDGE_X.map((x, i) => {
        const latest = scores.filter((s) => s.judge === i && frame >= s.at).pop();
        const sp = latest ? spring({ frame: frame - latest.at, fps, config: { damping: 10, stiffness: 240, mass: 0.6 } }) : 0;
        const hop = i === 2 && cat === "ovation" ? Math.abs(Math.sin(t * 9)) * 26 : 0;
        return (
          <div key={i} style={{ position: "absolute", left: x - 110, width: 220, top: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
            {latest && <div style={{ position: "absolute", top: -150, width: 120, height: 128, borderRadius: 10, background: "#fffdf7", boxShadow: "0 16px 30px rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: latest.value.length > 2 ? 44 : 78, color: "#1c1317", transform: `rotateX(${(1 - sp) * 90}deg) rotate(${(i - 1) * 4}deg)`, transformOrigin: "50% 100%" }}>{latest.value}</div>}
            <div style={{ fontSize: 96, lineHeight: 1, transform: `translateY(${-hop}px)`, filter: "drop-shadow(0 10px 16px rgba(0,0,0,0.5))" }}>{faces[i]}</div>
            {i === 2 && cat === "sleep" && <div style={{ position: "absolute", left: 160, top: -10 - (t * 20) % 40, fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 34, color: "#fff4dc", opacity: 0.8 }}>z z z</div>}
            {i === 2 && cat === "ovation" && <div style={{ position: "absolute", left: 150, top: 10, fontSize: 56, transform: `rotate(${Math.sin(t * 18) * 20}deg)` }}>👏</div>}
          </div>
        );
      })}
      {/* table */}
      <div style={{ position: "absolute", left: 360, right: 360, top: 96, height: 170, borderRadius: "18px 18px 0 0", background: "linear-gradient(180deg, #5a3a26 0%, #2e1d13 100%)", boxShadow: "0 -10px 40px rgba(0,0,0,0.5)", borderTop: "4px solid #d4a64a" }}>
        {JUDGE_X.map((x, i) => <div key={i} style={{ position: "absolute", left: x - 360 - 100, top: 22, width: 200, padding: "8px 0", textAlign: "center", borderRadius: 8, background: "#1c1317", color: "#f3d27a", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 18, letterSpacing: "0.14em", border: "1px solid #d4a64a" }}>{names[i]}</div>)}
      </div>
      {brain.map((b, i) => <Thought key={i} text={b.text} x={1060} y={-70} at={b.at} popAt={b.popAt} hideAt={b.hideAt} size={30} tail="left" seed={"brain" + i} />)}
    </div>
  );
};

// ---------- the one good key ----------
export const Key: React.FC<{ size?: number; spinFrom?: number; pressAt?: number; glow?: boolean }> = ({ size = 240, spinFrom, pressAt, glow = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const spin = spinFrom !== undefined ? Math.sin(((frame - spinFrom) / fps) * 0.9) * 28 : 0;
  const press = pressAt !== undefined && frame >= pressAt ? interpolate(frame - pressAt, [0, 3, 10], [0, 1, 0.35], clamp) : 0;
  const lit = pressAt !== undefined && frame >= pressAt;
  return (
    <div style={{ perspective: 900 }}>
      <div style={{ position: "relative", width: size, height: size, transform: `rotateY(${spin}deg) rotateX(18deg) translateY(${press * 16}px)`, transformStyle: "preserve-3d" }}>
        <div style={{ position: "absolute", inset: 0, top: size * 0.08, borderRadius: size * 0.16, background: "#b9b3a6", boxShadow: "0 40px 60px rgba(0,0,0,0.6)" }} />
        <div style={{ position: "absolute", inset: 0, bottom: size * 0.08 - press * size * 0.05, borderRadius: size * 0.16, background: lit || glow ? "linear-gradient(160deg, #eafff5 0%, #bfeedb 100%)" : "linear-gradient(160deg, #ffffff 0%, #e7e2d6 100%)", boxShadow: lit || glow ? `0 0 ${60 + 40 * Math.sin(frame / 6)}px rgba(91,199,162,0.8), inset 0 -6px 12px rgba(0,0,0,0.08)` : "inset 0 -6px 12px rgba(0,0,0,0.08)", display: "flex", alignItems: "flex-start", justifyContent: "flex-start", padding: size * 0.1, boxSizing: "border-box" }} />
      </div>
    </div>
  );
};

export const Pedestal: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
    <div style={{ position: "relative", zIndex: 2, marginBottom: -30 }}>{children}</div>
    <div style={{ width: 360, height: 60, borderRadius: "50%", background: "radial-gradient(closest-side, #4b1a26, #2a0e16)", boxShadow: "0 10px 30px rgba(0,0,0,0.6)" }} />
    <div style={{ width: 300, height: 200, marginTop: -30, background: "linear-gradient(90deg, #2a0e16 0%, #6b2233 45%, #2a0e16 100%)", borderRadius: "0 0 20px 20px" }} />
  </div>
);

// Marquee title with chasing bulbs
export const Marquee: React.FC<{ text: string; at: number }> = ({ text, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const p = spring({ frame: frame - at, fps, config: { damping: 11, stiffness: 220, mass: 0.8 } });
  const bulbs = 34;
  return (
    <div style={{ position: "relative", padding: "30px 60px", borderRadius: 26, background: "#1c1317", border: "5px solid #d4a64a", transform: `scale(${interpolate(p, [0, 1], [1.5, 1])})`, opacity: interpolate(p, [0, 0.3], [0, 1], clamp), boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>
      {Array.from({ length: bulbs }).map((_, i) => {
        const u = i / bulbs; const perim = u * 4; const side = Math.floor(perim); const f = perim - side;
        const pos = [{ left: `${f * 100}%`, top: 0 }, { left: "100%", top: `${f * 100}%` }, { left: `${(1 - f) * 100}%`, top: "100%" }, { left: 0, top: `${(1 - f) * 100}%` }][side];
        const on = (i + Math.floor(frame / 3)) % 3 === 0;
        return <div key={i} style={{ position: "absolute", ...pos, width: 14, height: 14, marginLeft: -7, marginTop: -7, borderRadius: "50%", background: on ? "#fff3c4" : "#8a6a2a", boxShadow: on ? "0 0 14px #ffd76a" : "none" }} />;
      })}
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 104, letterSpacing: "-0.02em", color: "#ffd76a", textShadow: "0 0 30px rgba(255,200,80,0.5)", whiteSpace: "nowrap" }}>{text}</div>
    </div>
  );
};

export const Cricket: React.FC<{ at: number; x: number }> = ({ at, x }) => {
  const frame = useCurrentFrame();
  if (frame < at || frame > at + 70) return null;
  const o = interpolate(frame - at, [0, 6, 60, 70], [0, 1, 1, 0], clamp);
  const hop = Math.abs(Math.sin((frame - at) / 5)) * 10;
  return <div style={{ position: "absolute", left: x, top: 800 - hop, fontSize: 44, opacity: o, zIndex: 20, fontFamily: FONT_BODY }}>🦗 <span style={{ fontSize: 24, color: "#fff4dc", fontStyle: "italic", opacity: 0.8 }}>chirp</span></div>;
};

export const seeded = (s: string) => random(s);
export { C };
