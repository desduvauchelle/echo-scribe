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

export const getVoiceAtCursorBinding = (): Promise<JsBinding> =>
  invoke("get_voice_at_cursor_binding");

export const updateVoiceAtCursorBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_voice_at_cursor_binding", { binding });

export const startPipeline = (): Promise<void> => invoke("start_pipeline");

export const isPipelineRunning = (): Promise<boolean> =>
  invoke("is_pipeline_running");
