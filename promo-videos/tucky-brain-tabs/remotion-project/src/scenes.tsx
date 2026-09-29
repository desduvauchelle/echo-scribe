import React, { ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, clamp } from "./theme";
import { FONT_BODY, FONT_DISPLAY, FONT_HAND, FONT_MONO } from "./fonts";
import { DotGrid, Glow, LightSweep } from "./fx";
import { Kicker, Typewriter, Words } from "./text";
import { Cursor, ListeningPill, Logo, Mascot, Pop, Toast } from "./ui";
import { Caption, Card, Column, FocusBubble, FocusGroup, MenuBar, PitchDoc, Sticky, Thought, Win } from "./brain";
import { CAP_POP, CUE, FPS, T, sec } from "./timeline";

// Each chapter is mounted in its own <Sequence>, so useCurrentFrame() is 0 at the chapter start.
const rel = (chapterStart: number) => (s: number) => sec(s - chapterStart);

const Bg: React.FC<{ seed?: number; warm?: boolean }> = ({ seed = 1, warm = false }) => (
  <>
    <AbsoluteFill style={{ background: warm ? `linear-gradient(160deg, #fdf3de 0%, ${C.cream} 55%, #eaf3ec 100%)` : `linear-gradient(180deg, ${C.paper} 0%, ${C.cream} 100%)` }} />
    <Glow x={260} y={200} color="#d9efe3" size={1300} opacity={0.8} drift={1} seed={seed} />
    <Glow x={1700} y={950} color="#f6e3c4" size={1300} opacity={0.7} drift={1} seed={seed + 3} />
    <DotGrid opacity={0.12} color="#176b50" />
  </>
);

// Show children between two chapter-relative frames, fading in (no frame reset, cues stay absolute).
const Part: React.FC<{ from: number; to?: number; fade?: number; children: ReactNode }> = ({ from, to = 1e9, fade = 8, children }) => {
  const frame = useCurrentFrame();
  if (frame < from || frame >= to) return null;
  return <AbsoluteFill style={{ opacity: from === 0 ? 1 : interpolate(frame, [from, from + fade], [0, 1], clamp) }}>{children}</AbsoluteFill>;
};

// ---------- the brain's opening repertoire ----------
const OPEN_B = [
  { text: "did I reply to Sam?", x: 330, y: 250, d: 0 },
  { text: "oat milk", x: 1660, y: 330, d: 0.35 },
  { text: "what if bees had knees", x: 440, y: 860, d: 0.7 },
  { text: "is it “affect” or “effect”?", x: 1420, y: 890, d: 1.0 },
  { text: "that thing I said in 2014", x: 1500, y: 610, d: 1.25 },
  { text: "SAM.", x: 870, y: 540, d: 1.5, size: 50 },
];
const EXTRA_B = [
  { text: "renew passport", x: 300, y: 560, d: 0 },
  { text: "text mom back", x: 1640, y: 180, d: 0.2 },
  { text: "why did I walk in here?", x: 700, y: 170, d: 0.4 },
  { text: "the plant looks thirsty", x: 1240, y: 330, d: 0.6 },
  { text: "podcast idea??", x: 960, y: 940, d: 0.8 },
];
const ORBIT = [...OPEN_B, ...EXTRA_B];
// After CUE.orbit every bubble drifts onto a slow elliptical loop around the doc: the thought loop.
const orbitPos = (i: number, base: { x: number; y: number }) => (absT: number) => {
  const k = interpolate(absT, [CUE.orbit, CUE.orbit + 1.4], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const a = (i / ORBIT.length) * Math.PI * 2 + Math.max(0, absT - CUE.orbit) * 0.32;
  const o = { x: 960 + 730 * Math.cos(a), y: 560 + 370 * Math.sin(a) };
  return { x: base.x + (o.x - base.x) * k, y: base.y + (o.y - base.y) * k };
};
const LoopBubbles: React.FC<{ chStart: number; include?: "open" | "all"; hideAt?: number }> = ({ chStart, include = "all", hideAt }) => {
  const r = rel(chStart);
  return (
    <>
      {ORBIT.map((b, i) => {
        if (include === "open" && i >= OPEN_B.length) return null;
        const extra = i >= OPEN_B.length;
        const at = extra ? r(CUE.orbit + b.d) : r(CUE.bubbles + b.d);
        const pos = orbitPos(i, b);
        return <Thought key={b.text} text={b.text} x={b.x} y={b.y} at={at} size={"size" in b ? (b as { size: number }).size : 30} hideAt={hideAt} pos={(f) => pos(f / FPS + chStart)} />;
      })}
    </>
  );
};

const DocShot: React.FC<{ clock: string; body?: ReactNode }> = ({ clock, body }) => (
  <>
    <Bg />
    <MenuBar clock={clock} />
    <div style={{ position: "absolute", left: 370, top: 180 }}><PitchDoc body={body ?? <Cursor color={C.ink} />} /></div>
  </>
);

// ---------- cold open ----------
export const Open: React.FC = () => {
  return (
    <AbsoluteFill>
      <DocShot clock="9:02 AM" />
      <LoopBubbles chStart={T.open} include="open" />
    </AbsoluteFill>
  );
};

// ---------- ch1: the loop + "your system" ----------
const SYS_AT = CUE.sysApps - 1.8;
const APPS = [
  { name: "To-Do", badge: 212, x: 90, y: 70, rot: -3 },
  { name: "Tasks", badge: 88, x: 390, y: 150, rot: 2 },
  { name: "Todo (old)", badge: 1043, x: 170, y: 330, rot: 1 },
  { name: "Get It Done", badge: 7, x: 520, y: 390, rot: -2 },
];
export const Ch1: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = rel(T.ch1);
  const reminders = [0, 2.1, 4.2, 6.3, 8.4].map((d, i) => ({ at: r(CUE.reminder + d), stamp: `reminder #${[4, 9, 14, 22, 31][i]}` }));
  const fall = frame - r(CUE.stickyFall);
  const fallY = fall > 0 ? 0.5 * 2600 * (fall / fps) ** 2 : 0;
  const fallRot = fall > 0 ? Math.min(40, fall * 1.6) : 0;
  const dangle = fall > -24 && fall <= 0 ? Math.sin((fall + 24) * 0.9) * 3 : 0;
  return (
    <AbsoluteFill>
      <Part from={0} to={r(SYS_AT)}>
        <DocShot clock="9:40 AM" />
        <LoopBubbles chStart={T.ch1} hideAt={r(SYS_AT) - 10} />
        {reminders.map((m, i) => (
          <Thought key={i} text="email the accountant" x={960} y={330} at={m.at} hideAt={m.at + sec(1.6)} size={40} hl stamp={m.stamp} seed={`acct${i}`} />
        ))}
      </Part>
      <Part from={r(SYS_AT)} fade={10}>
        <Bg warm seed={4} />
        {/* the monitor */}
        <div style={{ position: "absolute", left: 250, top: 90, width: 1420, height: 860, borderRadius: 34, background: "#1c201d", boxShadow: "0 60px 140px rgba(32,51,41,0.35)", padding: 26 }}>
          <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 14, overflow: "hidden", background: "linear-gradient(135deg, #cfe7da 0%, #f3e6cc 100%)" }}>
            <MenuBar app="Finder" clock="11:15 AM" />
            <div style={{ position: "absolute", left: 40, top: 70, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 22, letterSpacing: "0.16em", color: C.green2, opacity: interpolate(frame, [r(SYS_AT), r(SYS_AT) + 12], [0, 1], clamp) }}>YOUR SYSTEM™</div>
            {APPS.map((a, i) => (
              <Pop key={a.name} start={r(CUE.sysApps) + i * 5} style={{ position: "absolute", left: a.x, top: a.y + 60 }}>
                <div style={{ transform: `rotate(${a.rot}deg)` }}><Win width={380} height={260} title={a.name}>
                  <div style={{ position: "absolute", inset: 0, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
                    {[0.9, 0.7, 0.8, 0.55].map((w, j) => <div key={j} style={{ display: "flex", gap: 12, alignItems: "center" }}><div style={{ width: 20, height: 20, borderRadius: 6, border: "2px solid #d6d1c4" }} /><div style={{ height: 12, width: `${w * 80}%`, borderRadius: 6, background: "#ebe7dc" }} /></div>)}
                  </div>
                  <div style={{ position: "absolute", right: 16, top: -38, minWidth: 40, padding: "4px 12px", borderRadius: 999, background: C.red, color: "#fff", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 20, textAlign: "center" }}>{a.badge}</div>
                </Win></div>
              </Pop>
            ))}
            <Pop start={r(CUE.sysEmail)} style={{ position: "absolute", left: 640, top: 150 }}>
              <Win width={640} height={260} title="Inbox">
                <div style={{ position: "absolute", inset: 0, padding: "18px 26px", fontFamily: FONT_BODY }}>
                  {[{ f: "Me", s: "!!", b: "(no body)", bold: true }, { f: "Me", s: "READ THIS", b: "…", bold: false }, { f: "Me", s: "re: !!", b: "(no body)", bold: false }].map((m, i) => (
                    <div key={i} style={{ display: "flex", gap: 20, padding: "14px 0", borderBottom: "1px solid #efece4", fontSize: 24, fontWeight: m.bold ? 800 : 500, color: C.ink, background: i === 0 ? "#fff7e3" : "transparent" }}>
                      <span style={{ width: 70 }}>{m.f}</span><span style={{ width: 170 }}>{m.s}</span><span style={{ color: C.slateLight, fontWeight: 500 }}>{m.b}</span>
                    </div>
                  ))}
                </div>
              </Win>
            </Pop>
            <Pop start={r(CUE.sysPhoto)} style={{ position: "absolute", left: 930, top: 440 }}>
              <div style={{ transform: "rotate(5deg)", width: 400, padding: "16px 16px 50px", background: "#fff", boxShadow: "0 24px 50px rgba(0,0,0,0.25)" }}>
                <div style={{ height: 250, background: "linear-gradient(160deg, #f6f6f2, #dcdcd4)", position: "relative", fontFamily: FONT_HAND, fontWeight: 700, color: "#2e5aa8", fontSize: 40, padding: 20, lineHeight: 1.05 }}>
                  PLAN??<br /><span style={{ color: "#b42318" }}>→ ask ?? re: thing</span><br />v2 (final) (real)
                </div>
                <div style={{ fontFamily: FONT_HAND, fontSize: 28, color: C.slate, marginTop: 10, fontWeight: 700 }}>whiteboard, march? (blurry)</div>
              </div>
            </Pop>
          </div>
          {/* the sticky note on the bezel */}
          {frame >= r(CUE.sticky) && fallY < 1400 && (
            <Pop start={r(CUE.sticky)} style={{ position: "absolute", right: -40, top: -30 }}>
              <div style={{ transform: `translateY(${fallY}px) rotate(${6 + fallRot + dangle}deg)`, transformOrigin: "50% 0" }}>
                <Sticky text="IMPORTANT" size={230} />
              </div>
            </Pop>
          )}
        </div>
      </Part>
    </AbsoluteFill>
  );
};

// ---------- ch2: hand it off ----------
const BOARD_AT = CUE.cap1 - 1.4;
const CALM_AT = CUE.calm;
const CAPS: { at: number; bubble: string; bx: number; by: number; said: string; col: number; kind: "task" | "note" | "idea"; card: string }[] = [
  { at: CUE.cap1, bubble: "Maya prefers Thursdays", bx: 330, by: 250, said: "Note that Maya prefers Thursdays.", col: 1, kind: "note", card: "Maya prefers Thursdays" },
  { at: CUE.cap2, bubble: "call the dentist", bx: 250, by: 430, said: "Remind me to call the dentist.", col: 2, kind: "task", card: "Call the dentist" },
  { at: CUE.cap3, bubble: "bees with knees: podcast?", bx: 360, by: 600, said: "Save a thought: bees with knees. Podcast?", col: 3, kind: "idea", card: "Bees with knees: a podcast?" },
  { at: CUE.cap4, bubble: "oat milk", bx: 470, by: 760, said: "Add a task: buy oat milk.", col: 2, kind: "task", card: "Buy oat milk" },
];
const FILLER = [
  { text: "renew passport", x: 140, y: 150 }, { text: "text mom back", x: 560, y: 140 }, { text: "why did I walk in here?", x: 330, y: 900 },
  { text: "affect / effect", x: 560, y: 480 }, { text: "that thing in 2014", x: 170, y: 690 },
];
const COLS = [
  { name: "Finance", color: C.amber }, { name: "Website relaunch", color: C.green2 }, { name: "Personal", color: "#e5484d" }, { name: "Ideas", color: "#7c5cff" },
];
export const Ch2: React.FC = () => {
  const frame = useCurrentFrame();
  const r = rel(T.ch2);
  const popF = (s: number) => r(s + CAP_POP);
  const fillerPop = popF(CUE.cap4) + 6;
  return (
    <AbsoluteFill>
      {/* A. the loop, then one key */}
      <Part from={0} to={r(BOARD_AT)}>
        <DocShot clock="11:58 AM" />
        <LoopBubbles chStart={T.ch2} />
        <Thought text="email the accountant" x={960} y={330} at={-20} popAt={r(CUE.loopPop)} size={40} hl stamp="reminder #38" seed="acct-final" />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 60, display: "flex", flexDirection: "column", alignItems: "center", gap: 22, zIndex: 30 }}>
          <Caption text="Tucky, add a task to Finance: email the accountant about Q3." start={r(CUE.pill) + 8} cps={14.5} />
          <ListeningPill start={r(CUE.pill)} stopAt={r(CUE.captionEnd) + 6} label="Listening…" />
        </div>
        {frame < r(CUE.loopPop) + 40 && <div style={{ position: "absolute", right: 48, top: 150, zIndex: 35 }}><Toast start={r(CUE.toast)} title="Created task in ‘Finance’" sub="Email the accountant about Q3" width={560} /></div>}
        <div style={{ position: "absolute", left: 60, bottom: -10, zIndex: 36 }}><Mascot pose="mic" start={r(CUE.loopPop) + 2} width={250} /></div>
      </Part>
      {/* B. rapid fire: say it, pop it, filed */}
      <Part from={r(BOARD_AT)} to={r(CALM_AT)} fade={10}>
        <Bg seed={6} />
        <MenuBar app="Tucky" clock="12:04 PM" />
        <div style={{ position: "absolute", left: 30, top: 70, width: 650, height: 960, borderRadius: 48, background: "rgba(233,172,66,0.08)", border: "2px dashed rgba(199,137,60,0.3)" }} />
        <div style={{ position: "absolute", left: 60, top: 92, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 20, letterSpacing: "0.16em", color: C.amber }}>YOUR HEAD</div>
        {FILLER.map((b, i) => <Thought key={b.text} text={b.text} x={b.x + 30} y={b.y + 30} at={r(BOARD_AT) - 20} popAt={fillerPop + i * 3} size={24} />)}
        {CAPS.map((c) => {
          const hl = frame >= r(c.at);
          return <Thought key={c.bubble} text={c.bubble} x={c.bx} y={c.by} at={r(BOARD_AT) - 20} popAt={popF(c.at)} size={hl ? 34 : 28} hl={hl} />;
        })}
        <div style={{ position: "absolute", left: 710, top: 150, display: "flex", gap: 14 }}>
          {COLS.map((col, ci) => (
            <Column key={col.name} name={col.name} color={col.color} width={284}>
              {ci === 0 && <Card kind="task" text="Email the accountant about Q3" at={-30} />}
              {CAPS.filter((c) => c.col === ci).map((c) => <Card key={c.card} kind={c.kind} text={c.card} at={popF(c.at)} from={{ x: -(760 + ci * 298 - c.bx), y: c.by - 260 }} />)}
            </Column>
          ))}
        </div>
        {CAPS.map((c, i) => {
          const end = i + 1 < CAPS.length ? r(CAPS[i + 1].at) : r(CALM_AT);
          if (frame < r(c.at) || frame >= end) return null;
          return (
            <div key={c.said} style={{ position: "absolute", left: 710, right: 60, bottom: 48, display: "flex", alignItems: "center", gap: 22, zIndex: 30 }}>
              <ListeningPill start={r(c.at)} stopAt={popF(c.at)} label="" scale={0.8} />
              <Caption text={c.said} start={r(c.at) + 3} cps={26} />
            </div>
          );
        })}
      </Part>
      {/* C. calm */}
      <Part from={r(CALM_AT)} fade={10}>
        <DocShot clock="12:10 PM" body={<Typewriter text="Three bets for Q4. One owner each. No new tools." start={r(CALM_AT) + 10} cps={18} cursorColor={C.ink} />} />
        <Thought text="plant?" x={220} y={220} at={r(CALM_AT) - 30} size={22} />
        <div style={{ position: "absolute", right: 70, bottom: -10 }}><Mascot pose="laptop" start={r(CALM_AT) + 12} width={300} /></div>
      </Part>
    </AbsoluteFill>
  );
};

// ---------- ch3: today's focus ----------
const FOCUS_NOTE = "Finish the Q4 pitch. Send the invoice. Nothing else. Really.";
const groups = (doneAll: boolean, checkAt?: number): FocusGroup[] => [
  { project: "Q4 pitch", color: C.green2, tasks: [{ text: "Finish the draft", doneAt: doneAll ? -1 : checkAt }] },
  { project: "Finance", color: C.amber, tasks: [{ text: "Send the Q3 invoice", doneAt: doneAll ? -1 : undefined }, { text: "Email the accountant", doneAt: doneAll ? -1 : undefined }] },
  { project: "Website relaunch", color: "#0ea5e9", tasks: [{ text: "Approve homepage copy", doneAt: doneAll ? -1 : undefined }] },
];
const PET_AT = CUE.pet;
const SPOON_TABS = ["Are spoons just tiny bowls?", "Spork: a cry for help", "Top 10 ladles of 2026"];

const Desk: React.FC<{ clock: string; body: ReactNode; bubble: ReactNode; petStart: number; bounceAt?: number }> = ({ clock, body, bubble, petStart, bounceAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const b = bounceAt !== undefined && frame >= bounceAt ? Math.abs(Math.sin((frame - bounceAt) * 0.45)) * interpolate(frame - bounceAt, [0, 24], [30, 0], clamp) : 0;
  const pb = spring({ frame: frame - petStart, fps, config: { damping: 12, stiffness: 180, mass: 0.8 } });
  return (
    <>
      <Bg warm seed={9} />
      <MenuBar clock={clock} />
      <div style={{ position: "absolute", left: 90, top: 150 }}><PitchDoc width={1080} height={700} body={body} /></div>
      <div style={{ position: "absolute", right: 70, bottom: 300, zIndex: 30, opacity: interpolate(pb, [0, 0.4], [0, 1], clamp), transform: `translateY(${interpolate(pb, [0, 1], [30, 0])}px) scale(${interpolate(pb, [0, 1], [0.85, 1])})`, transformOrigin: "100% 100%" }}>{frame >= petStart && bubble}</div>
      <div style={{ position: "absolute", right: 80, bottom: -6, zIndex: 31, transform: `translateY(${-b}px)` }}><Mascot pose="bag" start={petStart} width={250} /></div>
    </>
  );
};

export const Ch3: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = rel(T.ch3);
  const speaking = frame >= r(CUE.focusSpeak) - 10 && frame < r(CUE.focusTasks);
  const saved = frame >= r(CUE.focusTasks);
  const bIn = spring({ frame: frame - r(CUE.spoon), fps, config: { damping: 16, stiffness: 160, mass: 0.9 } });
  const bOut = interpolate(frame, [r(CUE.spoonClose), r(CUE.spoonClose) + 10], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  const browserY = interpolate(bIn, [0, 1], [900, 0]) + bOut * 1000;
  return (
    <AbsoluteFill>
      {/* A. morning focus */}
      <Part from={0} to={r(PET_AT)}>
        <Bg seed={2} />
        <MenuBar app="Tucky" clock="8:47 AM" />
        <Kicker text="The next morning" color={C.green2} delay={4} size={24} style={{ position: "absolute", left: 140, top: 110 }} />
        <Pop start={6} style={{ position: "absolute", left: 140, top: 180 }}>
          <div style={{ width: 900, padding: "44px 50px", borderRadius: 30, background: C.white, boxShadow: "0 40px 100px rgba(32,51,41,0.18)", border: "1px solid rgba(32,51,41,0.08)", fontFamily: FONT_BODY }}>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.16em", color: C.green2, textTransform: "uppercase" }}>Morning focus</div>
            <div style={{ marginTop: 16, fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: 48, lineHeight: 1.12, letterSpacing: "-0.025em", color: C.ink }}>What are the few things you need to do today to make it successful?</div>
            <div style={{ marginTop: 30, minHeight: 130, padding: "22px 26px", borderRadius: 18, background: "#f7f4ec", fontSize: 30, lineHeight: 1.45, color: C.ink }}>
              {frame < r(CUE.focusSpeak) ? <span style={{ color: C.slateLight }}>Today's priorities…</span> : <Typewriter text={FOCUS_NOTE} start={r(CUE.focusSpeak)} cps={34} cursorColor={C.ink} />}
            </div>
            <div style={{ marginTop: 26, display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 30px", borderRadius: 999, background: speaking ? C.ink : C.green, color: "#fff", fontWeight: 800, fontSize: 24, transform: `scale(${speaking ? 0.97 : 1})` }}>
                {speaking && <span style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 24 }}>{[0, 1, 2, 3].map((i) => <span key={i} style={{ width: 5, borderRadius: 3, background: C.mint, height: 8 + 16 * Math.abs(Math.sin(frame / 4 + i)) }} />)}</span>}
                {saved ? "Saved ✓" : speaking ? "Release to finish" : "Hold to speak"}
              </div>
              <div style={{ fontSize: 20, color: C.slateLight, fontWeight: 600 }}>Or type it here</div>
            </div>
          </div>
        </Pop>
        <Pop start={r(CUE.focusTasks)} style={{ position: "absolute", right: 110, top: 200 }}>
          <div style={{ width: 640, padding: "34px 38px", borderRadius: 30, background: C.white, boxShadow: "0 40px 100px rgba(32,51,41,0.18)", fontFamily: FONT_BODY }}>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.16em", color: C.green2, textTransform: "uppercase", marginBottom: 18 }}>Focus</div>
            {groups(false).map((g, gi) => (
              <Pop key={g.project} start={r(CUE.focusTasks) + 4 + gi * 5} y={10}>
                <div style={{ padding: "14px 0", borderTop: gi ? "1px solid #efece4" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 24, color: C.ink, marginBottom: 8 }}><div style={{ width: 14, height: 14, borderRadius: 4, background: g.color }} />{g.project}</div>
                  {g.tasks.map((t) => <div key={t.text} style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 25, color: C.ink, padding: "5px 0 5px 4px" }}><div style={{ width: 22, height: 22, borderRadius: 7, border: "2px solid #d6d1c4" }} />{t.text}</div>)}
                </div>
              </Pop>
            ))}
          </div>
        </Pop>
      </Part>
      {/* B. the desktop pet keeps it in your face; the spoon relapse */}
      <Part from={r(PET_AT)} fade={10}>
        <Desk
          clock={frame >= r(CUE.spoon) - 12 ? "2:14 PM" : "10:31 AM"}
          body={<span>Three bets for Q4. One owner each. No new tools.<br /><span style={{ color: C.slate }}>Bet one: </span><Cursor color={C.ink} /></span>}
          bubble={<FocusBubble note={FOCUS_NOTE} groups={groups(false, r(CUE.check))} wiggleAt={r(CUE.wiggle)} />}
          petStart={r(PET_AT)}
          bounceAt={r(CUE.wiggle)}
        />
        {frame >= r(CUE.spoon) && bOut < 1 && (
          <div style={{ position: "absolute", left: 130, top: 120, zIndex: 25, transform: `translateY(${browserY}px) rotate(${-1.5 * (1 - bIn)}deg)` }}>
            <Win width={1120} height={760} title="" tabs={
              <div style={{ display: "flex", gap: 6, marginLeft: 14, alignSelf: "flex-end" }}>
                {["The Spoon: A History", ...SPOON_TABS].map((tab, i) => {
                  const show = i === 0 || frame >= r(CUE.spoonMore) + (i - 1) * 7;
                  if (!show) return null;
                  return <div key={tab} style={{ padding: "10px 16px", maxWidth: 230, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", borderRadius: "10px 10px 0 0", background: i === 0 ? "#fff" : "#e6e3da", fontFamily: FONT_BODY, fontSize: 16, fontWeight: 600, color: C.ink }}>🥄 {tab}</div>;
                })}
              </div>
            }>
              <div style={{ position: "absolute", inset: 0, padding: "46px 70px", fontFamily: "Georgia, serif", color: "#202122" }}>
                <div style={{ fontSize: 60, borderBottom: "1px solid #a2a9b1", paddingBottom: 8 }}>Spoon</div>
                <div style={{ fontSize: 20, color: "#54595d", marginTop: 10, fontFamily: FONT_BODY }}>From the Encyclopedia of Kitchen Things</div>
                <div style={{ display: "flex", gap: 40, marginTop: 30 }}>
                  <div style={{ flex: 1, fontSize: 26, lineHeight: 1.55 }}>A <b>spoon</b> is a utensil consisting of a shallow bowl on a handle. It has been used since antiquity, and has been researched in depth at 2:14 PM by people with a deadline.</div>
                  <div style={{ width: 260, height: 300, border: "1px solid #c8ccd1", background: "#f8f9fa", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 140 }}>🥄</div>
                </div>
              </div>
            </Win>
          </div>
        )}
      </Part>
    </AbsoluteFill>
  );
};

// ---------- close ----------
export const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const r = rel(T.close);
  const logo = r(CUE.logo), cta = r(CUE.cta);
  const slam = spring({ frame: frame - logo, fps, config: { damping: 13, stiffness: 240, mass: 0.9 }, durationInFrames: 14 });
  const fadeOut = interpolate(frame, [durationInFrames - 26, durationInFrames], [0, 1], clamp);
  return (
    <AbsoluteFill>
      <Part from={0} to={logo}>
        <Desk
          clock="5:40 PM"
          body={<span>Three bets for Q4. One owner each. No new tools.<br />Bet one: ship the thing we already built.<br />Bet two: …</span>}
          bubble={<FocusBubble note={FOCUS_NOTE} groups={groups(true)} />}
          petStart={-30}
          bounceAt={r(CUE.stovePop)}
        />
        <Thought text="…did I leave the stove on?" x={960} y={470} at={r(CUE.stove)} popAt={r(CUE.stovePop)} size={46} hl seed="stove" />
      </Part>
      <Part from={logo} fade={2}>
        <Bg seed={7} />
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 36, paddingBottom: 60 }}>
          <div style={{ transform: `scale(${interpolate(slam, [0, 1], [1.6, 1])})`, opacity: interpolate(slam, [0, 0.3], [0, 1], clamp) }}><Logo size={150} /></div>
          <Words text="Say it once. Forget it on purpose." delay={logo + 12} size={84} color={C.ink} weight={900} stagger={3} gradientWords={["purpose."]} />
          {frame >= cta && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22, marginTop: 10 }}>
              <Pop start={cta}><div style={{ display: "flex", alignItems: "center", gap: 20 }}><div style={{ padding: "18px 40px", borderRadius: 16, background: C.green, color: C.cream, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 30, boxShadow: "0 20px 50px rgba(18,59,45,0.3)" }}>Get Tucky free</div><div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 28, color: C.ink }}>tucky.ai-juicing.com</div></div></Pop>
              <Pop start={cta + 10}><div style={{ fontFamily: FONT_BODY, fontSize: 22, fontWeight: 700, letterSpacing: "0.12em", color: C.green2, textTransform: "uppercase" }}>Free · Private · On-device AI · macOS</div></Pop>
            </div>
          )}
        </AbsoluteFill>
        <div style={{ position: "absolute", right: 150, bottom: 50 }}><Mascot pose="laptop" start={logo + 6} width={340} /></div>
        <LightSweep duration={100} delay={logo} opacity={0.3} />
      </Part>
      <AbsoluteFill style={{ background: C.cream, opacity: fadeOut, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
