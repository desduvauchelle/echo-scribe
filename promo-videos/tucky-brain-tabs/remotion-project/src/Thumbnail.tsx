import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { FONT_BODY, FONT_DISPLAY } from "./fonts";
import { C } from "./theme";
import { Thought } from "./brain";

// 1280x720 YouTube thumbnail. "tabs": the 61-tabs brain (recommended). "forget": tagline-led A/B variant.
const BUBBLES = [
  { text: "email the accountant", x: 930, y: 110, hl: true }, { text: "SAM.", x: 1180, y: 250, size: 44 }, { text: "oat milk", x: 770, y: 430 },
  { text: "bees… knees?", x: 1140, y: 590 }, { text: "did I reply??", x: 760, y: 610 },
];
export const Thumbnail: React.FC<{ variant?: "tabs" | "forget" }> = ({ variant = "tabs" }) => {
  const headline = variant === "tabs" ? ["My brain has", "61 tabs open."] : ["Say it once.", "Forget it."];
  return (
    <AbsoluteFill style={{ background: `radial-gradient(1100px 700px at 78% 60%, ${C.cream2} 0%, ${C.cream} 55%)`, overflow: "hidden" }}>
      <div style={{ position: "absolute", right: 90, top: 150, width: 560, height: 560, borderRadius: "50%", background: "radial-gradient(circle, #e9ac4255 0%, #e9ac4200 70%)" }} />
      <Img src={staticFile("brand/tucky-mic-t.png")} style={{ position: "absolute", right: 150, bottom: -30, width: 420, filter: "drop-shadow(0 30px 40px rgba(32,51,41,0.25))" }} />
      {BUBBLES.map((b) => <Thought key={b.text} text={b.text} x={b.x} y={b.y} at={-60} size={b.size ?? 32} hl={b.hl} seed={"thumb" + b.text} />)}
      <div style={{ position: "absolute", left: 64, top: 70, fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 104, lineHeight: 0.98, letterSpacing: "-0.045em", color: C.ink, zIndex: 30 }}>
        <div>{headline[0]}</div>
        <div style={{ color: variant === "tabs" ? "#b42318" : C.green2 }}>{headline[1]}</div>
      </div>
      <div style={{ position: "absolute", left: 68, top: 320, fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: variant === "tabs" ? 50 : 58, letterSpacing: "-0.03em", color: C.ink, zIndex: 30 }}>{variant === "tabs" ? "One of them is playing music." : "On purpose."}</div>
      <div style={{ position: "absolute", left: 64, top: 470, display: "inline-flex", alignItems: "center", gap: 16, padding: "18px 30px", borderRadius: 999, background: C.green, color: C.cream, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 36, boxShadow: "0 18px 40px rgba(18,59,45,0.28)", zIndex: 30 }}>
        <div style={{ width: 16, height: 16, borderRadius: "50%", background: C.mint }} />Say it. Tucky files it.
      </div>
      <div style={{ position: "absolute", left: 64, bottom: 44, display: "flex", alignItems: "center", gap: 14, zIndex: 30 }}>
        <Img src={staticFile("brand/tucky.jpeg")} style={{ width: 60, height: 60, borderRadius: 15, boxShadow: "0 10px 24px rgba(32,51,41,0.2)" }} />
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 48, letterSpacing: "-0.04em", color: C.ink }}>Tucky</div>
      </div>
    </AbsoluteFill>
  );
};
