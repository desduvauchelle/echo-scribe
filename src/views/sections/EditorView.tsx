import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Loader, Pause, Play } from "lucide-react";
import { useToasts } from "../../components/ToastProvider";
import {
  getRecordingProject,
  setRecordingProject,
  importEditorBackground,
  type RecordingRow,
} from "../../lib/api";
import {
  defaultProject,
  parseProject,
  type Background,
  type EditorProject,
  PADDING_MAX,
  PADDING_MIN,
  CORNER_MAX,
  CORNER_MIN,
} from "../../lib/editorProject";
import { drawCompositeV2, type Appearance } from "../../lib/render/compositor";

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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  // Latest project in a ref so the rAF loop always reads current appearance
  // without re-subscribing.
  const projectRef = useRef(project);
  projectRef.current = project;
  const saveTimer = useRef<number | null>(null);
  // Mirrors `loaded` for the true-unmount flush effect below, which must read
  // refs only (it can't close over the `loaded` state without re-running on
  // every change, which is exactly the bug this ref avoids).
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const src = convertFileSrc(recording.denoised_path ?? recording.file_path);

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
    drawCompositeV2(
      ctx,
      video,
      vw,
      vh,
      vw,
      vh,
      appearance,
      { cx: 0.5, cy: 0.5, scale: 1 },
      { cursor: null, webcam: null },
      p.cursor.scale,
      bgImageRef.current,
    );
  }, []);

  // Drive continuous frames while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      renderFrame();
      const v = videoRef.current;
      if (v) setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, renderFrame]);

  // Re-render a single frame whenever appearance changes while paused (so slider
  // moves show up immediately) or the background image finished loading.
  useEffect(() => {
    if (playing) return;
    const id = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(id);
  }, [project, playing, renderFrame, loaded]);

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

  const seg = (active: boolean) =>
    `flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium ${
      active ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-surface"
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] hover:bg-surface"
        >
          <ArrowLeft size={15} /> Back
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          Edit · {recording.title?.trim() || recording.source_label || "Recording"}
        </h2>
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
              min={0}
              max={duration || 0}
              step={0.01}
              value={current}
              onChange={(e) => onScrub(Number(e.target.value))}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="shrink-0 text-[12px] tabular-nums text-muted">
              {fmtTime(current)} / {fmtTime(duration)}
            </span>
          </div>
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
        </div>
      </div>
    </div>
  );
}
