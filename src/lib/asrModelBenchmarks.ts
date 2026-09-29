/** Unassisted 28.73-second personal voice sample, 2026-09-26.
 * Source: output/voice-sample-2026-09-26/report.md.
 * Memory is peak macOS physical footprint, not RSS or download size.
 */
export const asrModelBenchmarks: Record<string, {
  errors: number;
  warmSeconds: number;
  loadSeconds: number;
  memoryGiB: number;
}> = {
  "parakeet-v3": { errors: 8, warmSeconds: 0.60, loadSeconds: 0.52, memoryGiB: 2.01 },
  "whisper-base": { errors: 11, warmSeconds: 0.19, loadSeconds: 0.22, memoryGiB: 0.38 },
  "whisper-turbo": { errors: 6, warmSeconds: 1.06, loadSeconds: 0.31, memoryGiB: 0.81 },
  "qwen3-asr": { errors: 8, warmSeconds: 0.30, loadSeconds: 0.61, memoryGiB: 2.20 },
};

/** Relative ranks: best = 5; lose one bar per model with a better result.
 * Ties share a score. Higher always means better (including lower RAM use).
 */
export function benchmarkGrade(metric: "errors" | "warmSeconds" | "memoryGiB", value: number) {
  return Math.max(1, 5 - Object.values(asrModelBenchmarks).filter(row => row[metric] < value).length);
}
