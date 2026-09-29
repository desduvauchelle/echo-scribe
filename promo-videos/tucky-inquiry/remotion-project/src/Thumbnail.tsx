import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { FONT_BODY, FONT_DISPLAY } from "./fonts";
import { C } from "./theme";

// Static 1280x720 YouTube thumbnail. Two variants: "talk" (headline) and "free" (price hook).
export const Thumbnail: React.FC<{ variant?: "talk" | "free" }> = ({ variant = "talk" }) => {
  const headline = variant === "talk" ? ["Typing is", "overrated."] : ["Talk to", "your Mac."];
  const badge = variant === "talk" ? "Free · Private · Mac" : "$0 · No cloud · No account";
  return (
    <AbsoluteFill style={{ background: `radial-gradient(1100px 700px at 78% 60%, ${C.cream2} 0%, ${C.cream} 55%)`, overflow: "hidden" }}>
      {/* soft mint blob behind mascot */}
      <div style={{ position: "absolute", right: 60, top: 90, width: 560, height: 560, borderRadius: "50%", background: `radial-gradient(circle, ${C.mintSoft}66 0%, ${C.mintSoft}00 70%)` }} />
      {/* headline */}
      <div style={{ position: "absolute", left: 72, top: 96, fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 132, lineHeight: 0.98, letterSpacing: "-0.045em", color: C.ink }}>
        <div>{headline[0]}</div>
        <div style={{ color: C.green2 }}>{headline[1]}</div>
      </div>
      <div style={{ position: "absolute", left: 76, top: 392, fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 64, letterSpacing: "-0.03em", color: C.ink }}>Just talk.</div>
      {/* badge */}
      <div style={{ position: "absolute", left: 76, top: 500, display: "inline-flex", alignItems: "center", gap: 16, padding: "18px 30px", borderRadius: 999, background: C.green, color: C.cream, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 36, boxShadow: "0 18px 40px rgba(18,59,45,0.28)" }}>
        <div style={{ width: 16, height: 16, borderRadius: "50%", background: C.mint }} />
        {badge}
      </div>
      {/* listening bars */}
      <div style={{ position: "absolute", left: 76, top: 610, display: "flex", alignItems: "flex-end", gap: 8, height: 44 }}>
        {[14, 30, 44, 22, 38, 16, 28, 40, 18].map((h, i) => <div key={i} style={{ width: 10, height: h, borderRadius: 5, background: i % 3 === 0 ? C.amberSoft : C.mint }} />)}
      </div>
      {/* mascot */}
      <Img src={staticFile("brand/tucky-mic-t.png")} style={{ position: "absolute", right: 72, bottom: -10, width: 520, filter: "drop-shadow(0 30px 40px rgba(32,51,41,0.25))" }} />
      {/* logo chip */}
      <div style={{ position: "absolute", right: 44, top: 40, display: "flex", alignItems: "center", gap: 14 }}>
        <Img src={staticFile("brand/tucky.jpeg")} style={{ width: 64, height: 64, borderRadius: 16, boxShadow: "0 10px 24px rgba(32,51,41,0.2)" }} />
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 52, letterSpacing: "-0.04em", color: C.ink }}>Tucky</div>
      </div>
    </AbsoluteFill>
  );
};
