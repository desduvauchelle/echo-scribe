import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Download, FolderOpen, Loader, Pause, Play, RotateCcw } from "lucide-react";
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
  defaultProject,
  parseProject,
  type Background,
  type EditorProject,
  PADDING_MAX,
  PADDING_MIN,
  CORNER_MAX,
  CORNER_MIN,
  CURSOR_SCALE_MIN,
  CURSOR_SCALE_MAX,
} from "../../lib/editorProject";
import { renderRecording, type RenderProgress } from "../../lib/render/renderPipeline";
import {
  cursorDrawScale,
  cursorStateAt,
  drawCompositeV2,
  type Appearance,
  type CursorSample,
  type OverlayState,
} from "../../lib/render/compositor";
import { parseEventsJsonl, type EventsHeader } from "../../lib/autoZoom";

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

  // Synthetic cursor is only available when the recording was captured with the
  // system cursor hidden AND we have an input-event track to reconstruct it
  // from. Otherwise the cursor section is disabled (the real cursor is already
  // baked into the video, so drawing a second one would double it up).
  const cursorAvailable = recording.cursor_hidden && !!recording.events_path;

  // Parsed input-event data for the synthetic cursor, loaded once when the
  // cursor section is available and enabled. Kept in refs so the rAF loop reads
  // the latest without re-subscribing; `cursorHeaderRef` null = not yet loaded
  // (or unavailable), which makes the overlay a no-op.
  const cursorHeaderRef = useRef<EventsHeader | null>(null);
  const cursorMovesRef = useRef<CursorSample[]>([]);
  const cursorDownsRef = useRef<CursorSample[]>([]);
  const cursorLoadedForRef = useRef<string | null>(null);
  const [cursorEventsReady, setCursorEventsReady] = useState(false);

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
      setProject(parseProject(json));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [recording.id]);

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

  // Load + parse the input-event track once when the synthetic cursor becomes
  // relevant (available AND enabled). Splitting moves/downs here keeps the rAF
  // loop's per-frame work to a binary search. Guarded by `cursorLoadedForRef`
  // so we fetch at most once per recording.
  const cursorEnabled = project.cursor.enabled;
  useEffect(() => {
    if (!cursorAvailable || !cursorEnabled) return;
    if (cursorLoadedForRef.current === recording.id) return;
    cursorLoadedForRef.current = recording.id;
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
        cursorHeaderRef.current = header;
        cursorMovesRef.current = moves;
        cursorDownsRef.current = downs;
        setCursorEventsReady(true);
      })
      .catch((e) => {
        // Non-fatal: the preview just falls back to no synthetic cursor. Allow
        // a retry on a later enable by clearing the guard.
        cursorLoadedForRef.current = null;
        console.warn("[editor] cursor events failed to load", e);
      });
    return () => {
      cancelled = true;
    };
  }, [cursorAvailable, cursorEnabled, recording.id]);

  // Compute the synthetic-cursor overlay for a given SOURCE time (ms). Returns
  // null unless the cursor is available, enabled, and the events are loaded.
  const cursorOverlayAt = useCallback(
    (tMsSource: number): OverlayState["cursor"] => {
      const p = projectRef.current;
      if (!p.cursor.enabled || !cursorAvailable) return null;
      const header = cursorHeaderRef.current;
      if (!header) return null;
      return cursorStateAt(tMsSource, cursorMovesRef.current, cursorDownsRef.current, header);
    },
    [cursorAvailable],
  );

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
    if (canvas.width !== vw) canvas.width = vw;
    if (canvas.height !== vh) canvas.height = vh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const p = projectRef.current;
    const appearance: Appearance = {
      padding: p.appearance.padding,
      cornerRadius: p.appearance.cornerRadius,
      background: p.appearance.background,
    };
    // The preview uses identity zoom (no auto-zoom applied live), so the source
    // time driving the cursor is just the video's currentTime.
    const cursor = cursorOverlayAt(video.currentTime * 1000);
    const pxScale = cursorHeaderRef.current?.capture.px_scale ?? 1;
    drawCompositeV2(
      ctx,
      video,
      vw,
      vh,
      vw,
      vh,
      appearance,
      { cx: 0.5, cy: 0.5, scale: 1 },
      { cursor, webcam: null },
      cursorDrawScale(p.cursor.scale, pxScale),
      bgImageRef.current,
    );
  }, [cursorOverlayAt]);

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
          setPlaying(false);
          setCurrent(endSec);
          renderFrame();
          return;
        }
      }
      renderFrame();
      if (v) setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, renderFrame]);

  // Re-render a single frame whenever appearance changes while paused (so slider
  // moves show up immediately), the background image finished loading, or the
  // cursor event track just became ready (so the synthetic cursor appears
  // without needing a scrub).
  useEffect(() => {
    if (playing) return;
    const id = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(id);
  }, [project, playing, renderFrame, loaded, cursorEventsReady]);

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
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  const onScrub = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    // Defensively clamp into the trim window — the scrubber's own min/max
    // already restrict this, but guard here too in case the trim changed
    // out from under an in-flight drag.
    const trim = projectRef.current.trim;
    if (trim) t = Math.min(Math.max(t, trim.startMs / 1000), trim.endMs / 1000);
    v.currentTime = t;
    setCurrent(t);
    // Draw the sought frame once the seek settles. If playing, the rAF loop
    // already redraws every frame, so only wire a one-shot when paused.
    if (v.paused) {
      const onSeeked = () => {
        renderFrame();
        v.removeEventListener("seeked", onSeeked);
      };
      v.addEventListener("seeked", onSeeked);
    }
  }, [renderFrame]);

  // ---- Appearance updaters ------------------------------------------------
  const setPadding = (padding: number) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, padding } }));
  const setCornerRadius = (cornerRadius: number) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, cornerRadius } }));
  const setBackground = (background: Background) =>
    setProject((p) => ({ ...p, appearance: { ...p.appearance, background } }));

  // ---- Cursor updaters ----------------------------------------------------
  const setCursorEnabled = (enabled: boolean) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, enabled } }));
  const setCursorScale = (scale: number) =>
    setProject((p) => ({ ...p, cursor: { ...p.cursor, scale } }));

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
  }, [recording.id, recording.events_path, cursorAvailable, src, duration, toasts]);

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
          <div className="grid flex-1 place-items-center overflow-hidden rounded-lg bg-black">
            <canvas ref={canvasRef} className="max-h-full max-w-full object-contain" />
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
            onEnded={() => setPlaying(false)}
          />
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
                className="relative h-8 w-full touch-none select-none rounded-md border border-line bg-surface"
              >
                {/* Dimmed region before trim start */}
                <div
                  className="absolute inset-y-0 left-0 rounded-l-md bg-black/40"
                  style={{ width: `${(trimStartMs / (duration * 1000)) * 100}%` }}
                />
                {/* Dimmed region after trim end */}
                <div
                  className="absolute inset-y-0 right-0 rounded-r-md bg-black/40"
                  style={{ width: `${100 - (trimEndMs / (duration * 1000)) * 100}%` }}
                />
                {/* Active (kept) region */}
                <div
                  className="absolute inset-y-0 border-x-2 border-accent bg-accent/10"
                  style={{
                    left: `${(trimStartMs / (duration * 1000)) * 100}%`,
                    right: `${100 - (trimEndMs / (duration * 1000)) * 100}%`,
                  }}
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
                  className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent"
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
                  className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent"
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
        </div>
      </div>
    </div>
  );
}
