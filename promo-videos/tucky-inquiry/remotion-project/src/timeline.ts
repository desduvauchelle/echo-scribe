export const FPS = 30;
export const sec = (t: number) => Math.round(t * FPS);

// Chapter boundaries (seconds)
export const T = { ch1: 0, ch2: 15.0, ch3: 43.0, ch4: 70.4, ch5: 92.0, close: 102.4, total: 110.0 };
export const TOTAL_FRAMES = sec(T.total);

// Cue points inside chapters (absolute seconds)
export const CUE = {
  q1: 4.4, hotkey1: 5.6, land1: 8.5,
  q2: 15.2, day1: 15.8, day2: 19.0, day3: 21.2, day7: 25.4, ramble: 32.5, trigger: 35.0, reformat: 36.4, click: 39.5,
  q3: 43.2, library: 43.8, wonder: 50.5, toast: 54.4, call: 57.2, guide: 60.0, card: 65.7,
  q4: 70.6, week3: 71.2, search: 80.0, answer: 82.6, recap: 87.1,
  q5: 92.2, pull: 92.8, free: 100.0,
  reprise: 102.4, hotkey2: 103.6, logo: 104.6, cta: 106.6,
};

export const VO: { id: string; start: number; dur: number }[] = [
  { id: "01", start: 0.8, dur: 3.24 },
  { id: "02", start: 5.0, dur: 2.88 },
  { id: "03", start: 8.3, dur: 4.32 },
  { id: "04", start: 13.0, dur: 1.44 },
  { id: "05", start: 15.8, dur: 9.17 },
  { id: "06", start: 25.4, dur: 6.67 },
  { id: "07", start: 32.5, dur: 6.55 },
  { id: "08", start: 39.5, dur: 2.45 },
  { id: "09", start: 43.8, dur: 10.15 },
  { id: "10", start: 54.4, dur: 2.28 },
  { id: "11", start: 57.2, dur: 8.04 },
  { id: "12", start: 65.7, dur: 3.79 },
  { id: "13", start: 71.2, dur: 8.35 },
  { id: "14", start: 80.0, dur: 6.65 },
  { id: "15", start: 87.1, dur: 4.13 },
  { id: "16", start: 92.8, dur: 6.55 },
  { id: "17", start: 100.0, dur: 1.39 },
  { id: "18", start: 103.0, dur: 4.73 },
];

export type Sfx = { file: string; at: number; vol: number };
const W = 0.04;
export const SFX: Sfx[] = [
  { file: "tick", at: 1.4, vol: 0.35 }, { file: "tick", at: 1.6, vol: 0.35 }, { file: "tick", at: 1.8, vol: 0.35 }, { file: "tick", at: 2.6, vol: 0.3 }, { file: "tick", at: 2.75, vol: 0.3 },
  { file: "pop", at: CUE.hotkey1, vol: 0.5 },
  { file: "chime", at: CUE.land1, vol: 0.45 },
  { file: "whoosh", at: T.ch2 - 0.05, vol: W }, { file: "thump", at: T.ch2, vol: 0.5 },
  { file: "pop", at: CUE.day1 + 0.4, vol: 0.4 }, { file: "tick", at: CUE.day2 + 0.5, vol: 0.4 }, { file: "tick", at: CUE.day2 + 0.7, vol: 0.4 }, { file: "pop", at: CUE.day2 + 1.6, vol: 0.4 }, { file: "pop", at: CUE.day3 + 0.4, vol: 0.45 },
  { file: "pop", at: CUE.day7 + 0.3, vol: 0.4 }, { file: "pop", at: CUE.day7 + 1.5, vol: 0.4 }, { file: "pop", at: CUE.day7 + 2.7, vol: 0.4 }, { file: "pop", at: CUE.day7 + 3.9, vol: 0.4 },
  { file: "pop", at: CUE.ramble + 0.2, vol: 0.35 }, { file: "pop", at: CUE.trigger, vol: 0.45 }, { file: "chime", at: CUE.reformat, vol: 0.45 },
  { file: "hit", at: CUE.click, vol: 0.5 }, { file: "pop", at: CUE.click + 0.2, vol: 0.5 },
  { file: "whoosh", at: T.ch3 - 0.05, vol: W }, { file: "pop", at: CUE.library + 0.3, vol: 0.4 },
  { file: "pop", at: CUE.toast, vol: 0.5 }, { file: "tick", at: CUE.toast + 1.6, vol: 0.5 },
  { file: "pop", at: CUE.call + 0.2, vol: 0.4 }, { file: "chime", at: CUE.guide + 0.8, vol: 0.35 }, { file: "pop", at: CUE.guide + 2.4, vol: 0.4 },
  { file: "pop", at: CUE.card, vol: 0.45 }, { file: "chime", at: CUE.card + 1.4, vol: 0.4 },
  { file: "whoosh", at: T.ch4 - 0.05, vol: W }, { file: "pop", at: CUE.week3 + 0.5, vol: 0.4 }, { file: "pop", at: CUE.week3 + 2.0, vol: 0.4 }, { file: "pop", at: CUE.week3 + 3.4, vol: 0.4 }, { file: "pop", at: CUE.week3 + 5.0, vol: 0.4 },
  { file: "tick", at: CUE.search + 0.6, vol: 0.4 }, { file: "chime", at: CUE.answer, vol: 0.45 },
  { file: "pop", at: CUE.recap + 0.2, vol: 0.45 },
  { file: "whoosh", at: T.ch5 - 0.05, vol: W }, { file: "pop", at: CUE.pull + 3.4, vol: 0.4 }, { file: "pop", at: CUE.pull + 4.3, vol: 0.4 }, { file: "pop", at: CUE.pull + 5.2, vol: 0.4 },
  { file: "hit", at: CUE.free, vol: 0.7 },
  { file: "whoosh", at: T.close - 0.05, vol: W },
  { file: "pop", at: CUE.hotkey2, vol: 0.5 }, { file: "hit", at: CUE.logo, vol: 0.9 }, { file: "pop", at: CUE.cta, vol: 0.45 },
];

export const musicVolume = (frame: number) => {
  const t = frame / FPS;
  let v = t < T.ch2 ? 0.3 : 0.3;
  for (const l of VO) {
    const a = l.start - 0.15, b = l.start + l.dur + 0.25;
    if (t >= a && t <= b) { const edge = Math.min(1, Math.min(t - a, b - t) / 0.25); v *= 1 - 0.5 * edge; }
  }
  if (t > T.total - 1.6) v *= Math.max(0, (T.total - t) / 1.6);
  return v;
};
