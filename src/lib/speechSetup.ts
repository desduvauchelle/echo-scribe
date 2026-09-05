import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { downloadSpeechModel, frontendLog, listSpeechModels, setActiveSpeechModel, type DownloadProgress } from "./api";

type Setup = { phase: "idle" | "preparing" | "ready" | "error"; progress: DownloadProgress | null };
let state: Setup = { phase: "idle", progress: null };
const subscribers = new Set<() => void>();
let pending: Promise<void> | null = null;
function update(next: Setup) { state = next; subscribers.forEach((fn) => fn()); }

/** One download per app session, surviving navigation and React StrictMode. */
export function prepareSpeech(): Promise<void> {
  if (pending) return pending;
  update({ phase: "preparing", progress: null });
  pending = (async () => {
    let unlisten: (() => void) | undefined;
    try {
      const models = (await listSpeechModels()).filter((m) => m.supported);
      const model = models.find((m) => m.active && m.downloaded)
        ?? models.find((m) => m.downloaded) ?? models.find((m) => m.active) ?? models[0];
      if (!model) throw new Error("No supported speech model available");
      if (!model.downloaded) {
        update({ phase: "preparing", progress: { id: model.id, bytes_downloaded: model.disk_bytes, bytes_total: model.size_bytes } });
        unlisten = await listen<DownloadProgress>("speech_model:progress", ({ payload }) => {
          if (payload.id === model.id) update({ phase: "preparing", progress: payload });
        });
        frontendLog("info", `onboarding: preparing speech model ${model.id}`);
        await downloadSpeechModel(model.id);
      }
      if (!model.active) await setActiveSpeechModel(model.id);
      const verified = await listSpeechModels();
      if (!verified.some((m) => m.active && m.downloaded)) throw new Error("Speech model did not become ready");
      update({ phase: "ready", progress: null });
      frontendLog("info", "onboarding: speech ready");
    } catch (error) {
      frontendLog("error", `onboarding: speech setup failed: ${String(error)}`);
      update({ phase: "error", progress: state.progress });
    } finally {
      unlisten?.();
      pending = null;
    }
  })();
  return pending;
}

export function useSpeechSetup(start = false) {
  const snapshot = useSyncExternalStore((fn) => { subscribers.add(fn); return () => subscribers.delete(fn); }, () => state);
  useEffect(() => { if (start && state.phase === "idle") void prepareSpeech(); }, [start]);
  return snapshot;
}
