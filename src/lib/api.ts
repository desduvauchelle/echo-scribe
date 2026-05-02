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

export const resetOnboardingAndQuit = (): Promise<void> =>
  invoke("reset_onboarding_and_quit");
