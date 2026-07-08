import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Download,
  FolderOpen,
  Loader,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useToasts } from "../../components/ToastProvider";
import {
  getRecordingProject,
  setRecordingProject,
  importEditorBackground,
  readRecordingEvents,
  finalizeRenderedRecording,
  revealRecording,
  type RecordingRow,
} from "../../lib/api";
import {
  clampTrim,
  clampZoomCenter,
  defaultProject,
  moveZoomBlock,
  nextZoomBlockId,
  parseProject,
  placeZoomBlock,
  resizeZoomBlock,
  type AspectPreset,
  type Background,
  type EditorProject,
  type WebcamSettings,
  type ZoomMode,
  PADDING_MAX,
  PADDING_MIN,
  CORNER_MAX,
  CORNER_MIN,
  CURSOR_SCALE_MIN,
  CURSOR_SCALE_MAX,
  WEBCAM_SIZE_MIN,
  WEBCAM_SIZE_MAX,
  ZOOM_SCALE_MIN,
  ZOOM_SCALE_MAX,
  ZOOM_ADD_DEFAULT_LENGTH_MS,
  ZOOM_ADD_DEFAULT_SCALE,
} from "../../lib/editorProject";
import { renderRecording, type RenderProgress } from "../../lib/render/renderPipeline";
import {
  canvasToCapture,
  cursorDrawScale,
  cursorStateAt,
  drawCompositeV2,
  outputLayout,
  zoomStateAt,
  type Appearance,
  type CursorSample,
  type OverlayState,
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

/**
 * Full-pane per-recording editor. Left: a live canvas preview driven by a hidden
 * <video> and a rAF loop through `drawCompositeV2` at the project's appearance.
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
  // Path to the just-exported mp4 (for the Reveal-in-Finder affordance).
  const [exportedRevealId, setExportedRevealId] = useState<string | null>(null);

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
        parsed.webcam = { show: true, shape: "circle", corner: "br", sizeFrac: 0.2 };
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
    void loadImage(convertFileSrc(bgPath))
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
        for (const e of events) {
          if (e.k === "move") moves.push({ t: e.t, x: e.x, y: e.y });
          else if (e.k === "down") downs.push({ t: e.t, x: e.x, y: e.y });
        }
        eventsHeaderRef.current = header;
        eventsRef.current = events;
        cursorMovesRef.current = moves;
        cursorDownsRef.current = downs;
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
      return cursorStateAt(tMsSource, cursorMovesRef.current, cursorDownsRef.current, header);
    },
    [cursorAvailable],
  );

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

  // Drop a stale selection if its block no longer exists (e.g. mode switched to
  // "off"/"auto", or the block was deleted). Runs after the memo so it reacts to
  // the resolved list, never mid-drag on the ref.
  useEffect(() => {
    if (selectedBlockId === null) return;
    if (!effectiveBlocks.some((b) => b.id === selectedBlockId)) {
      setSelectedBlockId(null);
    }
  }, [effectiveBlocks, selectedBlockId]);

  // rAF render loop: draw the current video frame through drawCompositeV2 at
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
    const blocks = zoomBlocksRef.current;
    const zoom = blocks.length ? zoomStateAt(tMsSource, blocks) : { cx: 0.5, cy: 0.5, scale: 1 };
    const cursor = cursorOverlayAt(tMsSource);
    const pxScale = eventsHeaderRef.current?.capture.px_scale ?? 1;
    // Webcam overlay: feed the hidden webcam <video> as the frame source when
    // it's decodable (readyState >= 2 = HAVE_CURRENT_DATA) and the project is
    // showing it. The webcam element's currentTime is kept ≈ main + offset by
    // the sync effect below; here we just draw whatever frame it's parked on.
    // The compositor no-ops gracefully on a not-ready frame, but we gate on
    // readyState anyway to avoid drawing a blank/black bubble on first paint.
    const wv = webcamVideoRef.current;
    const webcam: OverlayState["webcam"] =
      p.webcam?.show && wv && wv.readyState >= 2 && wv.videoWidth > 0
        ? {
            frame: wv,
            shape: p.webcam.shape,
            corner: p.webcam.corner,
            sizeFrac: p.webcam.sizeFrac,
          }
        : null;
    drawCompositeV2(
      ctx,
      video,
      vw,
      vh,
      outW,
      outH,
      appearance,
      zoom,
      { cursor, webcam },
      cursorDrawScale(p.cursor.scale, pxScale),
      bgImageRef.current,
    );
  }, [cursorOverlayAt]);

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

  // ---- Cursor updaters ----------------------------------------------------
  const setCursorEnabled = (enabled: boolean) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, enabled } }));
  const setCursorScale = (scale: number) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, scale } }));

  // ---- Webcam updaters ----------------------------------------------------
  // Each updater merges onto the existing webcam settings, falling back to the
  // defaults if `webcam` is somehow still null (shouldn't happen once the load
  // effect has initialized it for a webcam recording, but keeps updates safe).
  const WEBCAM_DEFAULTS: WebcamSettings = {
    show: true,
    shape: "circle",
    corner: "br",
    sizeFrac: 0.2,
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
    setExportedRevealId(null);
    try {
      // Snapshot the current project so mid-export slider moves don't affect
      // the render. Force-disable the synthetic cursor when the recording
      // doesn't support it (real cursor baked in / no events) so a stale
      // project flag can't double-draw a cursor at export.
      const projSnapshot = projectRef.current;
      const proj: EditorProject = cursorAvailable
        ? projSnapshot
        : { ...projSnapshot, cursor: { ...projSnapshot.cursor, enabled: false } };

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
          bgImage = await loadImage(convertFileSrc(proj.appearance.background.path));
        } catch (e) {
          console.warn("[export] background image failed to load; using fallback", e);
        }
      }

      const durationMs = Math.round((durationMsRef.current || duration * 1000) || 0);

      const bytes = await renderRecording({
        fileUrl: src,
        eventsJsonl,
        durationMs,
        project: proj,
        bgImage,
        // Webcam overlay: only when the recording HAS a webcam file AND the
        // (snapshotted) project is showing it. The pipeline treats any webcam
        // demux/decode failure as non-fatal (renders without the overlay).
        webcamUrl: webcamSrc && proj.webcam?.show ? webcamSrc : null,
        webcamOffsetMs,
        onProgress: (p) => {
          setExportPhase(p.phase);
          setExportPct(p.pct);
        },
      });

      // Rust muxes the (trim-aligned) audio back in. The trim window is
      // SOURCE-time ms; clamp against the real duration so the audio slice
      // matches the frames the pipeline kept.
      setExportPhase("finalizing");
      setExportPct(100);
      const clamped = clampTrim(proj.trim, durationMs);
      await finalizeRenderedRecording(recording.id, bytes, clamped);

      setExportedRevealId(recording.id);
      toasts.push({ tone: "success", message: "Export complete." });
    } catch (e) {
      console.error("[export] failed", e);
      toasts.push({
        tone: "error",
        message: "Export failed. See Settings → Diagnostics → logs for details.",
      });
    } finally {
      setExportPhase(null);
      setExportPct(0);
    }
  }, [recording.id, recording.events_path, cursorAvailable, src, webcamSrc, webcamOffsetMs, duration, toasts]);

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
            onClick={() => void revealRecording(exportedRevealId)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface"
          >
            <FolderOpen size={15} /> Reveal in Finder
          </button>
        ) : null}
        <button
          onClick={() => void onExport()}
          disabled={exporting || !loaded}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {exporting ? (
            <Loader size={15} className="animate-spin" />
          ) : (
            <Download size={15} />
          )}
          {exporting ? `${exportLabel}… ${exportPct}%` : "Export"}
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
                if (bg.type !== "image") void pickImage();
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
              <div className="overflow-hidden rounded-md border border-line bg-black">
                <img
                  src={convertFileSrc(bg.path)}
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
              className="mb-2 w-full accent-accent disabled:opacity-50"
            />
            {!cursorAvailable ? (
              <p className="text-[11px] leading-snug text-muted">
                Record with &lsquo;Enhance cursor&rsquo; to enable
              </p>
            ) : null}
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
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
