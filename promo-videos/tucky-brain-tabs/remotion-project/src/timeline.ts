export const FPS = 30;
export const sec = (t: number) => Math.round(t * FPS);

// Narration lines: start (s) and measured duration (s) from scripts/normalize-vo.sh.
export const VO: { id: string; start: number; dur: number }[] = [
  { id: "01", start: 0.8, dur: 3.24 },
  { id: "02", start: 5.2, dur: 1.59 },
  { id: "03", start: 8.6, dur: 5.98 },
  { id: "04", start: 15.1, dur: 3.36 },
  { id: "05", start: 19.4, dur: 8.45 },
  { id: "06", start: 28.6, dur: 2.45 },
  { id: "07", start: 32.4, dur: 3.26 },
  { id: "08", start: 39.2, dur: 4.53 },
  { id: "09", start: 44.3, dur: 10.15 },
  { id: "10", start: 55.0, dur: 3.37 },
  { id: "11", start: 59.6, dur: 8.4 },
  { id: "12", start: 68.4, dur: 3.58 },
  { id: "13", start: 72.6, dur: 5.21 },
  { id: "14", start: 78.1, dur: 3.02 },
  { id: "15", start: 82.6, dur: 1.54 },
  { id: "16", start: 84.6, dur: 1.84 },
  { id: "17", start: 87.0, dur: 3.98 },
];
const at = (id: string) => VO.find((l) => l.id === id)!.start;

// Chapter boundaries (s).
export const T = { open: 0, ch1: 8.1, ch2: 31.9, ch3: 59.0, close: 82.0, total: 94.5 };
export const TOTAL_FRAMES = sec(T.total);

// Cue points (absolute seconds).
export const CUE = {
  // cold open
  bubbles: at("02") - 0.4, // thoughts start crashing in
  // ch1
  reminder: T.ch1 + 0.4, // "email the accountant" first ping
  orbit: at("04") - 0.3, // bubbles orbit, counter 47
  sysApps: at("05") + 1.6, // "Four to-do apps"
  sysEmail: at("05") + 3.0, // "An email to yourself…"
  sysPhoto: at("05") + 5.6,
  sticky: at("05") + 7.2, // "…says important"
  stickyFall: at("06") + 0.2,
  // ch2
  pill: at("07") + 2.2, // "…and say it"
  captionEnd: at("08") - 0.3,
  toast: at("08") + 0.4,
  loopPop: at("08") + 3.3, // "the loop… stops"
  cap1: at("09") + 1.0,
  cap2: at("09") + 3.6,
  cap3: at("09") + 6.4,
  cap4: at("09") + 8.6,
  calm: at("10") - 0.2,
  // ch3
  morning: T.ch3 + 0.2,
  focusSpeak: at("11") + 5.0, // "You answer out loud"
  focusTasks: at("11") + 6.4,
  pet: at("12") - 0.2,
  spoon: at("13") + 2.2, // "history of the spoon"
  spoonMore: at("13") + 3.6,
  wiggle: at("13") + 4.4,
  spoonClose: at("14") - 0.1,
  check: at("14") + 1.3,
  // close
  stove: at("15") - 0.3,
  stovePop: at("16") + 0.7,
  logo: at("17") - 0.1,
  cta: at("17") + 3.0,
};

export const CAP_POP = 1.5; // seconds from a capture cue to its bubble popping / card filing

// The "🧠 N tabs open" counter: [absolute seconds, value]. Rolls to each new value.
export const TABS: [number, number][] = [
  [0, 3],
  [CUE.bubbles, 5], [CUE.bubbles + 0.35, 6], [CUE.bubbles + 0.7, 8], [CUE.bubbles + 1.0, 9], [CUE.bubbles + 1.25, 11], [CUE.bubbles + 1.5, 12],
  [CUE.reminder, 15], [CUE.reminder + 2.1, 19], [CUE.reminder + 4.2, 24], [CUE.orbit, 47],
  [CUE.sysApps, 51], [CUE.sysEmail, 54], [CUE.sysPhoto, 57], [CUE.sticky, 61],
  [CUE.loopPop, 60], [CUE.cap1 + 1.5, 45], [CUE.cap2 + 1.5, 28], [CUE.cap3 + 1.5, 11], [CUE.cap4 + 1.5, 4],
  [CUE.focusTasks, 3], [CUE.spoon, 5], [CUE.spoonMore, 9], [CUE.spoonClose, 3], [CUE.check, 2],
  [T.close, 1], [CUE.stove, 2], [CUE.stovePop, 1],
];

export type Sfx = { file: "tick" | "pop" | "chime" | "whoosh" | "thump" | "hit" | "boom" | "riser"; at: number; vol: number };
const W = 0.04; // whooshes are loud: keep them almost subliminal
const BUBBLE_IN = [0, 0.35, 0.7, 1.0, 1.25, 1.5]; // cold-open bubble entrances, relative to CUE.bubbles
export const SFX: Sfx[] = [
  ...BUBBLE_IN.map((d) => ({ file: "tick" as const, at: CUE.bubbles + d, vol: 0.35 })),
  { file: "whoosh", at: T.ch1 - 0.05, vol: W },
  ...[0, 2.1, 4.2].map((d) => ({ file: "pop" as const, at: CUE.reminder + d, vol: 0.3 })),
  { file: "pop", at: CUE.sysApps, vol: 0.35 }, { file: "pop", at: CUE.sysEmail, vol: 0.35 }, { file: "pop", at: CUE.sysPhoto, vol: 0.35 }, { file: "pop", at: CUE.sticky, vol: 0.4 },
  { file: "thump", at: CUE.stickyFall + 0.9, vol: 0.45 },
  { file: "whoosh", at: T.ch2 - 0.05, vol: W }, { file: "thump", at: T.ch2, vol: 0.4 },
  { file: "pop", at: CUE.pill, vol: 0.4 },
  { file: "chime", at: CUE.toast, vol: 0.45 },
  { file: "pop", at: CUE.loopPop, vol: 0.6 },
  ...[CUE.cap1, CUE.cap2, CUE.cap3, CUE.cap4].map((a) => ({ file: "pop" as const, at: a + CAP_POP, vol: 0.5 })),
  { file: "whoosh", at: T.ch3 - 0.05, vol: W }, { file: "thump", at: T.ch3, vol: 0.4 },
  { file: "chime", at: CUE.focusTasks, vol: 0.35 },
  { file: "pop", at: CUE.pet, vol: 0.45 },
  { file: "tick", at: CUE.spoon, vol: 0.4 }, { file: "tick", at: CUE.spoonMore, vol: 0.3 }, { file: "tick", at: CUE.spoonMore + 0.3, vol: 0.3 },
  { file: "chime", at: CUE.check, vol: 0.5 },
  { file: "tick", at: CUE.stove, vol: 0.35 },
  { file: "pop", at: CUE.stovePop, vol: 0.6 },
  { file: "hit", at: CUE.logo, vol: 0.85 }, { file: "pop", at: CUE.cta, vol: 0.4 },
];

// Music bed level with narration ducking (-50% under each line, 0.25 s edges) and a fade-out at the end.
export const musicVolume = (frame: number) => {
  const t = frame / FPS;
  let v = 0.3;
  for (const l of VO) {
    const a = l.start - 0.15, b = l.start + l.dur + 0.25;
    if (t >= a && t <= b) { const edge = Math.min(1, Math.min(t - a, b - t) / 0.25); v *= 1 - 0.5 * edge; }
  }
  if (t > T.total - 1.6) v *= Math.max(0, (T.total - t) / 1.6);
  return v;
};
