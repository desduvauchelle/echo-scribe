import type { DashboardStats, StatsCategoryKey } from "./api";

export const MILESTONES = [10, 25, 50, 100, 200] as const;
export const CATEGORIES: StatsCategoryKey[] = ["transcriptions", "notes", "tasks", "meetings", "recordings"];
export type Counts = Record<StatsCategoryKey, number>;
export const emptyCounts = (): Counts => ({ transcriptions: 0, notes: 0, tasks: 0, meetings: 0, recordings: 0 });
export type Win = { category: StatsCategoryKey; count: number };
export type LearningState = {
  version: 1; initialized: boolean; counts: Counts; hidden: boolean; retrieved: boolean;
  practiced: boolean; celebrations: boolean; tips: boolean;
  dismissed: string[]; snoozed: Record<string, number>; lastTipAt: number;
  earned: string[]; pending: Win[];
};
export const initialLearning = (): LearningState => ({
  version: 1, initialized: false, counts: emptyCounts(), hidden: false, retrieved: false,
  practiced: false, celebrations: true, tips: true, dismissed: [], snoozed: {}, lastTipAt: 0,
  earned: [], pending: [],
});
export const winId = (win: Win) => `${win.category}:${win.count}`;
export function countsFromStats(stats: DashboardStats): Counts {
  return Object.fromEntries(CATEGORIES.map((key) => [key, Math.max(0, stats.categories[key].all_time.count)])) as Counts;
}
export function observeCounts(state: LearningState, counts: Counts): LearningState {
  const next = { ...state, counts: { ...state.counts }, earned: [...state.earned], pending: [...state.pending], initialized: true };
  for (const category of CATEGORIES) {
    const count = Math.max(state.counts[category], counts[category]);
    next.counts[category] = count;
    const crossed = MILESTONES.filter((n) => n <= count && !state.earned.includes(winId({ category, count: n })));
    for (const n of crossed) next.earned.push(winId({ category, count: n }));
    // Existing users keep their wins, without a burst of historical celebrations.
    if (state.initialized && crossed.length && state.celebrations)
      next.pending.push({ category, count: crossed[crossed.length - 1] });
  }
  if (!state.initialized && counts.transcriptions >= 10) {
    next.hidden = true; next.retrieved = true;
  }
  return next;
}

export type LessonId = "dictate" | "capture" | "retrieve" | "projects" | "tasks" | "chat" | "meetings" | "people" | "daily" | "recordings" | "templates" | "actions" | "export" | "agents" | "startup";
export type Lesson = { id: LessonId; group: "voice" | "memory" | "meetings" | "recordings" | "power"; category?: StatsCategoryKey; after: number };
export const LESSONS: Lesson[] = [
  { id: "dictate", group: "voice", after: 0 },
  { id: "capture", group: "memory", category: "transcriptions", after: 1 },
  { id: "retrieve", group: "memory", category: "notes", after: 1 },
  { id: "projects", group: "memory", category: "notes", after: 3 },
  { id: "tasks", group: "memory", category: "tasks", after: 1 },
  { id: "chat", group: "memory", category: "transcriptions", after: 5 },
  { id: "meetings", group: "meetings", after: 0 },
  { id: "people", group: "meetings", category: "meetings", after: 1 },
  { id: "daily", group: "memory", category: "transcriptions", after: 3 },
  { id: "recordings", group: "recordings", category: "recordings", after: 1 },
  { id: "templates", group: "voice", category: "transcriptions", after: 10 },
  { id: "actions", group: "power", category: "transcriptions", after: 25 },
  { id: "export", group: "power", category: "notes", after: 5 },
  { id: "agents", group: "power", category: "notes", after: 10 },
  { id: "startup", group: "power", category: "transcriptions", after: 2 },
];
export function nextTip(state: LearningState, now: number): Lesson | undefined {
  if (!state.tips || now - state.lastTipAt < 24 * 60 * 60 * 1000) return;
  return LESSONS.find((lesson) => lesson.category && state.counts[lesson.category] >= lesson.after
    && !["dictate", "capture", "retrieve"].includes(lesson.id)
    && !state.dismissed.includes(lesson.id) && (state.snoozed[lesson.id] ?? 0) <= now);
}
export function learningSteps(state: LearningState) {
  return [state.practiced || state.counts.transcriptions > 0, state.counts.notes + state.counts.tasks > 0, state.retrieved];
}
