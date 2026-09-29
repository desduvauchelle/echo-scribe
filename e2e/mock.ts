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
  lowMemoryMode?: boolean;
  memorySaveError?: boolean;
  wakeWordSaveError?: boolean;
  onboardingCompleted?: boolean;
  /** Speech model already downloaded + active (the Start gate). */
  speechModelReady?: boolean;
  /** LLM already downloaded + active (suppresses the "AI features are off" card). */
  llmReady?: boolean;
  captureCounts?: Partial<Record<"transcriptions" | "notes" | "tasks" | "meetings" | "recordings", number>>;
  speechDownloadDeferred?: boolean;
  speechDownloadError?: string;
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
  /** Pending post-meeting debriefs (list_pending_debriefs). Default: none,
   *  so the dashboard debrief section stays hidden in unrelated tests. */
  debriefs?: Array<{
    meetingId: string;
    title: string;
    startedAt: string;
    durationMs: number | null;
    projectId: string | null;
    participants: Array<Record<string, unknown>>;
    suggestions: Array<{ id: string; text: string; ownerName: string | null; status: "pending" }>;
  }>;
  /** Items returned by list_items (the activity feed). Default: none. */
  feedItems?: Array<Record<string, any> & { id: string; kind: string | null; project_id: string | null }>;
  /** Task rows (list_tasks); complete/uncomplete_task update them. */
  tasks?: Array<{ item: Record<string, any> & { id: string }; deadline: string | null; completed_at: string | null }>;
  /** item id → tags (list_tags_for_item). */
  itemTags?: Record<string, string[]>;
  focusTaskIds?: string[];
  dailyFocusNotes?: Record<string, string>;
  deferDailyFocusStart?: boolean;
  dictionaryEntries?: Array<{ spoken_form: string; replacement: string; language: string }>;
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
      voiceWorkflows: [] as Array<{ id: string; phrase: string; url: string; enabled: boolean }>,
      lowMemoryMode: sc.lowMemoryMode ?? false,
      wakeStatus: { enabled: false, state: "off", message: "Wake word is off" },
      onboardingCompleted: sc.onboardingCompleted ?? false,
      speechModelReady: sc.speechModelReady ?? false,
      llmReady: sc.llmReady ?? false,
      captureCounts: sc.captureCounts,
      speechDownloadError: sc.speechDownloadError ?? null,
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
      debriefs: JSON.parse(JSON.stringify(sc.debriefs ?? [])) as NonNullable<typeof sc.debriefs>,
      feedItems: JSON.parse(JSON.stringify(sc.feedItems ?? [])) as NonNullable<typeof sc.feedItems>,
      tasks: JSON.parse(JSON.stringify(sc.tasks ?? [])) as NonNullable<typeof sc.tasks>,
      dictionaryEntries: [...(sc.dictionaryEntries ?? [])],
      dailyFocusNotes: {
        ...(sc.dailyFocusNotes ?? {}),
        ...JSON.parse(localStorage.getItem("mock:daily-focus-notes") ?? "{}"),
      },
      morningFocusEnabled: localStorage.getItem("mock:morning-focus-enabled") !== "false",
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
    const focusTasks: Array<{ item: any; completed_at: string | null; focus_rank: number }> =
      state.feedItems.filter((item) => sc.focusTaskIds?.includes(item.id))
        .map((item, index) => ({ item, completed_at: null, focus_rank: index + 1 }));
    const handlers: Record<string, (args: any) => unknown> = {
      get_wake_word_status: () => state.wakeStatus,
      set_wake_word_enabled: ({ enabled }) => {
        if (sc.wakeWordSaveError) throw new Error("Microphone access is required");
        state.wakeStatus = { enabled, state: enabled ? "listening" : "off", message: enabled ? "Listening for “Tucky”" : "Wake word is off" };
        (window as any).__MOCK_EMIT__("wakeword:status", state.wakeStatus);
      },
      get_voice_workflows: () => state.voiceWorkflows,
      set_voice_workflows: ({ workflows }) => {
        state.voiceWorkflows = workflows;
      },
      get_low_memory_mode: () => state.lowMemoryMode,
      set_low_memory_mode: (args: any) => {
        if (sc.memorySaveError) throw new Error("save failed");
        state.lowMemoryMode = args.enabled;
      },
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
        if (state.speechDownloadError) throw new Error(state.speechDownloadError);
        if (sc.speechDownloadDeferred) return new Promise<void>((resolve) => {
          (window as any).__FINISH_SPEECH_DOWNLOAD__ = () => { state.speechModelReady = true; resolve(); };
        });
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
      get_edit_selection_binding: () => binding,
      get_app_launcher_enabled: () => true,
      get_action_counter: () => 21,
      get_trigger_word_routing_enabled: () => false,
      get_action_trigger_word: () => "tucky",
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
      get_dictionary_entries: () => [...state.dictionaryEntries],
      set_dictionary_entries: (args: any) => {
        state.dictionaryEntries = [...args.entries];
      },
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
            transcriptions: state.captureCounts ? category(0, 0, 0, state.captureCounts.transcriptions ?? 0) : category(18, 86, 312, 2840),
            notes: state.captureCounts ? category(0, 0, 0, state.captureCounts.notes ?? 0) : category(3, 14, 52, 428),
            tasks: state.captureCounts ? category(0, 0, 0, state.captureCounts.tasks ?? 0) : category(2, 11, 39, 316),
            meetings: state.captureCounts ? category(0, 0, 0, state.captureCounts.meetings ?? 0, true) : category(1, 5, 18, 142, true),
            recordings: state.captureCounts ? category(0, 0, 0, state.captureCounts.recordings ?? 0, true) : category(1, 3, 12, 87, true),
          },
          daily_activity: dailyActivity,
        };
      },
      get_project_assistant_report: () => null,
      // Dashboard Focus section: a tiny in-memory store.
      list_focus_tasks: () => focusTasks.map((f) => ({ ...f, item: { ...f.item } })),
      get_daily_focus_note: (args: any) => state.dailyFocusNotes[args.localDate]
        ? { local_date: args.localDate, content: state.dailyFocusNotes[args.localDate], updated_at: "2026-09-25T12:00:00Z" }
        : null,
      get_morning_focus_enabled: () => state.morningFocusEnabled,
      set_morning_focus_enabled: (args: any) => {
        state.morningFocusEnabled = args.enabled;
        localStorage.setItem("mock:morning-focus-enabled", String(args.enabled));
        (window as any).__MOCK_EMIT__("morning-focus:enabled-changed", args.enabled);
      },
      desktop_pet_focus_set_visible: () => undefined,
      save_daily_focus_note: (args: any) => {
        state.dailyFocusNotes[args.localDate] = args.content.trim();
        localStorage.setItem("mock:daily-focus-notes", JSON.stringify(state.dailyFocusNotes));
        (window as any).__MOCK_EMIT__("daily-focus:changed", { local_date: args.localDate, content: state.dailyFocusNotes[args.localDate], updated_at: "2026-09-25T12:00:00Z" });
        return { local_date: args.localDate, content: state.dailyFocusNotes[args.localDate], updated_at: "2026-09-25T12:00:00Z" };
      },
      set_daily_focus_recording: (args: any) => {
        if (args.recording && sc.deferDailyFocusStart) {
          (window as any).__MOCK_DAILY_FOCUS_STARTED__ = () => (window as any).__MOCK_EMIT__("voice:recording_started", null);
        } else {
          (window as any).__MOCK_EMIT__(args.recording ? "voice:recording_started" : "voice:recording_stopped", null);
        }
      },
      set_task_focus: (args: any) => {
        const existing = focusTasks.findIndex((task) => task.item.id === args.itemId);
        if (args.focus && existing < 0) {
          const item = state.feedItems.find((row) => row.id === args.itemId);
          if (item) focusTasks.push({ item, completed_at: null, focus_rank: focusTasks.length + 1 });
        } else if (!args.focus && existing >= 0) {
          focusTasks.splice(existing, 1);
        }
        (window as any).__MOCK_EMIT__("focus:changed", null);
      },
      get_item: (args: any) => state.feedItems.find((item) => item.id === args.id) ?? focusTasks.find((task) => task.item.id === args.id)?.item ?? null,
      add_focus_task: (args: any) => {
        const now = "2026-09-25T12:00:00Z";
        const item = {
          id: `focus-${focusTasks.length + 1}-${Date.now()}`,
          content: args.content,
          source: "log_capture",
          kind: "task",
          project_id: args.projectId ?? null,
          captured_at: now,
          created_at: now,
          deleted_at: null,
          confidence: 1,
          classified_by: "user",
          capture_context: null,
          importance: null,
        };
        focusTasks.push({ item, completed_at: null, focus_rank: focusTasks.length + 1 });
        return item;
      },
      reorder_focus_tasks: (args: any) => {
        const byId = new Map(focusTasks.map((f) => [f.item.id, f]));
        const next = args.order
          .map((o: { item_id: string; project_id: string | null }, i: number) => {
            const f = byId.get(o.item_id);
            if (f) {
              f.item.project_id = o.project_id;
              f.focus_rank = i + 1;
            }
            return f;
          })
          .filter(Boolean);
        focusTasks.splice(0, focusTasks.length, ...next);
      },
      complete_task: (args: any) => {
        const f = focusTasks.find((x) => x.item.id === args.itemId);
        if (f) f.completed_at = "2026-09-25T12:00:00Z";
        const task = state.tasks.find((x) => x.item.id === args.itemId);
        if (task) task.completed_at = "2026-09-25T12:00:00Z";
      },
      uncomplete_task: (args: any) => {
        const f = focusTasks.find((x) => x.item.id === args.itemId);
        if (f) f.completed_at = null;
        const task = state.tasks.find((x) => x.item.id === args.itemId);
        if (task) task.completed_at = null;
      },
      // Activity feed + Tasks view.
      list_items: (args: any) =>
        state.feedItems
          .filter(
            (i) =>
              (!args.kind || i.kind === args.kind) &&
              (!args.projectId || i.project_id === args.projectId),
          )
          .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)),
      list_tasks: (args: any) =>
        state.tasks
          .filter((x) => (args.includeCompleted ? x.completed_at !== null : x.completed_at === null))
          .filter((x) => !args.projectId || x.item.project_id === args.projectId)
          .map((x) => JSON.parse(JSON.stringify(x))),
      list_tags_for_item: (args: any) => sc.itemTags?.[args.itemId] ?? [],
      delete_item: (args: any) => {
        const i = focusTasks.findIndex((x) => x.item.id === args.id);
        if (i >= 0) focusTasks.splice(i, 1);
      },
      update_item: (args: any) => {
        const f = focusTasks.find((x) => x.item.id === args.args.id);
        if (f && typeof args.args.content === "string") f.item.content = args.args.content;
        return f?.item ?? null;
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
        binary_path: "/Applications/Tucky.app/Contents/MacOS/Tucky",
        permissions: [
          { id: "knowledge_search", label: "Search captures & notes", description: "Search dictations and notes, and list projects and tasks. Read-only." },
          { id: "meetings", label: "Meetings & transcripts", description: "Read meeting transcripts, summaries, participants, and recipes. Read-only." },
          { id: "chats", label: "Chats", description: "Search and read your Tucky chat conversations. Read-only." },
          { id: "contacts", label: "People & companies", description: "Read confirmed people and company records. Read-only." },
          { id: "screen_recording", label: "Screen recording", description: "List windows and start/stop screen recordings with mic, system audio, and camera options. Requires Tucky to be running." },
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
      // Post-meeting debrief. Mutations update the in-memory debriefs so a
      // refetch reflects them, like the real backend.
      list_pending_debriefs: () => JSON.parse(JSON.stringify(state.debriefs)),
      accept_meeting_task_suggestion: (a) => {
        for (const d of state.debriefs) d.suggestions = d.suggestions.filter((s) => s.id !== a.suggestionId);
        return `task-from-${a.suggestionId}`;
      },
      dismiss_meeting_task_suggestion: (a) => {
        for (const d of state.debriefs) d.suggestions = d.suggestions.filter((s) => s.id !== a.suggestionId);
      },
      set_meeting_project: (a) => {
        const d = state.debriefs.find((x) => x.meetingId === a.meetingId);
        if (d) d.projectId = a.projectId ?? null;
      },
      add_meeting_participant: (a) => {
        const d = state.debriefs.find((x) => x.meetingId === a.meetingId);
        const person = state.people.find((p) => p.id === a.personId);
        if (d && person) {
          d.participants.push({
            meeting_id: a.meetingId,
            speaker_key: `manual:${person.id}`,
            person_id: person.id,
            display_name: person.name,
            source: "user",
            confirmed: true,
            created_at: "2026-09-25T10:00:00Z",
            updated_at: "2026-09-25T10:00:00Z",
          });
        }
      },
      remove_meeting_participant: (a) => {
        const d = state.debriefs.find((x) => x.meetingId === a.meetingId);
        if (d) d.participants = d.participants.filter((p) => p.speaker_key !== a.speakerKey);
      },
      complete_meeting_debrief: (a) => {
        state.debriefs = state.debriefs.filter((x) => x.meetingId !== a.meetingId);
      },
      set_task_assignee: () => undefined,
      "plugin:autostart|is_enabled": () => false,
      "plugin:event|listen": (args) => {
        const id = nextEventId++;
        listeners.set(id, { event: args.event, handler: args.handler });
        return id;
      },
      get_project_tagger_status: () => ({ running: false, stopping: false, paused: false, processed: 0, total: 0, assigned: 0 }),
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
