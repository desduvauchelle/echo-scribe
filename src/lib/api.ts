import { invoke } from "@tauri-apps/api/core";

export type ModKind = "Control" | "Shift" | "Alt" | "Meta";
export type ModSide = "Left" | "Right" | "Either";

export type JsBinding = {
  primary: string;
  modifiers: { kind: ModKind; side: ModSide }[];
};

export type PermissionsStatus = {
  microphone: boolean;
  accessibility: boolean;
  screen_recording: boolean;
  calendars: boolean;
};

export const permissionsStatus = (): Promise<PermissionsStatus> =>
  invoke("permissions_status");

export const openMicrophoneSettings = (): Promise<void> =>
  invoke("open_microphone_settings");

export const openAccessibilitySettings = (): Promise<void> =>
  invoke("open_accessibility_settings");

export const openScreenRecordingSettings = (): Promise<void> =>
  invoke("open_screen_recording_settings");

export const openCalendarSettings = (): Promise<void> =>
  invoke("open_calendar_settings");

export const requestMicrophoneAccess = (): Promise<boolean> =>
  invoke("request_microphone_access");

export const promptAccessibilityAccess = (): Promise<boolean> =>
  invoke("prompt_accessibility_access");

export const requestScreenRecordingAccess = (): Promise<boolean> =>
  invoke("request_screen_recording_access");

export const promptCalendarAccess = (): Promise<boolean> =>
  invoke("prompt_calendar_access");

export const getVoiceAtCursorBinding = (): Promise<JsBinding> =>
  invoke("get_voice_at_cursor_binding");

export const updateVoiceAtCursorBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_voice_at_cursor_binding", { binding });

export const getLogCaptureBinding = (): Promise<JsBinding> =>
  invoke("get_log_capture_binding");

export const updateLogCaptureBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_log_capture_binding", { binding });

export const getActionBinding = (): Promise<JsBinding> =>
  invoke("get_action_binding");

export const updateActionBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_action_binding", { binding });

export const getTriggerWordRoutingEnabled = (): Promise<boolean> =>
  invoke("get_trigger_word_routing_enabled");

export const setTriggerWordRoutingEnabled = (enabled: boolean): Promise<void> =>
  invoke("set_trigger_word_routing_enabled", { enabled });

export const getActionTriggerWord = (): Promise<string> =>
  invoke("get_action_trigger_word");

export const setActionTriggerWord = (word: string): Promise<void> =>
  invoke("set_action_trigger_word", { word });

export type Classification = {
  kind: "note" | "task";
  project_id: string | null;
  new_project_name: string | null;
  tags: string[];
  deadline_iso: string | null;
  confidence: number;
};

export type LogCaptureClassificationReady = {
  transcript: string;
  classification: Classification | null;
  error?: string;
};

export const confirmLogCapture = (args: {
  content: string;
  kind: "note" | "task";
  project_id: string | null;
  new_project_name: string | null;
  tags: string[];
  deadline_iso: string | null;
}): Promise<string> =>
  invoke("confirm_log_capture", {
    content: args.content,
    kind: args.kind,
    projectId: args.project_id,
    newProjectName: args.new_project_name,
    tags: args.tags,
    deadlineIso: args.deadline_iso,
  });

export const cancelLogCapture = (): Promise<void> =>
  invoke("cancel_log_capture");

export const startPipeline = (): Promise<void> => invoke("start_pipeline");

export const isPipelineRunning = (): Promise<boolean> =>
  invoke("is_pipeline_running");

export type SpeechModelStatus = {
  id: string;
  display_name: string;
  version_label: string;
  description: string;
  language_label: string;
  english_only: boolean;
  accuracy_bars: number;
  speed_bars: number;
  size_label: string;
  size_bytes: number;
  downloaded: boolean;
  active: boolean;
  supported: boolean;
};

export type DownloadProgress = {
  id: string;
  bytes_downloaded: number;
  bytes_total: number;
};

export const listSpeechModels = (): Promise<SpeechModelStatus[]> =>
  invoke("list_speech_models");

export const downloadSpeechModel = (id: string): Promise<void> =>
  invoke("download_speech_model", { id });

export const getActiveSpeechModelId = (): Promise<string> =>
  invoke("get_active_speech_model_id");

export const setActiveSpeechModel = (id: string): Promise<void> =>
  invoke("set_active_speech_model", { id });

export const deleteSpeechModel = (id: string): Promise<void> =>
  invoke("delete_speech_model", { id });

// ----- Items / projects / tasks -----

export type ItemKind = "note" | "task" | "meeting" | "transcription";
export type ItemSource = "voice_at_cursor" | "log_capture" | "meeting";

export type Item = {
  id: string;
  content: string;
  source: ItemSource;
  kind: ItemKind | null;
  project_id: string | null;
  captured_at: string;
  created_at: string;
  deleted_at: string | null;
  confidence: number | null;
  classified_by: string | null;
  /** JSON-serialized FocusContext, if captured at recording time. */
  capture_context: string | null;
};

/** Parsed shape of the JSON stored in `Item.capture_context`. All fields optional. */
export type ParsedCaptureContext = {
  pid?: number;
  bundle_id?: string | null;
  app_name?: string | null;
  window_title?: string | null;
  browser_url?: string | null;
  browser_tab_title?: string | null;
};

export function parseCaptureContext(raw: string | null | undefined): ParsedCaptureContext | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return null;
    return obj as ParsedCaptureContext;
  } catch {
    return null;
  }
}

export type Project = {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
};

export type TaskWithItem = {
  item: Item;
  deadline: string | null;
  completed_at: string | null;
};

export const listItems = (args: {
  project_id?: string | null;
  /** Restrict to one kind. "meeting" also matches items captured during a
   *  meeting (source = "meeting"). Omit for all kinds. */
  kind?: ItemKind | null;
  limit?: number;
  offset?: number;
}): Promise<Item[]> =>
  invoke("list_items", {
    projectId: args.project_id ?? null,
    kind: args.kind ?? null,
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
  });

export const getItem = (id: string): Promise<Item | null> =>
  invoke("get_item", { id });

export const searchItems = (
  query: string,
  opts: { kind?: ItemKind | null; limit?: number } = {},
): Promise<Item[]> =>
  invoke("search_items", {
    query,
    kind: opts.kind ?? null,
    limit: opts.limit ?? 50,
  });

export const deleteItem = (id: string): Promise<void> =>
  invoke("delete_item", { id });

export const restoreItem = (id: string): Promise<void> =>
  invoke("restore_item", { id });

export const listTagsForItem = (item_id: string): Promise<string[]> =>
  invoke("list_tags_for_item", { itemId: item_id });

/** Update an item. Each field is optional: omit to leave alone.
 *  For project_id: pass `undefined` to leave alone, `null` to clear,
 *  or a string id to set. */
export type UpdateItemInput = {
  id: string;
  content?: string;
  /** undefined = leave alone, null = clear, string = set */
  project_id?: string | null;
  /** undefined = leave alone, "" = clear, "note"|"task" = set */
  kind?: "" | ItemKind;
  /** undefined = leave alone, [] / [...] = replace tag set */
  tags?: string[];
};

export const updateItem = (input: UpdateItemInput): Promise<Item> => {
  // Convert TS undefined-vs-null semantics into the double-Option JSON shape:
  // - field absent → backend `Option<None>` (leave alone)
  // - field null   → backend `Option<Some(None)>` (clear)
  // - field set    → backend `Option<Some(value))` (set)
  const args: Record<string, unknown> = { id: input.id };
  if (input.content !== undefined) args.content = input.content;
  if ("project_id" in input) {
    // explicit (null or string)
    args.project_id = input.project_id;
  }
  if (input.kind !== undefined) args.kind = input.kind;
  if (input.tags !== undefined) args.tags = input.tags;
  return invoke("update_item", { args });
};

export const listProjects = (include_archived = false): Promise<Project[]> =>
  invoke("list_projects", { includeArchived: include_archived });

export const createProject = (name: string): Promise<Project> =>
  invoke("create_project", { name });

export const renameProject = (id: string, name: string): Promise<void> =>
  invoke("rename_project", { id, name });

export const archiveProject = (id: string): Promise<void> =>
  invoke("archive_project", { id });

export const unarchiveProject = (id: string): Promise<void> =>
  invoke("unarchive_project", { id });

export const countItemsForProject = (id: string): Promise<number> =>
  invoke("count_items_for_project", { id });

export const listTasks = (args: {
  include_completed?: boolean;
  project_id?: string | null;
}): Promise<TaskWithItem[]> =>
  invoke("list_tasks", {
    includeCompleted: args.include_completed ?? false,
    projectId: args.project_id ?? null,
  });

export const completeTask = (item_id: string): Promise<void> =>
  invoke("complete_task", { itemId: item_id });

export const uncompleteTask = (item_id: string): Promise<void> =>
  invoke("uncomplete_task", { itemId: item_id });

export const setTaskDeadline = (
  item_id: string,
  deadline_iso: string | null,
): Promise<void> =>
  invoke("set_task_deadline", { itemId: item_id, deadlineIso: deadline_iso });

// ----- LLM -----

export type LlmModelStatus = {
  id: string;
  display_name: string;
  family: string;
  size_label: string;
  size_bytes: number;
  context_length: number;
  downloaded: boolean;
  active: boolean;
  supported: boolean;
};

export const listLlmModels = (): Promise<LlmModelStatus[]> =>
  invoke("list_llm_models");

export const downloadLlmModel = (id: string): Promise<void> =>
  invoke("download_llm_model", { id });

export const getActiveLlmModelId = (): Promise<string> =>
  invoke("get_active_llm_model_id");

export const setActiveLlmModel = (id: string): Promise<void> =>
  invoke("set_active_llm_model", { id });

export const deleteLlmModel = (id: string): Promise<void> =>
  invoke("delete_llm_model", { id });

export const testLlmInference = (prompt: string): Promise<string> =>
  invoke("test_llm_inference", { prompt });

// ----- Memory chat -----

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatSession = {
  id: string;
  name: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatMessage = {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export const createChatSession = (
  projectId: string | null,
): Promise<ChatSession> =>
  invoke("create_chat_session", { projectId });

export const listChatSessions = (
  projectId: string | null,
): Promise<ChatSession[]> =>
  invoke("list_chat_sessions", { projectId });

export const loadChatMessages = (sessionId: string): Promise<ChatMessage[]> =>
  invoke("load_chat_messages", { sessionId });

export const deleteChatSession = (sessionId: string): Promise<void> =>
  invoke("delete_chat_session", { sessionId });

export const renameChatSession = (
  sessionId: string,
  name: string,
): Promise<void> => invoke("rename_chat_session", { sessionId, name });

export type ContextSource = {
  date: string;
  kind: string;
  content: string;
};

export type ChatReply = {
  reply: string;
  sources: ContextSource[];
};

export const chatWithMemory = (
  sessionId: string,
  message: string,
  projectId?: string | null,
): Promise<ChatReply> =>
  invoke("chat_with_memory", {
    sessionId,
    message,
    projectId: projectId ?? null,
  });

export const resetOnboardingAndQuit = (): Promise<void> =>
  invoke("reset_onboarding_and_quit");

// ----- Audio feedback + onboarding flag -----

export const getAudioFeedbackEnabled = (): Promise<boolean> =>
  invoke("get_audio_feedback_enabled");

export const setAudioFeedbackEnabled = (enabled: boolean): Promise<void> =>
  invoke("set_audio_feedback_enabled", { enabled });

export const getMuteWhileRecording = (): Promise<boolean> =>
  invoke("get_mute_while_recording");

export const setMuteWhileRecording = (enabled: boolean): Promise<void> =>
  invoke("set_mute_while_recording", { enabled });

// ----- Transcription post-processing -----

export const getFillerRemovalEnabled = (): Promise<boolean> =>
  invoke("get_filler_removal_enabled");

export const setFillerRemovalEnabled = (enabled: boolean): Promise<void> =>
  invoke("set_filler_removal_enabled", { enabled });

export const getFillerWords = (): Promise<string[]> => invoke("get_filler_words");

export const setFillerWords = (words: string[]): Promise<void> =>
  invoke("set_filler_words", { words });

export const getCustomWords = (): Promise<string[]> => invoke("get_custom_words");

export const setCustomWords = (words: string[]): Promise<void> =>
  invoke("set_custom_words", { words });

export const getDefaultFillerWords = (): Promise<string[]> =>
  invoke("get_default_filler_words");

export const resetTccAndQuit = (): Promise<void> => invoke("reset_tcc_and_quit");

export const getOnboardingCompleted = (): Promise<boolean> =>
  invoke("get_onboarding_completed");

export const setOnboardingCompleted = (completed: boolean): Promise<void> =>
  invoke("set_onboarding_completed", { completed });

// ----- Tray-driven UI helpers -----

export const showMainWindow = (): Promise<void> => invoke("show_main_window");

// ----- Diagnostics -----

export const diagnosticsLogDir = (): Promise<string> =>
  invoke("diagnostics_log_dir");

export const diagnosticsRecentLog = (maxLines = 200): Promise<string> =>
  invoke("diagnostics_recent_log", { maxLines });

export const diagnosticsOpenLogFolder = (): Promise<void> =>
  invoke("diagnostics_open_log_folder");

export const getLlmUnloadSecs = (): Promise<number> =>
  invoke("get_llm_unload_secs");

export const setLlmUnloadSecs = (secs: number): Promise<void> =>
  invoke("set_llm_unload_secs", { secs });

export const getAsrUnloadSecs = (): Promise<number> =>
  invoke("get_asr_unload_secs");

export const setAsrUnloadSecs = (secs: number): Promise<void> =>
  invoke("set_asr_unload_secs", { secs });

export const applyUpdateAndRestart = (): Promise<void> =>
  invoke("apply_update_and_restart");

export const dismissUpdate = (version: string): Promise<void> =>
  invoke("dismiss_update", { version });

// ----- Auto-file (confident captures) -----

export type LogCaptureAutoFiled = {
  item_id: string;
  project_name: string;
  kind: "note" | "task";
  preview: string;
  confidence: number;
};

export const undoLogCapture = (itemId: string): Promise<void> =>
  invoke("undo_log_capture", { itemId });

export const getAutoFileEnabled = (): Promise<boolean> =>
  invoke("get_auto_file_enabled");

export const setAutoFileEnabled = (enabled: boolean): Promise<void> =>
  invoke("set_auto_file_enabled", { enabled });

export const getAutoFileThreshold = (): Promise<number> =>
  invoke("get_auto_file_threshold");

export const setAutoFileThreshold = (threshold: number): Promise<void> =>
  invoke("set_auto_file_threshold", { threshold });

// ----- Item events (lifecycle log) -----

export type ItemEvent = {
  id: string;
  item_id: string;
  event_type: string;
  detail: string | null;
  created_at: string;
};

export const listItemEvents = (itemId: string): Promise<ItemEvent[]> =>
  invoke("list_item_events", { itemId });

export const listSessionsForItem = (
  itemId: string,
): Promise<ChatSession[]> =>
  invoke("list_sessions_for_item", { itemId });

// ----- Claude Code session transcript -----

export type ClaudeSessionSummary = {
  session_id: string;
  preview: string;
  message_count: number;
  timestamp: string;
};

export type ClaudeSessionMessage = {
  role: string;
  content: string;
  timestamp: string;
};

export const listClaudeSessions = (): Promise<ClaudeSessionSummary[]> =>
  invoke("list_claude_sessions");

export const loadClaudeSession = (
  sessionId: string,
): Promise<ClaudeSessionMessage[]> =>
  invoke("load_claude_session", { sessionId });

// ----- Dashboard analytics -----

export type PeriodStats = {
  transcriptions: number;
  words: number;
};

export type DashboardStats = {
  today: PeriodStats;
  week: PeriodStats;
  month: PeriodStats;
  all_time: PeriodStats;
  /** [date_str, count] tuples for last 90 days, oldest first */
  daily_counts: [string, number][];
  current_streak: number;
  longest_streak: number;
  avg_words_per_capture: number;
  /** Busiest hour 0-23, or null if no data */
  busiest_hour: number | null;
};

export const getDashboardStats = (): Promise<DashboardStats> =>
  invoke("get_dashboard_stats");

// ============= Meetings =============

export type MeetingStatus =
  | "recording"
  | "transcribing"
  | "summarizing"
  | "complete"
  | "failed"
  | "recovered";

export type MeetingRow = {
  item_id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  detected_app: string | null;
  detected_app_name: string | null;
  status: MeetingStatus;
  transcript_json: string | null;
  summary_json: string | null;
  user_notes: string | null;
  failed_chunk_count: number;
  mic_only: boolean;
  /// Snapshot of the matched calendar event (JSON-encoded
  /// `CalendarMatch`) at the time the meeting was recorded. `null` when
  /// no event matched, calendar access wasn't granted, or the sidecar
  /// failed.
  calendar_match_json: string | null;
  /// Project name resolved via the meeting's item.project_id at read time.
  /// `null` when unassigned. Reflects later reassignment from the detail panel.
  project_name: string | null;
};

export type CalendarAttendee = {
  name: string | null;
  email: string | null;
  self: boolean;
  role: string | null;
};

export type CalendarMatch = {
  title: string | null;
  organizer: CalendarAttendee | null;
  attendees: CalendarAttendee[];
  starts_at: string;
  ends_at: string;
  notes: string | null;
  calendar_name: string | null;
  conferencing_url: string | null;
  match_score: number;
  match_reason: string;
};

export type MatchOutcome = {
  best: CalendarMatch;
  candidates: CalendarMatch[];
};

export const matchMeetingCalendar = (
  iso_start: string,
  iso_end: string,
  conf_hint?: string | null,
): Promise<MatchOutcome | null> =>
  invoke("match_meeting_calendar", {
    isoStart: iso_start,
    isoEnd: iso_end,
    confHint: conf_hint ?? null,
  });

export const setMeetingCalendarMatch = (
  id: string,
  match: CalendarMatch | null,
): Promise<void> => invoke("set_meeting_calendar_match", { id, match });

/// Parse the `calendar_match_json` column on a `MeetingRow` into a
/// `CalendarMatch` object. Returns `null` when the column is null or
/// the JSON is malformed (logged as a console warning).
export function parseCalendarMatch(
  row: Pick<MeetingRow, "calendar_match_json">,
): CalendarMatch | null {
  if (!row.calendar_match_json) return null;
  try {
    return JSON.parse(row.calendar_match_json) as CalendarMatch;
  } catch (e) {
    console.warn("calendar_match_json parse failed", e);
    return null;
  }
}

export type Segment = {
  speaker: "you" | "them";
  start_ms: number;
  end_ms: number;
  text: string;
};

export type StoredTranscript = {
  segments: Segment[];
  duration_ms: number;
  asr_model: string;
  chunk_seconds: number;
  failed_chunk_count: number;
  mic_only: boolean;
};

export type StoredSummary = {
  summary: string[];
  action_items: {
    text: string;
    owner: "you" | "them" | "unspecified";
    tags?: string[];
    project_name?: string | null;
  }[];
  suggested_title: string;
  raw?: string | null;
  tags?: string[];
  project_name?: string | null;
};

export const startMeetingManual = (): Promise<string> => invoke("start_meeting_manual");
export const stopMeeting = (): Promise<string> => invoke("stop_meeting");
export const isMeetingActive = (): Promise<boolean> => invoke("is_meeting_active");
export const getMeeting = (id: string): Promise<MeetingRow | null> =>
  invoke("get_meeting", { id });
export const listMeetings = (): Promise<MeetingRow[]> => invoke("list_meetings");
export const updateMeetingNotes = (id: string, notes: string): Promise<void> =>
  invoke("update_meeting_notes", { id, notes });
export const renameMeeting = (id: string, title: string): Promise<void> =>
  invoke("rename_meeting", { id, title });
export const deleteMeeting = (id: string): Promise<void> =>
  invoke("delete_meeting", { id });

export type MeetingSettings = {
  auto_detect: boolean;
  app_prefs: Record<string, "always" | "ask" | "never">;
  soft_warn_min: number;
  hard_cap_min: number;
  summary_prompt: string;
};

export const getMeetingSettings = (): Promise<MeetingSettings> =>
  invoke("get_meeting_settings");

export const setMeetingSummaryPrompt = (prompt: string): Promise<void> =>
  invoke("set_meeting_summary_prompt", { prompt });

export const setMeetingAutoDetect = (on: boolean): Promise<void> =>
  invoke("set_meeting_auto_detect", { on });

export const setMeetingAppPref = (
  bundle_id: string,
  pref: "always" | "ask" | "never",
): Promise<void> => invoke("set_meeting_app_pref", { bundleId: bundle_id, pref });

export const clearMeetingAppPref = (bundle_id: string): Promise<void> =>
  invoke("meeting_clear_app_pref", { bundleId: bundle_id });

export const retryMeetingSummary = (id: string): Promise<void> =>
  invoke("retry_meeting_summary", { id });
export const retryMeetingChunks = (id: string): Promise<void> =>
  invoke("retry_meeting_chunks", { id });

// ----- Input device selection -----

export interface InputDevice {
  name: string;
  sample_rate: number;
  channels: number;
  is_system_default: boolean;
}

export type InputDeviceSort = "last_used" | "alphabetical";

export const listInputDevices = (): Promise<InputDevice[]> =>
  invoke("list_input_devices");

export const getPreferredInputDevice = (): Promise<string | null> =>
  invoke("get_preferred_input_device");

export const setPreferredInputDevice = (name: string | null): Promise<void> =>
  invoke("set_preferred_input_device", { name });

export const getRecentInputDevices = (): Promise<string[]> =>
  invoke("get_recent_input_devices");

export const getInputDeviceSort = (): Promise<InputDeviceSort> =>
  invoke("get_input_device_sort");

export const setInputDeviceSort = (sort: InputDeviceSort): Promise<void> =>
  invoke("set_input_device_sort", { sort });

// ---------------------------------------------------------------------------
// Daily recap
// ---------------------------------------------------------------------------

export type DailySummaryStatus = "generated" | "skipped_empty" | "failed";

export type DailySummarySectionItem = {
  text: string;
  source_id?: string | null;
};

export type DailySummarySections = {
  meetings?: DailySummarySectionItem[];
  focus_work?: DailySummarySectionItem[];
  notes?: DailySummarySectionItem[];
  things_that_came_up?: DailySummarySectionItem[];
};

export type DailySummary = {
  date: string;
  generated_at: string;
  status: DailySummaryStatus;
  narrative: string;
  sections: DailySummarySections;
  source_meeting_ids: string[];
  source_item_ids: string[];
  model_version: string;
};

export type DailyRecapSettings = {
  enabled: boolean;
  deliver_hour: number;
  include_weekends: boolean;
};

export const getDailySummary = (date: string): Promise<DailySummary | null> =>
  invoke("daily_summary_get", { date });

export const listRecentDailySummaries = (
  limit: number,
): Promise<DailySummary[]> => invoke("daily_summary_list_recent", { limit });

export const regenerateDailySummary = (date: string): Promise<DailySummary> =>
  invoke("daily_summary_regenerate", { date });

export const getDailyRecapSettings = (): Promise<DailyRecapSettings> =>
  invoke("daily_recap_settings_get");

export const setDailyRecapSettings = (
  settings: DailyRecapSettings,
): Promise<void> => invoke("daily_recap_settings_set", { settings });

export const dailyRecapNotificationPermissionStatus = (): Promise<boolean> =>
  invoke("daily_recap_notification_permission_status");

// ===================== Guide templates =====================

export type GuideTemplate = {
  id: string;
  name: string;
  description: string;
  goal: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

export const listGuideTemplates = (): Promise<GuideTemplate[]> =>
  invoke("list_guide_templates");

export const createGuideTemplate = (
  name: string,
  description: string,
  goal: string,
  notes: string,
): Promise<GuideTemplate> =>
  invoke("create_guide_template", { name, description, goal, notes });

export const updateGuideTemplate = (
  id: string,
  name: string,
  description: string,
  goal: string,
  notes: string,
): Promise<void> =>
  invoke("update_guide_template", { id, name, description, goal, notes });

export const deleteGuideTemplate = (id: string): Promise<void> =>
  invoke("delete_guide_template", { id });

export const startGuidedSession = (templateId: string): Promise<string> =>
  invoke("start_guided_session", { templateId });

export const guideSetMode = (mode: "auto" | "on_demand"): Promise<void> =>
  invoke("guide_set_mode", { mode });

export const guideTriggerNow = (): Promise<void> => invoke("guide_trigger_now");

export const guideEnd = (): Promise<string> => invoke("guide_end");

export type GuideKeyPoint = {
  id: string;
  label: string;
  status: "covered" | "partial" | "open" | string;
};

export type GuideUpdate = {
  meetingId: string;
  templateName?: string;
  goal?: string;
  mode: "auto" | "on_demand";
  keyPoints: GuideKeyPoint[];
  suggestions: string[];
  updatedAt: string;
};

export type CommonActionTemplate = {
  category: string;
  description: string;
  voice_phrases: string[];
};

export const getAppLauncherEnabled = (): Promise<boolean> =>
  invoke("get_app_launcher_enabled");

export const setAppLauncherEnabled = (enabled: boolean): Promise<void> =>
  invoke("set_app_launcher_enabled", { enabled });

export const getActionCounter = (): Promise<number> =>
  invoke("get_action_counter");

export const resetActionCounter = (): Promise<void> =>
  invoke("reset_action_counter");

export const getCommonActions = (): Promise<CommonActionTemplate[]> =>
  invoke("get_common_actions");

// ============= Screen Recordings =============

export type RecordingRow = {
  id: string;
  created_at: number;
  file_path: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  source_label: string | null;
  has_mic: boolean;
  has_sysaudio: boolean;
  thumb_path: string | null;
  drive_file_id: string | null;
  drive_link: string | null;
  upload_status: string;
  upload_error: string | null;
  exports: string;
  title: string | null;
  transcript: string | null;
  denoised_path: string | null;
};

export const startScreenRecording = (p: {
  display_id?: number | null;
  window_id?: number | null;
  mic_device?: string | null;
  sysaudio: boolean;
  source_label: string;
}): Promise<void> =>
  invoke("start_screen_recording", {
    displayId: p.display_id ?? null,
    windowId: p.window_id ?? null,
    micDevice: p.mic_device ?? null,
    sysaudio: p.sysaudio,
    sourceLabel: p.source_label,
  });
export const stopScreenRecording = (): Promise<RecordingRow> =>
  invoke("stop_screen_recording");
export const isScreenRecording = (): Promise<boolean> =>
  invoke("is_screen_recording");
export const listRecordings = (): Promise<RecordingRow[]> =>
  invoke("list_recordings");
export const deleteRecording = (id: string): Promise<void> =>
  invoke("delete_recording", { id });
export const renameRecording = (id: string, title: string): Promise<void> =>
  invoke("rename_recording", { id, title });
export const transcribeRecording = (id: string): Promise<string> =>
  invoke("transcribe_recording", { id });
export const denoiseRecording = (id: string): Promise<void> =>
  invoke("denoise_recording", { id });
export const revealRecording = (id: string): Promise<void> =>
  invoke("reveal_recording", { id });

export const exportRecording = (
  id: string,
  quality: "1080" | "720" | "480",
): Promise<RecordingRow> => invoke("export_recording", { id, quality });

export type DriveStatus = {
  connected: boolean;
  email: string | null;
};

export const driveStatus = (): Promise<DriveStatus> => invoke("drive_status");
export const driveConnect = (): Promise<DriveStatus> => invoke("drive_connect");
export const driveDisconnect = (): Promise<void> => invoke("drive_disconnect");
export const getDriveClientId = (): Promise<string> => invoke("get_drive_client_id");
export const setDriveClientCredentials = (
  clientId: string,
  clientSecret: string,
): Promise<void> => invoke("set_drive_client_credentials", { clientId, clientSecret });
export const uploadRecording = (
  id: string,
  quality: "original" | "1080" | "720" | "480",
  makePublic?: boolean,
): Promise<RecordingRow> =>
  invoke("upload_recording", { id, quality, makePublic: makePublic ?? null });

export type DrivePrefs = {
  folder_name: string;
  make_public: boolean;
};

export const getDrivePrefs = (): Promise<DrivePrefs> => invoke("get_drive_prefs");

export const setDrivePrefs = (
  folderName: string,
  makePublic: boolean,
): Promise<void> => invoke("set_drive_prefs", { folderName, makePublic });

export type DisplaySource = { id: number; width: number; height: number; label: string };
export type WindowSource = { id: number; app: string; title: string; width: number; height: number; thumb: string };
export type ScreenSources = { displays: DisplaySource[]; windows: WindowSource[] };
export const listScreenSources = (): Promise<ScreenSources> =>
  invoke("list_screen_sources");

export type ScreenrecAudioPrefs = { sysaudio: boolean; mic_enabled: boolean; mic_device: string };
export const getScreenrecAudioPrefs = (): Promise<ScreenrecAudioPrefs> =>
  invoke("get_screenrec_audio_prefs");
export const setScreenrecAudioPrefs = (prefs: ScreenrecAudioPrefs): Promise<void> =>
  invoke("set_screenrec_audio_prefs", { prefs });
export const openScreenrecSetup = (): Promise<void> =>
  invoke("open_screenrec_setup");

