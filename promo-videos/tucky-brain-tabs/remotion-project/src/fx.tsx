import React, { ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, random, useCurrentFrame, useVideoConfig } from "remotion";
import { clamp } from "./theme";

export const shakeOffset = (frame: number, intensity: number, seed = "shake") => {
  if (intensity <= 0) return { x: 0, y: 0 };
  return { x: (random(`${seed}-x-${frame}`) - 0.5) * 2 * intensity, y: (random(`${seed}-y-${frame}`) - 0.5) * 2 * intensity };
};

// Film grain: small SVG turbulence tile scaled up (cheap), new seed every frame.
export const Grain: React.FC<{ opacity?: number; blend?: string }> = ({ opacity = 0.09, blend = "overlay" }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden", mixBlendMode: blend as any, opacity }}>
      <svg width="480" height="270" style={{ position: "absolute", left: 0, top: 0, transform: "scale(4)", transformOrigin: "0 0" }}>
        <filter id={`grain-${frame}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" seed={frame % 1000} />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="480" height="270" filter={`url(#grain-${frame})`} />
      </svg>
    </AbsoluteFill>
  );
};

export const Vignette: React.FC<{ strength?: number; inner?: number }> = ({ strength = 0.7, inner = 45 }) => (
  <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(ellipse at center, transparent ${inner}%, rgba(0,0,0,${strength}) 100%)` }} />
);

// Cinemascope bars. amount 0..1 (1 = full 2.39:1 bars)
export const Letterbox: React.FC<{ amount: number }> = ({ amount }) => {
  const h = 138 * amount;
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: h, background: "#000", zIndex: 50 }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: h, background: "#000", zIndex: 50 }} />
    </>
  );
};

export const Glow: React.FC<{ x: number; y: number; color: string; size?: number; opacity?: number; drift?: number; seed?: number }> = ({ x, y, color, size = 900, opacity = 0.6, drift = 0, seed = 1 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const dx = drift * Math.sin(t * 0.5 + seed) * 60;
  const dy = drift * Math.cos(t * 0.37 + seed * 2) * 40;
  return (
    <div style={{ position: "absolute", left: x - size / 2 + dx, top: y - size / 2 + dy, width: size, height: size, borderRadius: "50%", background: `radial-gradient(circle, ${color} 0%, transparent 62%)`, opacity, pointerEvents: "none" }} />
  );
};

export const LightSweep: React.FC<{ duration: number; delay?: number; opacity?: number; angle?: number }> = ({ duration, delay = 0, opacity = 0.16, angle = 16 }) => {
  const frame = useCurrentFrame();
  const x = interpolate(frame - delay, [0, duration], [-70, 170], clamp);
  return (
    <AbsoluteFill style={{ overflow: "hidden", pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: "-40%", left: `${x}%`, width: "24%", height: "180%", transform: `rotate(${angle}deg)`, background: `linear-gradient(90deg, transparent, rgba(255,255,255,${opacity}), transparent)` }} />
    </AbsoluteFill>
  );
};

export const Flash: React.FC<{ at: number; color?: string; max?: number; length?: number }> = ({ at, color = "#fff", max = 0.9, length = 10 }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame - at, [0, 2, length], [max, max * 0.5, 0], { ...clamp, easing: Easing.out(Easing.quad) });
  if (frame < at || o <= 0.01) return null;
  return <AbsoluteFill style={{ background: color, opacity: o, pointerEvents: "none", zIndex: 60 }} />;
};

export const CameraPush: React.FC<{ from?: number; to?: number; children: ReactNode; origin?: string }> = ({ from = 1, to = 1.06, children, origin = "50% 50%" }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const s = interpolate(frame, [0, durationInFrames], [from, to], clamp);
  return <AbsoluteFill style={{ transform: `scale(${s})`, transformOrigin: origin }}>{children}</AbsoluteFill>;
};

export const Shake: React.FC<{ intensity: number; seed?: string; children: ReactNode }> = ({ intensity, seed = "s", children }) => {
  const frame = useCurrentFrame();
  const { x, y } = shakeOffset(frame, intensity, seed);
  return <AbsoluteFill style={{ transform: `translate(${x}px, ${y}px)` }}>{children}</AbsoluteFill>;
};

export const SceneFade: React.FC<{ inFrames?: number; outFrames?: number; children: ReactNode }> = ({ inFrames = 8, outFrames = 8, children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const o = Math.min(interpolate(frame, [0, inFrames], [0, 1], clamp), interpolate(frame, [durationInFrames - outFrames, durationInFrames], [1, 0], clamp));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

export const DotGrid: React.FC<{ opacity?: number; color?: string }> = ({ opacity = 0.35, color = "#6D5CF6" }) => (
  <AbsoluteFill style={{ pointerEvents: "none", opacity, backgroundImage: `radial-gradient(${color} 1.4px, transparent 1.6px)`, backgroundSize: "34px 34px", maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)", WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)" }} />
);

export const Dust: React.FC<{ count?: number; color?: string; opacity?: number }> = ({ count = 40, color = "#C4B5FD", opacity = 0.5 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity }}>
      {Array.from({ length: count }).map((_, i) => {
        const sx = random(`dx${i}`) * width, sy = random(`dy${i}`) * height, sp = 6 + random(`ds${i}`) * 18, sz = 1.5 + random(`dz${i}`) * 3;
        const x = sx + Math.sin(t * 0.3 + i) * 30, y = ((sy - t * sp) % height + height) % height;
        const a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 1.7));
        return <div key={i} style={{ position: "absolute", left: x, top: y, width: sz, height: sz, borderRadius: "50%", background: color, opacity: a, boxShadow: `0 0 ${sz * 3}px ${color}` }} />;
      })}
    </AbsoluteFill>
  );
};
