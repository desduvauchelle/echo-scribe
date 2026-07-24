import type { Page } from "@playwright/test";

/** Knobs describing the simulated machine state at app boot. */
export type Scenario = {
  permissions?: Partial<{
    microphone: boolean;
    accessibility: boolean;
    screen_recording: boolean;
    calendars: boolean;
    camera: boolean;
  }>;
  onboardingCompleted?: boolean;
  /** Speech model already downloaded + active (the Start gate). */
  speechModelReady?: boolean;
  /** When set, start_pipeline rejects with this message. */
  startPipelineError?: string | null;
};

/**
 * Install a fake `window.__TAURI_INTERNALS__` before any app code runs.
 *
 * The stub answers the IPC commands the boot/onboarding path uses from a
 * scenario object, records every call on `window.__MOCK_CALLS__` so tests
 * can assert on them, and REJECTS unknown commands (recorded on
 * `window.__MOCK_UNHANDLED__`) — rejection matches how components treat a
 * failing backend, so gaps show up as error UI rather than silent nulls.
 */
export async function installTauriMock(page: Page, scenario: Scenario = {}) {
  await page.addInitScript((sc) => {
    const state = {
      permissions: {
        microphone: false,
        accessibility: false,
        screen_recording: false,
        calendars: false,
        camera: false,
        ...(sc.permissions ?? {}),
      },
      onboardingCompleted: sc.onboardingCompleted ?? false,
      speechModelReady: sc.speechModelReady ?? false,
      startPipelineError: sc.startPipelineError ?? null,
      pipelineRunning: false,
    };
    const calls: { cmd: string; args: unknown }[] = [];
    const unhandled: string[] = [];
    (window as any).__MOCK_CALLS__ = calls;
    (window as any).__MOCK_UNHANDLED__ = unhandled;
    (window as any).__MOCK_STATE__ = state;

    const binding = { primary: "ControlRight", modifiers: [] };
    const speechModel = () => ({
      id: "parakeet-test",
      display_name: "Parakeet (test)",
      version_label: "v3",
      description: "Mock speech model",
      language_label: "English",
      english_only: true,
      accuracy_bars: 3,
      speed_bars: 3,
      size_label: "600 MB",
      size_bytes: 600_000_000,
      downloaded: state.speechModelReady,
      active: true,
      supported: true,
    });
    const llmModel = () => ({
      id: "gemma-test",
      display_name: "Gemma (test)",
      family: "gemma",
      size_label: "2 GB",
      size_bytes: 2_000_000_000,
      context_length: 8192,
      downloaded: false,
      active: false,
      supported: true,
      disk_bytes: 0,
      incomplete: false,
    });

    let nextEventId = 1;
    const handlers: Record<string, (args: any) => unknown> = {
      permissions_status: () => ({ ...state.permissions }),
      platform_capabilities: () => ({
        direct_voice_capture: true,
        local_database: true,
        meeting_auto_detect: true,
        system_audio_capture: true,
        calendar_matching: true,
        screen_recording: true,
        bundle_self_update: true,
      }),
      get_onboarding_completed: () => state.onboardingCompleted,
      set_onboarding_completed: (a) => {
        state.onboardingCompleted = !!a.completed;
      },
      list_speech_models: () => [speechModel()],
      get_active_speech_model_id: () => "parakeet-test",
      set_active_speech_model: () => undefined,
      download_speech_model: () => {
        state.speechModelReady = true;
      },
      list_llm_models: () => [llmModel()],
      get_active_llm_model_id: () => null,
      start_pipeline: () => {
        if (state.startPipelineError) throw new Error(state.startPipelineError);
        state.pipelineRunning = true;
      },
      is_pipeline_running: () => state.pipelineRunning,
      get_voice_at_cursor_binding: () => binding,
      get_log_capture_binding: () => binding,
      get_action_binding: () => binding,
      get_edit_selection_binding: () => binding,
      set_rebinding: () => undefined,
      smoke_checkpoint: () => undefined,
      get_dashboard_stats: () => {
        const period = { transcriptions: 0, words: 0 };
        const category = (today: number, week: number, month: number, all: number, timed = false) => ({
          today: { count: today, words: timed ? 0 : today * 22, duration_ms: timed ? today * 18 * 60_000 : 0 },
          week: { count: week, words: timed ? 0 : week * 22, duration_ms: timed ? week * 18 * 60_000 : 0 },
          month: { count: month, words: timed ? 0 : month * 22, duration_ms: timed ? month * 18 * 60_000 : 0 },
          all_time: { count: all, words: timed ? 0 : all * 22, duration_ms: timed ? all * 18 * 60_000 : 0 },
        });
        const dailyActivity = Array.from({ length: 90 }, (_, index) => {
          const date = new Date();
          date.setDate(date.getDate() - (89 - index));
          return {
            date: date.toISOString().slice(0, 10),
            transcriptions: index % 5 === 0 ? 0 : (index % 9) + 1,
            notes: index % 3 === 0 ? 2 : 0,
            tasks: index % 4 === 0 ? 1 : 0,
            meetings: index % 7 === 0 ? 2 : index % 5 === 0 ? 1 : 0,
            recordings: index % 8 === 0 ? 1 : 0,
          };
        });
        return {
          today: period,
          week: period,
          month: period,
          all_time: period,
          daily_counts: [],
          current_streak: 6,
          longest_streak: 18,
          avg_words_per_capture: 42,
          busiest_hour: 10,
          categories: {
            transcriptions: category(18, 86, 312, 2840),
            notes: category(3, 14, 52, 428),
            tasks: category(2, 11, 39, 316),
            meetings: category(1, 5, 18, 142, true),
            recordings: category(1, 3, 12, 87, true),
          },
          daily_activity: dailyActivity,
        };
      },
      daily_summary_get: () => null,
      "plugin:autostart|is_enabled": () => false,
      "plugin:event|listen": () => nextEventId++,
      "plugin:event|unlisten": () => undefined,
    };

    (window as any).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
        currentWebviewWindow: { label: "main" },
      },
      transformCallback(cb: (r: unknown) => void) {
        const id = Math.floor(Math.random() * 1_000_000_000);
        (window as any)[`_${id}`] = cb;
        return id;
      },
      invoke(cmd: string, args: unknown = {}) {
        calls.push({ cmd, args });
        const handler = handlers[cmd];
        if (handler) {
          try {
            return Promise.resolve(handler(args));
          } catch (e) {
            return Promise.reject(e instanceof Error ? e.message : String(e));
          }
        }
        // Generic fallbacks so incidental Main-view widgets render their
        // empty states instead of erroring.
        if (/^(list_|search_)/.test(cmd)) return Promise.resolve([]);
        if (/^count_/.test(cmd)) return Promise.resolve(0);
        if (/^is_/.test(cmd)) return Promise.resolve(false);
        unhandled.push(cmd);
        return Promise.reject(`mock: unhandled command ${cmd}`);
      },
    };
  }, scenario);
}

/** Commands invoked so far, oldest first. */
export function recordedCalls(page: Page) {
  return page.evaluate(
    () => (window as any).__MOCK_CALLS__ as { cmd: string; args: any }[],
  );
}

export function mockState(page: Page) {
  return page.evaluate(() => (window as any).__MOCK_STATE__);
}
