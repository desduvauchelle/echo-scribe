import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, clamp } from "./theme";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "./fonts";
import { CameraPush, DotGrid, Dust, Glow, LightSweep, Vignette, shakeOffset } from "./fx";
import { Kicker, Typewriter, Words } from "./text";
import { AppWindow, Bullet, CaptureRow, Cursor, DayStamp, GuideItem, Hesitation, ListeningPill, Logo, MacWindow, Mascot, Pop, PromptBox, Toast } from "./ui";
import { CUE, T, sec } from "./timeline";

const Bg: React.FC<{ seed?: number }> = ({ seed = 1 }) => (
  <>
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${C.paper} 0%, ${C.cream} 100%)` }} />
    <Glow x={260} y={200} color="#d9efe3" size={1300} opacity={0.8} drift={1} seed={seed} />
    <Glow x={1700} y={950} color="#f6e3c4" size={1300} opacity={0.7} drift={1} seed={seed + 3} />
    <DotGrid opacity={0.14} color="#176b50" />
  </>
);

const DarkBg: React.FC = () => (
  <>
    <AbsoluteFill style={{ background: C.bgDark }} />
    <Glow x={960} y={1150} color="#14392b" size={1800} opacity={0.7} drift={1} />
    <Glow x={300} y={150} color="#0f2a20" size={1200} opacity={0.7} />
    <Dust count={30} opacity={0.3} color="#8fe0ba" />
  </>
);

const Keycap: React.FC<{ at: number; label?: string; x: number; y: number }> = ({ at, label = "^ Space", x, y }) => {
  const frame = useCurrentFrame();
  const press = frame >= at && frame < at + 8 ? 0.92 : 1;
  const o = interpolate(frame, [at - 14, at - 4], [0, 1], clamp);
  if (frame < at - 14) return null;
  return <div style={{ position: "absolute", left: x, top: y, padding: "18px 34px", borderRadius: 18, background: "#1a201c", color: "#fff", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 30, boxShadow: press < 1 ? "0 2px 0 #000" : "0 10px 0 #000, 0 24px 40px rgba(0,0,0,0.4)", transform: `scale(${press}) translateY(${press < 1 ? 8 : 0}px)`, opacity: o, border: "1px solid rgba(255,255,255,0.15)" }}>{label}</div>;
};

// ================= CHAPTER 1 · "What if I just… talked?" (dark) =================
export const Ch1: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = (s: number) => sec(s - T.ch1);
  const hot = r(CUE.hotkey1), land = r(CUE.land1), sentAt = r(11.6);
  const sent = frame >= sentAt;
  const lift = spring({ frame: frame - sentAt, fps, config: { damping: 14, stiffness: 120 } });
  const zoomOut = interpolate(frame, [r(12.8), r(15)], [1, 0.94], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const fade = interpolate(frame, [r(14.4), r(15)], [1, 0], clamp);
  const prompt = "Sam, let's move the launch to Friday. Two reasons: the export pipeline lands Thursday, and it gives support a full day. Can you confirm by tonight?";
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <DarkBg />
      <AbsoluteFill style={{ transform: `scale(${zoomOut})` }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, display: "flex", justifyContent: "center" }}>
          <div style={{ fontFamily: FONT_BODY, fontSize: 22, fontWeight: 600, color: "rgba(255,255,255,0.45)", letterSpacing: "0.02em", opacity: interpolate(frame, [0, 20], [0, 1], clamp), display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 20 }}>✦</span>AI assistant</div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 40, transform: `translateY(${-lift * 40}px)` }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 44, fontWeight: 700, color: "rgba(255,255,255,0.85)", opacity: interpolate(frame, [4, 24], [0, 1], clamp) }}>What are you working on?</div>
          <PromptBox width={1040} brand="gpt" placeholder="" sent={sent}>
            {frame < hot ? (
              <Hesitation text="Write a message to Sam about moving the launch" start={r(1.1)} cps={13} deleteAt={r(2.7)} deleteCount={12} color="#ececec" />
            ) : frame < land ? (
              <span><Cursor color="#8fe0ba" /></span>
            ) : (
              <span style={{ color: sent ? "#8fe0ba" : "#ececec" }}><Typewriter text={prompt} start={land} cps={60} cursorColor="#8fe0ba" /></span>
            )}
          </PromptBox>
          {frame >= hot && frame < land + 4 && <ListeningPill start={hot} stopAt={land - 2} />}
        </div>
        {frame >= sentAt + 6 && (
          <div style={{ position: "absolute", left: 0, right: 0, top: 640, display: "flex", justifyContent: "center", opacity: interpolate(frame, [sentAt + 6, sentAt + 20], [0, 1], clamp) }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "12px 22px", borderRadius: 999, background: "rgba(143,224,186,0.12)", color: "#8fe0ba", fontFamily: FONT_BODY, fontWeight: 700, fontSize: 22 }}><svg width="20" height="20" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" stroke="#8fe0ba" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>Sent · 31 words · 0 typed</div>
          </div>
        )}
      </AbsoluteFill>
      <Vignette strength={0.85} inner={35} />
    </AbsoluteFill>
  );
};

// ================= CHAPTER 2 · "Why am I still typing?" =================
export const Ch2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = (s: number) => sec(s - T.ch2);
  const d1 = r(CUE.day1), d2 = r(CUE.day2), d3 = r(CUE.day3), d7 = r(CUE.day7), ramble = r(CUE.ramble), trig = r(CUE.trigger), ref = r(CUE.reformat), click = r(CUE.click);
  const phase = frame < d2 ? 1 : frame < d3 ? 2 : frame < d7 ? 3 : frame < ramble ? 7 : frame < click ? 8 : 9;
  const words = Math.round(interpolate(frame, [d7, d7 + 150], [0, 4120], { ...clamp, easing: Easing.out(Easing.cubic) }));
  const rawText = "ok so um tell sam the launch is friday because the export thing lands thursday and uh also support gets a full day, ask him to confirm tonight";
  const email = "Hi Sam,\n\nLet's move the launch to Friday. The export pipeline lands Thursday, and support gets a full day.\n\nCan you confirm tonight?\n\nThanks,\nAlex";
  const clickP = spring({ frame: frame - click, fps, config: { damping: 12, stiffness: 200 } });
  const blur = frame >= click ? interpolate(clickP, [0, 1], [0, 10]) : 0;
  const fadeIn = interpolate(frame, [0, 12], [0, 1], clamp);
  const win = (kind: "gmail" | "slack" | "code" | "claude" | "notes", at: number, x: number, y: number, w: number, h: number, text: string, pillAt: number, landAt: number, cps = 50) => (
    <div key={kind + at} style={{ position: "absolute", left: x, top: y }}>
      <Pop start={at} from={0.94} y={30}>
        <AppWindow kind={kind} width={w} height={h}>
          {frame >= landAt ? <Typewriter text={text} start={landAt} cps={cps} cursorColor={C.mint} /> : <Cursor color={kind === "code" ? "#d4d4d4" : C.ink} />}
        </AppWindow>
      </Pop>
      {frame >= pillAt && frame < landAt + 2 && <div style={{ position: "absolute", left: w / 2 - 250, top: h - 60 }}><ListeningPill start={pillAt} scale={0.8} stopAt={landAt - 2} /></div>}
    </div>
  );
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <Bg seed={2} />
      <AbsoluteFill style={{ filter: blur ? `blur(${blur}px)` : undefined }}>
        <CameraPush from={1} to={1.03}>
          {/* Day 1 */}
          {phase === 1 && (
            <>
              <DayStamp label="DAY 1" at={d1} />
              <div style={{ position: "absolute", left: 300, top: 300, width: 1320 }}>
                <Pop start={d1 + 2} from={0.95} y={30}>
                  <div style={{ fontFamily: FONT_DISPLAY, fontSize: 40, fontWeight: 700, color: C.ink, marginBottom: 26, textAlign: "center" }}>What are you working on?</div>
                  <PromptBox width={1320} brand="claude" placeholder="">
                    {frame >= d1 + 48 ? <Typewriter text="Draft three subject lines for the launch email. Keep them under eight words." start={d1 + 48} cps={55} cursorColor={C.mint} /> : <Cursor color={C.ink} />}
                  </PromptBox>
                </Pop>
              </div>
              {frame >= d1 + 18 && <div style={{ position: "absolute", left: 640, top: 640 }}><ListeningPill start={d1 + 18} stopAt={d1 + 46} /></div>}
              <div style={{ position: "absolute", left: 0, right: 0, top: 880, display: "flex", justifyContent: "center", opacity: interpolate(frame, [d1 + 30, d1 + 44], [0, 1], clamp) }}><div style={{ fontFamily: FONT_BODY, fontSize: 28, fontStyle: "italic", color: C.slate }}>talking to your laptop. out loud. in a café.</div></div>
            </>
          )}
          {/* Day 2 — hesitates, types, then presses the key */}
          {phase === 2 && (
            <>
              <DayStamp label="DAY 2" at={d2} />
              <div style={{ position: "absolute", left: 360, top: 260 }}>
                <Pop start={d2 + 2} from={0.95} y={30}>
                  <AppWindow kind="slack" width={1200} height={520}>
                    {frame < d2 + 52 ? <Hesitation text="hey team, quick update on the" start={d2 + 8} cps={20} deleteAt={d2 + 52} deleteCount={0} /> : <span>hey team, quick update on the <Typewriter text="launch: we're moving to Friday so the export pipeline lands first. Support gets a full day." start={d2 + 52} cps={80} cursorColor={C.mint} /></span>}
                  </AppWindow>
                </Pop>
              </div>
              {frame >= d2 + 38 && frame < d2 + 56 && <div style={{ position: "absolute", left: 640, top: 700 }}><ListeningPill start={d2 + 38} stopAt={d2 + 52} /></div>}
              <div style={{ position: "absolute", left: 0, right: 0, top: 880, display: "flex", justifyContent: "center", opacity: interpolate(frame, [d2 + 14, d2 + 26], [0, 1], clamp) }}><div style={{ fontFamily: FONT_BODY, fontSize: 28, fontStyle: "italic", color: C.slate }}>{frame < d2 + 38 ? "…you forget, and type." : "…oh right."}</div></div>
            </>
          )}
          {/* Day 3 — key first */}
          {phase === 3 && (
            <>
              <DayStamp label="DAY 3" at={d3} />
              <div style={{ position: "absolute", left: 360, top: 240 }}>
                <Pop start={d3 + 2} from={0.95} y={30}>
                  <AppWindow kind="gmail" width={1200} height={560}>
                    {frame >= d3 + 30 ? <Typewriter text="Hi Sam, quick one before your flight: the launch moves to Friday. Export pipeline lands Thursday, support gets a full day. Shout if that breaks anything on your side." start={d3 + 30} cps={70} cursorColor={C.mint} /> : <Cursor color={C.ink} />}
                  </AppWindow>
                </Pop>
              </div>
              {frame >= d3 + 8 && frame < d3 + 34 && <div style={{ position: "absolute", left: 640, top: 720 }}><ListeningPill start={d3 + 8} stopAt={d3 + 30} /></div>}
              <div style={{ position: "absolute", left: 0, right: 0, top: 900, display: "flex", justifyContent: "center", opacity: interpolate(frame, [d3 + 40, d3 + 54], [0, 1], clamp) }}><div style={{ fontFamily: FONT_BODY, fontSize: 28, fontStyle: "italic", color: C.slate }}>…before you've decided to.</div></div>
            </>
          )}
          {/* Day 7 — everything */}
          {phase === 7 && (
            <>
              <DayStamp label="DAY 7" at={d7} />
              <div style={{ position: "absolute", right: 120, top: 62, fontFamily: FONT_MONO, fontSize: 26, fontWeight: 700, color: C.green2, letterSpacing: "0.06em", opacity: interpolate(frame, [d7 + 10, d7 + 24], [0, 1], clamp) }}>{words.toLocaleString("en-US")} words today · <span style={{ color: C.amber }}>0 typed</span></div>
              {win("gmail", d7 + 6, 120, 150, 820, 380, "Hi Sam, moving the launch to Friday. Export lands Thursday, support gets a day.", d7 + 12, d7 + 30, 60)}
              {win("claude", d7 + 42, 980, 150, 820, 380, "Rewrite this paragraph so a first-time reader gets it in one pass.", d7 + 48, d7 + 66, 60)}
              {win("code", d7 + 78, 120, 570, 820, 380, "// TODO: retry the webhook with exponential backoff, cap at five attempts", d7 + 84, d7 + 102, 60)}
              {win("slack", d7 + 114, 980, 570, 820, 380, "Sam, sorry for the silence. Yes to Friday. I'll own the launch notes.", d7 + 120, d7 + 138, 60)}
            </>
          )}
          {/* the trigger word */}
          {phase === 8 && (
            <>
              <div style={{ position: "absolute", left: 260, top: 200 }}>
                <Pop start={ramble + 2} from={0.95} y={30}>
                  <AppWindow kind="notes" width={1400} height={640}>
                    <div style={{ position: "absolute", left: 28, top: 28, right: 28 }}>
                      {frame < ref ? (
                        <div style={{ fontSize: 30, lineHeight: 1.45, color: C.ink, opacity: frame >= trig ? interpolate(frame, [ref - 10, ref], [1, 0.25], clamp) : 1 }}><Typewriter text={rawText} start={ramble + 6} cps={44} cursorColor={C.mint} /></div>
                      ) : (
                        <div style={{ fontSize: 30, lineHeight: 1.45, color: C.ink, whiteSpace: "pre-wrap" }}><Typewriter text={email} start={ref} cps={90} cursorColor={C.mint} /></div>
                      )}
                    </div>
                    {frame >= ref && <div style={{ position: "absolute", right: 28, top: 22, padding: "8px 16px", borderRadius: 999, background: C.mintPale, color: C.green2, fontSize: 17, fontWeight: 800, letterSpacing: "0.1em", opacity: interpolate(frame, [ref, ref + 10], [0, 1], clamp) }}>FORMAT · EMAIL · YOUR TONE</div>}
                  </AppWindow>
                </Pop>
              </div>
              {frame >= ramble + 4 && frame < trig && <div style={{ position: "absolute", left: 640, top: 880 }}><ListeningPill start={ramble + 4} /></div>}
              {frame >= trig && frame < ref + 4 && <div style={{ position: "absolute", left: 520, top: 880 }}><ListeningPill start={trig} label="“Tucky, make this an email.”" stopAt={ref} /></div>}
            </>
          )}
        </CameraPush>
      </AbsoluteFill>
      {/* the click */}
      {frame >= click && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: `rgba(251,246,234,${0.6 * clickP})` }}>
          <Words text="You can't go back." delay={click + 2} size={132} color={C.ink} weight={900} stagger={4} gradientWords={["back."]} />
          <div style={{ position: "absolute", right: 200, bottom: 120 }}><Mascot pose="mic" start={click + 12} width={300} /></div>
        </AbsoluteFill>
      )}
      <LightSweep duration={140} delay={0} opacity={0.18} />
    </AbsoluteFill>
  );
};

// ================= CHAPTER 3 · "Wait… this is all useful, isn't it?" =================
export const Ch3: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = (s: number) => sec(s - T.ch3);
  const lib = r(CUE.library), wonder = r(CUE.wonder), toast = r(CUE.toast), call = r(CUE.call), guide = r(CUE.guide), card = r(CUE.card);
  const rows = [
    ["note", "Launch moves to Friday; export pipeline lands Thursday", "Mon 09:12", "Launch"],
    ["task", "Ask Sam to confirm the launch date tonight", "Mon 09:13", "Launch"],
    ["idea", "Onboarding checklist could be voice-first too", "Mon 11:40", "Product"],
    ["note", "Pricing: start with per-seat, revisit usage tiers after pilot", "Tue 10:05", "Acme"],
    ["task", "Send Maya the pilot scope by Friday", "Tue 10:06", "Acme"],
    ["note", "Support needs one full day before any launch", "Wed 16:22", "Launch"],
    ["idea", "Daily recap could read out loud in the morning", "Thu 08:15", "Product"],
    ["task", "Book design review for the export screen", "Thu 09:40", "Product"],
  ] as const;
  const scroll = interpolate(frame, [lib + 90, wonder + 60], [0, -36], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const libOut = interpolate(frame, [call - 10, call], [1, 0], clamp);
  const transcript = "Maya (Acme): We're about forty people, mostly remote. Budget-wise we've set something aside for this quarter.\nYou: Got it. And when would you want to be live?\nMaya: Ideally before the sales kickoff in May.";
  const callOut = interpolate(frame, [card - 10, card], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 12], [0, 1], clamp) }}>
      <Bg seed={3} />
      <CameraPush from={1} to={1.04} origin="50% 40%">
        {/* library */}
        {frame < call && (
          <div style={{ position: "absolute", left: 210, top: 120, opacity: libOut }}>
            <Pop start={lib} from={0.95} y={30}>
              <MacWindow width={1500} height={860} title="Tucky — Library">
                <div style={{ position: "absolute", inset: 0, padding: 30, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 22px", borderRadius: 16, border: "2px solid rgba(32,51,41,0.1)", fontFamily: FONT_BODY, fontSize: 22, color: C.slateLight, marginBottom: 22 }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.slate} strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>Search everything you've said this week…<span style={{ marginLeft: "auto", fontFamily: FONT_MONO, fontSize: 16, color: C.slateLight }}>{Math.min(rows.length, Math.max(0, Math.floor((frame - lib - 10) / 6)))} of 148 captures</span></div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, transform: `translateY(${scroll}px)` }}>
                    {rows.map((row, i) => <CaptureRow key={i} at={lib + 12 + i * 6} kind={row[0]} text={row[1]} time={row[2]} project={row[3]} />)}
                  </div>
                </div>
              </MacWindow>
            </Pop>
          </div>
        )}
        {/* calendar + record toast */}
        {frame >= toast && frame < call + 6 && (
          <div style={{ position: "absolute", right: 120, top: 100, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-end", opacity: interpolate(frame, [call - 6, call + 4], [1, 0], clamp) }}>
            <Toast start={toast} title="Acme discovery call" sub="Zoom · starts in 2 min" icon={<div style={{ width: 44, height: 44, borderRadius: 12, background: "#2D8CFF", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 900, fontSize: 18 }}>Z</div>} />
            <Toast start={toast + 20} title="Record this call?" sub="Live transcript, summary and follow-ups. Stays on your Mac." actions={["Record", "Not now"]} chosenAt={toast + 48} />
          </div>
        )}
        {/* the call */}
        {frame >= call && frame < card + 4 && (
          <AbsoluteFill style={{ opacity: callOut }}>
            <div style={{ position: "absolute", left: 120, top: 130 }}>
              <Pop start={call} from={0.95} y={30}>
                <MacWindow width={1080} height={820} title="Tucky — Meeting">
                  <div style={{ position: "absolute", inset: 0, padding: 34, fontFamily: FONT_BODY }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 40, fontWeight: 900, color: C.ink, letterSpacing: "-0.03em" }}>Acme discovery call</div>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 16px", borderRadius: 999, background: "#fff3df", color: C.amber, fontFamily: FONT_MONO, fontWeight: 700, fontSize: 18, letterSpacing: "0.1em" }}><div style={{ width: 12, height: 12, borderRadius: "50%", background: C.amber, opacity: 0.5 + 0.5 * Math.sin(frame / 4) }} />RECORDING {String(Math.floor((frame - call) / fps / 60)).padStart(2, "0")}:{String(Math.floor((frame - call) / fps) % 60).padStart(2, "0")}</div>
                    </div>
                    <div style={{ marginTop: 26, borderRadius: 18, border: "1px solid rgba(32,51,41,0.1)", padding: "22px 26px", minHeight: 420 }}>
                      <div style={{ fontSize: 18, color: C.slateLight, marginBottom: 12 }}>Live transcript</div>
                      <div style={{ fontSize: 26, lineHeight: 1.5, color: C.ink, whiteSpace: "pre-wrap" }}><Typewriter text={transcript} start={call + 10} cps={34} cursorColor={C.green2} /></div>
                    </div>
                    <div style={{ marginTop: 22, padding: "18px 24px", borderRadius: 16, background: C.mintPale, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 20, fontWeight: 700, color: C.green2 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 12 }}><span style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 26 }}>{[0, 1, 2, 3].map((i) => <span key={i} style={{ width: 5, height: 8 + 18 * Math.abs(Math.sin(frame / 5 + i)), background: C.green2, borderRadius: 2 }} />)}</span>Capturing system + mic audio</span>
                      <span style={{ fontFamily: FONT_MONO, fontWeight: 500, color: C.slate }}>Zoom · detected automatically</span>
                    </div>
                  </div>
                </MacWindow>
              </Pop>
            </div>
            <div style={{ position: "absolute", left: 1250, top: 130 }}>
              <Pop start={call + 16} from={0.95} y={30}>
                <div style={{ width: 550, background: C.white, borderRadius: 22, border: "1px solid rgba(32,51,41,0.08)", boxShadow: "0 30px 80px rgba(32,51,41,0.14)", padding: 26, fontFamily: FONT_BODY }}>
                  <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.16em", color: C.slate, marginBottom: 6 }}>LIVE GUIDE · DISCOVERY CALL</div>
                  <div style={{ fontSize: 17, color: C.slateLight, marginBottom: 14 }}>What a great call covers. Tucky ticks what's been said.</div>
                  <GuideItem text="Team size and setup" done at={guide} />
                  <GuideItem text="Budget this quarter" done at={guide + 24} />
                  <GuideItem text="Timeline to go live" suggested at={guide + 72} />
                  <GuideItem text="Who signs off" />
                  <GuideItem text="Current tools and pain" />
                </div>
              </Pop>
            </div>
          </AbsoluteFill>
        )}
        {/* after the call */}
        {frame >= card && (
          <div style={{ position: "absolute", left: 0, right: 0, top: 150, display: "flex", justifyContent: "center" }}>
            <Pop start={card} from={0.94} y={40}>
              <div style={{ width: 1200, background: C.white, borderRadius: 26, border: "1px solid rgba(32,51,41,0.08)", boxShadow: "0 40px 100px rgba(32,51,41,0.16)", padding: 40, fontFamily: FONT_BODY }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}><div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.16em", color: C.slate }}>AFTER THE CALL · 24 MIN</div><div style={{ padding: "4px 12px", borderRadius: 999, background: C.mintPale, color: C.green2, fontSize: 15, fontWeight: 700 }}>Acme</div></div>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 44, fontWeight: 900, color: C.ink, letterSpacing: "-0.03em", marginBottom: 22 }}>Acme discovery call</div>
                <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.14em", color: C.green2, marginBottom: 10 }}>DECISION</div>
                <Bullet at={card + 14} color={C.green2} size={28}>Pilot with the sales team first, before the May kickoff.</Bullet>
                <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.14em", color: C.amber, margin: "22px 0 10px" }}>NEXT STEPS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <Bullet at={card + 30} color={C.amber} size={28}><b>Maya:</b> send current pricing tiers.</Bullet>
                  <Bullet at={card + 44} color={C.amber} size={28}><b>You:</b> propose a pilot scope by Friday.</Bullet>
                </div>
                <div style={{ marginTop: 26, display: "flex", gap: 12, opacity: interpolate(frame, [card + 60, card + 72], [0, 1], clamp) }}>{["Transcript", "Summary", "Tasks added ✓"].map((t) => <div key={t} style={{ padding: "8px 16px", borderRadius: 999, background: "#f1efe8", color: C.ink, fontSize: 17, fontWeight: 700 }}>{t}</div>)}</div>
              </div>
            </Pop>
          </div>
        )}
      </CameraPush>
      <LightSweep duration={160} delay={0} opacity={0.16} />
    </AbsoluteFill>
  );
};

// ================= CHAPTER 4 · "What else does it know?" =================
export const Ch4: React.FC = () => {
  const frame = useCurrentFrame();
  const r = (s: number) => sec(s - T.ch4);
  const w3 = r(CUE.week3), search = r(CUE.search), answer = r(CUE.answer), recap = r(CUE.recap);
  const cols = [
    { name: "Acme", rows: [["meeting", "Discovery call · pilot first", "Tue"], ["note", "Per-seat pricing, revisit after pilot", "Tue"], ["task", "Pilot scope by Friday", "Tue"], ["meeting", "Pricing follow-up · $49/seat agreed", "Thu"]] },
    { name: "Launch", rows: [["note", "Friday launch, export lands Thursday", "Mon"], ["screen", "Walkthrough for support (4 min)", "Wed"], ["task", "Own the launch notes", "Wed"]] },
    { name: "Product", rows: [["idea", "Voice-first onboarding checklist", "Mon"], ["screen", "Client demo: export flow, narrated", "Thu"], ["meeting", "Design review · auto-zoom bug", "Fri"]] },
  ] as const;
  const gridOut = interpolate(frame, [search - 10, search], [1, 0], clamp);
  const searchOut = interpolate(frame, [recap - 10, recap], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 12], [0, 1], clamp) }}>
      <Bg seed={4} />
      <CameraPush from={1} to={1.04}>
        {frame < search && (
          <AbsoluteFill style={{ opacity: gridOut }}>
            <DayStamp label="WEEK 3" at={w3} />
            <div style={{ position: "absolute", left: 120, top: 150, display: "flex", gap: 30 }}>
              {cols.map((c, ci) => (
                <div key={c.name} style={{ width: 546 }}>
                  <Pop start={w3 + 6 + ci * 6} from={0.95} y={20}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, fontFamily: FONT_BODY }}><div style={{ padding: "8px 18px", borderRadius: 999, background: C.green, color: C.cream, fontWeight: 800, fontSize: 20 }}>{c.name}</div><div style={{ fontSize: 17, color: C.slateLight, fontWeight: 600 }}>project</div></div>
                  </Pop>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {c.rows.map((row, i) => <CaptureRow key={i} at={w3 + 16 + i * 28 + ci * 10} kind={row[0]} text={row[1]} time={row[2]} />)}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: 940, display: "flex", justifyContent: "center", opacity: interpolate(frame, [w3 + 150, w3 + 165], [0, 1], clamp) }}><div style={{ fontFamily: FONT_BODY, fontSize: 26, fontStyle: "italic", color: C.slate }}>one place. sorted by project. nothing to file.</div></div>
          </AbsoluteFill>
        )}
        {frame >= search && frame < recap + 4 && (
          <AbsoluteFill style={{ opacity: searchOut }}>
            <div style={{ position: "absolute", left: 260, top: 200, width: 1400 }}>
              <Pop start={search} from={0.96} y={20}>
                <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "26px 34px", borderRadius: 24, background: C.white, border: `2px solid ${C.green2}`, boxShadow: "0 30px 80px rgba(32,51,41,0.14)", fontFamily: FONT_BODY, fontSize: 38, color: C.ink }}>
                  <Img src={staticFile("brand/tucky.jpeg")} style={{ width: 48, height: 48, borderRadius: 12 }} />
                  <Typewriter text="What did we decide on pricing with Acme?" start={search + 8} cps={28} cursorColor={C.green2} />
                </div>
              </Pop>
              {frame >= answer && (
                <Pop start={answer} from={0.96} y={30} style={{ marginTop: 26 }}>
                  <div style={{ background: C.white, borderRadius: 24, border: "1px solid rgba(32,51,41,0.08)", boxShadow: "0 30px 80px rgba(32,51,41,0.12)", padding: "30px 36px", fontFamily: FONT_BODY }}>
                    <div style={{ fontSize: 32, lineHeight: 1.45, color: C.ink }}><Typewriter text="You agreed on $49 per seat for the sales team, as a 3-month pilot. Pricing gets revisited after the pilot, before the May kickoff." start={answer + 4} cps={60} cursorColor={C.green2} /></div>
                    <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
                      {[["Acme discovery call", "Tue 14:02"], ["Pricing follow-up", "Thu 11:30"], ["Note · per-seat pricing", "Tue 10:05"]].map(([t, w], i) => (
                        <Pop key={t} start={answer + 70 + i * 8} from={0.85} y={10}><div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 16px", borderRadius: 12, background: C.mintPale, color: C.green2, fontSize: 18, fontWeight: 700 }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green2} strokeWidth="2.5" strokeLinecap="round"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></svg>{t}<span style={{ fontFamily: FONT_MONO, fontWeight: 500, color: C.slate }}>{w}</span></div></Pop>
                      ))}
                    </div>
                  </div>
                </Pop>
              )}
            </div>
            {frame >= answer + 70 && <div style={{ position: "absolute", left: 0, right: 0, top: 960, display: "flex", justifyContent: "center", opacity: interpolate(frame, [answer + 70, answer + 84], [0, 1], clamp) }}><div style={{ fontFamily: FONT_BODY, fontSize: 26, fontStyle: "italic", color: C.slate }}>…and shows you where it came from.</div></div>}
          </AbsoluteFill>
        )}
        {frame >= recap && (
          <div style={{ position: "absolute", left: 0, right: 0, top: 140, display: "flex", justifyContent: "center" }}>
            <Pop start={recap} from={0.95} y={40}>
              <MacWindow width={1300} height={780} title="Tucky — Daily Summary">
                <div style={{ position: "absolute", inset: 0, padding: 36, fontFamily: FONT_BODY }}>
                  <div style={{ fontFamily: FONT_DISPLAY, fontSize: 42, fontWeight: 900, color: C.ink, letterSpacing: "-0.03em" }}>Your day</div>
                  <div style={{ fontSize: 22, color: C.slate, marginBottom: 24 }}>Tuesday, March 11</div>
                  <div style={{ display: "flex", gap: 20, marginBottom: 26 }}>
                    {[["4", "Meetings"], ["9", "Tasks extracted"], ["3", "Recordings"]].map(([n, l], i) => <Pop key={l} start={recap + 10 + i * 6} from={0.9} y={16} style={{ flex: 1 }}><div style={{ borderRadius: 18, border: "1px solid rgba(32,51,41,0.1)", padding: "22px 0", textAlign: "center" }}><div style={{ fontFamily: FONT_DISPLAY, fontSize: 56, fontWeight: 900, color: C.green2 }}>{n}</div><div style={{ fontSize: 20, color: C.slate }}>{l}</div></div></Pop>)}
                  </div>
                  <div style={{ borderRadius: 18, border: "1px solid rgba(32,51,41,0.1)", padding: "22px 26px" }}>
                    <div style={{ fontSize: 20, color: C.slateLight, marginBottom: 12 }}>What matters · what's next</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <Bullet at={recap + 30} size={25}>Team committed to a <b>March 14</b> launch in Weekly Product Sync.</Bullet>
                      <Bullet at={recap + 40} size={25}>Acme pilot: propose scope by Friday. <span style={{ color: C.amber, fontWeight: 700 }}>Due in 2 days.</span></Bullet>
                      <Bullet at={recap + 50} size={25}>Design review surfaced an auto-zoom bug on external displays.</Bullet>
                    </div>
                  </div>
                </div>
              </MacWindow>
            </Pop>
          </div>
        )}
      </CameraPush>
      <LightSweep duration={160} delay={0} opacity={0.16} />
    </AbsoluteFill>
  );
};

// ================= CHAPTER 5 · "And where does all of this live?" =================
export const Ch5: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = (s: number) => sec(s - T.ch5);
  const pull = r(CUE.pull), free = r(CUE.free);
  const shrink = interpolate(frame, [pull, pull + 40], [1.15, 0.62], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const ring = interpolate(frame, [pull + 40, pull + 90], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const pills = [{ at: pull + 102, text: "No account", x: 260, y: 300 }, { at: pull + 129, text: "No cloud", x: 1380, y: 260 }, { at: pull + 156, text: "No subscription", x: 1330, y: 760 }];
  const freeP = spring({ frame: frame - free, fps, config: { damping: 11, stiffness: 220, mass: 0.9 } });
  const { x: sx, y: sy } = shakeOffset(frame, frame >= free && frame < free + 10 ? 8 : 0, "free");
  const laptopOut = frame >= free ? interpolate(freeP, [0, 1], [1, 0.5]) : 1;
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 12], [0, 1], clamp) }}>
      <Bg seed={5} />
      <AbsoluteFill style={{ transform: `translate(${sx}px, ${sy}px)` }}>
        {/* laptop */}
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${shrink * laptopOut}) translateY(${frame >= free ? -freeP * 120 : 0}px)`, opacity: frame >= free ? 1 - freeP * 0.5 : 1 }}>
          <div style={{ position: "relative" }}>
            <div style={{ width: 1160, height: 720, borderRadius: 28, background: "#1a1f1b", padding: 16, boxShadow: "0 60px 140px rgba(32,51,41,0.35)" }}>
              <div style={{ width: "100%", height: "100%", borderRadius: 16, overflow: "hidden", background: C.cream, position: "relative" }}>
                <div style={{ position: "absolute", left: 30, top: 24, right: 30, fontFamily: FONT_BODY }}>
                  <div style={{ fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 900, color: C.ink }}>Tucky — Library</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
                    {[["note", "Launch moves to Friday", "Mon"], ["meeting", "Acme discovery call · pilot first", "Tue"], ["screen", "Client demo: export flow", "Thu"], ["task", "Pilot scope by Friday", "Tue"], ["idea", "Voice-first onboarding", "Mon"]].map((row, i) => <CaptureRow key={i} at={0} kind={row[0] as "note"} text={row[1]} time={row[2]} />)}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ width: 1360, height: 26, marginLeft: -100, marginTop: 4, borderRadius: "0 0 22px 22px", background: "linear-gradient(180deg, #d8d4c8, #b9b5aa)" }} />
            {/* the line around it */}
            <svg width="1560" height="960" viewBox="0 0 1560 960" style={{ position: "absolute", left: -200, top: -110, overflow: "visible" }}>
              <rect x="20" y="20" width="1520" height="920" rx="60" fill="none" stroke={C.green2} strokeWidth="8" strokeDasharray="4900" strokeDashoffset={4900 * (1 - ring)} strokeLinecap="round" />
              <text x="780" y="-30" textAnchor="middle" fontFamily={FONT_MONO} fontWeight="700" fontSize="26" fill={C.green2} letterSpacing="4" opacity={ring}>YOUR MAC · EVERYTHING STAYS HERE</text>
            </svg>
          </div>
        </div>
        {pills.map((p) => { const sp = spring({ frame: frame - p.at, fps, config: { damping: 11, stiffness: 240 } }); if (frame < p.at) return null; return (
          <div key={p.text} style={{ position: "absolute", left: p.x, top: p.y, padding: "18px 34px", borderRadius: 999, background: C.ink, color: C.cream, fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 44, letterSpacing: "-0.02em", boxShadow: "0 24px 60px rgba(32,51,41,0.3)", opacity: interpolate(sp, [0, 0.4], [0, 1], clamp) * (frame >= free ? 1 - freeP * 0.6 : 1), transform: `scale(${interpolate(sp, [0, 1], [0.6, 1])}) rotate(${(random(p.text) - 0.5) * 8}deg)` }}><span style={{ color: C.red, marginRight: 14 }}>✕</span>{p.text}</div>); })}
        {frame >= free && (
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingTop: 200 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 300, fontWeight: 900, letterSpacing: "-0.06em", color: C.green2, transform: `scale(${interpolate(freeP, [0, 1], [2.2, 1])})`, opacity: interpolate(freeP, [0, 0.3], [0, 1], clamp), textShadow: "0 40px 100px rgba(23,107,80,0.3)" }}>Free.</div>
          </AbsoluteFill>
        )}
      </AbsoluteFill>
      <LightSweep duration={160} delay={0} opacity={0.16} />
    </AbsoluteFill>
  );
};

// ================= CLOSE =================
export const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const r = (s: number) => sec(s - T.close);
  const hot = r(CUE.hotkey2), logo = r(CUE.logo), cta = r(CUE.cta);
  const light = frame >= logo;
  const slam = spring({ frame: frame - logo, fps, config: { damping: 13, stiffness: 240, mass: 0.9 }, durationInFrames: 14 });
  const fadeOut = interpolate(frame, [durationInFrames - 26, durationInFrames], [0, 1], clamp);
  return (
    <AbsoluteFill>
      {!light ? (
        <>
          <DarkBg />
          <div style={{ position: "absolute", left: 0, right: 0, top: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 40 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 44, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>What are you working on?</div>
            <PromptBox width={1040} brand="gpt" placeholder=""><span><Cursor color="#ececec" /></span></PromptBox>
            {frame >= hot && <ListeningPill start={hot} />}
          </div>
          <Vignette strength={0.85} inner={35} />
        </>
      ) : (
        <>
          <Bg seed={7} />
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 36, paddingBottom: 60 }}>
            <div style={{ transform: `scale(${interpolate(slam, [0, 1], [1.6, 1])})`, opacity: interpolate(slam, [0, 0.3], [0, 1], clamp) }}><Logo size={150} /></div>
            <Words text="Typing is overrated. Just talk." delay={logo + 12} size={84} color={C.ink} weight={900} stagger={3} gradientWords={["talk."]} />
            {frame >= cta && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22, marginTop: 10 }}>
                <Pop start={cta}><div style={{ display: "flex", alignItems: "center", gap: 20 }}><div style={{ padding: "18px 40px", borderRadius: 16, background: C.green, color: C.cream, fontFamily: FONT_BODY, fontWeight: 800, fontSize: 30, boxShadow: "0 20px 50px rgba(18,59,45,0.3)" }}>Get Tucky free</div><div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 28, color: C.ink }}>echo-scribe.ai-juicing.com</div></div></Pop>
                <Pop start={cta + 10}><div style={{ fontFamily: FONT_BODY, fontSize: 22, fontWeight: 700, letterSpacing: "0.12em", color: C.green2, textTransform: "uppercase" }}>Free · Private · On-device AI · macOS</div></Pop>
              </div>
            )}
          </AbsoluteFill>
          <div style={{ position: "absolute", right: 160, bottom: 60 }}><Mascot pose="laptop" start={logo + 6} width={360} /></div>
          <LightSweep duration={100} delay={logo} opacity={0.3} />
        </>
      )}
      <AbsoluteFill style={{ background: C.cream, opacity: fadeOut, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
