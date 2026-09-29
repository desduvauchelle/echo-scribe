import React from "react";
import { AbsoluteFill } from "remotion";
import { FONT_BODY, FONT_DISPLAY } from "./fonts";
import { C } from "./theme";

// Static 1280x720 YouTube thumbnail. Big two-line headline left, product/mascot visual right, one badge.
// Text must survive at 168 px wide (the mobile feed): keep the headline to ~4 words per line.
export const Thumbnail: React.FC<{ line1?: string; line2?: string; sub?: string; badge?: string }> = ({ line1 = "Headline line", line2 = "in green.", sub = "One short promise.", badge = "Free · Private · Mac" }) => (
  <AbsoluteFill style={{ background: `radial-gradient(1100px 700px at 78% 60%, ${C.cream2} 0%, ${C.cream} 55%)`, overflow: "hidden" }}>
    <div style={{ position: "absolute", left: 72, top: 96, fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 132, lineHeight: 0.98, letterSpacing: "-0.045em", color: C.ink }}>
      <div>{line1}</div>
      <div style={{ color: C.green2 }}>{line2}</div>
    </div>
    <div style={{ position: "absolute", left: 76, top: 392, fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 64, letterSpacing: "-0.03em", color: C.ink }}>{sub}</div>
    <div style={{ position: "absolute", left: 76, top: 500, display: "inline-flex", alignItems: "center", gap: 16, padding: "18px 30px", borderRadius: 999, background: C.green, color: C.cream, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 36, boxShadow: "0 18px 40px rgba(18,59,45,0.28)" }}>
      <div style={{ width: 16, height: 16, borderRadius: "50%", background: C.mint }} />{badge}
    </div>
    {/* Put the product visual here: <Img src={staticFile("brand/hero.png")} style={{ position:"absolute", right:72, bottom:-10, width:520 }} /> */}
  </AbsoluteFill>
);
