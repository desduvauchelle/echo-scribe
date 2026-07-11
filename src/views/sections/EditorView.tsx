import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  Copy,
  Download,
  FolderOpen,
  Loader,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useToasts } from "../../components/ToastProvider";
import {
  getRecordingProject,
  setRecordingProject,
  importEditorBackground,
  readRecordingEvents,
  finalizeRenderedRecording,
  saveRenderedGif,
  logExportError,
  generateCaptions,
  revealRecording,
  revealRecordingFile,
  copyExportToClipboard,
  type RecordingRow,
} from "../../lib/api";
import {
  clampCaptionSegments,
  clampSpeedRanges,
  clampTrim,
  clampWebcamScenes,
  clampZoomCenter,
  defaultProject,
  moveRange,
  moveZoomBlock,
  nextRangeId,
  nextZoomBlockId,
  parseProject,
  placeRange,
  placeSpeedRange,
  placeZoomBlock,
  renderedExportPath,
  resizeRange,
  resizeSpeedRange,
  resizeZoomBlock,
  resolveCaptionSegments,
  resolveWebcamScenes,
  shiftRangesForTrim,
  type AspectPreset,
  type Background,
  type CaptionSegment as ProjectCaptionSegment,
  type EditorProject,
  type Mask,
  type SpeedRange,
  type WebcamScene,
  type WebcamSettings,
  type ZoomMode,
  PADDING_MAX,
  PADDING_MIN,
  CORNER_MAX,
  CORNER_MIN,
  CURSOR_SCALE_MIN,
  CURSOR_SCALE_MAX,
  CURSOR_SMOOTHING_MIN,
  CURSOR_SMOOTHING_MAX,
  WEBCAM_SIZE_MIN,
  WEBCAM_SIZE_MAX,
  ZOOM_SCALE_MIN,
  ZOOM_SCALE_MAX,
  ZOOM_ADD_DEFAULT_LENGTH_MS,
  ZOOM_ADD_DEFAULT_SCALE,
  SPEED_RATE_MIN,
  SPEED_RATE_MAX,
  SPEED_ADD_DEFAULT_LENGTH_MS,
  SPEED_ADD_DEFAULT_RATE,
  SCENE_MIN_LENGTH_MS,
  MUSIC_VOLUME_MIN,
  MUSIC_VOLUME_MAX,
  clampMasks,
  resizeMaskRect,
} from "../../lib/editorProject";

const BACKGROUND_PRESETS = [
  ["midnight-glass", "Midnight glass"],
  ["terracotta-arches", "Terracotta arches"],
  ["alpine-blue-hour", "Alpine blue hour"],
  ["emerald-folds", "Emerald folds"],
  ["indigo-aurora", "Indigo aurora"],
  ["zen-sand", "Zen sand"],
  ["ocean-dawn", "Ocean dawn"],
  ["cobalt-coral", "Cobalt coral"],
  ["topographic-night", "Topographic night"],
  ["golden-dunes", "Golden dunes"],
  ["foggy-forest", "Foggy forest"],
  ["ice-crystal", "Ice crystal"],
  ["rainy-city", "Rainy city"],
] as const;

const presetBackgroundPath = (name: string) => `/editor-backgrounds/${name}.jpg`;
const backgroundImageSrc = (path: string) =>
  path.startsWith("/editor-backgrounds/") ? path : convertFileSrc(path);
import { renderRecording, type RenderProgress } from "../../lib/render/renderPipeline";
import {
  canvasToCapture,
  canvasToCaptureUnclamped,
  captionAt,
  cursorDrawScale,
  cursorStateAt,
  drawCompositeBlurred,
  keystrokeBadgeAlpha,
  keystrokeBadgeAt,
  maskRectToContent,
  masksAt,
  motionBlurSamples,
  MOTION_BLUR_SAMPLES,
  outputLayout,
  smoothCursorPath,
  webcamSceneAt,
  webcamShrinkFactor,
  zoomStateAt,
  type Appearance,
  type CursorSample,
  type OverlayState,
  type ZoomState,
} from "../../lib/render/compositor";
import {
  materializeBlocks,
  parseEventsJsonl,
  resolveZoomBlocks,
  type EventsHeader,
  type RecEvent,
  type ZoomBlock,
} from "../../lib/autoZoom";

const SAVE_DEBOUNCE_MS = 500;

/** Load an image path (via convertFileSrc) into an HTMLImageElement. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

/** The playback rate for SOURCE time `tMs`: the rate of the (non-overlapping)
 *  speed range containing `tMs` (half-open `[startMs, endMs)`), or 1.0 when
 *  `tMs` is outside every range. Pure. */
function activeSpeedRate(tMs: number, ranges: SpeedRange[]): number {
  for (const r of ranges) {
    if (tMs >= r.startMs && tMs < r.endMs) return r.rate;
  }
  return 1;
}

/** Local numeric clamp — mirrors editorProject.ts's private `clamp` (not
 *  exported; small enough not to warrant plumbing it through). Used by the
 *  masks lane's free move/resize (no neighbour-stop, so the bound is just
 *  `[lo,hi]`). */
function clampMs(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** mm:ss.d — used for the trim handle readouts, which need sub-second
 *  precision since trims are commonly a few hundred ms wide. */
function fmtTimeDs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalDs = Math.round(ms / 100);
  const m = Math.floor(totalDs / 600);
  const s = Math.floor((totalDs % 600) / 10);
  const d = totalDs % 10;
  return `${m}:${String(s).padStart(2, "0")}.${d}`;
}

/** Compact human ETA for the export button. Quantized to 5s steps above 15s
 *  so the countdown ticks calmly instead of flickering every progress event. */
function fmtEta(secs: number): string {
  const s = Math.max(1, Math.round(secs));
  const q = s > 15 ? Math.round(s / 5) * 5 : s;
  if (q < 60) return `${q}s`;
  const m = Math.floor(q / 60);
  const r = q % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/** Whether the live preview applies motion blur during zoom transitions (Task
 *  5). Kept as a module constant so it can be flipped to `false` (confining
 *  blur to the export only) if the ×N ramp draws ever cause preview jank on
 *  low-end hardware. Blur is self-limiting — `motionBlurSamples` returns a
 *  single sample outside transition ramps, so the extra cost applies only to
 *  the brief ramps — so the WYSIWYG default is ON. */
const PREVIEW_MOTION_BLUR = true;

/** Frame interval (ms) the preview passes to `motionBlurSamples` for the
 *  sub-sample time step — the export's TARGET_FPS (30) interval, so the preview
 *  smears over the same ~1-frame window the exported file will. */
const PREVIEW_FRAME_INTERVAL_MS = 1000 / 30;

/** Default length for a freshly-added "cut to camera" scene ("Add camera
 *  scene") — mirrors ZOOM_ADD_DEFAULT_LENGTH_MS / SPEED_ADD_DEFAULT_LENGTH_MS. */
const SCENE_ADD_DEFAULT_LENGTH_MS = 3000;

/** Default length/kind/rect for a freshly-added mask ("Add mask"): 3s,
 *  pixelate, a rect centered in the capture frame at 25% of its width/height
 *  (`{x:0.375,y:0.375,w:0.25,h:0.25}` — 0.375 + 0.25 + 0.375 = 1, so it's
 *  exactly centered on both axes). */
const MASK_ADD_DEFAULT_LENGTH_MS = 3000;
const MASK_ADD_DEFAULT_RECT = { x: 0.375, y: 0.375, w: 0.25, h: 0.25 };

/** Minimum mask length (ms) — masks move/resize FREELY (they may legitimately
 *  overlap in time, unlike every other lane), so this is the ONLY time
 *  constraint: a drag can't shrink a mask below this, matching the other
 *  lanes' floors (SCENE_MIN_LENGTH_MS / ZOOM_MIN_LENGTH_MS / SPEED_MIN_LENGTH_MS). */
const MASK_MIN_LENGTH_MS = 500;

/**
 * Full-pane per-recording editor. Left: a live canvas preview driven by a hidden
 * <video> and a rAF loop through `drawCompositeBlurred` at the project's appearance.
 * Right: appearance controls (padding, corner radius, background). Every change
 * updates local state, re-renders the canvas live, and saves (debounced) via
 * `setRecordingProject`. Works for recordings with `events_path` NULL — cursor
 * and webcam overlays are Tasks 6/8 and stay null here.
 */
export function EditorView({
  recording,
  onBack,
}: {
  recording: RecordingRow;
  onBack: () => void;
}) {
  const toasts = useToasts();
  const [project, setProject] = useState<EditorProject>(defaultProject);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [importing, setImporting] = useState(false);
  // Export state: `phase` is the render pipeline phase, or "finalizing" while
  // the Rust command muxes audio, or null when idle.
  const [exportPhase, setExportPhase] = useState<
    RenderProgress["phase"] | "finalizing" | null
  >(null);
  const [exportPct, setExportPct] = useState(0);
  // Estimated seconds until the current export phase completes (null until
  // enough progress has accrued to extrapolate a rate; resets on phase change).
  const [exportEta, setExportEta] = useState<number | null>(null);
  // Output format for the export button. Session-local only (NOT persisted to
  // the project) — MP4 is the default; GIF renders a silent, 15fps, ≤960px-wide
  // animated GIF via the same composite pipeline (no audio).
  const [exportFormat, setExportFormat] = useState<"mp4" | "gif">("mp4");
  // Path to the just-exported mp4 (for the Reveal-in-Finder affordance).
  const [exportedRevealId, setExportedRevealId] = useState<string | null>(null);
  // Absolute path of the just-created `<id>.rendered.mp4`, so "Reveal in
  // Finder" targets the export rather than the original recording. Falls back
  // to `revealRecording(id)` when unknown.
  const [exportedRevealPath, setExportedRevealPath] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Second hidden <video> for the webcam file, time-synced to the main video.
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  // Latest project in a ref so the rAF loop always reads current appearance
  // without re-subscribing.
  const projectRef = useRef(project);
  projectRef.current = project;
  const saveTimer = useRef<number | null>(null);
  // Latest duration (ms) in a ref so drag handlers and the playback-clamp
  // tick can read it without depending on (and re-subscribing per) render.
  const durationMsRef = useRef(0);
  // Mirrors `loaded` for the true-unmount flush effect below, which must read
  // refs only (it can't close over the `loaded` state without re-running on
  // every change, which is exactly the bug this ref avoids).
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const src = convertFileSrc(recording.denoised_path ?? recording.file_path);
  // Webcam preview/export source + clock offset. Convention (settled by review
  // derivation): `webcamTime = mainTime + offsetMs`, where
  //   offsetMs = firstMainFramePTS − webcamStart   (`recordings.webcam_offset_ms`).
  // Normally positive; null on the row → 0.
  const webcamSrc = recording.webcam_path ? convertFileSrc(recording.webcam_path) : null;
  const webcamOffsetMs = recording.webcam_offset_ms ?? 0;

  // Synthetic cursor is only available when the recording was captured with the
  // system cursor hidden AND we have an input-event track to reconstruct it
  // from. Otherwise the cursor section is disabled (the real cursor is already
  // baked into the video, so drawing a second one would double it up).
  const cursorAvailable = recording.cursor_hidden && !!recording.events_path;
  // Auto-zoom is driven by recorded clicks, independent of the cursor: any
  // recording with an events track can zoom (even if its real cursor is baked
  // in). So the events file is loaded whenever it exists, not just for cursor.
  const eventsAvailable = !!recording.events_path;

  // Parsed input-event track, loaded once per recording when an events file
  // exists. Kept in refs so the rAF loop reads the latest without
  // re-subscribing. `eventsHeaderRef` null = not loaded / unavailable (both the
  // cursor overlay and zoom resolution then no-op). `eventsRef` holds the raw
  // events for `resolveZoomBlocks`; `cursorMovesRef`/`cursorDownsRef` are the
  // pre-split subset the synthetic-cursor lookup binary-searches per frame.
  const eventsHeaderRef = useRef<EventsHeader | null>(null);
  const eventsRef = useRef<RecEvent[]>([]);
  const cursorMovesRef = useRef<CursorSample[]>([]);
  const cursorDownsRef = useRef<CursorSample[]>([]);
  // Smoothed cursor move path (Task 5), recomputed only when the events load or
  // `cursor.smoothing` changes (memoized below, synced to this ref during
  // render — the SAME once-per-load precompute the export does, never per
  // frame). The rAF loop binary-searches this instead of the raw moves so the
  // preview and export smooth identically. strength 0 ⇒ identity path.
  const smoothedMovesRef = useRef<CursorSample[]>([]);
  // Pre-split `k: "key"` events, alongside the existing moves/downs split —
  // the keystroke badge lookup (`keystrokeBadgeAt`) scans this per frame, so
  // splitting it once here (rather than filtering `eventsRef` every frame)
  // keeps the rAF loop's per-frame work cheap, mirroring the cursor pattern.
  const keyEventsRef = useRef<RecEvent[]>([]);
  const eventsLoadedForRef = useRef<string | null>(null);
  const [eventsReady, setEventsReady] = useState(false);
  // Resolved zoom timeline for the preview. Recomputed (below) only when the
  // project's zoom settings, the loaded events, or the duration change — never
  // per frame — so the rAF loop's per-frame `zoomStateAt` reads a STABLE array
  // reference (no per-frame allocation, scrubbing stays smooth). `[]` means
  // identity zoom (mode "off", no events, or old recordings without a track).
  const zoomBlocksRef = useRef<ZoomBlock[]>([]);

  // Currently-selected zoom chip (by stable id). Drives the inspector row, the
  // chip highlight, AND center-pick mode (a click on the preview canvas sets the
  // selected block's center while this is non-null). Cleared when the recording
  // changes (the whole component remounts on id change, so a fresh null is fine).
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Currently-selected speed range (by index into the sorted `project.speed`).
  // Speed ranges have no stable id in the data contract, but the list stays
  // sorted + non-overlapping and edits stop-at-neighbour (never reorder), so
  // the index is stable across a drag; add/delete reset the selection. Drives
  // the speed inspector row + chip highlight.
  const [selectedSpeedIdx, setSelectedSpeedIdx] = useState<number | null>(null);
  // Latest speed ranges in a ref so the rAF loop can read the active rate
  // (for `video.playbackRate`) without re-subscribing per edit.
  const speedRangesRef = useRef<SpeedRange[]>(project.speed);
  speedRangesRef.current = project.speed;

  // Currently-selected camera scene (by stable id) — mirrors `selectedBlockId`
  // (zoom scenes carry stable "s"-prefixed ids just like zoom blocks' "z"
  // ones). Drives the camera-lane inspector row + chip highlight. Cleared when
  // the recording changes (fresh mount).
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // Latest webcam scenes in a ref so pointer handlers (which fire many times
  // per drag) can read the current list without re-subscribing per edit —
  // mirrors `zoomBlocksRef`.
  const scenesRef = useRef<WebcamScene[]>(project.webcam?.scenes ?? []);
  scenesRef.current = project.webcam?.scenes ?? [];
  // Render-boundary defensive clamp of the stored scenes / caption segments,
  // held in refs so the rAF loop + overlay callbacks read a STABLE, pre-clamped
  // list (mirrors `zoomBlocksRef`). `webcamSceneAt` / `captionAt` binary-search
  // assuming sorted, non-overlapping input; the editor keeps the stored arrays
  // clamped on every edit, but resolving through the SAME `resolveWebcamScenes`
  // / `resolveCaptionSegments` the export uses makes the preview robust to
  // hand-edited / foreign project_json (parse only shape-validates). Assigned
  // from the memos below (after `durationMs` is known).
  const previewScenesRef = useRef<WebcamScene[]>([]);
  const previewCaptionsRef = useRef<ProjectCaptionSegment[]>([]);

  // Currently-selected mask (by stable id) — mirrors `selectedSceneId`. Drives
  // the masks-lane inspector row + chip highlight AND the on-canvas rect-edit
  // overlay (drawn on the preview whenever a mask is selected). Cleared when
  // the recording changes (fresh mount).
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);
  // Latest masks in a ref so pointer handlers (many events per drag) read the
  // current list without re-subscribing per edit — mirrors `scenesRef`.
  const masksRef = useRef<Mask[]>(project.masks);
  masksRef.current = project.masks;

  // Whether this recording was captured with a webcam (a `.webcam.mp4` exists).
  // Gates the whole webcam editor section and the preview/export overlay.
  const webcamAvailable = !!recording.webcam_path;

  // Load persisted project on open (tolerant parse → always valid). Reset
  // `loaded` up front whenever the recording changes so the debounced-save
  // effect below can't fire with stale project state from the previous
  // recording before this load resolves (belt-and-suspenders alongside the
  // `key={recording.id}` remount in RecordingsView).
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void getRecordingProject(recording.id).then((json) => {
      if (cancelled) return;
      const parsed = parseProject(json);
      // Initialize webcam defaults the first time we open a recording that HAS
      // a webcam file but whose persisted project has no webcam settings yet
      // (parseProject leaves `webcam` null for a stale/absent field). Default:
      // shown, circle bubble, bottom-right, 20% width.
      if (webcamAvailable && parsed.webcam === null) {
        parsed.webcam = {
          show: true,
          shape: "circle",
          corner: "br",
          sizeFrac: 0.2,
          autoShrink: false,
          mirror: false,
          scenes: [],
        };
      }
      setProject(parsed);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [recording.id, webcamAvailable]);

  // Keep a decoded background image in sync with the project background path.
  const bgPath =
    project.appearance.background.type === "image"
      ? project.appearance.background.path
      : null;
  useEffect(() => {
    if (!bgPath) {
      bgImageRef.current = null;
      return;
    }
    let cancelled = false;
    void loadImage(backgroundImageSrc(bgPath))
      .then((img) => {
        if (!cancelled) bgImageRef.current = img;
      })
      .catch(() => {
        if (!cancelled) bgImageRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [bgPath]);

  // Load + parse the input-event track once per recording whenever an events
  // file exists. Both features read from it: auto-zoom needs the clicks (any
  // recording, default mode), and the synthetic cursor needs the moves/downs
  // (only when it's available + enabled). Splitting moves/downs here keeps the
  // rAF loop's per-frame cursor work to a binary search. Guarded by
  // `eventsLoadedForRef` so we fetch at most once per recording — the zoom and
  // cursor consumers share this single load (no double fetch).
  useEffect(() => {
    if (!eventsAvailable) return;
    if (eventsLoadedForRef.current === recording.id) return;
    eventsLoadedForRef.current = recording.id;
    let cancelled = false;
    void readRecordingEvents(recording.id)
      .then((text) => {
        if (cancelled) return;
        const { header, events } = parseEventsJsonl(text);
        if (!header) return;
        const moves: CursorSample[] = [];
        const downs: CursorSample[] = [];
        const keys: RecEvent[] = [];
        for (const e of events) {
          if (e.k === "move") moves.push({ t: e.t, x: e.x, y: e.y });
          else if (e.k === "down") downs.push({ t: e.t, x: e.x, y: e.y });
          else if (e.k === "key") keys.push(e);
        }
        eventsHeaderRef.current = header;
        eventsRef.current = events;
        cursorMovesRef.current = moves;
        cursorDownsRef.current = downs;
        keyEventsRef.current = keys;
        setEventsReady(true);
      })
      .catch((e) => {
        // Non-fatal: the preview just falls back to no synthetic cursor and no
        // live zoom. Allow a retry on a later open by clearing the guard.
        eventsLoadedForRef.current = null;
        console.warn("[editor] input events failed to load", e);
      });
    return () => {
      cancelled = true;
    };
  }, [eventsAvailable, recording.id]);

  // Compute the synthetic-cursor overlay for a given SOURCE time (ms). Returns
  // null unless the cursor is available, enabled, and the events are loaded.
  const cursorOverlayAt = useCallback(
    (tMsSource: number): OverlayState["cursor"] => {
      const p = projectRef.current;
      if (!p.cursor.enabled || !cursorAvailable) return null;
      const header = eventsHeaderRef.current;
      if (!header) return null;
      // Read the pre-smoothed path (Task 5); pass the hideIdle flag so the
      // cursor fades out before idle gaps. Both mirror the export exactly.
      return cursorStateAt(tMsSource, smoothedMovesRef.current, cursorDownsRef.current, header, {
        hideIdle: p.cursor.hideIdle,
      });
    },
    [cursorAvailable],
  );

  // Compute the keystroke badge overlay for a given SOURCE time (ms). Returns
  // null unless keystrokes are enabled and a qualifying event is in the
  // display window. `keystrokeBadgeAt` only returns the label; the fade alpha
  // is derived here from the driving event's age (re-walk is cheap — the
  // array is small and we scan from the end same as `keystrokeBadgeAt`).
  const keystrokeOverlayAt = useCallback((tMsSource: number): OverlayState["keystroke"] => {
    const p = projectRef.current;
    if (!p.keystrokes.enabled) return null;
    const events = keyEventsRef.current;
    const badge = keystrokeBadgeAt(tMsSource, events, { allKeys: p.keystrokes.allKeys });
    if (!badge) return null;
    // Find the driving event's age: the same latest-qualifying-event scan
    // `keystrokeBadgeAt` performed, redone here only to get its timestamp
    // (kept as a separate small scan rather than changing that function's
    // pure `{ label }` contract just to also return an age).
    let age = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.k !== "key" || e.t > tMsSource || tMsSource - e.t > 800) continue;
      age = tMsSource - e.t;
      break;
    }
    return { label: badge.label, alpha: keystrokeBadgeAlpha(age) };
  }, []);

  // Compute the caption pill text for a given SOURCE time (ms). Returns null
  // unless captions are enabled and a generated segment covers `tMsSource`.
  // Reads `previewCaptionsRef` — the render-boundary-clamped segments resolved
  // above (empty when captions are disabled / never generated) — through the
  // SAME `captionAt` the export path uses, so preview and export render
  // identical captions and the binary search never sees unsorted input.
  const captionOverlayAt = useCallback((tMsSource: number): OverlayState["caption"] => {
    return captionAt(tMsSource, previewCaptionsRef.current);
  }, []);

  // Compute the active masks (pixelate/highlight) for a given SOURCE time (ms).
  // Reads `project.masks` via `projectRef` (mirroring the caption/keystroke
  // lookups), clamps them against the current duration (rect into [0,1],
  // degenerate/zero-area dropped; time-overlaps preserved), then returns ALL
  // active via the SAME shared `masksAt` the export path uses — so preview and
  // rendered file draw identical masks. Empty ⇒ [] (pre-M5 look unchanged).
  const masksOverlayAt = useCallback((tMsSource: number): OverlayState["masks"] => {
    const p = projectRef.current;
    if (p.masks.length === 0) return [];
    const clamped = clampMasks(p.masks, durationMsRef.current || 0);
    return masksAt(tMsSource, clamped);
  }, []);

  // Resolve the effective zoom timeline whenever the inputs change:
  //   - `project.zoom`  (mode/blocks — off/custom/auto)
  //   - `eventsReady`   (the click track finished loading; auto mode needs it)
  //   - `duration`      (full source length; bounds auto blocks' lead-in/hold)
  // Memoized (not per-frame) and made VISIBLE to render (the zoom lane draws
  // these chips) — the rAF loop reads it from `zoomBlocksRef` (synced below) so
  // it never re-resolves per frame and keeps a STABLE reference for
  // `zoomStateAt`. Blocks are SOURCE-time, matching the export. (Mirrors
  // export's `resolveZoomBlocks` call so preview and rendered file zoom
  // identically.)
  const zoomSettings = project.zoom;
  const durationMs = durationMsRef.current || Math.round(duration * 1000) || 0;
  const effectiveBlocks = useMemo(
    () =>
      resolveZoomBlocks(project, eventsHeaderRef.current, eventsRef.current, durationMs),
    // `project` is read only for its `zoom` here; depending on the whole object
    // would re-resolve on every appearance tweak. `eventsReady` gates the auto
    // path (events loaded); `durationMs` bounds auto block windows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoomSettings, eventsReady, durationMs],
  );
  // Keep the rAF-loop ref pointed at the freshly-resolved array. Assigned
  // during render (not in an effect) so the very next paint — the "renderOnce"
  // effect fires on `project` change — already sees the new blocks.
  zoomBlocksRef.current = effectiveBlocks;

  // Resolve the clamped scenes / caption segments ONCE per (scenes/captions ×
  // duration) change (not per frame) — mirrors the zoom-blocks memo above so
  // the rAF loop reads a STABLE, pre-clamped reference and the binary searches
  // in `webcamSceneAt` / `captionAt` never see unsorted/overlapping input. The
  // export path resolves through the same helpers, so preview and file match.
  const previewScenes = useMemo(
    () => resolveWebcamScenes(project, durationMs),
    [project.webcam, durationMs],
  );
  previewScenesRef.current = previewScenes;
  const previewCaptionSegments = useMemo(
    () => resolveCaptionSegments(project, durationMs),
    [project.captions, durationMs],
  );
  previewCaptionsRef.current = previewCaptionSegments;

  // Smooth the cursor move path (Task 5) once per (events-load × smoothing)
  // change — mirrors the zoom-blocks memo above so the rAF loop reads a STABLE
  // reference and never re-smooths per frame. strength 0 returns the raw path
  // unchanged (identity), so the default look is untouched. Synced to the ref
  // during render (not an effect) so the very next paint sees it.
  const cursorSmoothing = project.cursor.smoothing;
  const smoothedMoves = useMemo(
    () => smoothCursorPath(cursorMovesRef.current, cursorSmoothing),
    // `eventsReady` gates the load (moves populated); `cursorSmoothing` is the
    // only project field that changes the output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventsReady, cursorSmoothing],
  );
  smoothedMovesRef.current = smoothedMoves;

  // Drop a stale selection if its block no longer exists (e.g. mode switched to
  // "off"/"auto", or the block was deleted). Runs after the memo so it reacts to
  // the resolved list, never mid-drag on the ref.
  useEffect(() => {
    if (selectedBlockId === null) return;
    if (!effectiveBlocks.some((b) => b.id === selectedBlockId)) {
      setSelectedBlockId(null);
    }
  }, [effectiveBlocks, selectedBlockId]);

  // rAF render loop: draw the current video frame through drawCompositeBlurred at
  // whatever appearance is current. Runs whenever the video is playing OR when
  // a control changed while paused (we always request one more frame on state
  // change via the `renderOnce` effect below).
  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return;
    const p = projectRef.current;
    // Size the preview canvas to the resolved output geometry (aspect + padding
    // + cap), so the letterboxing and centering render exactly as the export
    // will. The compositor derives the same content rect from frame dims +
    // appearance internally.
    const { outW, outH } = outputLayout(vw, vh, p.appearance.padding, p.appearance.aspect);
    if (canvas.width !== outW) canvas.width = outW;
    if (canvas.height !== outH) canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const appearance: Appearance = {
      padding: p.appearance.padding,
      cornerRadius: p.appearance.cornerRadius,
      aspect: p.appearance.aspect,
      background: p.appearance.background,
    };
    // Live zoom: evaluate the resolved zoom timeline at the current SOURCE time
    // (the preview shows the un-trimmed clip, so currentTime IS source time —
    // same source-time keying the export uses). `zoomBlocksRef` holds a stable,
    // pre-resolved array (empty ⇒ identity, so old/eventless recordings are
    // unchanged); `zoomStateAt` is a cheap per-frame scan with no allocation of
    // the block list, so scrubbing while zoomed stays smooth. The cursor uses
    // the same source time.
    const tMsSource = video.currentTime * 1000;
    // Live speed preview: drive the <video> element's playbackRate from the
    // speed range containing the current SOURCE time (1.0 outside any range).
    // The webcam element follows the SAME rate so the bubble stays in step.
    // Setting playbackRate while paused is harmless and ensures the right rate
    // the instant playback resumes.
    const rate = activeSpeedRate(tMsSource, speedRangesRef.current);
    if (video.playbackRate !== rate) video.playbackRate = rate;
    const blocks = zoomBlocksRef.current;
    // Motion blur (Task 5): compute the zoom sub-samples for this frame. Off /
    // static stretches ⇒ a single current-time state (`drawCompositeBlurred`
    // then does one plain draw — byte-identical to pre-M4). The preview applies
    // blur too (WYSIWYG), and it is self-limiting: `motionBlurSamples` only
    // returns N>1 during a transition ramp, so the ×N cost is confined to the
    // brief ramps. If preview jank is ever observed, set PREVIEW_MOTION_BLUR to
    // false to confine blur to the export (the export path is unaffected).
    const blurN = PREVIEW_MOTION_BLUR && p.motionBlur && blocks.length ? MOTION_BLUR_SAMPLES : 1;
    const zoomSamples: ZoomState[] = blocks.length
      ? motionBlurSamples(tMsSource, blocks, blurN, PREVIEW_FRAME_INTERVAL_MS)
      : [{ cx: 0.5, cy: 0.5, scale: 1 }];
    const cursor = cursorOverlayAt(tMsSource);
    const pxScale = eventsHeaderRef.current?.capture.px_scale ?? 1;
    // Webcam overlay: feed the hidden webcam <video> as the frame source when
    // it's decodable (readyState >= 2 = HAVE_CURRENT_DATA) and the project is
    // showing it. The webcam element's currentTime is kept ≈ main + offset by
    // the sync effect below; here we just draw whatever frame it's parked on.
    // The compositor no-ops gracefully on a not-ready frame, but we gate on
    // readyState anyway to avoid drawing a blank/black bubble on first paint.
    const wv = webcamVideoRef.current;
    if (wv && wv.playbackRate !== rate) wv.playbackRate = rate;
    // Webcam frame is drawable when the hidden element has decoded data. Shared
    // between the "cut to camera" scene layout and the corner bubble (M6). Uses
    // the SAME shared `webcamSceneAt` / `webcamShrinkFactor` the export uses, so
    // preview and rendered file render scenes/shrink/mirror identically.
    const wcReady = !!wv && wv.readyState >= 2 && wv.videoWidth > 0;
    // Render-boundary-clamped scenes (see `previewScenesRef`) so `webcamSceneAt`
    // binary-searches sorted, non-overlapping input just like the export.
    const scenes = previewScenesRef.current;
    const mirror = !!p.webcam?.mirror;
    // Scene active this frame: a scene covers the SOURCE time AND a webcam frame
    // is decodable. When the frame isn't ready, `scene` stays null → the preview
    // falls back to the normal screen layout (never black), matching export.
    const scene: OverlayState["scene"] =
      wcReady && scenes.length > 0 && webcamSceneAt(tMsSource, scenes)
        ? { frame: wv!, mirror }
        : null;
    // Corner bubble: shown, frame ready, and NOT superseded by a scene. Auto-
    // shrink follows the frame's primary zoom scale at tMsSource (one value per
    // frame, stable across the blur sub-samples).
    const webcam: OverlayState["webcam"] =
      p.webcam?.show && wcReady && !scene
        ? {
            frame: wv!,
            shape: p.webcam.shape,
            corner: p.webcam.corner,
            sizeFrac: p.webcam.sizeFrac,
            scaleFactor:
              p.webcam.autoShrink && blocks.length
                ? webcamShrinkFactor(zoomStateAt(tMsSource, blocks).scale)
                : 1,
            mirror,
          }
        : null;
    const keystroke = keystrokeOverlayAt(tMsSource);
    const caption = captionOverlayAt(tMsSource);
    // Masks (pixelate/highlight) active this frame — suppressed during a scene
    // (screen hidden), matching export. Belt-and-suspenders with the
    // compositor's scene early-return, which also skips the mask draw.
    const masks = scene ? [] : masksOverlayAt(tMsSource);
    // Motion blur collapses during a scene (zoom ignored ⇒ identical sub-samples).
    const frameZoomSamples = scene ? [zoomSamples[0]] : zoomSamples;
    drawCompositeBlurred(
      ctx,
      video,
      vw,
      vh,
      outW,
      outH,
      appearance,
      frameZoomSamples,
      { cursor, webcam, keystroke, caption, scene, masks },
      cursorDrawScale(p.cursor.scale, pxScale),
      bgImageRef.current,
    );
  }, [captionOverlayAt, cursorOverlayAt, keystrokeOverlayAt, masksOverlayAt]);

  // Webcam preview time-sync. The webcam element should sit at
  //   webcamTime = mainTime + offsetMs   (offset = firstMainFramePTS − webcamStart).
  // `hardSyncWebcam` snaps its currentTime on discrete events (seek/play/pause);
  // the rAF loop only drift-corrects (below) when the gap exceeds a threshold —
  // setting currentTime every frame stutters playback, so we avoid it.
  const WEBCAM_DRIFT_TOLERANCE_S = 0.15; // 150ms

  /** Target webcam currentTime (s) for a given main time (s), clamped into the
   *  webcam element's own duration. */
  const webcamTargetTime = useCallback(
    (mainSec: number): number => {
      const wv = webcamVideoRef.current;
      let t = mainSec + webcamOffsetMs / 1000;
      if (t < 0) t = 0;
      if (wv && Number.isFinite(wv.duration) && wv.duration > 0) {
        t = Math.min(t, wv.duration);
      }
      return t;
    },
    [webcamOffsetMs],
  );

  /** Hard-snap the webcam element to the main time (seek/play/pause events). */
  const hardSyncWebcam = useCallback(
    (mainSec: number) => {
      const wv = webcamVideoRef.current;
      if (!wv) return;
      wv.currentTime = webcamTargetTime(mainSec);
    },
    [webcamTargetTime],
  );

  // Drive continuous frames while playing. When a trim is set, playback is
  // clamped to [startMs, endMs]: reaching endMs pauses (no loop) rather than
  // running to the end of the full clip.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const trim = projectRef.current.trim;
      if (v && trim) {
        const endSec = trim.endMs / 1000;
        if (v.currentTime >= endSec) {
          v.pause();
          v.currentTime = endSec;
          webcamVideoRef.current?.pause();
          hardSyncWebcam(endSec);
          setPlaying(false);
          setCurrent(endSec);
          renderFrame();
          return;
        }
      }
      // Drift-correct the webcam only when it has slipped past tolerance — a
      // per-frame currentTime write would stutter its decode.
      if (v) {
        const wv = webcamVideoRef.current;
        if (wv && wv.readyState >= 1) {
          const target = webcamTargetTime(v.currentTime);
          if (Math.abs(wv.currentTime - target) > WEBCAM_DRIFT_TOLERANCE_S) {
            wv.currentTime = target;
          }
        }
      }
      renderFrame();
      if (v) setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, renderFrame, hardSyncWebcam, webcamTargetTime]);

  // Re-render a single frame whenever appearance changes while paused (so slider
  // moves show up immediately), the background image finished loading, or the
  // input-event track just became ready (so the synthetic cursor AND live zoom
  // appear without needing a scrub). `project` covers zoom mode/block edits;
  // the zoom-resolution effect above runs first (declared earlier) so
  // `zoomBlocksRef` is already up to date by the time this repaints.
  useEffect(() => {
    if (playing) return;
    const id = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(id);
  }, [project, playing, renderFrame, loaded, eventsReady]);

  // On unmount, restore both media elements to 1× so a speed-segment rate
  // never leaks into a re-created element (belt-and-suspenders — the element
  // is normally torn down on recording change anyway).
  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (v) v.playbackRate = 1;
      const wv = webcamVideoRef.current;
      if (wv) wv.playbackRate = 1;
    };
  }, []);

  // Debounced persist on any project change (after the initial load). Plain
  // debounce semantics: the cleanup only clears the pending timer (it runs on
  // every dep change, not just unmount, so it must never flush — see the
  // true-unmount effect below for the flush).
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void setRecordingProject(recording.id, JSON.stringify(project)).catch(() => {
        toasts.push({
          tone: "error",
          message: "Couldn't save editor settings. See Settings → Diagnostics → logs.",
        });
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [project, loaded, recording.id, toasts]);

  // Flush any pending debounced save on true unmount only (empty deps means
  // this cleanup runs exactly once). Reads refs exclusively — loadedRef and
  // projectRef mirror the latest state without retriggering this effect, and
  // `recording.id` is safe to capture directly in the closure because it's
  // constant for the lifetime of this component instance (RecordingsView
  // remounts a fresh EditorView via `key={selected.id}` whenever the
  // recording changes, so this instance never sees a different id).
  useEffect(() => {
    return () => {
      if (!loadedRef.current) return;
      if (saveTimer.current === null) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      void setRecordingProject(recording.id, JSON.stringify(projectRef.current)).catch(() => {
        toasts.push({
          tone: "error",
          message: "Couldn't save editor settings. See Settings → Diagnostics → logs.",
        });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const wv = webcamVideoRef.current;
    if (v.paused) {
      // If currentTime is outside the trim window (before start, at/after
      // end, or stale from a previous trim edit), jump to start before
      // resuming playback.
      const trim = projectRef.current.trim;
      if (trim) {
        const startSec = trim.startMs / 1000;
        const endSec = trim.endMs / 1000;
        if (v.currentTime < startSec || v.currentTime >= endSec) {
          v.currentTime = startSec;
          setCurrent(startSec);
        }
      }
      // Snap the webcam to the (possibly-jumped) start, then mirror play.
      hardSyncWebcam(v.currentTime);
      void v.play();
      if (wv) void wv.play().catch(() => {});
      setPlaying(true);
    } else {
      v.pause();
      wv?.pause();
      // Restore normal rate when paused so a paused clip decodes at 1× (the
      // rAF loop re-applies the range rate on the next play/scrub).
      v.playbackRate = 1;
      if (wv) wv.playbackRate = 1;
      setPlaying(false);
    }
  }, [hardSyncWebcam]);

  const onScrub = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    // Defensively clamp into the trim window — the scrubber's own min/max
    // already restrict this, but guard here too in case the trim changed
    // out from under an in-flight drag.
    const trim = projectRef.current.trim;
    if (trim) t = Math.min(Math.max(t, trim.startMs / 1000), trim.endMs / 1000);
    v.currentTime = t;
    hardSyncWebcam(t);
    setCurrent(t);
    // Draw the sought frame once the seek settles. If playing, the rAF loop
    // already redraws every frame, so only wire a one-shot when paused. Redraw
    // on BOTH the main-video seek settling and the webcam seek settling, so a
    // webcam frame that decodes slightly later than the main frame still shows.
    if (v.paused) {
      const onSeeked = () => {
        renderFrame();
        v.removeEventListener("seeked", onSeeked);
      };
      v.addEventListener("seeked", onSeeked);
      const wv = webcamVideoRef.current;
      // Skip registering the webcam's one-shot listener when hardSyncWebcam
      // was a no-op (target ~= current currentTime): with nothing to seek to,
      // "seeked" never fires and the listener would otherwise leak until
      // component teardown (it's only ever removed by firing or unmount).
      if (wv && Math.abs(wv.currentTime - webcamTargetTime(t)) >= 0.01) {
        const onWebcamSeeked = () => {
          renderFrame();
          wv.removeEventListener("seeked", onWebcamSeeked);
        };
        wv.addEventListener("seeked", onWebcamSeeked);
      }
    }
  }, [renderFrame, hardSyncWebcam, webcamTargetTime]);

  // ---- Appearance updaters ------------------------------------------------
  const setPadding = (padding: number) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, padding } }));
  const setCornerRadius = (cornerRadius: number) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, cornerRadius } }));
  const setAspect = (aspect: AspectPreset) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, aspect } }));
  const setBackground = (background: Background) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, background } }));
  const setMotionBlur = (motionBlur: boolean) =>
    setProject((p) => ({ ...p, motionBlur }));

  // ---- Cursor updaters ----------------------------------------------------
  const setCursorEnabled = (enabled: boolean) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, enabled } }));
  const setCursorScale = (scale: number) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, scale } }));
  const setCursorSmoothing = (smoothing: number) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, smoothing } }));
  const setCursorHideIdle = (hideIdle: boolean) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, hideIdle } }));

  // ---- Keystroke overlay updaters ------------------------------------------
  const setKeystrokesEnabled = (enabled: boolean) =>
    setProject((p) => ({ ...p, keystrokes: { ...p.keystrokes, enabled } }));
  const setKeystrokesAllKeys = (allKeys: boolean) =>
    setProject((p) => ({ ...p, keystrokes: { ...p.keystrokes, allKeys } }));

  // ---- Audio ----------------------------------------------------------------
  const setNormalizeLoudness = (normalizeLoudness: boolean) =>
    setProject((p) => ({ ...p, audio: { ...p.audio, normalizeLoudness } }));

  // ---- Background music (Task 7) ---------------------------------------------
  const [musicImporting, setMusicImporting] = useState(false);
  const setMusicVolume = (volume: number) =>
    setProject((p) =>
      p.audio.music
        ? { ...p, audio: { ...p.audio, music: { ...p.audio.music, volume } } }
        : p,
    );
  const clearMusic = () =>
    setProject((p) => ({ ...p, audio: { ...p.audio, music: null } }));
  const pickMusic = useCallback(async () => {
    setMusicImporting(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "aac"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      setProject((p) => ({
        ...p,
        audio: { ...p.audio, music: { path: picked, volume: p.audio.music?.volume ?? 0.5 } },
      }));
    } catch (e) {
      toasts.push({
        tone: "error",
        message:
          typeof e === "string"
            ? e
            : "Couldn't select the music file. See Settings → Diagnostics → logs.",
      });
    } finally {
      setMusicImporting(false);
    }
  }, [toasts]);

  // ---- Captions -------------------------------------------------------------
  // Gated on the recording actually having audio to transcribe (same evidence
  // the backend's `generate_captions` command itself requires — a mic or
  // system-audio source captured). No audio source means there's nothing to
  // generate captions from, so the whole section is disabled up front rather
  // than letting the user hit the backend's "Recording has no audio" error.
  const audioAvailable = recording.has_mic || recording.has_sysaudio;

  const [captionsGenerating, setCaptionsGenerating] = useState(false);
  const [captionsProgress, setCaptionsProgress] = useState(0);

  // Listen for `captions-progress` events (id, ratio 0..1) scoped to THIS
  // recording while a generation is in flight. Mirrors the app-wide
  // `listen<T>` pattern used elsewhere (e.g. SpeechModelPicker's download
  // progress) — subscribe once per recording, filter by id since the event is
  // global (the backend doesn't scope emission to a webview).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<{ id: string; ratio: number }>("captions-progress", (event) => {
      if (event.payload.id !== recording.id) return;
      setCaptionsProgress(Math.round(Math.max(0, Math.min(1, event.payload.ratio)) * 100));
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [recording.id]);

  const setCaptionsEnabled = (enabled: boolean) =>
    setProject((p) => ({ ...p, captions: { ...p.captions, enabled } }));

  /** Persist a new segment list, clamped/sorted/de-overlapped against the
   *  clip's real duration — mirrors `applySpeedEdit`'s safety-net pattern so a
   *  stale/hand-edited project can never leave an invalid list. */
  const setCaptionSegments = useCallback((segments: ProjectCaptionSegment[]) => {
    setProject((p) => ({
      ...p,
      captions: {
        ...p.captions,
        segments: clampCaptionSegments(segments, durationMsRef.current || 0),
      },
    }));
  }, []);

  /** Generate (or regenerate) captions for this recording. Runs the ASR
   *  pipeline via the Task 2 backend command, tracks progress from the
   *  `captions-progress` listener above, and on success stores the returned
   *  segments (clamped) and turns captions on. Errors surface as a toast with
   *  the friendly message the backend already returns; detail is in the log. */
  const onGenerateCaptions = useCallback(async () => {
    setCaptionsGenerating(true);
    setCaptionsProgress(0);
    try {
      const segments = await generateCaptions(recording.id);
      setProject((p) => ({
        ...p,
        captions: {
          enabled: true,
          segments: clampCaptionSegments(segments, durationMsRef.current || 0),
        },
      }));
    } catch (e) {
      toasts.push({ tone: "error", message: String(e) });
    } finally {
      setCaptionsGenerating(false);
    }
  }, [recording.id, toasts]);

  /** Edit one segment's text in place (by index into the sorted/clamped
   *  list), then re-run the same clamp/save path as any other edit. */
  const editCaptionSegment = useCallback(
    (index: number, text: string) => {
      const segments = project.captions.segments ?? [];
      if (index < 0 || index >= segments.length) return;
      setCaptionSegments(segments.map((s, i) => (i === index ? { ...s, text } : s)));
    },
    [project.captions.segments, setCaptionSegments],
  );

  /** Delete one segment (by index). */
  const deleteCaptionSegment = useCallback(
    (index: number) => {
      const segments = project.captions.segments ?? [];
      setCaptionSegments(segments.filter((_, i) => i !== index));
    },
    [project.captions.segments, setCaptionSegments],
  );

  // ---- Webcam updaters ----------------------------------------------------
  // Each updater merges onto the existing webcam settings, falling back to the
  // defaults if `webcam` is somehow still null (shouldn't happen once the load
  // effect has initialized it for a webcam recording, but keeps updates safe).
  const WEBCAM_DEFAULTS: WebcamSettings = {
    show: true,
    shape: "circle",
    corner: "br",
    sizeFrac: 0.2,
    autoShrink: false,
    mirror: false,
    scenes: [],
  };
  const setWebcam = (patch: Partial<WebcamSettings>) =>
    setProject((p) => ({ ...p, webcam: { ...WEBCAM_DEFAULTS, ...(p.webcam ?? {}), ...patch } }));

  // ---- Trim ---------------------------------------------------------------
  // Effective trim window in ms — null means "full range" throughout.
  const trim = project.trim;
  const trimStartMs = trim?.startMs ?? 0;
  const trimEndMs = trim?.endMs ?? duration * 1000;

  const setTrim = useCallback((next: { startMs: number; endMs: number } | null) => {
    setProject((p) => ({ ...p, trim: clampTrim(next, durationMsRef.current) }));
  }, []);

  const resetTrim = useCallback(() => setTrim(null), [setTrim]);

  // Once duration metadata is known, re-clamp any persisted trim against it
  // (handles a trim saved against a different/incorrect duration, e.g. from
  // a stale project or an edited source file).
  const clampTrimToDuration = useCallback((durationSec: number) => {
    const ms = Math.round(durationSec * 1000);
    durationMsRef.current = ms;
    setProject((p) => {
      if (p.trim === null) return p;
      const clamped = clampTrim(p.trim, ms);
      if (clamped && clamped.startMs === p.trim.startMs && clamped.endMs === p.trim.endMs) {
        return p;
      }
      return { ...p, trim: clamped };
    });
  }, []);

  // Pointer-drag state for the timeline handles: which handle ("start" | "end")
  // is currently being dragged, if any. Kept in a ref (not state) since drag
  // handling only needs to read/write on pointer events, not trigger renders.
  const dragHandleRef = useRef<"start" | "end" | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const msFromClientX = useCallback((clientX: number): number => {
    const el = timelineRef.current;
    const durMs = durationMsRef.current;
    if (!el || durMs <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.round(Math.min(Math.max(frac, 0), 1) * durMs);
  }, []);

  const onHandlePointerDown = useCallback(
    (handle: "start" | "end") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragHandleRef.current = handle;
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onTimelinePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const handle = dragHandleRef.current;
      if (!handle) return;
      const ms = msFromClientX(e.clientX);
      const currentTrim = projectRef.current.trim ?? { startMs: 0, endMs: durationMsRef.current };
      // If the dragged handle's new position crosses over its sibling, swap
      // which handle we consider "dragged" so the pointer keeps controlling
      // the handle under it after clampTrim's min/max sort flips start/end —
      // otherwise the visual handle sticks at the crossover point.
      if (handle === "start" && ms > currentTrim.endMs) {
        dragHandleRef.current = "end";
      } else if (handle === "end" && ms < currentTrim.startMs) {
        dragHandleRef.current = "start";
      }
      const activeHandle = dragHandleRef.current;
      const next =
        activeHandle === "start"
          ? { startMs: ms, endMs: currentTrim.endMs }
          : { startMs: currentTrim.startMs, endMs: ms };
      setTrim(next);
    },
    [msFromClientX, setTrim],
  );

  const onTimelinePointerUp = useCallback(() => {
    dragHandleRef.current = null;
  }, []);

  // Click-to-seek on the shared timeline track body: map the click x to a time
  // and seek the playhead (onScrub re-clamps into the trim window). Chip / handle
  // pointerdowns call stopPropagation, so this only fires on empty track space —
  // it's wired on the track background, below the interactive lanes in the hit
  // stack. `onScrub` wants seconds.
  const onTrackSeek = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Ignore anything that originated on an interactive child (defensive: the
      // children stopPropagation, but a stray target check is cheap insurance).
      const ms = msFromClientX(e.clientX);
      onScrub(ms / 1000);
    },
    [msFromClientX, onScrub],
  );

  // ---- Webcam "cut to camera" scenes (camera lane) -------------------------
  // Scenes reuse the SAME generic range core the zoom lane's blocks do
  // (moveRange/resizeRange/placeRange/nextRangeId — see editorProject.ts's
  // "Generic range editing core" comment) rather than named per-feature
  // wrappers, since scenes have no pre-existing call-site signature to
  // preserve. EVERY write funnels through `applySceneEdit`, which re-runs
  // `clampWebcamScenes` before touching `setProject` — the hard invariant:
  // `webcamSceneAt` (preview + export) assumes sorted, non-overlapping input,
  // so an unclamped write would corrupt rendering. Mirrors `applySpeedEdit`.
  const applySceneEdit = useCallback((fn: (scenes: WebcamScene[]) => WebcamScene[]) => {
    setProject((p) => {
      const scenes = p.webcam?.scenes ?? [];
      const next = fn(scenes);
      if (next === scenes) return p; // no-op edit
      const clamped = clampWebcamScenes(next, durationMsRef.current || 0);
      return { ...p, webcam: { ...WEBCAM_DEFAULTS, ...(p.webcam ?? {}), scenes: clamped } };
    });
  }, []);

  // "Add camera scene": a 3s scene at the playhead, clamped into free space —
  // stop-at-neighbour via `placeRange`, mirroring "Add speed" (never pushes
  // past an overlap; no-op with a toast when there's no room).
  const addWebcamScene = useCallback(() => {
    const durMs = durationMsRef.current || 0;
    if (durMs <= 0) return;
    const v = videoRef.current;
    const playheadMs = v ? Math.round(v.currentTime * 1000) : 0;
    const slot = placeRange(
      scenesRef.current,
      playheadMs,
      SCENE_ADD_DEFAULT_LENGTH_MS,
      durMs,
      SCENE_MIN_LENGTH_MS,
    );
    if (!slot) {
      toasts.push({
        tone: "info",
        message: "No room for a camera scene here — move the playhead to an open spot.",
      });
      return;
    }
    const newId = nextRangeId(scenesRef.current, "s");
    const scene: WebcamScene = { id: newId, startMs: slot.startMs, endMs: slot.endMs };
    applySceneEdit((scenes) => [...scenes, scene].sort((a, b) => a.startMs - b.startMs));
    setSelectedSceneId(newId);
  }, [applySceneEdit, toasts]);

  // Resize one edge of a scene (id-addressed → index inside the current list).
  const resizeScene = useCallback(
    (id: string, edge: "start" | "end", valueMs: number) => {
      applySceneEdit((scenes) => {
        const idx = scenes.findIndex((s) => s.id === id);
        if (idx < 0) return scenes;
        return resizeRange(scenes, idx, edge, valueMs, durationMsRef.current || 0, SCENE_MIN_LENGTH_MS);
      });
    },
    [applySceneEdit],
  );

  // Move a scene's body (keeps length; stops at neighbours).
  const moveScene = useCallback(
    (id: string, newStartMs: number) => {
      applySceneEdit((scenes) => {
        const idx = scenes.findIndex((s) => s.id === id);
        if (idx < 0) return scenes;
        return moveRange(scenes, idx, newStartMs, durationMsRef.current || 0);
      });
    },
    [applySceneEdit],
  );

  // Delete the selected scene. Clears the selection immediately (avoids a
  // one-frame stale inspector), mirroring `deleteBlock`.
  const deleteScene = useCallback(
    (id: string) => {
      applySceneEdit((scenes) => scenes.filter((s) => s.id !== id));
      setSelectedSceneId(null);
    },
    [applySceneEdit],
  );

  // Drop a stale scene selection if it no longer exists (e.g. deleted from
  // another path, or the recording changed). Mirrors the zoom block effect.
  useEffect(() => {
    if (selectedSceneId === null) return;
    if (!(project.webcam?.scenes ?? []).some((s) => s.id === selectedSceneId)) {
      setSelectedSceneId(null);
    }
  }, [project.webcam?.scenes, selectedSceneId]);

  // Camera lane pointer drag (chip body + edges) — mirrors the zoom lane
  // exactly: same `timelineRef`/`msFromClientX`, pointer capture, and
  // grab-offset-preserving body drag.
  const sceneDragRef = useRef<{
    id: string;
    kind: "start" | "end" | "body";
    grabOffsetMs: number;
  } | null>(null);

  const onSceneChipPointerDown = useCallback(
    (id: string, kind: "start" | "end" | "body") =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedSceneId(id);
        const scene = scenesRef.current.find((s) => s.id === id);
        const grabMs = msFromClientX(e.clientX);
        sceneDragRef.current = {
          id,
          kind,
          grabOffsetMs: scene ? grabMs - scene.startMs : 0,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      },
    [msFromClientX],
  );

  const onScenePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = sceneDragRef.current;
      if (!drag) return;
      const ms = msFromClientX(e.clientX);
      if (drag.kind === "body") {
        moveScene(drag.id, ms - drag.grabOffsetMs);
      } else {
        resizeScene(drag.id, drag.kind, ms);
      }
    },
    [msFromClientX, moveScene, resizeScene],
  );

  const onScenePointerUp = useCallback(() => {
    sceneDragRef.current = null;
  }, []);

  // ---- Masks (pixelate/highlight) -----------------------------------------
  // UNLIKE every other lane, masks move/resize FREELY: they may legitimately
  // overlap in time (`clampMasks` preserves overlaps — see its doc), so this
  // section does NOT reuse the generic range core's moveRange/resizeRange
  // (which stop at neighbours to prevent overlap). Move/resize here clamp
  // ONLY to `[0, duration]` with a `MASK_MIN_LENGTH_MS` floor — no neighbour
  // awareness at all. EVERY write funnels through `applyMaskEdit`, which
  // re-runs `clampMasks` before touching `setProject` — mirrors
  // `applySceneEdit`'s single-choke-point shape exactly, just with a
  // different (overlap-preserving) clamp function.
  const applyMaskEdit = useCallback((fn: (masks: Mask[]) => Mask[]) => {
    setProject((p) => {
      const next = fn(p.masks);
      if (next === p.masks) return p; // no-op edit
      return { ...p, masks: clampMasks(next, durationMsRef.current || 0) };
    });
  }, []);

  // "Add mask" at the playhead: 3s, pixelate, centered default rect. Unlike
  // "Add camera scene" / "Add zoom", there's no `placeRange`-style slot search
  // — masks are allowed to overlap, so the default window never needs to dodge
  // existing masks. Deterministic id via `nextRangeId(masks, "m")`.
  const addMask = useCallback(() => {
    const durMs = durationMsRef.current || 0;
    if (durMs <= 0) return;
    const v = videoRef.current;
    const playheadMs = v ? Math.round(v.currentTime * 1000) : 0;
    const startMs = Math.max(0, Math.min(playheadMs, Math.max(0, durMs - MASK_ADD_DEFAULT_LENGTH_MS)));
    const endMs = Math.min(durMs, startMs + MASK_ADD_DEFAULT_LENGTH_MS);
    if (endMs - startMs < MASK_MIN_LENGTH_MS) return; // clip too short to fit a mask
    const newId = nextRangeId(masksRef.current, "m");
    const mask: Mask = {
      id: newId,
      startMs,
      endMs,
      rect: { ...MASK_ADD_DEFAULT_RECT },
      kind: "pixelate",
    };
    applyMaskEdit((masks) => [...masks, mask]);
    setSelectedMaskId(newId);
  }, [applyMaskEdit]);

  // Move a mask bodily (keeps length), clamped only to [0, duration] — no
  // neighbour stop, mirrors `moveScene` minus the neighbour bounds.
  const moveMask = useCallback(
    (id: string, newStartMs: number) => {
      applyMaskEdit((masks) => {
        const idx = masks.findIndex((m) => m.id === id);
        if (idx < 0) return masks;
        const m = masks[idx];
        const len = m.endMs - m.startMs;
        const durMs = durationMsRef.current || 0;
        const start = clampMs(Math.round(newStartMs), 0, Math.max(0, durMs - len));
        if (start === m.startMs) return masks;
        return masks.map((x, i) => (i === idx ? { ...x, startMs: start, endMs: start + len } : x));
      });
    },
    [applyMaskEdit],
  );

  // Resize one edge of a mask, clamped only to [0, duration] with the
  // MASK_MIN_LENGTH_MS floor — no neighbour stop, mirrors `resizeScene` minus
  // the neighbour bounds.
  const resizeMask = useCallback(
    (id: string, edge: "start" | "end", valueMs: number) => {
      applyMaskEdit((masks) => {
        const idx = masks.findIndex((m) => m.id === id);
        if (idx < 0) return masks;
        const m = masks[idx];
        const durMs = durationMsRef.current || 0;
        let v = clampMs(Math.round(valueMs), 0, Math.max(0, durMs));
        if (edge === "start") {
          v = clampMs(v, 0, Math.max(0, m.endMs - MASK_MIN_LENGTH_MS));
          if (v === m.startMs) return masks;
          return masks.map((x, i) => (i === idx ? { ...x, startMs: v } : x));
        } else {
          v = clampMs(v, m.startMs + MASK_MIN_LENGTH_MS, Math.max(0, durMs));
          if (v === m.endMs) return masks;
          return masks.map((x, i) => (i === idx ? { ...x, endMs: v } : x));
        }
      });
    },
    [applyMaskEdit],
  );

  // Delete the selected mask. Clears the selection immediately (avoids a
  // one-frame stale inspector), mirroring `deleteScene`.
  const deleteMask = useCallback(
    (id: string) => {
      applyMaskEdit((masks) => masks.filter((m) => m.id !== id));
      setSelectedMaskId(null);
    },
    [applyMaskEdit],
  );

  // Change the selected mask's kind (pixelate/highlight) — inspector select.
  const setMaskKind = useCallback(
    (id: string, kind: Mask["kind"]) => {
      applyMaskEdit((masks) => masks.map((m) => (m.id === id ? { ...m, kind } : m)));
    },
    [applyMaskEdit],
  );

  // Drop a stale mask selection if it no longer exists (e.g. deleted from
  // another path, or the recording changed). Mirrors the scene/zoom effects.
  useEffect(() => {
    if (selectedMaskId === null) return;
    if (!project.masks.some((m) => m.id === selectedMaskId)) {
      setSelectedMaskId(null);
    }
  }, [project.masks, selectedMaskId]);

  // Masks-lane pointer drag (chip body + edges) — mirrors the camera lane
  // exactly: same `timelineRef`/`msFromClientX`, pointer capture, and
  // grab-offset-preserving body drag. The only difference is the underlying
  // move/resize calls (moveMask/resizeMask — free, no neighbour stop).
  const maskDragRef = useRef<{
    id: string;
    kind: "start" | "end" | "body";
    grabOffsetMs: number;
  } | null>(null);

  const onMaskChipPointerDown = useCallback(
    (id: string, kind: "start" | "end" | "body") =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedMaskId(id);
        const mask = masksRef.current.find((m) => m.id === id);
        const grabMs = msFromClientX(e.clientX);
        maskDragRef.current = {
          id,
          kind,
          grabOffsetMs: mask ? grabMs - mask.startMs : 0,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      },
    [msFromClientX],
  );

  const onMaskPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = maskDragRef.current;
      if (!drag) return;
      const ms = msFromClientX(e.clientX);
      if (drag.kind === "body") {
        moveMask(drag.id, ms - drag.grabOffsetMs);
      } else {
        resizeMask(drag.id, drag.kind, ms);
      }
    },
    [msFromClientX, moveMask, resizeMask],
  );

  const onMaskPointerUp = useCallback(() => {
    maskDragRef.current = null;
  }, []);

  // ---- Zoom blocks --------------------------------------------------------
  // Every zoom edit funnels through `applyBlockEdit`, which folds first-edit
  // MATERIALIZATION into the same `setProject` call as the edit itself (one
  // update, never two): if the project is still in "auto" mode, its blocks are
  // materialized from the recorded clicks (`materializeBlocks` — the same
  // `z1,z2,…` ids the auto-preview chips already carry, so a selection made in
  // auto survives the flip) and the mode becomes "custom" BEFORE `fn` runs. In
  // "custom" mode it edits the stored blocks in place. `fn` receives the
  // resolved block list and returns the next one; all overlap/clamp semantics
  // live in the pure helpers (resize/move/…), so this only wires state.
  const applyBlockEdit = useCallback(
    (fn: (blocks: ZoomBlock[]) => ZoomBlock[]) => {
      setProject((p) => {
        const durMs = durationMsRef.current || 0;
        let blocks: ZoomBlock[];
        if (p.zoom.mode === "custom") {
          blocks = p.zoom.blocks ?? [];
        } else {
          // auto (or off, defensively): materialize from clicks. Off has no auto
          // blocks to speak of, but an edit only reaches here from a visible lane
          // (custom/auto), so this is effectively the auto path.
          blocks = materializeBlocks(
            eventsHeaderRef.current ?? { k: "header", v: 1, capture: { kind: "display", rect: [0, 0, 1, 1], px_scale: 1 }, screen_h: 1 },
            eventsRef.current,
            durMs,
          );
        }
        const next = fn(blocks);
        if (p.zoom.mode === "custom" && next === blocks) return p; // no-op edit
        return { ...p, zoom: { mode: "custom", blocks: next } };
      });
    },
    [],
  );

  // Resize one edge of a block (id-addressed → index inside the resolved list).
  const resizeBlock = useCallback(
    (id: string, edge: "start" | "end", valueMs: number) => {
      applyBlockEdit((blocks) => {
        const idx = blocks.findIndex((b) => b.id === id);
        if (idx < 0) return blocks;
        return resizeZoomBlock(blocks, idx, edge, valueMs, durationMsRef.current || 0);
      });
    },
    [applyBlockEdit],
  );

  // Move a block's body (keeps length; stops at neighbours).
  const moveBlock = useCallback(
    (id: string, newStartMs: number) => {
      applyBlockEdit((blocks) => {
        const idx = blocks.findIndex((b) => b.id === id);
        if (idx < 0) return blocks;
        return moveZoomBlock(blocks, idx, newStartMs, durationMsRef.current || 0);
      });
    },
    [applyBlockEdit],
  );

  // Set a block's zoom level; re-clamp its center into the new scale's safe box
  // so a higher zoom can't leave the center off-frame.
  const setBlockScale = useCallback(
    (id: string, scale: number) => {
      applyBlockEdit((blocks) =>
        blocks.map((b) => {
          if (b.id !== id) return b;
          const c = clampZoomCenter(b.cx, b.cy, scale);
          return { ...b, scale, cx: c.cx, cy: c.cy };
        }),
      );
    },
    [applyBlockEdit],
  );

  // Delete the selected block. Clears the selection (the effect above would too,
  // but doing it here avoids a one-frame stale inspector).
  const deleteBlock = useCallback(
    (id: string) => {
      applyBlockEdit((blocks) => blocks.filter((b) => b.id !== id));
      setSelectedBlockId(null);
    },
    [applyBlockEdit],
  );

  // "Add zoom": a manual block at the playhead (2s @2×, centered), clamped to a
  // free gap. Both the placement and the deterministic id (max numeric suffix +
  // 1, NOT Date.now) are computed OUTSIDE the state updater from the resolved
  // block list `effectiveBlocks` — which is exactly what `applyBlockEdit`'s `fn`
  // receives (custom → stored blocks; auto → the same materialized list). That
  // keeps the updater pure (safe under React double-invoke) and lets us select
  // the new id synchronously. Bails (no block) if no gap ≥ min length remains.
  const addZoomBlock = useCallback(() => {
    const durMs = durationMsRef.current || 0;
    if (durMs <= 0) return;
    const v = videoRef.current;
    const playheadMs = v ? Math.round(v.currentTime * 1000) : 0;

    const slot = placeZoomBlock(
      effectiveBlocks,
      playheadMs,
      ZOOM_ADD_DEFAULT_LENGTH_MS,
      durMs,
    );
    if (!slot) return; // timeline full / too short
    const newId = nextZoomBlockId(effectiveBlocks);
    const block: ZoomBlock = {
      id: newId,
      startMs: slot.startMs,
      endMs: slot.endMs,
      cx: 0.5,
      cy: 0.5,
      scale: ZOOM_ADD_DEFAULT_SCALE,
      mode: "manual",
    };
    applyBlockEdit((blocks) =>
      [...blocks, block].sort((a, b) => a.startMs - b.startMs),
    );
    setSelectedBlockId(newId);
  }, [applyBlockEdit, effectiveBlocks]);

  // Zoom section header controls: mode select + reset-to-auto.
  const setZoomMode = useCallback((mode: ZoomMode) => {
    setProject((p) => {
      if (p.zoom.mode === mode) return p;
      // Switching to custom while auto: materialize so the chips are editable.
      if (mode === "custom") {
        const blocks =
          p.zoom.mode === "custom"
            ? p.zoom.blocks ?? []
            : materializeBlocks(
                eventsHeaderRef.current ?? { k: "header", v: 1, capture: { kind: "display", rect: [0, 0, 1, 1], px_scale: 1 }, screen_h: 1 },
                eventsRef.current,
                durationMsRef.current || 0,
              );
        return { ...p, zoom: { mode: "custom", blocks } };
      }
      // auto / off: blocks go null (contract: non-null only in custom).
      return { ...p, zoom: { mode, blocks: null } };
    });
  }, []);

  const resetToAuto = useCallback(async () => {
    const confirmed = await ask(
      "Reset zoom to automatic? Your hand-edited zoom blocks will be replaced by the click-driven auto-zoom.",
      { title: "Reset zoom to auto", kind: "warning" },
    );
    if (!confirmed) return;
    setSelectedBlockId(null);
    setProject((p) => ({ ...p, zoom: { mode: "auto", blocks: null } }));
  }, []);

  // ---- Zoom lane pointer drag (chip body + edges) -------------------------
  // Mirrors the trim-handle pattern: pointer-capture on the grabbed element,
  // move routed through a single handler, id/edge/grab-offset stashed in a ref.
  // `grabOffsetMs` records where inside the chip the pointer grabbed (body drag),
  // so the chip doesn't jump its start to the cursor.
  const zoomDragRef = useRef<{
    id: string;
    kind: "start" | "end" | "body";
    grabOffsetMs: number;
  } | null>(null);

  const onZoomChipPointerDown = useCallback(
    (id: string, kind: "start" | "end" | "body") =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedBlockId(id);
        const block = zoomBlocksRef.current.find((b) => b.id === id);
        const grabMs = msFromClientX(e.clientX);
        zoomDragRef.current = {
          id,
          kind,
          grabOffsetMs: block ? grabMs - block.startMs : 0,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      },
    [msFromClientX],
  );

  const onZoomPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = zoomDragRef.current;
      if (!drag) return;
      const ms = msFromClientX(e.clientX);
      if (drag.kind === "body") {
        moveBlock(drag.id, ms - drag.grabOffsetMs);
      } else {
        resizeBlock(drag.id, drag.kind, ms);
      }
    },
    [msFromClientX, moveBlock, resizeBlock],
  );

  const onZoomPointerUp = useCallback(() => {
    zoomDragRef.current = null;
  }, []);

  // ---- Speed segments -----------------------------------------------------
  // Speed ranges are always stored sorted + non-overlapping. Unlike zoom
  // (which drops overlaps via clampSpeedRanges — see the Task-1 note), the UI
  // PREVENTS overlaps up front: adds no-op when the playhead is inside a range,
  // and edge drags stop at neighbours (`resizeSpeedRange`). Every edit re-runs
  // `clampSpeedRanges` at the end as a safety net so a persisted/stale project
  // can't leave an invalid list.
  const applySpeedEdit = useCallback(
    (fn: (ranges: SpeedRange[]) => SpeedRange[]) => {
      setProject((p) => {
        const next = fn(p.speed);
        if (next === p.speed) return p; // no-op edit
        return { ...p, speed: clampSpeedRanges(next, durationMsRef.current || 0) };
      });
    },
    [],
  );

  // "Add speed": a 2× segment at the playhead (5s), clamped into free space.
  // No-op (with a toast) when the playhead sits inside an existing range or no
  // gap ≥ the minimum length remains — mirrors the zoom lane's stop-at-neighbour
  // behaviour rather than pushing past neighbours.
  const addSpeedRange = useCallback(() => {
    const durMs = durationMsRef.current || 0;
    if (durMs <= 0) return;
    const v = videoRef.current;
    const playheadMs = v ? Math.round(v.currentTime * 1000) : 0;
    const slot = placeSpeedRange(
      speedRangesRef.current,
      playheadMs,
      SPEED_ADD_DEFAULT_LENGTH_MS,
      durMs,
    );
    if (!slot) {
      toasts.push({
        tone: "info",
        message: "No room for a speed segment here — move the playhead to an open spot.",
      });
      return;
    }
    const range: SpeedRange = {
      startMs: slot.startMs,
      endMs: slot.endMs,
      rate: SPEED_ADD_DEFAULT_RATE,
    };
    // Insert + re-sort; select the new range by its post-sort index.
    const nextSorted = [...speedRangesRef.current, range].sort(
      (a, b) => a.startMs - b.startMs,
    );
    applySpeedEdit(() => nextSorted);
    setSelectedSpeedIdx(nextSorted.findIndex((r) => r === range));
  }, [applySpeedEdit, toasts]);

  const setSpeedRate = useCallback(
    (idx: number, rate: number) => {
      applySpeedEdit((ranges) =>
        ranges.map((r, i) => (i === idx ? { ...r, rate } : r)),
      );
    },
    [applySpeedEdit],
  );

  const deleteSpeedRange = useCallback(
    (idx: number) => {
      applySpeedEdit((ranges) => ranges.filter((_, i) => i !== idx));
      setSelectedSpeedIdx(null);
    },
    [applySpeedEdit],
  );

  // Speed lane pointer drag (chip body + edges) — mirrors the zoom lane. The
  // drag is index-addressed; body drags stop at neighbours via a manual clamp
  // (moveSpeedRange-equivalent using resizeSpeedRange twice would reorder, so
  // body-move is done inline), edge drags use `resizeSpeedRange`.
  const speedDragRef = useRef<{
    idx: number;
    kind: "start" | "end" | "body";
    grabOffsetMs: number;
    lenMs: number;
  } | null>(null);

  const onSpeedChipPointerDown = useCallback(
    (idx: number, kind: "start" | "end" | "body") =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedSpeedIdx(idx);
        const range = speedRangesRef.current[idx];
        const grabMs = msFromClientX(e.clientX);
        speedDragRef.current = {
          idx,
          kind,
          grabOffsetMs: range ? grabMs - range.startMs : 0,
          lenMs: range ? range.endMs - range.startMs : 0,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      },
    [msFromClientX],
  );

  const onSpeedPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = speedDragRef.current;
      if (!drag) return;
      const ms = msFromClientX(e.clientX);
      const { idx, kind, grabOffsetMs, lenMs } = drag;
      if (kind === "body") {
        // Body move: slide the range, keeping length, clamped so it stays in
        // [0, dur] and butts (never overlaps) either neighbour.
        applySpeedEdit((ranges) => {
          if (idx < 0 || idx >= ranges.length) return ranges;
          const durMs = durationMsRef.current || 0;
          const prev = ranges[idx - 1];
          const next = ranges[idx + 1];
          const lo = prev ? prev.endMs : 0;
          const hi = (next ? next.startMs : durMs) - lenMs;
          let start = Math.round(ms - grabOffsetMs);
          start = Math.min(Math.max(start, lo), Math.max(lo, hi));
          if (start === ranges[idx].startMs) return ranges;
          return ranges.map((r, i) =>
            i === idx ? { ...r, startMs: start, endMs: start + lenMs } : r,
          );
        });
      } else {
        applySpeedEdit((ranges) =>
          resizeSpeedRange(ranges, idx, kind, ms, durationMsRef.current || 0),
        );
      }
    },
    [msFromClientX, applySpeedEdit],
  );

  const onSpeedPointerUp = useCallback(() => {
    speedDragRef.current = null;
  }, []);

  const selectedSpeed =
    selectedSpeedIdx !== null ? project.speed[selectedSpeedIdx] ?? null : null;

  // Speed lane is always available (no capture-time evidence needed — any clip
  // can be sped up/slowed down).

  const selectedScene = selectedSceneId
    ? (project.webcam?.scenes ?? []).find((s) => s.id === selectedSceneId) ?? null
    : null;

  const selectedMask = selectedMaskId
    ? project.masks.find((m) => m.id === selectedMaskId) ?? null
    : null;

  const selectedBlock = selectedBlockId
    ? effectiveBlocks.find((b) => b.id === selectedBlockId) ?? null
    : null;
  // Center-pick is active whenever a block is selected: a click on the preview
  // canvas maps to capture coords and sets that block's center.
  const pickMode = selectedBlock !== null;

  // Gate the whole zoom lane + section on evidence that zoom is meaningful:
  // recorded clicks, an explicit custom-mode project, or already-resolved
  // blocks. `n_clicks` is the M3 column; when it's NULL (pre-M3 rows never
  // populated it) fall back to events-file presence — same pattern the cursor
  // section uses — so old recordings with a click track still expose zoom.
  const hasClicks =
    recording.n_clicks !== null ? recording.n_clicks > 0 : eventsAvailable;
  const zoomGateOpen =
    hasClicks || project.zoom.mode === "custom" || effectiveBlocks.length > 0;

  // Click the preview canvas (while a block is selected) → set that block's
  // center. The canvas is CSS-scaled to fit (object-contain), so we first map
  // the client point into the canvas' intrinsic pixel space, then invert the
  // compositor mapping (`canvasToCapture`) at the CURRENT frame's pan/zoom to
  // land on the true capture point under the cursor. The resulting center is
  // clamped into the block's own scale-safe box (same bound generateAutoZoom
  // uses) before it's stored. A click in the padding / letterbox band (outside
  // the content rect) returns null and is ignored.
  const onPreviewClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const block = selectedBlock;
      if (!block || block.id === undefined) return;
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // object-contain: the drawn image is letterboxed inside the element. Map
      // the client point into intrinsic canvas pixels via the uniform contain
      // scale + centering offsets, so a click maps correctly regardless of the
      // element's on-screen size.
      const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
      const dispW = canvas.width * scale;
      const dispH = canvas.height * scale;
      const offX = (rect.width - dispW) / 2;
      const offY = (rect.height - dispH) / 2;
      const px = (e.clientX - rect.left - offX) / scale;
      const py = (e.clientY - rect.top - offY) / scale;

      const p = projectRef.current;
      const layout = outputLayout(vw, vh, p.appearance.padding, p.appearance.aspect);
      // Invert at the zoom state ACTIVELY shown for this block at the current
      // playhead (so picking while already magnified lands where the user sees).
      const tMsSource = video.currentTime * 1000;
      const blocks = zoomBlocksRef.current;
      const zoom = blocks.length
        ? zoomStateAt(tMsSource, blocks)
        : { cx: 0.5, cy: 0.5, scale: 1 };
      const hit = canvasToCapture(px, py, layout, zoom);
      if (!hit) return; // clicked the padding / letterbox band

      const c = clampZoomCenter(hit.nx, hit.ny, block.scale);
      applyBlockEdit((bs) =>
        bs.map((b) => (b.id === block.id ? { ...b, cx: c.cx, cy: c.cy } : b)),
      );
    },
    [selectedBlock, applyBlockEdit],
  );

  // Shared setup for client->capture mapping: canvas-intrinsic pixel coords
  // for `clientX/clientY` plus the layout/zoom state needed by
  // `canvasToCapture`/`canvasToCaptureUnclamped`. Returns null when the
  // canvas/video aren't ready. Extracted so `clientPointToCapture` and
  // `clientPointToCaptureUnclamped` share the exact same math (they must
  // never drift from each other or from `onPreviewClick`'s inline copy).
  const clientPointToCanvasCtx = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const dispW = canvas.width * scale;
    const dispH = canvas.height * scale;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    const px = (clientX - rect.left - offX) / scale;
    const py = (clientY - rect.top - offY) / scale;

    const p = projectRef.current;
    const layout = outputLayout(vw, vh, p.appearance.padding, p.appearance.aspect);
    const tMsSource = video.currentTime * 1000;
    const blocks = zoomBlocksRef.current;
    const zoom = blocks.length ? zoomStateAt(tMsSource, blocks) : { cx: 0.5, cy: 0.5, scale: 1 };
    return { px, py, layout, zoom };
  }, []);

  // Map a client point to normalized capture coords `{nx, ny}` — the SAME
  // canvas-intrinsic-space + `canvasToCapture` inversion `onPreviewClick`
  // uses, extracted here so the mask rect drag (move + corner resize) can
  // reuse it. Returns null when the canvas/video aren't ready, or the point
  // lands in the padding/letterbox band (canvasToCapture's own guard).
  const clientPointToCapture = useCallback(
    (clientX: number, clientY: number): { nx: number; ny: number } | null => {
      const ctx = clientPointToCanvasCtx(clientX, clientY);
      if (!ctx) return null;
      return canvasToCapture(ctx.px, ctx.py, ctx.layout, ctx.zoom);
    },
    [clientPointToCanvasCtx],
  );

  // Same as `clientPointToCapture` but UNCLAMPED: still returns the true
  // capture-space point when the client point lands outside the drawn
  // content rect (padding/letterbox band) or outside [0,1] in capture space.
  // Used only for the mask corner-resize grab offset (see
  // `onMaskRectPointerDown`) — a 12px corner handle drawn on a zoom-clipped
  // edge can have roughly half its hit area sitting just outside the content
  // rect, and `clientPointToCapture` returning null there would silently
  // record a zero grab offset and resurrect the absolute-position snap on
  // the first move.
  const clientPointToCaptureUnclamped = useCallback(
    (clientX: number, clientY: number): { nx: number; ny: number } | null => {
      const ctx = clientPointToCanvasCtx(clientX, clientY);
      if (!ctx) return null;
      return canvasToCaptureUnclamped(ctx.px, ctx.py, ctx.layout, ctx.zoom);
    },
    [clientPointToCanvasCtx],
  );

  // Selected mask's on-canvas rect-edit box: move (drag inside) + resize
  // (drag a corner handle), mapped via `clientPointToCapture` and clamped to
  // [0,1] by `applyMaskEdit`'s `clampMasks` pass. Drag state records which
  // corner (if any) is being resized and the grab offset — for BOTH body
  // move and corner resize — so neither branch snaps the rect to re-center
  // under the cursor. This matters especially for corner resize under zoom:
  // the on-screen handle is drawn on `maskRectBoxStyle`'s zoom-CLIPPED
  // display box (see `maskRectToContent`), which can sit at different
  // coordinates than the TRUE unclamped rect corner. Recording the grab
  // offset against the true corner (not the clipped display box) and
  // re-applying it in `resizeMaskRect` means a zero-movement drag is a
  // no-op regardless of how far the clipped box was from the true corner.
  //
  // `fixedX/fixedY` (corner resize only) is the OPPOSITE corner's absolute
  // position, captured ONCE here at pointer-down and passed through
  // unchanged on every move — `resizeMaskRect` no longer re-derives it from
  // the (mutated) rect + the corner label, because after the dragged corner
  // crosses the anchor mid-gesture that re-derivation picks the wrong
  // physical corner on every subsequent move (see resizeMaskRect's doc).
  const maskRectDragRef = useRef<{
    id: string;
    corner: "nw" | "ne" | "sw" | "se" | null; // null = body move
    grabDx: number; // grab point minus the dragged corner (or rect.x for a body move), in normalized capture coords
    grabDy: number;
    fixedX: number; // corner resize only: the anchor corner's position, fixed for the whole gesture
    fixedY: number;
  } | null>(null);

  const onMaskRectPointerDown = useCallback(
    (corner: "nw" | "ne" | "sw" | "se" | null) =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        const mask = selectedMask;
        if (!mask) return;
        e.preventDefault();
        e.stopPropagation();
        // UNCLAMPED hit test: a 12px corner handle drawn on a zoom-clipped
        // edge can have roughly half its hit area sitting just outside the
        // drawn content rect. `clientPointToCapture` would return null there,
        // which recorded a zero grab offset and resurrected the
        // absolute-position snap on the very first move. The unclamped
        // inverse mapping is well-defined outside [0,1] (only its in-bounds
        // guard rejects), so use it here to get a real grab offset even for
        // an outer-half grab.
        const hit = clientPointToCaptureUnclamped(e.clientX, e.clientY);
        // The TRUE (unclamped) point being grabbed: for a body move it's the
        // rect's origin; for a corner resize it's that corner, derived from
        // the true rect — never from the zoom-clipped display box.
        const grabX =
          corner === null ? mask.rect.x : corner.includes("e") ? mask.rect.x + mask.rect.w : mask.rect.x;
        const grabY =
          corner === null ? mask.rect.y : corner.includes("s") ? mask.rect.y + mask.rect.h : mask.rect.y;
        // The OPPOSITE (anchor) corner, captured once now — stays fixed for
        // the whole gesture regardless of how the dragged corner moves.
        const fixedX = corner === null ? 0 : corner.includes("e") ? mask.rect.x : mask.rect.x + mask.rect.w;
        const fixedY = corner === null ? 0 : corner.includes("s") ? mask.rect.y : mask.rect.y + mask.rect.h;
        maskRectDragRef.current = {
          id: mask.id,
          corner,
          grabDx: hit ? hit.nx - grabX : 0,
          grabDy: hit ? hit.ny - grabY : 0,
          fixedX,
          fixedY,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      },
    [selectedMask, clientPointToCaptureUnclamped],
  );

  const onMaskRectPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = maskRectDragRef.current;
      if (!drag) return;
      const hit = clientPointToCapture(e.clientX, e.clientY);
      if (!hit) return;
      applyMaskEdit((masks) => {
        const idx = masks.findIndex((m) => m.id === drag.id);
        if (idx < 0) return masks;
        if (drag.corner === null) {
          // Body move: keep w/h, reposition x/y so the grab point stays under
          // the cursor. clampMasks clamps x/y into [0,1] (and w/h to fit).
          const x = hit.nx - drag.grabDx;
          const y = hit.ny - drag.grabDy;
          return masks.map((mm, i) => (i === idx ? { ...mm, rect: { ...mm.rect, x, y } } : mm));
        }
        // Corner resize: pure helper reconstructs the dragged corner from the
        // grab offset (so zero movement = no-op) and anchors the OPPOSITE
        // corner at the FIXED point captured at pointer-down (never
        // re-derived from the mutated rect) — see resizeMaskRect's doc.
        const rect = resizeMaskRect(drag.fixedX, drag.fixedY, hit.nx, hit.ny, drag.grabDx, drag.grabDy);
        return masks.map((mm, i) => (i === idx ? { ...mm, rect } : mm));
      });
    },
    [applyMaskEdit, clientPointToCapture],
  );

  const onMaskRectPointerUp = useCallback(() => {
    maskRectDragRef.current = null;
  }, []);

  // Selected mask's edit-box geometry, in CSS px relative to the canvas
  // element's own on-screen box (so it can be rendered as an absolutely
  // positioned sibling of <canvas> inside the same `relative` wrapper).
  // Forward-maps the mask's normalized rect to canvas-intrinsic content
  // pixels via `maskRectToContent` (the SAME forward map the compositor uses
  // to draw the mask effect itself — see its doc), then converts intrinsic
  // canvas px -> on-screen CSS px with the object-contain scale/offset
  // (mirrors `clientPointToCapture`'s inverse of the same transform).
  // Recomputed on every render — `getBoundingClientRect` is cheap and
  // `current` already re-renders every rAF tick during playback, so the box
  // tracks zoom pan/scale live. Null when there's no selection or the canvas
  // isn't laid out yet (nothing to draw).
  let maskRectBoxStyle: React.CSSProperties | null = null;
  if (selectedMask) {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (canvas && video && video.videoWidth > 0 && video.videoHeight > 0 && canvas.width > 0) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const p = projectRef.current;
        const layout = outputLayout(
          video.videoWidth,
          video.videoHeight,
          p.appearance.padding,
          p.appearance.aspect,
        );
        const tMsSource = video.currentTime * 1000;
        const blocks = zoomBlocksRef.current;
        const zoom = blocks.length
          ? zoomStateAt(tMsSource, blocks)
          : { cx: 0.5, cy: 0.5, scale: 1 };
        const content = maskRectToContent(
          selectedMask.rect,
          zoom,
          layout.contentX,
          layout.contentY,
          layout.contentW,
          layout.contentH,
        );
        if (content) {
          const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
          const dispW = canvas.width * scale;
          const dispH = canvas.height * scale;
          const offX = (rect.width - dispW) / 2;
          const offY = (rect.height - dispH) / 2;
          maskRectBoxStyle = {
            left: offX + content.x * scale,
            top: offY + content.y * scale,
            width: content.w * scale,
            height: content.h * scale,
          };
        }
      }
    }
  }

  const bg = project.appearance.background;

  const pickImage = useCallback(async () => {
    setImporting(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (typeof picked !== "string") return; // cancelled
      const dest = await importEditorBackground(recording.id, picked);
      setBackground({ type: "image", path: dest });
    } catch (e) {
      toasts.push({
        tone: "error",
        message:
          typeof e === "string"
            ? e
            : "Couldn't import the image. See Settings → Diagnostics → logs.",
      });
    } finally {
      setImporting(false);
    }
  }, [recording.id, toasts]);

  // ---- Export -------------------------------------------------------------
  const exporting = exportPhase !== null;

  const onExport = useCallback(async () => {
    setExportPhase("decode");
    setExportPct(0);
    setExportEta(null);
    setExportedRevealId(null);
    // Per-phase ETA tracking (closure-local: one export run, one tracker).
    // Each phase has its own throughput, so the rate resets on phase change.
    let etaPhaseSeen: string | null = null;
    let etaT0 = 0;
    let etaPct0 = 0;
    let etaSmoothed: number | null = null;
    try {
      // Snapshot the current project so mid-export slider moves don't affect
      // the render. Force-disable the synthetic cursor when the recording
      // doesn't support it (real cursor baked in / no events), and likewise
      // force-disable the keystroke overlay when there's no events file to
      // source key data from — so a stale project flag can't draw either
      // overlay from data that doesn't exist.
      const projSnapshot = projectRef.current;
      const proj: EditorProject = {
        ...projSnapshot,
        cursor: cursorAvailable
          ? projSnapshot.cursor
          : { ...projSnapshot.cursor, enabled: false },
        keystrokes: eventsAvailable
          ? projSnapshot.keystrokes
          : { ...projSnapshot.keystrokes, enabled: false },
      };

      // Events file drives auto-zoom; missing/unreadable is fine (no zoom).
      let eventsJsonl: string | null = null;
      if (recording.events_path) {
        try {
          eventsJsonl = await readRecordingEvents(recording.id);
        } catch (e) {
          console.warn("[export] no events; rendering without zoom", e);
        }
      }

      // Decode the background image (if any) outside the pipeline so it stays
      // testable and free of DOM-image I/O.
      let bgImage: CanvasImageSource | null = null;
      if (proj.appearance.background.type === "image") {
        try {
          bgImage = await loadImage(backgroundImageSrc(proj.appearance.background.path));
        } catch (e) {
          console.warn("[export] background image failed to load; using fallback", e);
        }
      }

      const durationMs = Math.round((durationMsRef.current || duration * 1000) || 0);

      // Snapshot the format so a mid-export toggle can't switch the finalize
      // branch out from under the just-rendered bytes.
      const format = exportFormat;

      const bytes = await renderRecording({
        fileUrl: src,
        eventsJsonl,
        durationMs,
        project: proj,
        bgImage,
        // GIF: same composite pipeline, but 15fps / ≤960px / no audio (see
        // renderPipeline's GifSink). MP4 (default) → the WebCodecs encode path.
        format,
        // Webcam overlay: pass the webcam file when the recording HAS one AND
        // the (snapshotted) project either shows the bubble OR has at least one
        // "cut to camera" scene (scenes render even with the bubble hidden —
        // M6). `renderRecording` re-derives the same `show || scenes>0` gate;
        // any webcam demux/decode failure is non-fatal (renders without it).
        webcamUrl:
          webcamSrc && (proj.webcam?.show || (proj.webcam?.scenes.length ?? 0) > 0)
            ? webcamSrc
            : null,
        webcamOffsetMs,
        onProgress: (p) => {
          setExportPhase(p.phase);
          setExportPct(p.pct);
          // ETA = linear extrapolation of this phase's progress rate, lightly
          // EMA-smoothed; shown only once enough progress has accrued for the
          // rate to mean something (avoids wild estimates in the first ticks).
          const now = performance.now();
          if (p.phase !== etaPhaseSeen) {
            etaPhaseSeen = p.phase;
            etaT0 = now;
            etaPct0 = p.pct;
            etaSmoothed = null;
            setExportEta(null);
            return;
          }
          const dPct = p.pct - etaPct0;
          const dtSecs = (now - etaT0) / 1000;
          if (dPct < 3 || dtSecs < 1) return;
          const raw = (dtSecs * (100 - p.pct)) / dPct;
          etaSmoothed = etaSmoothed === null ? raw : etaSmoothed * 0.7 + raw * 0.3;
          setExportEta(etaSmoothed);
        },
      });

      let updated: RecordingRow;
      if (format === "gif") {
        // GIF has no soundtrack — skip the audio chain entirely. Rust just
        // writes `<id>.rendered.gif` and records the "rendered-gif" export row.
        setExportPhase("finalizing");
        setExportPct(100);
        setExportEta(null);
        updated = await saveRenderedGif(recording.id, bytes);
        setExportedRevealPath(renderedExportPath(updated.exports, "rendered-gif"));
      } else {
        // Rust muxes the (trim-aligned, speed-retimed) audio back in. The trim
        // window is SOURCE-time ms; clamp against the real duration so the audio
        // slice matches the frames the pipeline kept. Speed ranges are shifted
        // into POST-TRIM time (same `shiftRangesForTrim` the video pipeline's
        // speed map uses) so Rust applies them directly to the trimmed WAV.
        setExportPhase("finalizing");
        setExportPct(100);
        setExportEta(null);
        const clamped = clampTrim(proj.trim, durationMs);
        const shiftedSpeed = shiftRangesForTrim(
          clampSpeedRanges(proj.speed, durationMs),
          clamped,
        );
        updated = await finalizeRenderedRecording(
          recording.id,
          bytes,
          clamped,
          shiftedSpeed,
          proj.audio.normalizeLoudness,
          proj.audio.music,
        );
        setExportedRevealPath(renderedExportPath(updated.exports));
      }

      setExportedRevealId(recording.id);
      toasts.push({ tone: "success", message: "Export complete." });
    } catch (e) {
      console.error("[export] failed", e);
      // The render runs in the webview, so this error otherwise only reaches
      // the webview console — invisible in a production bundle. Bridge the raw
      // detail (name + message + stack) to the daily log so the "See logs"
      // toast below actually points at something. Fire-and-forget; never let a
      // logging failure mask the original error.
      const detail =
        e instanceof Error
          ? `format=${exportFormat} ${e.name}: ${e.message}\n${e.stack ?? "(no stack)"}`
          : `format=${exportFormat} ${String(e)}`;
      void logExportError(detail).catch(() => {});
      toasts.push({
        tone: "error",
        message: "Export failed. See Settings → Diagnostics → logs for details.",
      });
    } finally {
      setExportPhase(null);
      setExportPct(0);
      setExportEta(null);
    }
  }, [recording.id, recording.events_path, cursorAvailable, src, webcamSrc, webcamOffsetMs, duration, exportFormat, toasts]);

  const exportLabel =
    exportPhase === "decode"
      ? "Decoding"
      : exportPhase === "encode"
        ? "Encoding"
        : exportPhase === "mux"
          ? "Finalizing video"
          : exportPhase === "finalizing"
            ? "Finalizing audio"
            : null;

  const seg = (active: boolean) =>
    `flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium ${
      active ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-surface"
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={onBack}
          disabled={exporting}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface disabled:opacity-50"
        >
          <ArrowLeft size={15} /> Back
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          Edit · {recording.title?.trim() || recording.source_label || "Recording"}
        </h2>
        {exportedRevealId && !exporting ? (
          <button
            onClick={() => {
              const reveal = exportedRevealPath
                ? revealRecordingFile(exportedRevealPath)
                : revealRecording(exportedRevealId);
              reveal.catch((e) => {
                console.error("[editor] reveal failed", e);
                toasts.push({ tone: "error", message: String(e) });
              });
            }}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface"
          >
            <FolderOpen size={15} /> Reveal in Finder
          </button>
        ) : null}
        {/* Copy-to-clipboard (Task 7): copies the just-exported file as a
            pasteable file reference (macOS NSPasteboard), not a text path.
            Only shown once we have a concrete export path — mirrors the
            Reveal button's gating, but skips the `revealRecording(id)`
            fallback since clipboard copy needs an actual file to point at. */}
        {exportedRevealPath && !exporting ? (
          <button
            onClick={() => {
              copyExportToClipboard(exportedRevealPath).then(
                () => toasts.push({ tone: "success", message: "Copied!" }),
                (e) => {
                  console.error("[editor] copy to clipboard failed", e);
                  toasts.push({ tone: "error", message: String(e) });
                },
              );
            }}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface"
          >
            <Copy size={15} /> Copy
          </button>
        ) : null}
        {/* Export format select (session-local; not persisted). GIF renders a
            silent 15fps ≤960px animated GIF via the same composite pipeline. */}
        <label className="sr-only" htmlFor="export-format">
          Export format
        </label>
        <select
          id="export-format"
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value === "gif" ? "gif" : "mp4")}
          disabled={exporting || !loaded}
          title="Export format"
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] disabled:opacity-50"
        >
          <option value="mp4">MP4</option>
          <option value="gif">GIF</option>
        </select>
        <button
          onClick={() => void onExport()}
          disabled={exporting || !loaded}
          // While exporting: a fixed min-width + tabular digits so the button
          // doesn't change size as the percentage/ETA tick (no width wiggle).
          className={`flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50 ${
            exporting ? "min-w-[230px] tabular-nums" : ""
          }`}
        >
          {exporting ? (
            <Loader size={15} className="shrink-0 animate-spin" />
          ) : (
            <Download size={15} />
          )}
          {exporting
            ? `${exportLabel}… ${exportPct}%${
                exportEta !== null ? ` · ~${fmtEta(exportEta)} left` : ""
              }`
            : "Export"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Left: preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative grid flex-1 place-items-center overflow-hidden rounded-lg bg-black">
            <canvas
              ref={canvasRef}
              onClick={pickMode ? onPreviewClick : undefined}
              className={`max-h-full max-w-full object-contain ${
                pickMode ? "cursor-crosshair" : ""
              }`}
            />
            {/* Pick-mode affordance: a subtle hint that clicking the preview
                sets the selected zoom block's center. */}
            {pickMode ? (
              <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-accent/60 bg-black/60 px-2.5 py-1 text-[11px] font-medium text-accent shadow-sm">
                Click to set zoom center
              </div>
            ) : null}
            {/* Selected mask's rect-edit box: an EDIT AFFORDANCE overlay (the
                compositor already renders the mask effect itself, under this
                box) — drag the body to move, a corner handle to resize. Both
                map the pointer through `clientPointToCapture` (the inverse of
                the same forward transform `maskRectBoxStyle` uses), and every
                write clamps to [0,1] via `applyMaskEdit`'s `clampMasks` pass. */}
            {selectedMask && maskRectBoxStyle ? (
              <div
                onPointerDown={onMaskRectPointerDown(null)}
                onPointerMove={onMaskRectPointerMove}
                onPointerUp={onMaskRectPointerUp}
                onPointerCancel={onMaskRectPointerUp}
                className="absolute cursor-move touch-none border-2 border-rose-400 bg-rose-400/10"
                style={maskRectBoxStyle}
              >
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <div
                    key={corner}
                    onPointerDown={onMaskRectPointerDown(corner)}
                    onPointerMove={onMaskRectPointerMove}
                    onPointerUp={onMaskRectPointerUp}
                    onPointerCancel={onMaskRectPointerUp}
                    className={`absolute h-3 w-3 touch-none rounded-full border-2 border-rose-400 bg-white ${
                      corner === "nw"
                        ? "-left-1.5 -top-1.5 cursor-nwse-resize"
                        : corner === "ne"
                          ? "-right-1.5 -top-1.5 cursor-nesw-resize"
                          : corner === "sw"
                            ? "-bottom-1.5 -left-1.5 cursor-nesw-resize"
                            : "-bottom-1.5 -right-1.5 cursor-nwse-resize"
                    }`}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {/* Hidden source video; drives the canvas. */}
          <video
            ref={videoRef}
            key={src}
            src={src}
            className="hidden"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(v.duration);
              clampTrimToDuration(v.duration);
              // Draw the first frame once metadata + a frame are available.
              requestAnimationFrame(renderFrame);
            }}
            onLoadedData={() => requestAnimationFrame(renderFrame)}
            onEnded={() => {
              setPlaying(false);
              webcamVideoRef.current?.pause();
            }}
          />
          {/* Hidden webcam video; muted, time-synced to the main video and fed
              as the overlay bubble frame. Only mounted when the recording has
              a webcam file. */}
          {webcamSrc ? (
            <video
              ref={webcamVideoRef}
              key={webcamSrc}
              src={webcamSrc}
              muted
              playsInline
              className="hidden"
              onLoadedMetadata={() => {
                // Park the webcam at the main video's current time so the first
                // preview paint shows the right frame.
                const v = videoRef.current;
                if (v) hardSyncWebcam(v.currentTime);
                requestAnimationFrame(renderFrame);
              }}
              onLoadedData={() => requestAnimationFrame(renderFrame)}
            />
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent text-white"
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <input
              type="range"
              min={trimStartMs / 1000}
              max={trimEndMs / 1000 || 0}
              step={0.01}
              value={Math.min(Math.max(current, trimStartMs / 1000), trimEndMs / 1000 || 0)}
              onChange={(e) => onScrub(Number(e.target.value))}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="shrink-0 text-[12px] tabular-nums text-muted">
              {fmtTime(current)} / {fmtTime(duration)}
            </span>
          </div>

          {/* Timeline strip: duration-proportional bar with draggable
              trim in/out handles. Dimmed regions mark what will be cut. */}
          {duration > 0 ? (
            <div className="mt-3">
              <div
                ref={timelineRef}
                onPointerDown={onTrackSeek}
                className="relative h-8 w-full cursor-pointer touch-none select-none rounded-md border border-line bg-surface"
              >
                {/* Dimmed region before trim start */}
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-black/40"
                  style={{ width: `${(trimStartMs / (duration * 1000)) * 100}%` }}
                />
                {/* Dimmed region after trim end */}
                <div
                  className="pointer-events-none absolute inset-y-0 right-0 rounded-r-md bg-black/40"
                  style={{ width: `${100 - (trimEndMs / (duration * 1000)) * 100}%` }}
                />
                {/* Active (kept) region */}
                <div
                  className="pointer-events-none absolute inset-y-0 border-x-2 border-accent bg-accent/10"
                  style={{
                    left: `${(trimStartMs / (duration * 1000)) * 100}%`,
                    right: `${100 - (trimEndMs / (duration * 1000)) * 100}%`,
                  }}
                />
                {/* Playhead marker (current time). Non-interactive; the track
                    body handles click-to-seek. */}
                <div
                  className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/90"
                  style={{ left: `${Math.min(Math.max((current * 1000) / (duration * 1000), 0), 1) * 100}%` }}
                />
                {/* Start handle. Pointer events are wired directly on the
                    handle (not the container) since setPointerCapture
                    retargets subsequent move/up events to this element. */}
                <div
                  onPointerDown={onHandlePointerDown("start")}
                  onPointerMove={onTimelinePointerMove}
                  onPointerUp={onTimelinePointerUp}
                  onPointerCancel={onTimelinePointerUp}
                  role="slider"
                  aria-label="Trim start"
                  aria-valuemin={0}
                  aria-valuemax={trimEndMs}
                  aria-valuenow={trimStartMs}
                  className="absolute inset-y-0 z-30 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent"
                  style={{ left: `${(trimStartMs / (duration * 1000)) * 100}%` }}
                />
                {/* End handle */}
                <div
                  onPointerDown={onHandlePointerDown("end")}
                  onPointerMove={onTimelinePointerMove}
                  onPointerUp={onTimelinePointerUp}
                  onPointerCancel={onTimelinePointerUp}
                  role="slider"
                  aria-label="Trim end"
                  aria-valuemin={trimStartMs}
                  aria-valuemax={duration * 1000}
                  aria-valuenow={trimEndMs}
                  className="absolute inset-y-0 z-30 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent"
                  style={{ left: `${(trimEndMs / (duration * 1000)) * 100}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[12px] tabular-nums text-muted">
                <span>Start {fmtTimeDs(trimStartMs)}</span>
                {trim !== null ? (
                  <button
                    onClick={resetTrim}
                    className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-fg hover:bg-surface"
                  >
                    <RotateCcw size={11} /> Reset trim
                  </button>
                ) : (
                  <span className="text-[11px] text-muted/70">Full length</span>
                )}
                <span>End {fmtTimeDs(trimEndMs)}</span>
              </div>

              {/* Zoom lane: effective blocks as chips (position/width
                  proportional to start/end over the full duration). Auto blocks
                  tinted differently from manual; the selected chip is
                  highlighted. Drag a chip's body to move, its edges to resize.
                  Gated on click evidence / custom mode / resolved blocks. */}
              {zoomGateOpen ? (
                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Zoom</span>
                    {project.zoom.mode === "off" ? (
                      <span className="text-muted/70">Off</span>
                    ) : null}
                  </div>
                  <div className="relative h-7 w-full touch-none select-none rounded-md border border-line bg-surface/60">
                    {project.zoom.mode === "off" ? (
                      <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted/60">
                        Zoom disabled
                      </div>
                    ) : effectiveBlocks.length === 0 ? (
                      <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted/60">
                        No zoom blocks — add one below
                      </div>
                    ) : (
                      effectiveBlocks.map((b) => {
                        const leftPct = (b.startMs / (duration * 1000)) * 100;
                        const widthPct = ((b.endMs - b.startMs) / (duration * 1000)) * 100;
                        const isAuto = b.mode === "auto";
                        const selected = b.id != null && b.id === selectedBlockId;
                        return (
                          <div
                            key={b.id ?? `${b.startMs}-${b.endMs}`}
                            onPointerDown={
                              b.id != null ? onZoomChipPointerDown(b.id, "body") : undefined
                            }
                            onPointerMove={onZoomPointerMove}
                            onPointerUp={onZoomPointerUp}
                            onPointerCancel={onZoomPointerUp}
                            title={`${isAuto ? "Auto" : "Manual"} zoom ×${b.scale.toFixed(1)}`}
                            className={`absolute inset-y-0.5 flex cursor-grab items-center justify-center overflow-hidden rounded-sm border text-[10px] font-medium active:cursor-grabbing ${
                              selected
                                ? "border-accent bg-accent/40 text-fg ring-1 ring-accent"
                                : isAuto
                                  ? "border-sky-500/50 bg-sky-500/20 text-sky-200"
                                  : "border-violet-500/50 bg-violet-500/25 text-violet-200"
                            }`}
                            style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 1)}%` }}
                          >
                            <span className="pointer-events-none truncate px-2">
                              ×{b.scale.toFixed(1)}
                            </span>
                            {/* Left resize edge */}
                            <div
                              onPointerDown={
                                b.id != null ? onZoomChipPointerDown(b.id, "start") : undefined
                              }
                              onPointerMove={onZoomPointerMove}
                              onPointerUp={onZoomPointerUp}
                              onPointerCancel={onZoomPointerUp}
                              className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                            />
                            {/* Right resize edge */}
                            <div
                              onPointerDown={
                                b.id != null ? onZoomChipPointerDown(b.id, "end") : undefined
                              }
                              onPointerMove={onZoomPointerMove}
                              onPointerUp={onZoomPointerUp}
                              onPointerCancel={onZoomPointerUp}
                              className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                            />
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}

              {/* Speed lane: ranges as chips (position/width proportional to
                  start/end over the full duration), tinted amber to distinguish
                  from the zoom lane. Drag a chip's body to move, its edges to
                  resize; both stop at neighbours (no overlaps). Always shown —
                  any clip can be sped up / slowed down. */}
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                  <span>Speed</span>
                </div>
                <div className="relative h-7 w-full touch-none select-none rounded-md border border-line bg-surface/60">
                  {project.speed.length === 0 ? (
                    <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted/60">
                      No speed segments — add one below
                    </div>
                  ) : (
                    project.speed.map((r, i) => {
                      const leftPct = (r.startMs / (duration * 1000)) * 100;
                      const widthPct = ((r.endMs - r.startMs) / (duration * 1000)) * 100;
                      const selected = i === selectedSpeedIdx;
                      return (
                        <div
                          key={`${r.startMs}-${r.endMs}-${i}`}
                          onPointerDown={onSpeedChipPointerDown(i, "body")}
                          onPointerMove={onSpeedPointerMove}
                          onPointerUp={onSpeedPointerUp}
                          onPointerCancel={onSpeedPointerUp}
                          title={`Speed ×${r.rate.toFixed(2)}`}
                          className={`absolute inset-y-0.5 flex cursor-grab items-center justify-center overflow-hidden rounded-sm border text-[10px] font-medium active:cursor-grabbing ${
                            selected
                              ? "border-accent bg-accent/40 text-fg ring-1 ring-accent"
                              : "border-amber-500/50 bg-amber-500/25 text-amber-200"
                          }`}
                          style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 1)}%` }}
                        >
                          <span className="pointer-events-none truncate px-2">
                            ×{r.rate.toFixed(2)}
                          </span>
                          {/* Left resize edge */}
                          <div
                            onPointerDown={onSpeedChipPointerDown(i, "start")}
                            onPointerMove={onSpeedPointerMove}
                            onPointerUp={onSpeedPointerUp}
                            onPointerCancel={onSpeedPointerUp}
                            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                          />
                          {/* Right resize edge */}
                          <div
                            onPointerDown={onSpeedChipPointerDown(i, "end")}
                            onPointerMove={onSpeedPointerMove}
                            onPointerUp={onSpeedPointerUp}
                            onPointerCancel={onSpeedPointerUp}
                            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Camera lane: "cut to camera" scenes as chips, mirroring the
                  zoom lane's x-mapping/pointer machinery exactly (same
                  timelineRef/msFromClientX; body drag moves via moveRange,
                  edge drag resizes via resizeRange — both stop at neighbours,
                  never dropping a range on overlap). Gated on webcamAvailable
                  (a `.webcam.mp4` exists for this recording). */}
              {webcamAvailable ? (
                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Camera</span>
                  </div>
                  <div className="relative h-7 w-full touch-none select-none rounded-md border border-line bg-surface/60">
                    {(project.webcam?.scenes.length ?? 0) === 0 ? (
                      <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted/60">
                        No camera scenes — add one below
                      </div>
                    ) : (
                      (project.webcam?.scenes ?? []).map((s) => {
                        const leftPct = (s.startMs / (duration * 1000)) * 100;
                        const widthPct = ((s.endMs - s.startMs) / (duration * 1000)) * 100;
                        const selected = s.id === selectedSceneId;
                        return (
                          <div
                            key={s.id}
                            onPointerDown={onSceneChipPointerDown(s.id, "body")}
                            onPointerMove={onScenePointerMove}
                            onPointerUp={onScenePointerUp}
                            onPointerCancel={onScenePointerUp}
                            title={`Camera scene ${fmtTimeDs(s.startMs)}–${fmtTimeDs(s.endMs)}`}
                            className={`absolute inset-y-0.5 flex cursor-grab items-center justify-center overflow-hidden rounded-sm border text-[10px] font-medium active:cursor-grabbing ${
                              selected
                                ? "border-accent bg-accent/40 text-fg ring-1 ring-accent"
                                : "border-emerald-500/50 bg-emerald-500/25 text-emerald-200"
                            }`}
                            style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 1)}%` }}
                          >
                            <span className="pointer-events-none truncate px-2">
                              {fmtTimeDs(s.endMs - s.startMs)}
                            </span>
                            {/* Left resize edge */}
                            <div
                              onPointerDown={onSceneChipPointerDown(s.id, "start")}
                              onPointerMove={onScenePointerMove}
                              onPointerUp={onScenePointerUp}
                              onPointerCancel={onScenePointerUp}
                              className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                            />
                            {/* Right resize edge */}
                            <div
                              onPointerDown={onSceneChipPointerDown(s.id, "end")}
                              onPointerMove={onScenePointerMove}
                              onPointerUp={onScenePointerUp}
                              onPointerCancel={onScenePointerUp}
                              className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                            />
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}

              {/* Masks lane: privacy/emphasis masks as chips, mirroring the
                  camera lane's x-mapping/pointer machinery (same
                  timelineRef/msFromClientX; pointer capture; grab-offset body
                  drag) — but move/resize FREELY (moveMask/resizeMask clamp
                  only to [0,duration] with a MASK_MIN_LENGTH_MS floor, no
                  neighbour stop), since masks may legitimately overlap in
                  time. Gated on nothing special — masks apply to any
                  recording. */}
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                  <span>Masks</span>
                </div>
                <div className="relative h-7 w-full touch-none select-none rounded-md border border-line bg-surface/60">
                  {project.masks.length === 0 ? (
                    <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-muted/60">
                      No masks — add one below
                    </div>
                  ) : (
                    project.masks.map((m) => {
                      const leftPct = (m.startMs / (duration * 1000)) * 100;
                      const widthPct = ((m.endMs - m.startMs) / (duration * 1000)) * 100;
                      const selected = m.id === selectedMaskId;
                      return (
                        <div
                          key={m.id}
                          onPointerDown={onMaskChipPointerDown(m.id, "body")}
                          onPointerMove={onMaskPointerMove}
                          onPointerUp={onMaskPointerUp}
                          onPointerCancel={onMaskPointerUp}
                          title={`${m.kind === "pixelate" ? "Pixelate" : "Highlight"} mask ${fmtTimeDs(m.startMs)}–${fmtTimeDs(m.endMs)}`}
                          className={`absolute inset-y-0.5 flex cursor-grab items-center justify-center overflow-hidden rounded-sm border text-[10px] font-medium active:cursor-grabbing ${
                            selected
                              ? "border-accent bg-accent/40 text-fg ring-1 ring-accent"
                              : "border-rose-500/50 bg-rose-500/25 text-rose-200"
                          }`}
                          style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 1)}%` }}
                        >
                          <span className="pointer-events-none truncate px-2">
                            {m.kind === "pixelate" ? "Pixelate" : "Highlight"}
                          </span>
                          {/* Left resize edge */}
                          <div
                            onPointerDown={onMaskChipPointerDown(m.id, "start")}
                            onPointerMove={onMaskPointerMove}
                            onPointerUp={onMaskPointerUp}
                            onPointerCancel={onMaskPointerUp}
                            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                          />
                          {/* Right resize edge */}
                          <div
                            onPointerDown={onMaskChipPointerDown(m.id, "end")}
                            onPointerMove={onMaskPointerMove}
                            onPointerUp={onMaskPointerUp}
                            onPointerCancel={onMaskPointerUp}
                            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/20 hover:bg-black/40"
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Right: controls */}
        <div className="w-[300px] shrink-0 overflow-y-auto rounded-lg border border-line p-4">
          <h3 className="mb-4 text-[13px] font-semibold">Appearance</h3>

          <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
            <span>Padding</span>
            <span className="tabular-nums text-fg">{project.appearance.padding}px</span>
          </label>
          <input
            type="range"
            min={PADDING_MIN}
            max={PADDING_MAX}
            value={project.appearance.padding}
            onChange={(e) => setPadding(Number(e.target.value))}
            className="mb-5 w-full accent-accent"
          />

          <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
            <span>Corner radius</span>
            <span className="tabular-nums text-fg">{project.appearance.cornerRadius}px</span>
          </label>
          <input
            type="range"
            min={CORNER_MIN}
            max={CORNER_MAX}
            value={project.appearance.cornerRadius}
            onChange={(e) => setCornerRadius(Number(e.target.value))}
            className="mb-5 w-full accent-accent"
          />

          <div className="mb-2 text-[12px] text-muted">Aspect ratio</div>
          <div className="mb-5 grid grid-cols-5 gap-1.5">
            {(
              [
                ["auto", "Auto"],
                ["16:9", "16:9"],
                ["9:16", "9:16"],
                ["1:1", "1:1"],
                ["4:3", "4:3"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={`rounded-md border px-1 py-1.5 text-[11px] font-medium ${
                  project.appearance.aspect === value
                    ? "border-accent bg-accent/15 text-fg"
                    : "border-line text-muted hover:bg-surface"
                }`}
                onClick={() => setAspect(value as AspectPreset)}
                aria-pressed={project.appearance.aspect === value}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="mb-5 flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={project.motionBlur}
              onChange={(e) => setMotionBlur(e.target.checked)}
              className="accent-accent"
            />
            <span className="flex flex-col">
              <span>Motion blur</span>
              <span className="text-[11px] leading-snug text-muted">
                Smears zoom transitions for a smoother, cinematic feel.
              </span>
            </span>
          </label>

          <div className="mb-2 text-[12px] text-muted">Background</div>
          <div className="mb-3 flex gap-2">
            <button
              className={seg(bg.type === "solid")}
              onClick={() =>
                setBackground(
                  bg.type === "solid" ? bg : { type: "solid", color: "#1e3a5f" },
                )
              }
            >
              Solid
            </button>
            <button
              className={seg(bg.type === "gradient")}
              onClick={() =>
                setBackground(
                  bg.type === "gradient"
                    ? bg
                    : { type: "gradient", from: "#1e3a5f", to: "#0f1b2d" },
                )
              }
            >
              Gradient
            </button>
            <button
              className={seg(bg.type === "image")}
              onClick={() => {
                if (bg.type !== "image") {
                  setBackground({
                    type: "image",
                    path: presetBackgroundPath(BACKGROUND_PRESETS[0][0]),
                  });
                }
              }}
            >
              Image
            </button>
          </div>

          {bg.type === "solid" ? (
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={bg.color}
                onChange={(e) => setBackground({ type: "solid", color: e.target.value })}
                className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
              />
              <span className="text-[12px] text-muted">{bg.color}</span>
            </div>
          ) : null}

          {bg.type === "gradient" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={bg.from}
                  onChange={(e) => setBackground({ ...bg, from: e.target.value })}
                  className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
                />
                <span className="text-[12px] text-muted">From {bg.from}</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={bg.to}
                  onChange={(e) => setBackground({ ...bg, to: e.target.value })}
                  className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
                />
                <span className="text-[12px] text-muted">To {bg.to}</span>
              </div>
            </div>
          ) : null}

          {bg.type === "image" ? (
            <div className="space-y-2">
              <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
                {BACKGROUND_PRESETS.map(([name, label]) => {
                  const path = presetBackgroundPath(name);
                  const selected = bg.path === path;
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setBackground({ type: "image", path })}
                      aria-label={`Use ${label} background`}
                      aria-pressed={selected}
                      title={label}
                      className={`overflow-hidden rounded-md border-2 transition ${
                        selected
                          ? "border-accent ring-1 ring-accent"
                          : "border-transparent hover:border-line"
                      }`}
                    >
                      <img
                        src={path}
                        alt=""
                        className="aspect-video w-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  );
                })}
              </div>
              <div className="overflow-hidden rounded-md border border-line bg-black">
                <img
                  src={backgroundImageSrc(bg.path)}
                  alt="Background"
                  className="h-24 w-full object-cover"
                />
              </div>
              <button
                onClick={() => void pickImage()}
                disabled={importing}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] hover:bg-surface disabled:opacity-50"
              >
                {importing ? <Loader size={14} className="animate-spin" /> : null}
                Choose a different image…
              </button>
            </div>
          ) : null}

          {/* Zoom section: mode select (Auto / Custom / Off) + reset-to-auto,
              an "Add zoom" button, and an inspector for the selected block.
              Gated identically to the lane. */}
          {zoomGateOpen ? (
            <>
              <h3 className="mb-3 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
                Zoom
              </h3>

              <div className="mb-3 flex gap-2">
                {(
                  [
                    ["auto", "Auto"],
                    ["custom", "Custom"],
                    ["off", "Off"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={seg(project.zoom.mode === value)}
                    onClick={() => setZoomMode(value)}
                    aria-pressed={project.zoom.mode === value}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {project.zoom.mode !== "off" ? (
                <div className="mb-3 flex gap-2">
                  <button
                    onClick={addZoomBlock}
                    disabled={duration <= 0}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] font-medium hover:bg-surface disabled:opacity-50"
                  >
                    <Plus size={14} /> Add zoom
                  </button>
                  <button
                    onClick={() => void resetToAuto()}
                    disabled={project.zoom.mode === "auto"}
                    className="flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] font-medium hover:bg-surface disabled:opacity-50"
                    title="Discard hand-edited blocks and use click-driven auto-zoom"
                  >
                    <RotateCcw size={13} /> Reset to auto
                  </button>
                </div>
              ) : null}

              {/* Inspector row for the selected block. */}
              {project.zoom.mode !== "off" && selectedBlock ? (
                <div className="mb-2 rounded-md border border-line bg-surface/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        selectedBlock.mode === "auto"
                          ? "bg-sky-500/20 text-sky-300"
                          : "bg-violet-500/25 text-violet-300"
                      }`}
                    >
                      {selectedBlock.mode}
                    </span>
                    <button
                      onClick={() =>
                        selectedBlock.id != null && deleteBlock(selectedBlock.id)
                      }
                      className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-fg hover:bg-surface"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                  <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
                    <span>Zoom level</span>
                    <span className="tabular-nums text-fg">
                      ×{selectedBlock.scale.toFixed(1)}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={ZOOM_SCALE_MIN}
                    max={ZOOM_SCALE_MAX}
                    step={0.1}
                    value={Math.min(Math.max(selectedBlock.scale, ZOOM_SCALE_MIN), ZOOM_SCALE_MAX)}
                    onChange={(e) =>
                      selectedBlock.id != null &&
                      setBlockScale(selectedBlock.id, Number(e.target.value))
                    }
                    className="mb-2 w-full accent-accent"
                  />
                  <p className="text-[11px] leading-snug text-muted/80">
                    Click the preview to set this block&rsquo;s center.
                  </p>
                </div>
              ) : project.zoom.mode !== "off" ? (
                <p className="mb-2 text-[11px] leading-snug text-muted/80">
                  Select a zoom block on the timeline to edit it.
                </p>
              ) : null}
            </>
          ) : null}

          {/* Speed section: an "Add speed" button (5s @2× at the playhead) and
              an inspector (rate stepper 0.5–4.0 step 0.25 + delete) for the
              selected segment. Always shown. */}
          <h3 className="mb-3 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
            Speed
          </h3>

          <div className="mb-3 flex gap-2">
            <button
              onClick={addSpeedRange}
              disabled={duration <= 0}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] font-medium hover:bg-surface disabled:opacity-50"
            >
              <Plus size={14} /> Add speed
            </button>
          </div>

          {selectedSpeed && selectedSpeedIdx !== null ? (
            <div className="mb-2 rounded-md border border-line bg-surface/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="rounded-full bg-amber-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                  ×{selectedSpeed.rate.toFixed(2)}
                </span>
                <button
                  onClick={() => deleteSpeedRange(selectedSpeedIdx)}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-fg hover:bg-surface"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
              <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
                <span>Playback rate</span>
                <span className="tabular-nums text-fg">
                  ×{selectedSpeed.rate.toFixed(2)}
                </span>
              </label>
              <input
                type="range"
                min={SPEED_RATE_MIN}
                max={SPEED_RATE_MAX}
                step={0.25}
                value={Math.min(Math.max(selectedSpeed.rate, SPEED_RATE_MIN), SPEED_RATE_MAX)}
                onChange={(e) => setSpeedRate(selectedSpeedIdx, Number(e.target.value))}
                className="mb-2 w-full accent-accent"
              />
              <p className="text-[11px] leading-snug text-muted/80">
                Above 1× speeds this segment up (audio pitches up); below 1×
                slows it down.
              </p>
            </div>
          ) : (
            <p className="mb-2 text-[11px] leading-snug text-muted/80">
              Select a speed segment on the timeline to edit its rate.
            </p>
          )}

          {/* Cursor section: only actionable when the recording was captured
              with the system cursor hidden AND has an event track. Otherwise
              disabled with an explanatory tooltip (title). */}
          <h3 className="mb-4 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
            Cursor
          </h3>
          <div
            title={
              cursorAvailable
                ? undefined
                : "Record with 'Enhance cursor' to enable"
            }
            className={cursorAvailable ? "" : "opacity-50"}
          >
            <label className="mb-3 flex cursor-pointer items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={project.cursor.enabled}
                disabled={!cursorAvailable}
                onChange={(e) => setCursorEnabled(e.target.checked)}
                className="accent-accent"
              />
              Show enhanced cursor
            </label>
            <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
              <span>Size</span>
              <span className="tabular-nums text-fg">
                ×{project.cursor.scale.toFixed(1)}
              </span>
            </label>
            <input
              type="range"
              min={CURSOR_SCALE_MIN}
              max={CURSOR_SCALE_MAX}
              step={0.1}
              value={project.cursor.scale}
              disabled={!cursorAvailable || !project.cursor.enabled}
              onChange={(e) => setCursorScale(Number(e.target.value))}
              className="mb-3 w-full accent-accent disabled:opacity-50"
            />
            <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
              <span>Smoothing</span>
              <span className="tabular-nums text-fg">
                {project.cursor.smoothing === 0
                  ? "Off"
                  : `${Math.round(project.cursor.smoothing * 100)}%`}
              </span>
            </label>
            <input
              type="range"
              min={CURSOR_SMOOTHING_MIN}
              max={CURSOR_SMOOTHING_MAX}
              step={0.1}
              value={project.cursor.smoothing}
              disabled={!cursorAvailable || !project.cursor.enabled}
              onChange={(e) => setCursorSmoothing(Number(e.target.value))}
              className="mb-3 w-full accent-accent disabled:opacity-50"
            />
            <label className="mb-2 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={project.cursor.hideIdle}
                disabled={!cursorAvailable || !project.cursor.enabled}
                onChange={(e) => setCursorHideIdle(e.target.checked)}
                className="accent-accent disabled:opacity-50"
              />
              Hide when idle
            </label>
            {!cursorAvailable ? (
              <p className="text-[11px] leading-snug text-muted">
                Record with &lsquo;Enhance cursor&rsquo; to enable
              </p>
            ) : null}
          </div>

          {/* Keystrokes section: gated on the recording having an events
              track at all (same evidence gate the zoom section uses) — no
              events file means no key data to draw badges from. PRIVACY:
              default is modifier-combo-only; "show all keys" is an explicit
              opt-in with a visible warning, never silently enabled. */}
          <h3 className="mb-4 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
            Keystrokes
          </h3>
          <div
            title={eventsAvailable ? undefined : "No recorded key events for this clip"}
            className={eventsAvailable ? "" : "opacity-50"}
          >
            <label className="mb-3 flex cursor-pointer items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={project.keystrokes.enabled}
                disabled={!eventsAvailable}
                onChange={(e) => setKeystrokesEnabled(e.target.checked)}
                className="accent-accent"
              />
              Show keystrokes
            </label>
            <label className="mb-1 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={project.keystrokes.allKeys}
                disabled={!eventsAvailable || !project.keystrokes.enabled}
                onChange={(e) => setKeystrokesAllKeys(e.target.checked)}
                className="accent-accent disabled:opacity-50"
              />
              Show all keys (may reveal typed text)
            </label>
            {!eventsAvailable ? (
              <p className="text-[11px] leading-snug text-muted">
                No recorded key events for this clip
              </p>
            ) : (
              <p className="text-[11px] leading-snug text-muted/80">
                By default only modifier shortcuts (⌘⌃⌥ combos) are shown.
              </p>
            )}
          </div>

          {/* Captions section: gated on the recording having an audio source
              (mic or system audio) to transcribe — mirrors the backend's own
              "Recording has no audio" gate so the user sees the disabled
              state instead of the generation call failing. Generate/Regenerate
              run the Task 2 ASR pipeline and show a progress bar fed by the
              `captions-progress` event; each segment is inline-editable and
              deletable, saved (clamped) via the same debounced project path
              every other section uses. */}
          <h3 className="mb-4 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
            Captions
          </h3>
          <div
            title={audioAvailable ? undefined : "This recording has no audio to transcribe"}
            className={audioAvailable ? "" : "opacity-50"}
          >
            {!audioAvailable ? (
              <p className="mb-3 text-[11px] leading-snug text-muted">
                This recording has no audio to transcribe.
              </p>
            ) : (
              <>
                <button
                  onClick={() => void onGenerateCaptions()}
                  disabled={!audioAvailable || captionsGenerating}
                  className="mb-2 flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium hover:bg-surface disabled:opacity-50"
                >
                  {captionsGenerating ? (
                    <Loader size={14} className="animate-spin" />
                  ) : null}
                  {captionsGenerating
                    ? `Generating… ${captionsProgress}%`
                    : project.captions.segments === null
                      ? "Generate captions"
                      : "Regenerate captions"}
                </button>

                {captionsGenerating ? (
                  <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{ width: `${captionsProgress}%` }}
                    />
                  </div>
                ) : null}

                {project.captions.segments !== null ? (
                  <>
                    <label className="mb-3 flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={project.captions.enabled}
                        onChange={(e) => setCaptionsEnabled(e.target.checked)}
                        className="accent-accent"
                      />
                      Show captions
                    </label>

                    {project.captions.segments.length === 0 ? (
                      <p className="text-[11px] leading-snug text-muted">
                        No speech detected in this recording.
                      </p>
                    ) : (
                      <div className="mb-2 max-h-64 overflow-y-auto rounded-md border border-line">
                        {project.captions.segments.map((s, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-2 border-b border-line p-2 last:border-b-0"
                          >
                            <span className="mt-1.5 shrink-0 text-[10px] tabular-nums text-muted">
                              {fmtTimeDs(s.startMs)}
                            </span>
                            <textarea
                              value={s.text}
                              onChange={(e) => editCaptionSegment(i, e.target.value)}
                              rows={1}
                              className="min-w-0 flex-1 resize-none rounded border border-line bg-transparent px-1.5 py-1 text-[12px] leading-snug focus:border-accent focus:outline-none"
                            />
                            <button
                              onClick={() => deleteCaptionSegment(i)}
                              title="Delete this caption"
                              className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-danger"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}
          </div>

          {/* Audio section: loudness normalization polish pass (Task 4).
              Gated on the recording having an audio source — there's nothing
              to normalize on a silent screen capture. The toggle writes
              `project.audio.normalizeLoudness`, saved via the same debounced
              project path as every other section; Rust applies the gated-RMS
              normalization (toward −16 dBFS, soft-knee limited at −1 dBFS)
              during export as a best-effort step. */}
          <h3 className="mb-4 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
            Audio
          </h3>
          <div
            title={audioAvailable ? undefined : "This recording has no audio"}
            className={audioAvailable ? "" : "opacity-50"}
          >
            <label className="mb-1 flex cursor-pointer items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={project.audio.normalizeLoudness}
                disabled={!audioAvailable}
                onChange={(e) => setNormalizeLoudness(e.target.checked)}
                className="accent-accent disabled:opacity-50"
              />
              Normalize loudness
            </label>
            <p className="text-[11px] leading-snug text-muted/80">
              {audioAvailable
                ? "Evens out the volume toward a consistent level on export."
                : "This recording has no audio."}
            </p>
          </div>

          {/* Background music (Task 7): a user-picked track mixed under the
              voice audio at export. Not gated on `audioAvailable` — music can
              be added even to a recording with no mic/system audio (the
              export just gains a soundtrack). File picker via the dialog
              plugin's `open()`; volume slider 0..1 step 0.05; a clear (✕)
              button drops the track back to null. `project.audio.music` is
              null by default (no music), so this is entirely opt-in. */}
          <div className="mt-4">
            <p className="mb-1 text-[13px] font-medium">Background music</p>
            {project.audio.music ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Music size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-[12px]" title={project.audio.music.path}>
                    {project.audio.music.path.split("/").pop() || project.audio.music.path}
                  </span>
                  <button
                    onClick={clearMusic}
                    title="Remove background music"
                    className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-fg"
                  >
                    <X size={14} />
                  </button>
                </div>
                <label className="flex items-center gap-2 text-[12px] text-muted">
                  Volume
                  <input
                    type="range"
                    min={MUSIC_VOLUME_MIN}
                    max={MUSIC_VOLUME_MAX}
                    step={0.05}
                    value={project.audio.music.volume}
                    onChange={(e) => setMusicVolume(Number(e.target.value))}
                    className="flex-1 accent-accent"
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">
                    {Math.round(project.audio.music.volume * 100)}%
                  </span>
                </label>
              </div>
            ) : (
              <button
                onClick={() => void pickMusic()}
                disabled={musicImporting}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] hover:bg-surface disabled:opacity-50"
              >
                {musicImporting ? <Loader size={14} className="animate-spin" /> : <Music size={14} />}
                Choose a music track…
              </button>
            )}
            <p className="mt-1 text-[11px] leading-snug text-muted/80">
              Mixed in under your voice at export. MP3, M4A, WAV, or AAC.
            </p>
          </div>

          {/* Webcam section: only rendered when the recording was captured with
              a camera (a `.webcam.mp4` exists). Controls the corner-anchored
              PiP bubble drawn over the composite in preview + export. */}
          {webcamAvailable ? (
            <>
              <h3 className="mb-4 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
                Webcam
              </h3>
              <label className="mb-3 flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={project.webcam?.show ?? false}
                  onChange={(e) => setWebcam({ show: e.target.checked })}
                  className="accent-accent"
                />
                Show camera
              </label>

              {/* Shape: circle / rounded. */}
              <div className="mb-1 text-[12px] text-muted">Shape</div>
              <div className="mb-4 flex gap-2">
                <button
                  className={seg(project.webcam?.shape === "circle")}
                  disabled={!project.webcam?.show}
                  onClick={() => setWebcam({ shape: "circle" })}
                >
                  Circle
                </button>
                <button
                  className={seg(project.webcam?.shape === "rounded")}
                  disabled={!project.webcam?.show}
                  onClick={() => setWebcam({ shape: "rounded" })}
                >
                  Rounded
                </button>
              </div>

              {/* Corner: 2×2 grid mirroring on-screen placement. */}
              <div className="mb-1 text-[12px] text-muted">Position</div>
              <div className="mb-4 grid grid-cols-2 gap-2">
                {(
                  [
                    ["tl", "Top left"],
                    ["tr", "Top right"],
                    ["bl", "Bottom left"],
                    ["br", "Bottom right"],
                  ] as const
                ).map(([corner, label]) => (
                  <button
                    key={corner}
                    className={`rounded-md border px-3 py-1.5 text-[12px] font-medium ${
                      project.webcam?.corner === corner
                        ? "border-accent bg-accent/15 text-fg"
                        : "border-line text-muted hover:bg-surface"
                    } disabled:opacity-50`}
                    disabled={!project.webcam?.show}
                    onClick={() => setWebcam({ corner })}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Size: fraction of output width. */}
              <label className="mb-1 flex items-center justify-between text-[12px] text-muted">
                <span>Size</span>
                <span className="tabular-nums text-fg">
                  {Math.round((project.webcam?.sizeFrac ?? 0.2) * 100)}%
                </span>
              </label>
              <input
                type="range"
                min={WEBCAM_SIZE_MIN}
                max={WEBCAM_SIZE_MAX}
                step={0.01}
                value={project.webcam?.sizeFrac ?? 0.2}
                disabled={!project.webcam?.show}
                onChange={(e) => setWebcam({ sizeFrac: Number(e.target.value) })}
                className="mb-2 w-full accent-accent disabled:opacity-50"
              />

              <label className="mb-3 flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={project.webcam?.autoShrink ?? false}
                  disabled={!project.webcam?.show}
                  onChange={(e) => setWebcam({ autoShrink: e.target.checked })}
                  className="accent-accent disabled:opacity-50"
                />
                <span className="flex flex-col">
                  <span>Auto-shrink on zoom</span>
                  <span className="text-[11px] leading-snug text-muted">
                    Shrinks the bubble while a zoom block is active.
                  </span>
                </span>
              </label>

              <label className="mb-4 flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={project.webcam?.mirror ?? false}
                  disabled={!project.webcam?.show}
                  onChange={(e) => setWebcam({ mirror: e.target.checked })}
                  className="accent-accent disabled:opacity-50"
                />
                Mirror
              </label>

              {/* Camera scenes: "Add camera scene" (3s at the playhead) and an
                  inspector (range display + delete) for the selected scene —
                  mirrors the zoom/speed "Add" button + inspector pattern. */}
              <div className="mb-3 flex gap-2">
                <button
                  onClick={addWebcamScene}
                  disabled={duration <= 0}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] font-medium hover:bg-surface disabled:opacity-50"
                >
                  <Plus size={14} /> Add camera scene
                </button>
              </div>

              {selectedScene ? (
                <div className="mb-2 rounded-md border border-line bg-surface/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="rounded-full bg-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                      {fmtTimeDs(selectedScene.startMs)} – {fmtTimeDs(selectedScene.endMs)}
                    </span>
                    <button
                      onClick={() => deleteScene(selectedScene.id)}
                      className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-fg hover:bg-surface"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                  <p className="text-[11px] leading-snug text-muted/80">
                    Drag the chip to move it, its edges to resize.
                  </p>
                </div>
              ) : (
                <p className="mb-2 text-[11px] leading-snug text-muted/80">
                  Select a camera scene on the timeline to edit it.
                </p>
              )}
            </>
          ) : null}

          {/* Masks section: "Add mask" (3s pixelate mask, centered, at the
              playhead) and an inspector (kind select + delete) for the
              selected mask — mirrors the camera-scene "Add" button +
              inspector pattern. Gated on nothing special (masks apply to any
              recording). */}
          <h3 className="mb-4 mt-6 border-t border-line pt-4 text-[13px] font-semibold">
            Masks
          </h3>
          <div className="mb-3 flex gap-2">
            <button
              onClick={addMask}
              disabled={duration <= 0}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[12px] font-medium hover:bg-surface disabled:opacity-50"
            >
              <Plus size={14} /> Add mask
            </button>
          </div>

          {selectedMask ? (
            <div className="mb-2 rounded-md border border-line bg-surface/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="rounded-full bg-rose-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
                  {fmtTimeDs(selectedMask.startMs)} – {fmtTimeDs(selectedMask.endMs)}
                </span>
                <button
                  onClick={() => deleteMask(selectedMask.id)}
                  className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-fg hover:bg-surface"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>

              <div className="mb-1 text-[12px] text-muted">Kind</div>
              <div className="mb-2 flex gap-2">
                <button
                  className={seg(selectedMask.kind === "pixelate")}
                  onClick={() => setMaskKind(selectedMask.id, "pixelate")}
                >
                  Pixelate
                </button>
                <button
                  className={seg(selectedMask.kind === "highlight")}
                  onClick={() => setMaskKind(selectedMask.id, "highlight")}
                >
                  Highlight
                </button>
              </div>

              <p className="text-[11px] leading-snug text-muted/80">
                Drag the chip to move it, its edges to resize. On the preview,
                drag the box to move it, a corner to resize.
              </p>
            </div>
          ) : (
            <p className="mb-2 text-[11px] leading-snug text-muted/80">
              Select a mask on the timeline to edit it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
