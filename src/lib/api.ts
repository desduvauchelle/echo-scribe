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
