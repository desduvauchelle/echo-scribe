const now = "2026-07-30T17:42:00Z";
const projects = [
  ["echo", "Tucky"],
  ["livecase", "LiveCase"],
  ["pffc", "PFFC"],
  ["recursive", "Recursive Solutions"],
].map(([id, name]) => ({
  id,
  name,
  created_at: now,
  archived_at: null,
  description: null,
  keywords: [],
  color: null,
  emoji: null,
  updated_at: now,
  export_folder: null,
  routing_aliases: [],
  routing_app_hints: [],
  routing_url_hints: [],
  routing_window_hints: [],
  routing_positive_examples: [],
  routing_negative_examples: [],
}));

const meetingRow = {
  item_id: "meeting-1",
  started_at: "2026-07-30T17:21:00Z",
  ended_at: "2026-07-30T17:59:00Z",
  duration_ms: 2_280_000,
  detected_app: "com.google.Chrome",
  detected_app_name: "Google Meet",
  status: "complete",
  transcript_json: JSON.stringify({
    segments: [
      { speaker: "you", start_ms: 0, end_ms: 9_000, text: "Let's lock the delivery milestones for the content push." },
      { speaker: "them", start_ms: 9_000, end_ms: 21_000, text: "Design hand-off lands Friday, then engineering owns the rollout." },
      { speaker: "you", start_ms: 21_000, end_ms: 30_000, text: "I'll share the delivery plan with both teams after this call." },
    ],
    duration_ms: 2_280_000,
    asr_model: "parakeet",
    chunk_seconds: 30,
    failed_chunk_count: 0,
    mic_only: false,
  }),
  summary_json: JSON.stringify({
    markdown: [
      "## Summary",
      "- Aligned on content delivery milestones and technical ownership.",
      "- Design hand-off lands Friday; engineering owns the rollout after that.",
      "",
      "## Decisions",
      "- The delivery plan is the single source of truth for both teams.",
      "",
      "## Next steps",
      "- Share the delivery plan with design and engineering.",
    ].join("\n"),
    suggested_title: "Product delivery sync",
    tags: ["planning"],
  }),
  user_notes: null,
  failed_chunk_count: 0,
  mic_only: false,
  project_name: "Recursive Solutions",
};

const items = [
  {
    id: "voice-1",
    content: "Can we make the version checker compare the installed build before asking to update?",
    source: "voice_at_cursor",
    kind: "transcription",
    project_id: "echo",
    captured_at: "2026-07-30T17:39:00Z",
    created_at: "2026-07-30T17:39:00Z",
    deleted_at: null,
    confidence: 0.96,
    classified_by: "router",
    capture_context: null,
  },
  {
    id: "note-1",
    content: "Keep the dashboard calm and let the content establish the hierarchy.",
    source: "log_capture",
    kind: "note",
    project_id: "echo",
    captured_at: "2026-07-30T16:58:00Z",
    created_at: "2026-07-30T16:58:00Z",
    deleted_at: null,
    confidence: 0.91,
    classified_by: "local_ai",
    capture_context: null,
  },
  {
    id: "task-1",
    content: "Add semantic version comparison to the update prompt",
    source: "log_capture",
    kind: "task",
    project_id: "recursive",
    captured_at: "2026-07-30T16:41:00Z",
    created_at: "2026-07-30T16:41:00Z",
    deleted_at: null,
    confidence: 0.93,
    classified_by: "local_ai",
    capture_context: null,
  },
];

const category = (today: number, week: number, duration = 0) => ({
  today: { count: today, words: today * 186, duration_ms: duration },
  week: { count: week, words: week * 186, duration_ms: duration },
  month: { count: week * 4, words: week * 744, duration_ms: duration * 4 },
  all_time: { count: week * 20, words: week * 3720, duration_ms: duration * 20 },
});

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  permissions_status: () => ({ microphone: true, accessibility: true, screen_recording: true, camera: true }),
  platform_capabilities: () => ({
    direct_voice_capture: true,
    local_database: true,
    meeting_auto_detect: true,
    system_audio_capture: true,
    screen_recording: true,
    bundle_self_update: true,
  }),
  get_onboarding_completed: () => true,
  list_speech_models: () => [{ id: "parakeet", active: true, downloaded: true }],
  start_pipeline: () => undefined,
  smoke_checkpoint: () => undefined,
  get_voice_at_cursor_binding: () => ({ primary: "ControlRight", modifiers: [] }),
  list_projects: () => projects,
  list_items: (args) => {
    const kind = args.kind as string | undefined;
    return kind ? items.filter((item) => item.kind === kind) : items;
  },
  list_tags_for_item: () => ["planning", "delivery"],
  list_meetings: () => [meetingRow],
  get_meeting: () => meetingRow,
  get_item: (args) =>
    args.id === "meeting-1"
      ? {
          id: "meeting-1",
          content: "[Summary]\nAligned on delivery milestones.\n\n[Transcript]\nYou: hi\n",
          source: "meeting",
          kind: null,
          project_id: "recursive",
          captured_at: "2026-07-30T17:21:00Z",
          created_at: "2026-07-30T17:21:00Z",
          deleted_at: null,
          confidence: null,
          classified_by: null,
          capture_context: null,
        }
      : (items.find((item) => item.id === args.id) ?? null),
  list_summary_templates: () => [
    {
      id: "builtin-general",
      name: "General",
      description: "Balanced notes for any conversation",
      instructions: "Summarize the key points, decisions, risks, and next steps.",
      sections_json: '["Summary","Decisions","Action items"]',
      is_builtin: true,
      archived_at: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: "builtin-sales-summary",
      name: "Sales",
      description: "Discovery, objections, commitments, and follow-up",
      instructions: "Emphasize goals, objections, commitments, and next steps.",
      sections_json: '["Goals","Objections","Next steps"]',
      is_builtin: true,
      archived_at: null,
      created_at: now,
      updated_at: now,
    },
  ],
  get_meeting_preferences: () => null,
  list_meeting_participants: () => [
    {
      meeting_id: "meeting-1",
      speaker_key: "them",
      person_id: null,
      display_name: "Jordan",
      source: "manual",
      confirmed: true,
      created_at: now,
      updated_at: now,
    },
  ],
  list_people: () => [],
  list_recordings: () => [
    {
      id: "recording-1",
      created_at: Date.parse("2026-07-30T16:15:00Z"),
      file_path: "/tmp/dashboard-walkthrough.mp4",
      duration_ms: 720_000,
      width: 1440,
      height: 900,
      size_bytes: 18_400_000,
      source_label: "Display 1",
      has_mic: true,
      has_sysaudio: true,
      thumb_path: null,
      drive_file_id: null,
      drive_link: null,
      upload_status: "local",
      upload_error: null,
      exports: "[]",
      title: "Dashboard walkthrough",
      transcript: null,
      denoised_path: null,
      events_path: null,
      project_json: null,
      webcam_path: null,
      cursor_hidden: false,
      webcam_offset_ms: null,
      n_events: null,
      n_clicks: null,
      project_id: "echo",
      confidence: 0.94,
      classified_by: "router",
    },
  ],
  get_dashboard_stats: () => ({
    today: { transcriptions: 3, words: 740 },
    week: { transcriptions: 18, words: 4280 },
    month: { transcriptions: 62, words: 15100 },
    all_time: { transcriptions: 420, words: 98200 },
    daily_counts: [],
    current_streak: 6,
    longest_streak: 18,
    avg_words_per_capture: 186,
    busiest_hour: 10,
    categories: {
      transcriptions: category(3, 18),
      notes: category(2, 12),
      tasks: category(4, 26),
      meetings: category(1, 5, 13_680_000),
      recordings: category(1, 4, 3_120_000),
    },
    daily_activity: [],
  }),
  daily_summary_get: () => ({
    date: "2026-07-29",
    generated_at: now,
    status: "generated",
    narrative: "The day focused on content delivery strategy, dashboard refinement, and version-checker reliability.",
    sections: { meetings: [], focus_work: [], notes: [], things_that_came_up: [] },
    source_meeting_ids: [],
    source_item_ids: [],
    model_version: "gemma",
  }),
  is_meeting_recording: () => false,
  is_screen_recording: () => false,
  "plugin:event|listen": () => Math.floor(Math.random() * 100000),
  "plugin:event|unlisten": () => undefined,
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
    currentWebviewWindow: { label: "main" },
  },
  transformCallback(callback: (value: unknown) => void) {
    const id = Math.floor(Math.random() * 1_000_000_000);
    (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
    return id;
  },
  unregisterListener() {
    return undefined;
  },
  invoke(command: string, args: Record<string, unknown> = {}) {
    const handler = handlers[command];
    if (handler) return Promise.resolve(handler(args));
    if (/^(list_|search_)/.test(command)) return Promise.resolve([]);
    if (/^(get_|is_)/.test(command)) return Promise.resolve(false);
    return Promise.resolve(undefined);
  },
};

localStorage.setItem("echoScribe.themePref", "light");
await import("../src/main");
