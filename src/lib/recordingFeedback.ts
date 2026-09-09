import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { CaptionSegment, RecordingRow } from "./api";
import { parseEventsJsonl, type EventsHeader, type RecEvent } from "./autoZoom";
import { parseProject, type Mask } from "./editorProject";

export type FeedbackFinding = {
  title: string; kind: "fix" | "change" | "preserve" | "question";
  quote: string; request: string; uncertainty: string; location: string;
  startMs: number; endMs: number;
};
export type FeedbackShot = { timeMs: number; image: string; marker: [number, number] | null };
export type IllustratedFinding = { finding: FeedbackFinding; screenshots: FeedbackShot[] };
export type FeedbackBundle = {
  findings: IllustratedFinding[]; transcript: CaptionSegment[]; directory: string; markdown: string;
};
export const createRecordingFeedback = (id: string) =>
  invoke<{ findings: FeedbackFinding[]; transcript: CaptionSegment[] }>("create_recording_feedback", { id });
export const loadRecordingFeedback = (id: string) => invoke<FeedbackBundle | null>("load_recording_feedback", { id });
export const saveRecordingFeedback = (id: string, bundle: FeedbackBundle) =>
  invoke<FeedbackBundle>("save_recording_feedback", { id, bundle });

/** Coordinates describe the last recorded pointer, not a verified DOM element. */
export function pointerAt(header: EventsHeader | null, events: RecEvent[], timeMs: number): [number, number] | null {
  const rect = header?.capture?.rect;
  if (!rect || rect.length !== 4 || !rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) return null;
  let last: RecEvent | undefined;
  for (const event of events) {
    if (event.k !== "key" && event.t <= timeMs && (!last || event.t >= last.t)) last = event;
  }
  if (!last || last.k === "key" || timeMs - last.t > 3000) return null;
  const x = (last.x - rect[0]) / rect[2], y = (last.y - rect[1]) / rect[3];
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
}

function waitFor(video: HTMLVideoElement, event: string, action: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener("error", error); };
    const done = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); reject(new Error("Could not read the recording. Try reopening it.")); };
    const timer = window.setTimeout(error, 20_000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", error, { once: true });
    action();
  });
}

/** Full source frame: no crop/zoom that could remove the browser address bar.
 * Existing privacy regions are covered solidly so screenshots cannot bypass masks. */
export function coverPrivacyMasks(ctx: CanvasRenderingContext2D, masks: Mask[], timeMs: number, width: number, height: number) {
  ctx.fillStyle = "#111111";
  for (const mask of masks) {
    if (mask.kind === "pixelate" && timeMs >= mask.startMs && timeMs < mask.endMs) {
      const { x, y, w, h } = mask.rect;
      ctx.fillRect(Math.floor(x * width), Math.floor(y * height), Math.ceil(w * width) + 1, Math.ceil(h * height) + 1);
    }
  }
}

export async function frameReader(rec: RecordingRow, eventsJsonl: string) {
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto";
  video.crossOrigin = "anonymous";
  const dispose = () => { video.pause(); video.removeAttribute("src"); video.load(); };
  try {
    await waitFor(video, "loadeddata", () => { video.src = convertFileSrc(rec.denoised_path ?? rec.file_path); video.load(); });
  } catch (e) { dispose(); throw e; }
  const { header, events } = parseEventsJsonl(eventsJsonl);
  const project = parseProject(rec.project_json);
  return {
    dispose,
    durationMs: Math.floor(video.duration * 1000),
    async capture(timeMs: number, marker?: [number, number] | null): Promise<FeedbackShot> {
      if (!Number.isFinite(timeMs) || timeMs < 0 || !Number.isFinite(video.duration)) throw new Error("Choose a valid time in the recording.");
      const seconds = Math.max(0, Math.min(timeMs / 1000, video.duration - 0.05));
      if (Math.abs(video.currentTime - seconds) > 0.001) {
        await waitFor(video, "seeked", () => { video.currentTime = seconds; });
      }
      const actualMs = Math.round(video.currentTime * 1000);
      // Some media servers report seeked while staying at t=0 (no byte-range
      // support). Never silently attach that unrelated frame to later feedback.
      if (Math.abs(actualMs - seconds * 1000) > 250) {
        throw new Error("The recording could not seek to this moment. Reopen the recording and try again.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx || !canvas.width || !canvas.height) throw new Error("Could not extract a screenshot from this recording.");
      ctx.drawImage(video, 0, 0);
      coverPrivacyMasks(ctx, project.masks, actualMs, canvas.width, canvas.height);
      return { timeMs: actualMs, image: canvas.toDataURL("image/jpeg", 0.94), marker: marker === undefined ? pointerAt(header, events, actualMs) : marker };
    },
  };
}

/** Bake the review marker into the actual exported file, not just a CSS overlay. */
export async function exportShot(shot: FeedbackShot, masks: Mask[] = []): Promise<FeedbackShot> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve(); img.onerror = () => reject(new Error("Could not read a screenshot. Capture it again before exporting."));
    img.src = shot.image;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Screenshot export is unavailable.");
  ctx.drawImage(img, 0, 0);
  coverPrivacyMasks(ctx, masks, shot.timeMs, canvas.width, canvas.height);
  if (shot.marker) {
    const [x, y] = shot.marker;
    const radius = Math.max(16, canvas.width * 0.018);
    ctx.beginPath(); ctx.arc(x * canvas.width, y * canvas.height, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(6, canvas.width / 400); ctx.stroke();
    ctx.strokeStyle = "#e11d48"; ctx.lineWidth = Math.max(3, canvas.width / 800); ctx.stroke();
  }
  return { ...shot, image: canvas.toDataURL("image/jpeg", 0.94).split(",")[1] };
}

export function savedBundleForReview(bundle: FeedbackBundle): FeedbackBundle {
  return { ...bundle, findings: bundle.findings.map(item => ({ ...item, screenshots: item.screenshots.map(shot => ({
    ...shot, image: convertFileSrc(`${bundle.directory}/${shot.image}`),
    // Marker is already baked into this saved JPEG. Recapture before relocating it.
    marker: null,
  })) })) };
}
