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
  /** LLM already downloaded + active (suppresses the "AI features are off" card). */
  llmReady?: boolean;
  /** When set, start_pipeline rejects with this message. */
  startPipelineError?: string | null;
  /** Number of projects shown in Main's sidebar. */
  projectCount?: number;
  /** Folder currently configured for automatic meeting Markdown export. */
  meetingExportFolder?: string | null;
  /** Per-category MCP permission overrides (id → enabled). */
  mcpPermissions?: Partial<Record<string, boolean>>;
  /** Folder returned by the native export-folder picker mock. */
  pickedExportFolder?: string | null;
  people?: Array<{
    id: string;
    name: string;
    email: string | null;
    role: string | null;
    company_id: string | null;
    notes: string;
    created_at: string;
    updated_at: string;
  }>;
  companies?: Array<{
    id: string;
    name: string;
    domain: string | null;
    notes: string;
    created_at: string;
    updated_at: string;
  }>;
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
      llmReady: sc.llmReady ?? false,
      startPipelineError: sc.startPipelineError ?? null,
      projectCount: sc.projectCount ?? 0,
      meetingExportFolder: sc.meetingExportFolder ?? null,
      // Mirrors src-tauri/src/mcp_permissions.rs (read-only categories on,
      // screen recording off).
      mcpPermissions: {
        knowledge_search: true,
        meetings: true,
        chats: true,
        contacts: true,
        screen_recording: false,
        ...(sc.mcpPermissions ?? {}),
      } as Record<string, boolean>,
      pickedExportFolder: sc.pickedExportFolder ?? "/Users/test/Meeting Notes",
      pipelineRunning: false,
      people: [...(sc.people ?? [])],
      companies: [...(sc.companies ?? [])],
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
      disk_bytes: state.speechModelReady ? 600_000_000 : 0,
      incomplete: false,
    });
    const llmModel = () => ({
      id: "gemma-test",
      display_name: "Gemma (test)",
      family: "gemma",
      size_label: "2 GB",
      size_bytes: 2_000_000_000,
      context_length: 8192,
      downloaded: state.llmReady,
      active: state.llmReady,
      supported: true,
      disk_bytes: 0,
      incomplete: false,
    });

    let nextEventId = 1;
    const listeners = new Map<number, { event: string; handler: number }>();
    (window as any).__MOCK_EMIT__ = (event: string, payload: unknown = null) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) {
          (window as any)[`_${listener.handler}`]({ event, id, payload });
        }
      }
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => listeners.delete(id),
    };
    const handlers: Record<string, (args: any) => unknown> = {
      permissions_status: () => ({ ...state.permissions }),
      install_warnings: () => [],
      // Grant-flow commands: the prompting calls report the (mock) TCC state
      // — false on a fresh install, like the real APIs — and the pane-openers
      // are no-ops recorded for ordering assertions.
      prompt_accessibility_access: () => state.permissions.accessibility,
      request_screen_recording_access: () => state.permissions.screen_recording,
      request_microphone_access: () => state.permissions.microphone,
      open_accessibility_settings: () => undefined,
      open_screen_recording_settings: () => undefined,
      open_microphone_settings: () => undefined,
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
      get_app_launcher_enabled: () => true,
      get_action_counter: () => 21,
      get_trigger_word_routing_enabled: () => false,
      get_action_trigger_word: () => "echo",
      get_common_actions: () => [
        {
          category: "Applications",
          description: "Launch standard macOS applications or workspace web apps",
          voice_phrases: ["open Slack", "launch Safari", "open Growthinator", "launch LiveCase"],
        },
        {
          category: "Emails",
          description: "Draft emails inside the system default client prefilled",
          voice_phrases: [
            "email denis about Growthinator saying tests passed",
            "email John about meeting saying I will be there",
          ],
        },
        {
          category: "Web Browsing",
          description: "Navigate directly to websites in your default browser",
          voice_phrases: ["open google", "go to github.com"],
        },
        {
          category: "Persistent Counter",
          description: "Increment, query, or reset the app action stats",
          voice_phrases: ["increment counter", "what is the count", "reset action count"],
        },
      ],
      set_rebinding: () => undefined,
      smoke_checkpoint: () => undefined,
      frontend_log: () => undefined,
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
      list_projects: () =>
        Array.from({ length: state.projectCount }, (_, index) => ({
          id: `project-${index + 1}`,
          name: `Project ${index + 1}`,
          description: null,
          archived_at: null,
          created_at: "2026-07-30T12:00:00Z",
          updated_at: "2026-07-30T12:00:00Z",
          keywords: [],
          color: null,
          emoji: null,
          export_folder: null,
          routing_aliases: [],
          routing_app_hints: [],
          routing_url_hints: [],
          routing_window_hints: [],
          routing_positive_examples: [],
          routing_negative_examples: [],
        })),
      get_project_delete_impact: () => ({
        items: 4,
        meetings: 1,
        notes: 1,
        tasks: 1,
        transcriptions: 1,
        recordings: 1,
        chats: 1,
        artifacts: 1,
      }),
      delete_project: () => {
        state.projectCount = Math.max(0, state.projectCount - 1);
      },
      get_meeting_settings: () => ({
        auto_detect: true,
        app_prefs: {},
        summary_prompt: "Summarize decisions and next steps.",
        export_folder: state.meetingExportFolder,
      }),
      pick_export_folder: () => state.pickedExportFolder,
      set_meeting_export_folder: (a) => {
        state.meetingExportFolder = a.folder ?? null;
      },
      open_meeting_export_folder: () => undefined,
      get_mcp_settings: () => ({
        binary_path: "/Applications/Echo Scribe.app/Contents/MacOS/echo-scribe",
        permissions: [
          { id: "knowledge_search", label: "Search captures & notes", description: "Search dictations and notes, and list projects and tasks. Read-only." },
          { id: "meetings", label: "Meetings & transcripts", description: "Read meeting transcripts, summaries, participants, and recipes. Read-only." },
          { id: "chats", label: "Chats", description: "Search and read your Echo Scribe chat conversations. Read-only." },
          { id: "contacts", label: "People & companies", description: "Read confirmed people and company records. Read-only." },
          { id: "screen_recording", label: "Screen recording", description: "List windows and start/stop screen recordings with mic, system audio, and camera options. Requires Echo Scribe to be running." },
        ].map((perm) => ({ ...perm, enabled: !!state.mcpPermissions[perm.id] })),
      }),
      set_mcp_permission: (a) => {
        if (!(a.id in state.mcpPermissions)) throw new Error(`unknown MCP permission: ${a.id}`);
        state.mcpPermissions[a.id] = !!a.enabled;
      },
      install_mcp_for_agent: (a) => {
        if (a.agent !== "claude-code" && a.agent !== "codex")
          throw new Error(`unknown agent: ${a.agent}`);
        return `Connected to ${a.agent === "codex" ? "Codex" : "Claude Code"}.`;
      },
      list_people: () => [...state.people],
      list_companies: () => [...state.companies],
      list_relationship_meetings: () => [],
      save_person: (a) => {
        const existing = state.people.find((person) => person.id === a.id);
        const now = "2026-07-31T17:00:00Z";
        const person = {
          id: a.id ?? `person-${state.people.length + 1}`,
          name: a.name,
          email: a.email ?? null,
          role: a.role ?? null,
          company_id: a.companyId ?? null,
          notes: a.notes,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        state.people = state.people.filter((candidate) => candidate.id !== person.id);
        state.people.push(person);
        return person;
      },
      save_company: (a) => {
        const existing = state.companies.find((company) => company.id === a.id);
        const now = "2026-07-31T17:00:00Z";
        const company = {
          id: a.id ?? `company-${state.companies.length + 1}`,
          name: a.name,
          domain: a.domain ?? null,
          notes: a.notes,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        state.companies = state.companies.filter((candidate) => candidate.id !== company.id);
        state.companies.push(company);
        return company;
      },
      delete_person: (a) => {
        state.people = state.people.filter((person) => person.id !== a.id);
      },
      delete_company: (a) => {
        state.companies = state.companies.filter((company) => company.id !== a.id);
      },
      daily_summary_get: () => null,
      "plugin:autostart|is_enabled": () => false,
      "plugin:event|listen": (args) => {
        const id = nextEventId++;
        listeners.set(id, { event: args.event, handler: args.handler });
        return id;
      },
      "plugin:event|unlisten": (args) => { listeners.delete(args.eventId); },
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
