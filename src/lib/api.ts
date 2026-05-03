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
};

export const permissionsStatus = (): Promise<PermissionsStatus> =>
  invoke("permissions_status");

export const openMicrophoneSettings = (): Promise<void> =>
  invoke("open_microphone_settings");

export const openAccessibilitySettings = (): Promise<void> =>
  invoke("open_accessibility_settings");

export const requestMicrophoneAccess = (): Promise<boolean> =>
  invoke("request_microphone_access");

export const promptAccessibilityAccess = (): Promise<boolean> =>
  invoke("prompt_accessibility_access");

export const getVoiceAtCursorBinding = (): Promise<JsBinding> =>
  invoke("get_voice_at_cursor_binding");

export const updateVoiceAtCursorBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_voice_at_cursor_binding", { binding });

export const getLogCaptureBinding = (): Promise<JsBinding> =>
  invoke("get_log_capture_binding");

export const updateLogCaptureBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_log_capture_binding", { binding });

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

export type ItemKind = "note" | "task";
export type ItemSource = "voice_at_cursor" | "log_capture";
export type Visibility = "hidden" | "visible";

export type Item = {
  id: string;
  content: string;
  source: ItemSource;
  visibility: Visibility;
  kind: ItemKind | null;
  project_id: string | null;
  captured_at: string;
  created_at: string;
  deleted_at: string | null;
  confidence: number | null;
  classified_by: string | null;
};

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
  visibility?: Visibility | null;
  project_id?: string | null;
  limit?: number;
  offset?: number;
}): Promise<Item[]> =>
  invoke("list_items", {
    visibility: args.visibility ?? null,
    projectId: args.project_id ?? null,
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
  });

export const searchItems = (query: string, limit = 50): Promise<Item[]> =>
  invoke("search_items", { query, limit });

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
