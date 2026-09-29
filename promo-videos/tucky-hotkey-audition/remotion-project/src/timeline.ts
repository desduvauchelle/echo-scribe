export const FPS = 30;
export const sec = (t: number) => Math.round(t * FPS);

// Narration lines: start (s) and measured duration (s) from scripts/normalize-vo.sh.
export const VO: { id: string; start: number; dur: number }[] = [
  { id: "01", start: 0.8, dur: 4.78 },
  { id: "02", start: 6.6, dur: 2.11 },
  { id: "03", start: 10.0, dur: 6.82 },
  { id: "04", start: 20.0, dur: 2.94 },
  { id: "05", start: 24.6, dur: 7.6 },
  { id: "06", start: 33.4, dur: 2.17 },
  { id: "07", start: 36.2, dur: 1.08 },
  { id: "08", start: 38.4, dur: 1.21 },
  { id: "09", start: 40.1, dur: 2.6 },
  { id: "10", start: 43.1, dur: 1.51 },
  { id: "11", start: 45.4, dur: 4.77 },
  { id: "12", start: 50.7, dur: 3.44 },
  { id: "13", start: 54.7, dur: 3.3 },
  { id: "14", start: 58.5, dur: 5.31 },
  { id: "15", start: 64.8, dur: 2.08 },
  { id: "16", start: 68.2, dur: 5.84 },
  { id: "17", start: 74.8, dur: 2.35 },
];
const at = (id: string) => VO.find((l) => l.id === id)!.start;

// Chapter boundaries (s).
export const T = { open: 0, a1: 9.6, a2: 24.2, a3: 37.9, close: 67.4, total: 81.5 };
export const TOTAL_FRAMES = sec(T.total);

export const CUE = {
  // open
  title: 5.8,
  judges: at("02"),
  // act 1: Superwhisper
  sw: T.a1 + 0.2, // tile lands in the spotlight
  swName: at("03") + 1.6,
  swTalk: at("03") + 3.9, // "You talk…"
  swText: at("03") + 4.9, // "…and it types"
  swBow: at("03") + 7.0,
  swAnd: at("03") + 8.3, // brain: "…and?"
  swAgain: at("04") + 0.1,
  swScores: at("04") + 2.4,
  // act 2: Wispr Flow
  wf: T.a2 + 0.3,
  wfName: at("05") + 1.6,
  wfTalk: at("05") + 3.6,
  wfText: at("05") + 4.4,
  wfApps: at("05") + 6.2, // "Across all your apps"
  wfBow: at("05") + 7.6,
  wfSame: at("05") + 8.1, // brain: "so… same thing?"
  catEye: at("06") + 0.4,
  wfScores: at("06") + 2.3,
  // act 3: Tucky
  tucky: T.a3 + 0.2, // mascot walks on
  tDictate: at("09") + 1.4,
  tEmail: at("10") + 0.4,
  score1: at("10") + 1.6,
  tTask: at("11") + 0.6,
  tFile: at("11") + 1.6,
  brainPop: at("11") + 3.0,
  score2: at("11") + 3.4,
  tMeet: at("12") - 0.3,
  catWake: at("12") + 1.4,
  tMeetCard: at("12") + 2.0,
  tAsk: at("13") - 0.2,
  tAnswer: at("13") + 1.6,
  tFocus: at("14") - 0.2,
  tRecap: at("14") + 2.2,
  tScreen: at("14") + 3.6,
  overflow: at("14") + 5.1,
  ovation: at("14") + 5.6,
  curtain: at("15") + 0.3,
  // close
  press: at("16") - 0.4,
  logo: at("17") - 0.2,
  cta: at("17") + 2.6,
};

export type Sfx = { file: "tick" | "pop" | "chime" | "whoosh" | "thump" | "hit" | "boom" | "riser" | "cricket" | "applause"; at: number; vol: number };
const W = 0.04;
export const SFX: Sfx[] = [
  { file: "thump", at: CUE.title, vol: 0.55 },
  { file: "pop", at: CUE.judges, vol: 0.35 },
  // act 1
  { file: "whoosh", at: T.a1 - 0.05, vol: W }, { file: "thump", at: CUE.sw, vol: 0.4 },
  { file: "pop", at: CUE.swName, vol: 0.35 },
  { file: "chime", at: CUE.swText, vol: 0.35 },
  { file: "cricket", at: CUE.swBow + 0.3, vol: 0.35 },
  { file: "pop", at: CUE.swAnd, vol: 0.35 },
  { file: "chime", at: CUE.swAgain + 0.8, vol: 0.4 },
  ...[0, 0.12, 0.24].map((d) => ({ file: "tick" as const, at: CUE.swScores + d, vol: 0.45 })),
  // act 2
  { file: "whoosh", at: T.a2 - 0.05, vol: W }, { file: "thump", at: CUE.wf, vol: 0.4 },
  { file: "pop", at: CUE.wfName, vol: 0.35 },
  { file: "chime", at: CUE.wfText, vol: 0.35 },
  { file: "cricket", at: CUE.wfBow + 0.2, vol: 0.35 }, { file: "cricket", at: CUE.wfBow + 1.0, vol: 0.25 },
  { file: "pop", at: CUE.wfSame, vol: 0.35 },
  ...[0, 0.12, 0.24].map((d) => ({ file: "tick" as const, at: CUE.wfScores + d, vol: 0.45 })),
  // act 3
  { file: "whoosh", at: T.a3 - 0.05, vol: W }, { file: "thump", at: CUE.tucky, vol: 0.45 },
  { file: "chime", at: CUE.tDictate, vol: 0.35 },
  { file: "pop", at: CUE.tEmail, vol: 0.4 }, { file: "tick", at: CUE.score1, vol: 0.5 },
  { file: "chime", at: CUE.tTask, vol: 0.4 }, { file: "pop", at: CUE.tFile, vol: 0.4 }, { file: "pop", at: CUE.brainPop, vol: 0.55 }, { file: "tick", at: CUE.score2, vol: 0.5 },
  { file: "pop", at: CUE.tMeet, vol: 0.4 }, { file: "chime", at: CUE.tMeetCard, vol: 0.35 },
  { file: "pop", at: CUE.tAsk, vol: 0.35 }, { file: "chime", at: CUE.tAnswer, vol: 0.4 },
  { file: "pop", at: CUE.tFocus, vol: 0.35 }, { file: "pop", at: CUE.tRecap, vol: 0.35 }, { file: "pop", at: CUE.tScreen, vol: 0.35 },
  ...[0, 0.15, 0.3].map((d) => ({ file: "tick" as const, at: CUE.overflow + d, vol: 0.5 })),
  { file: "applause", at: CUE.ovation, vol: 0.45 },
  { file: "thump", at: CUE.curtain + 0.5, vol: 0.5 },
  // close
  { file: "whoosh", at: T.close - 0.05, vol: W },
  { file: "tick", at: CUE.press, vol: 0.6 }, { file: "pop", at: CUE.press + 0.2, vol: 0.4 },
  { file: "hit", at: CUE.logo, vol: 0.85 }, { file: "pop", at: CUE.cta, vol: 0.4 },
];

// Music bed level with narration ducking (-50% under each line) and a fade-out at the end.
export const musicVolume = (frame: number) => {
  const t = frame / FPS;
  let v = 0.3;
  for (const l of VO) {
    const a = l.start - 0.15, b = l.start + l.dur + 0.25;
    if (t >= a && t <= b) { const edge = Math.min(1, Math.min(t - a, b - t) / 0.25); v *= 1 - 0.5 * edge; }
  }
  // the awkward silences get quieter music so the crickets land
  for (const s of [CUE.swBow, CUE.wfBow]) if (t >= s && t <= s + 2.2) v *= 0.35;
  if (t > T.total - 1.6) v *= Math.max(0, (T.total - t) / 1.6);
  return v;
};
export const TABS: [number, number][] = [[0, 0]]; // unused here; brain.tsx TabCounter is shared with "Brain Tabs"
