import React, { CSSProperties } from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "./fonts";
import { C, GRAD, clamp } from "./theme";
import { shakeOffset } from "./fx";

// Word-by-word rise with blur, premium keynote style
export const Words: React.FC<{ text: string; delay?: number; stagger?: number; size?: number; color?: string; weight?: number; style?: CSSProperties; align?: "left" | "center"; lineHeight?: number; gradientWords?: string[]; family?: string }> = ({ text, delay = 0, stagger = 3, size = 96, color = C.white, weight = 800, style, align = "center", lineHeight = 1.02, gradientWords = [], family = FONT_DISPLAY }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(" ");
  return (
    <div style={{ fontFamily: family, fontSize: size, fontWeight: weight, color, lineHeight, letterSpacing: "-0.03em", textAlign: align, display: "flex", flexWrap: "wrap", justifyContent: align === "center" ? "center" : "flex-start", gap: "0 0.26em", ...style }}>
      {words.map((w, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 16, stiffness: 150, mass: 0.7 } });
        const y = interpolate(p, [0, 1], [40, 0]);
        const o = interpolate(p, [0, 0.6], [0, 1], clamp);
        const blur = interpolate(p, [0, 1], [10, 0]);
        const isGrad = gradientWords.some((g) => w.replace(/[.,!?]/g, "") === g);
        return (
          <span key={i} style={{ display: "inline-block", transform: `translateY(${y}px)`, opacity: o, filter: `blur(${blur}px)`, ...(isGrad ? { background: GRAD, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", paddingRight: "0.04em" } : {}) }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};

// Movie-trailer slam: scales down hard, lands with a shake
export const Slam: React.FC<{ text: string; delay?: number; size?: number; color?: string; seed?: string; style?: CSSProperties; exitAt?: number; letterSpacing?: string }> = ({ text, delay = 0, size = 160, color = C.white, seed = "slam", style, exitAt, letterSpacing = "-0.04em" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 280, mass: 0.8 }, durationInFrames: Math.round(fps * 0.35) });
  const scale = interpolate(enter, [0, 1], [1.6, 1], clamp);
  const opacity = interpolate(enter, [0, 0.25], [0, 1], clamp);
  const land = frame - delay - fps * 0.12;
  const amp = land > 0 ? Math.max(0, 1 - land / 9) * 9 : 0;
  const { x, y } = shakeOffset(frame, amp, seed);
  const breathe = 1 + 0.006 * Math.sin(((frame - delay) / fps) * Math.PI * 1.4);
  const exit = exitAt !== undefined ? interpolate(frame, [exitAt - 4, exitAt], [1, 0], { ...clamp, easing: Easing.in(Easing.quad) }) : 1;
  if (frame < delay) return null;
  return (
    <div style={{ fontFamily: FONT_DISPLAY, fontSize: size, fontWeight: 900, color, textTransform: "uppercase", lineHeight: 0.95, letterSpacing, opacity: opacity * exit, transform: `translate(${x}px, ${y}px) scale(${scale * breathe})`, textShadow: "0 30px 80px rgba(0,0,0,0.55)", whiteSpace: "nowrap", ...style }}>
      {text}
    </div>
  );
};

export const Kicker: React.FC<{ text: string; color?: string; delay?: number; size?: number; style?: CSSProperties }> = ({ text, color = C.indigo, delay = 0, size = 22, style }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame - delay, [0, 10], [0, 1], clamp);
  const y = interpolate(frame - delay, [0, 12], [12, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
  return <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: size, letterSpacing: "0.18em", textTransform: "uppercase", color, opacity: o, transform: `translateY(${y}px)`, ...style }}>{text}</div>;
};

export const Typewriter: React.FC<{ text: string; start?: number; cps?: number; style?: CSSProperties; cursor?: boolean; cursorColor?: string }> = ({ text, start = 0, cps = 28, style, cursor = true, cursorColor = C.indigo }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.max(0, Math.min(text.length, Math.floor(((frame - start) / fps) * cps)));
  const done = n >= text.length;
  const blink = Math.floor(frame / 16) % 2 === 0;
  if (frame < start) return null;
  return (
    <span style={style}>
      {text.slice(0, n)}
      {cursor && (!done || blink) && <span style={{ display: "inline-block", width: "0.08em", height: "1em", background: cursorColor, marginLeft: 2, verticalAlign: "-0.1em", opacity: done ? (blink ? 1 : 0) : 1 }} />}
    </span>
  );
};

export const Mono: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: CSSProperties }> = ({ children, size = 26, color = C.slateLight, style }) => (
  <div style={{ fontFamily: FONT_MONO, fontSize: size, fontWeight: 700, letterSpacing: "0.08em", color, ...style }}>{children}</div>
);

// Eased count-up number
export const useCount = (from: number, to: number, start: number, dur: number) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  return from + (to - from) * p;
};

export const fadeInOut = (frame: number, inStart: number, inEnd: number, outStart: number, outEnd: number) =>
  Math.min(interpolate(frame, [inStart, inEnd], [0, 1], clamp), interpolate(frame, [outStart, outEnd], [1, 0], clamp));
