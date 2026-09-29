import React, { ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, clamp } from "./theme";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "./fonts";
import { DotGrid, Glow, LightSweep } from "./fx";
import { Typewriter, Words } from "./text";
import { ListeningPill, Logo, Mascot, Pop, Toast } from "./ui";
import { Card, Column, FocusBubble, Win } from "./brain";
import { Cricket, Judges, Key, Marquee, NameCard, Pedestal, ScoreEvent, Stage, Tile } from "./stage";
import { CUE, T, sec } from "./timeline";

const rel = (chapterStart: number) => (s: number) => sec(s - chapterStart);

const Part: React.FC<{ from: number; to?: number; fade?: number; children: ReactNode }> = ({ from, to = 1e9, fade = 8, children }) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  return <AbsoluteFill style={{ opacity: from <= 0 ? 1 : interpolate(frame, [from, from + fade], [0, 1], clamp) }}>{children}</AbsoluteFill>;
};

const Enter: React.FC<{ at: number; from?: "left" | "right" | "top"; children: ReactNode; style?: React.CSSProperties }> = ({ at, from = "left", children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return null;
  const p = spring({ frame: frame - at, fps, config: { damping: 15, stiffness: 140, mass: 0.9 } });
  const d = interpolate(p, [0, 1], [1, 0]);
  const tr = from === "left" ? `translateX(${-700 * d}px)` : from === "right" ? `translateX(${700 * d}px)` : `translateY(${-500 * d}px)`;
  return <div style={{ position: "absolute", transform: tr, ...style }}>{children}</div>;
};

const Doc: React.FC<{ title: string; width?: number; height?: number; children: ReactNode }> = ({ title, width = 720, height = 380, children }) => (
  <Win width={width} height={height} title={title}>
    <div style={{ position: "absolute", inset: 0, padding: "28px 34px", fontFamily: FONT_BODY, fontSize: 30, lineHeight: 1.45, color: C.ink }}>{children}</div>
  </Win>
);

// ---------- cold open: the one good key ----------
export const Open: React.FC = () => {
  const r = rel(T.open);
  return (
    <AbsoluteFill>
      <Stage spotX={960} spotW={420} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 200, display: "flex", justifyContent: "center" }}>
        <Pedestal><Key spinFrom={0} /></Pedestal>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 130, display: "flex", justifyContent: "center", zIndex: 25 }}><Marquee text="THE HOTKEY AUDITION" at={r(CUE.title)} /></div>
      <Judges enterAt={r(CUE.judges)} cat="sleep" brain={[{ text: "is this a meeting?", at: r(CUE.judges) + 14 }]} />
    </AbsoluteFill>
  );
};

// ---------- act 1: Superwhisper ----------
const LINE = "Hey team, the launch is moving to Thursday.";
export const Act1: React.FC = () => {
  const frame = useCurrentFrame();
  const r = rel(T.a1);
  const scores: ScoreEvent[] = [{ at: r(CUE.swScores), judge: 0, value: "8" }, { at: r(CUE.swScores) + 4, judge: 1, value: "7" }, { at: r(CUE.swScores) + 8, judge: 2, value: "💤" }];
  return (
    <AbsoluteFill>
      <Stage spotX={700} spotW={420} />
      <NameCard n={1} name="Superwhisper" at={r(CUE.swName)} style={{ left: 290, top: 130 }} />
      <Enter at={r(CUE.sw)} from="left" style={{ left: 560, top: 300 }}><Tile who="sw" size={280} name={false} bowAt={[r(CUE.swBow), r(CUE.swAgain) + 50]} /></Enter>
      {frame >= r(CUE.swTalk) && <div style={{ position: "absolute", left: 575, top: 620, zIndex: 26 }}><ListeningPill start={r(CUE.swTalk)} stopAt={r(CUE.swText) + 8} label="" scale={0.9} /></div>}
      <Pop start={r(CUE.swTalk)} style={{ position: "absolute", left: 980, top: 190 }}>
        <Doc title="Notes">
          <Typewriter text={LINE} start={r(CUE.swText)} cps={30} cursorColor={C.ink} />
          {frame >= r(CUE.swAgain) && <div style={{ marginTop: 14 }}><Typewriter text={LINE} start={r(CUE.swAgain)} cps={40} cursorColor={C.ink} /></div>}
        </Doc>
      </Pop>
      <Cricket at={r(CUE.swBow) + 8} x={1300} />
      <Judges cat="sleep" scores={scores} brain={[{ text: "…and?", at: r(CUE.swAnd), hideAt: r(CUE.swAgain) + 20 }]} />
    </AbsoluteFill>
  );
};

// ---------- act 2: Wispr Flow ----------
export const Act2: React.FC = () => {
  const frame = useCurrentFrame();
  const r = rel(T.a2);
  const scores: ScoreEvent[] = [{ at: r(CUE.wfScores), judge: 0, value: "8" }, { at: r(CUE.wfScores) + 4, judge: 1, value: "8" }, { at: r(CUE.wfScores) + 8, judge: 2, value: "💤" }];
  const skate = Math.sin(frame / 7) * interpolate(frame, [r(CUE.wf), r(CUE.wf) + 30], [8, 0], clamp);
  return (
    <AbsoluteFill>
      <Stage spotX={700} spotW={420} />
      <NameCard n={2} name="Wispr Flow" at={r(CUE.wfName)} style={{ left: 290, top: 130 }} />
      <Enter at={r(CUE.wf)} from="right" style={{ left: 560, top: 300, rotate: `${skate}deg` }}><Tile who="wf" size={280} name={false} bowAt={[r(CUE.wfBow)]} /></Enter>
      {frame >= r(CUE.wfTalk) && <div style={{ position: "absolute", left: 575, top: 620, zIndex: 26 }}><ListeningPill start={r(CUE.wfTalk)} stopAt={r(CUE.wfApps) + 20} label="" scale={0.9} /></div>}
      <Pop start={r(CUE.wfTalk)} style={{ position: "absolute", left: 960, top: 160 }}>
        <Doc title="Mail: New message" width={740} height={330}>
          <div style={{ fontSize: 20, color: C.slateLight, marginBottom: 10 }}>To: <span style={{ color: C.ink }}>sam@northwind.co</span></div>
          <Typewriter text="Hi Sam, quick update: the launch is moving to Thursday." start={r(CUE.wfText)} cps={32} cursorColor={C.ink} />
        </Doc>
      </Pop>
      <Pop start={r(CUE.wfApps)} style={{ position: "absolute", left: 1010, top: 520 }}>
        <Doc title="#launch" width={380} height={170}><span style={{ fontSize: 24 }}>Launch moves to Thursday 🎉</span></Doc>
      </Pop>
      <Pop start={r(CUE.wfApps) + 8} style={{ position: "absolute", left: 1330, top: 560 }}>
        <Doc title="Notes" width={360} height={150}><span style={{ fontSize: 24 }}>Launch → Thursday</span></Doc>
      </Pop>
      <Cricket at={r(CUE.wfBow) + 6} x={1260} />
      <Cricket at={r(CUE.wfBow) + 30} x={380} />
      <Judges cat={frame >= r(CUE.catEye) && frame < r(CUE.catEye) + 40 ? "eye" : "sleep"} scores={scores} brain={[{ text: "so… same thing?", at: r(CUE.wfSame), hideAt: r(CUE.wfScores) }]} />
    </AbsoluteFill>
  );
};

// ---------- act 3: Tucky doesn't bow ----------
const SCREEN = { left: 620, top: 128, w: 880, h: 530 };
const Screen: React.FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div style={{ position: "absolute", left: SCREEN.left, top: SCREEN.top, width: SCREEN.w, height: SCREEN.h, borderRadius: 26, background: `linear-gradient(180deg, ${C.paper} 0%, ${C.cream} 100%)`, boxShadow: "0 40px 100px rgba(0,0,0,0.6)", border: "4px solid #d4a64a", overflow: "hidden" }}>
    <DotGrid opacity={0.1} color="#176b50" />
    <div style={{ position: "absolute", left: 28, top: 22, display: "flex", alignItems: "center", gap: 10, fontFamily: FONT_MONO, fontWeight: 700, fontSize: 18, letterSpacing: "0.16em", color: C.green2 }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.mint }} />{label.toUpperCase()}
    </div>
    <div style={{ position: "absolute", inset: 0, top: 60 }}>{children}</div>
  </div>
);

const RAMBLE = "ok so the launch is thursday, um, tell sam, and the deck needs like one more pass";
export const Act3: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = rel(T.a3);
  const walk = spring({ frame: frame - r(CUE.tucky), fps, config: { damping: 18, stiffness: 60, mass: 1 } });
  const steps = walk < 0.98 ? Math.abs(Math.sin(frame / 3)) * 12 : 0;
  const scores: ScoreEvent[] = [
    { at: r(CUE.score1), judge: 0, value: "9" }, { at: r(CUE.score2), judge: 1, value: "10" },
    { at: r(CUE.overflow), judge: 0, value: "10" }, { at: r(CUE.overflow) + 4, judge: 1, value: "11" }, { at: r(CUE.overflow) + 8, judge: 2, value: "∞" },
  ];
  const cat = frame >= r(CUE.ovation) ? "ovation" : frame >= r(CUE.catWake) ? "awake" : "sleep";
  const seg = (a: number, b: number) => frame >= r(a) && frame < r(b);
  const curtainY = interpolate(frame, [r(CUE.curtain), r(CUE.curtain) + 16], [-690, 0], { ...clamp, easing: Easing.in(Easing.quad) });
  return (
    <AbsoluteFill>
      <Stage spotX={400} spotW={380} />
      <NameCard n={3} name="Tucky" at={r(CUE.tucky) + 20} style={{ left: 290, top: 130 }} />
      {/* the other two, still bowing at the edge of the stage */}
      <div style={{ position: "absolute", left: 1540, top: 300, display: "flex", flexDirection: "column", gap: 30, opacity: interpolate(frame, [r(CUE.tucky) + 30, r(CUE.tucky) + 45], [0, 0.9], clamp) }}>
        <Tile who="sw" size={110} loopBow />
        <Tile who="wf" size={110} loopBow />
      </div>
      {frame >= r(CUE.curtain) && <div style={{ position: "absolute", left: 1510, top: 96, width: 200, height: 690, overflow: "hidden", zIndex: 5 }}><div style={{ width: "100%", height: "100%", transform: `translateY(${curtainY}px)`, background: "repeating-linear-gradient(90deg, #7a0f1c 0px, #a3182b 18px, #c42a3c 28px, #a3182b 38px, #7a0f1c 56px)" }} /></div>}
      {/* Tucky walks on */}
      <div style={{ position: "absolute", left: 240, top: 330, transform: `translateX(${interpolate(walk, [0, 1], [-520, 0])}px) translateY(${-steps}px)`, zIndex: 12 }}>
        <Mascot pose="mic" start={r(CUE.tucky)} width={320} bounce={walk >= 0.98} />
      </div>
      {/* the stage screen: one capability after another */}
      {frame >= r(CUE.tDictate) - 6 && (
        <Pop start={r(CUE.tDictate) - 6} y={30}>
          {seg(CUE.tDictate - 1, CUE.tEmail) && <Screen label="Dictation"><div style={{ padding: "20px 40px", fontFamily: FONT_BODY, fontSize: 34, lineHeight: 1.5, color: C.ink }}><Typewriter text={RAMBLE} start={r(CUE.tDictate)} cps={40} cursorColor={C.ink} /></div></Screen>}
          {seg(CUE.tEmail, CUE.tTask) && <Screen label="“Tucky, make this an email”">
            <div style={{ padding: "16px 40px", fontFamily: FONT_BODY, fontSize: 30, lineHeight: 1.5, color: C.ink }}>
              <Words text="Hi Sam," delay={r(CUE.tEmail)} size={30} color={C.ink} weight={600} align="left" family={FONT_BODY} stagger={2} />
              <div style={{ height: 14 }} />
              <Words text="Quick update: the launch moves to Thursday. The deck needs one more pass before then." delay={r(CUE.tEmail) + 6} size={30} color={C.ink} weight={500} align="left" family={FONT_BODY} stagger={1} lineHeight={1.4} />
              <div style={{ height: 14 }} />
              <Words text="Thanks," delay={r(CUE.tEmail) + 22} size={30} color={C.ink} weight={500} align="left" family={FONT_BODY} stagger={2} />
            </div>
          </Screen>}
          {seg(CUE.tTask, CUE.tMeet) && <Screen label="“Tucky, add a task to Finance…”">
            <div style={{ position: "absolute", left: 30, top: 10, display: "flex", gap: 14, transform: "scale(0.86)", transformOrigin: "0 0" }}>
              <Column name="Finance" color={C.amber} width={300}><Card kind="task" text="Email the accountant about Q3" at={r(CUE.tFile)} from={{ x: 0, y: -120 }} /></Column>
              <Column name="Website relaunch" color={C.green2} width={300}><Card kind="note" text="Maya prefers Thursdays" at={-30} /></Column>
              <Column name="Ideas" color="#7c5cff" width={300}><Card kind="idea" text="Bees with knees: a podcast?" at={-30} /></Column>
            </div>
            <div style={{ position: "absolute", right: 26, bottom: 26 }}><Toast start={r(CUE.tTask)} title="Created task in ‘Finance’" sub="Email the accountant about Q3" width={440} /></div>
          </Screen>}
          {seg(CUE.tMeet, CUE.tAsk) && <Screen label="Meeting">
            <div style={{ position: "absolute", left: 30, top: 10, display: "flex", gap: 14 }}>
              {[["SK", "#176b50"], ["MR", "#c7893c"]].map(([n, c]) => <div key={n} style={{ width: 190, height: 140, borderRadius: 16, background: "#1f2621", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ width: 70, height: 70, borderRadius: "50%", background: c, color: "#fff", fontFamily: FONT_BODY, fontWeight: 800, fontSize: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</div></div>)}
            </div>
            <div style={{ position: "absolute", left: 30, top: 170, width: 394, display: "flex", flexDirection: "column", gap: 8, fontFamily: FONT_BODY, fontSize: 20, color: C.ink }}>
              {["Sam: so Thursday works for launch?", "You: yes, if the deck's ready.", "Sam: I'll take one more pass."].map((l, i) => <Pop key={l} start={r(CUE.tMeet) + 6 + i * 12} y={8}><div style={{ padding: "8px 12px", borderRadius: 10, background: "#fff" }}>{l}</div></Pop>)}
            </div>
            <Pop start={r(CUE.tMeetCard)} style={{ position: "absolute", right: 26, top: 10 }}>
              <div style={{ width: 400, padding: "20px 24px", borderRadius: 18, background: "#fff", boxShadow: "0 20px 50px rgba(32,51,41,0.18)", fontFamily: FONT_BODY, color: C.ink }}>
                <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.14em", color: C.green2 }}>MEETING SUMMARY</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 10 }}>Decision</div>
                <div style={{ fontSize: 20 }}>Launch moves to Thursday.</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 12 }}>Follow-ups</div>
                <div style={{ fontSize: 20 }}>Sam: one more pass on the deck</div>
                <div style={{ fontSize: 20 }}>You: send the Q3 invoice</div>
              </div>
            </Pop>
          </Screen>}
          {seg(CUE.tAsk, CUE.tFocus) && <Screen label="Ask">
            <div style={{ padding: "20px 40px", fontFamily: FONT_BODY, color: C.ink }}>
              <div style={{ padding: "18px 24px", borderRadius: 16, background: "#fff", border: "2px solid rgba(23,107,80,0.2)", fontSize: 28 }}><Typewriter text="What did we decide on pricing with Acme?" start={r(CUE.tAsk) + 4} cps={36} cursorColor={C.ink} /></div>
              <Pop start={r(CUE.tAnswer)} y={14}>
                <div style={{ marginTop: 20, padding: "20px 24px", borderRadius: 16, background: C.mintPale, fontSize: 26, lineHeight: 1.45 }}>
                  Annual plan at the current price, with a pilot for the first month.
                  <div style={{ marginTop: 12, display: "inline-flex", gap: 10, padding: "6px 14px", borderRadius: 999, background: "#fff", fontSize: 18, fontWeight: 700, color: C.green2 }}>Source: Acme call · 3 weeks ago</div>
                </div>
              </Pop>
            </div>
          </Screen>}
          {seg(CUE.tFocus, CUE.tRecap) && <Screen label="Today's focus"><div style={{ position: "absolute", left: 180, top: 0, transform: "scale(0.9)", transformOrigin: "0 0" }}><FocusBubble note="Finish the Q4 pitch. Send the invoice. Nothing else." groups={[{ project: "Q4 pitch", color: C.green2, tasks: [{ text: "Finish the draft" }] }, { project: "Finance", color: C.amber, tasks: [{ text: "Send the Q3 invoice" }] }]} /></div></Screen>}
          {seg(CUE.tRecap, CUE.tScreen) && <Screen label="Morning recap">
            <div style={{ padding: "10px 40px", display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT_BODY, color: C.ink }}>
              {[["What happened", "2 meetings, 9 notes, 4 tasks done"], ["What matters", "Launch Thursday. Deck needs a pass."], ["What's next", "Send the Q3 invoice"]].map(([h, b], i) => (
                <Pop key={h} start={r(CUE.tRecap) + i * 5} y={10}><div style={{ padding: "16px 22px", borderRadius: 16, background: "#fff" }}><div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.12em", color: C.green2, textTransform: "uppercase" }}>{h}</div><div style={{ fontSize: 26, marginTop: 4 }}>{b}</div></div></Pop>
              ))}
            </div>
          </Screen>}
          {frame >= r(CUE.tScreen) && <Screen label="Screen recording">
            <div style={{ position: "absolute", left: 40, top: 10, width: 800, height: 420, borderRadius: 16, background: "linear-gradient(135deg, #cfe7da 0%, #f3e6cc 100%)" }}>
              <div style={{ position: "absolute", left: 40, top: 40 }}><Win width={520} height={300} title="Q4 pitch — Docs"><div style={{ padding: 30, fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 44, color: C.ink }}>Q4 pitch</div></Win></div>
              <div style={{ position: "absolute", right: 30, bottom: 30, width: 150, height: 150, borderRadius: "50%", overflow: "hidden", border: "5px solid #fff", background: C.mintPale }}><div style={{ marginTop: 10, marginLeft: 12 }}><Mascot pose="mic" start={r(CUE.tScreen) - 30} width={120} bounce={false} /></div></div>
              <div style={{ position: "absolute", left: 20, top: 16, display: "flex", alignItems: "center", gap: 8, fontFamily: FONT_MONO, fontWeight: 700, fontSize: 18, color: "#b42318" }}><div style={{ width: 14, height: 14, borderRadius: "50%", background: "#e5484d", opacity: Math.floor(frame / 12) % 2 ? 1 : 0.3 }} />REC</div>
            </div>
          </Screen>}
        </Pop>
      )}
      <Judges cat={cat} scores={scores} brain={[{ text: "email the accountant", at: -20, popAt: r(CUE.brainPop) }]} />
    </AbsoluteFill>
  );
};

// ---------- close ----------
const CHIPS = [
  { t: "Voice", x: 420, y: 300 }, { t: "Notes", x: 1500, y: 300 }, { t: "Tasks", x: 380, y: 520 }, { t: "Meetings", x: 1540, y: 520 }, { t: "A memory that answers back", x: 960, y: 900 },
];
export const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const r = rel(T.close);
  const logo = r(CUE.logo), cta = r(CUE.cta);
  const slam = spring({ frame: frame - logo, fps, config: { damping: 13, stiffness: 240, mass: 0.9 }, durationInFrames: 14 });
  const fadeOut = interpolate(frame, [durationInFrames - 26, durationInFrames], [0, 1], clamp);
  const chipAt = [2.0, 2.5, 3.0, 3.5, 4.6].map((d) => r(CUE.press + 0.4 + d));
  return (
    <AbsoluteFill>
      <Part from={0} to={logo}>
        <Stage spotX={960} spotW={420} />
        <div style={{ position: "absolute", left: 0, right: 0, top: 170, display: "flex", justifyContent: "center" }}>
          <Pedestal><Key pressAt={r(CUE.press)} /></Pedestal>
        </div>
        {frame >= r(CUE.press) + 4 && <div style={{ position: "absolute", left: 0, right: 0, top: 740, display: "flex", justifyContent: "center", zIndex: 20 }}><ListeningPill start={r(CUE.press) + 4} label="Listening…" /></div>}
        {CHIPS.map((c, i) => (
          <div key={c.t} style={{ position: "absolute", left: c.x, top: c.y, transform: "translate(-50%, -50%)", zIndex: 21 }}><Pop start={chipAt[i]}>
            <div style={{ padding: "16px 30px", borderRadius: 999, background: "#fff4dc", color: "#1c1317", fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 40, boxShadow: "0 20px 40px rgba(0,0,0,0.5)", whiteSpace: "nowrap", border: "3px solid #d4a64a" }}>{c.t}</div>
          </Pop></div>
        ))}
      </Part>
      <Part from={logo} fade={2}>
        <AbsoluteFill style={{ background: `linear-gradient(180deg, ${C.paper} 0%, ${C.cream} 100%)` }} />
        <Glow x={260} y={200} color="#d9efe3" size={1300} opacity={0.8} drift={1} seed={3} />
        <Glow x={1700} y={950} color="#f6e3c4" size={1300} opacity={0.7} drift={1} seed={6} />
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 36, paddingBottom: 60 }}>
          <div style={{ transform: `scale(${interpolate(slam, [0, 1], [1.6, 1])})`, opacity: interpolate(slam, [0, 0.3], [0, 1], clamp) }}><Logo size={150} /></div>
          <Words text="It starts with one key." delay={logo + 12} size={84} color={C.ink} weight={900} stagger={3} gradientWords={["key."]} />
          {frame >= cta && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22, marginTop: 10 }}>
              <Pop start={cta}><div style={{ display: "flex", alignItems: "center", gap: 20 }}><div style={{ padding: "18px 40px", borderRadius: 16, background: C.green, color: C.cream, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 30, boxShadow: "0 20px 50px rgba(18,59,45,0.3)" }}>Get Tucky free</div><div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 28, color: C.ink }}>tucky.ai-juicing.com</div></div></Pop>
              <Pop start={cta + 10}><div style={{ fontFamily: FONT_BODY, fontSize: 22, fontWeight: 700, letterSpacing: "0.12em", color: C.green2, textTransform: "uppercase" }}>Free · Private · On-device AI · macOS</div></Pop>
            </div>
          )}
        </AbsoluteFill>
        <div style={{ position: "absolute", right: 150, bottom: 50 }}><Mascot pose="mic" start={logo + 6} width={320} /></div>
        <LightSweep duration={100} delay={logo} opacity={0.3} />
      </Part>
      <AbsoluteFill style={{ background: C.cream, opacity: fadeOut, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
