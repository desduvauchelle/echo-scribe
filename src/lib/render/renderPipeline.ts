// WebCodecs render pipeline: decode an MP4 → composite background + padding +
// rounded corners + pan/zoom + synthetic cursor + webcam bubble on an
// OffscreenCanvas → re-encode → mux to a fresh MP4. This is the editor's
// video-export path: it renders the frames for whatever the EditorProject
// specifies, then the Rust `finalizeRenderedRecording` command muxes the
// (trim-aligned) audio back in — so the exported file is audio-inclusive even
// though this stage is video-only. The effective zoom timeline comes from the
// shared `resolveZoomBlocks`, so the export matches the editor preview exactly.
//
// Pipeline stages:
//   1. Fetch the source MP4 bytes (fileUrl is a convertFileSrc URL).
//   2. Demux with mp4box → per-sample EncodedVideoChunks + the codec
//      description (avcC/hvcC bytes) for VideoDecoder.configure.
//   3. Decode with VideoDecoder; for each decoded VideoFrame, composite via
//      drawComposite onto an OffscreenCanvas, then feed the canvas to a
//      VideoEncoder. Backpressure caps the encoder queue so we never buffer all
//      frames (memory).
//   4. Mux encoded chunks with mp4-muxer → finished MP4 Uint8Array.
//
// Codec negotiation is runtime-probed (VideoEncoder.isConfigSupported): H.264
// High first, then HEVC, then VP9 — recorded in the render report.

import { createFile, DataStream, MP4BoxBuffer, type Sample } from "mp4box";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import {
  parseEventsJsonl,
  resolveZoomBlocks,
  type EventsHeader,
  type ZoomBlock,
} from "../autoZoom";
import {
  buildSpeedMap,
  clampMasks,
  clampTrim,
  shiftRangesForTrim,
  type EditorProject,
  type Mask,
  type SpeedMap,
} from "../editorProject";
import {
  captionAt,
  cursorDrawScale,
  cursorStateAt,
  drawCompositeBlurred,
  keystrokeBadgeAlpha,
  keystrokeBadgeAt,
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
} from "./compositor";
import type { RecEvent } from "../autoZoom";

export type RenderProgress = { phase: "decode" | "encode" | "mux"; pct: number };

// ---- Webcam overlay: offset convention -----------------------------------
// AUTHORITATIVE (settled by review derivation): the webcam timeline is shifted
// relative to the MAIN (screen) timeline by `webcam_offset_ms`, defined as
//   offset_ms = firstMainFramePTS − webcamStart          (host clock)
// so to find the webcam frame that co-occurs with a given main frame:
//   webcamTime = mainTime + offset_ms
// The value is normally positive (the main capture's first frame lands after
// the webcam started) and may be null on the row → treated as 0 here. Both the
// preview (EditorView) and export (below) apply the SAME rule at SOURCE time.

/**
 * Index of the webcam frame to show for a main frame at SOURCE time
 * `mainSourceUs` (µs), given an ascending-by-timestamp `webcamTsUs` buffer and
 * the `offsetMs` shift. Picks the LATEST webcam frame whose timestamp is
 * `<= mainSourceUs + offsetMs*1000` (i.e. the most recent webcam frame at or
 * before the co-occurring webcam time) — a zero-order hold, so a slower webcam
 * fps still shows its freshest frame under each screen frame.
 *
 * Returns -1 when every buffered webcam frame is still in the future relative
 * to the needed time (the webcam started later than this main frame — nothing
 * to draw yet). When the webcam stream has ended, the caller holds the last
 * frame simply by never advancing past it, so this returns the final index for
 * all later main frames. Pure; `webcamTsUs` is assumed sorted ascending.
 */
export function pickWebcamFrameIndex(
  mainSourceUs: number,
  offsetMs: number,
  webcamTsUs: number[],
): number {
  if (webcamTsUs.length === 0) return -1;
  const needUs = mainSourceUs + offsetMs * 1000;
  // Binary search for the largest index with webcamTsUs[i] <= needUs.
  let idx = -1;
  let a = 0;
  let b = webcamTsUs.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (webcamTsUs[mid] <= needUs) {
      idx = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  return idx;
}

export type RenderRecordingOpts = {
  /** convertFileSrc URL of the source mp4. */
  fileUrl: string;
  /** Raw events JSONL text, or null → render without zoom. */
  eventsJsonl: string | null;
  durationMs: number;
  /** The editor project: appearance (padding/corner/background) drives the
   *  composite, and `trim` restricts which source frames are rendered. */
  project: EditorProject;
  /** Decoded background image when `project.appearance.background.type ===
   *  "image"`, else null. Loaded by the caller (via convertFileSrc) so the
   *  pipeline stays free of Tauri/DOM-image I/O and remains testable. */
  bgImage: CanvasImageSource | null;
  /** convertFileSrc URL of the webcam `.webcam.mp4`, or null when the recording
   *  has no webcam / the project isn't showing it. When set (and
   *  `project.webcam?.show`), a second demux+decode pipeline composites the
   *  webcam bubble onto each output frame. */
  webcamUrl?: string | null;
  /** Webcam-vs-main clock offset in ms (`recordings.webcam_offset_ms`), i.e.
   *  `firstMainFramePTS − webcamStart`. Applied as `webcamTime = mainTime +
   *  offsetMs`. Null on the row → 0. */
  webcamOffsetMs?: number | null;
  /** Output container. "mp4" (default) → the WebCodecs H.264/HEVC/VP9 encode +
   *  mux (audio muxed back in by Rust). "gif" → an animated GIF at
   *  `TARGET_GIF_FPS`, width-capped to `GIF_MAX_WIDTH`, encoded incrementally
   *  with gifenc (no audio path at all). Both share the exact same
   *  decode→composite loop, so every effect rides along identically. */
  format?: "mp4" | "gif";
  onProgress: (p: RenderProgress) => void;
};

/** The applied trim window in SOURCE-time ms. `startMs`=0 / `endMs`=durationMs
 *  when the project has no trim. */
export type TrimWindow = { startMs: number; endMs: number };

/** Small leading-edge tolerance (µs) so a frame whose timestamp rounds a hair
 *  before `startMs` (timescale rounding) is still kept. */
const TRIM_EPSILON_US = 1;

/**
 * Whether a decoded source frame at SOURCE presentation time `tsSourceUs` (µs)
 * falls inside the kept trim window `[startMs, endMs)` (ms). Half-open on the
 * end so the frame exactly at `endMs` is excluded — consistent with the Rust
 * `trim_wav_samples` sample-range convention, keeping audio/video the same
 * length. A tiny epsilon on the leading edge absorbs timescale rounding.
 *
 * Pure; the input is SOURCE time by design — trim decisions and zoom lookup
 * both key off source time, and only the emitted output timestamp is
 * re-anchored to t0 (see the decode loop).
 */
export function frameInTrimWindow(tsSourceUs: number, trim: TrimWindow): boolean {
  const startUs = trim.startMs * 1000;
  const endUs = trim.endMs * 1000;
  return tsSourceUs >= startUs - TRIM_EPSILON_US && tsSourceUs < endUs;
}

/**
 * The CFR grid index a frame whose OUTPUT time is `outMs` lands on, at
 * `fps` frames per second. The output timeline (post-trim, post-speed) is
 * quantized to a fixed `1/fps` grid so the muxed file is constant-frame-rate;
 * this rounds the mapped output time to the nearest grid slot.
 *
 * Frame-pacing decision (documented CFR contract): the render loop keeps a
 * frame only when its grid index is strictly greater than the last emitted
 * frame's grid index. In sped-up regions many source frames collapse onto the
 * same (or an already-passed) grid slot → the extras are DROPPED to hold ≤fps.
 * In slowed regions consecutive source frames map to grid indices more than 1
 * apart → each is emitted once at its own slot, leaving the intervening slots
 * empty (a VFR-style gap on the CFR grid); we do NOT duplicate frames to fill
 * them (acceptable at 30fps — the muxer/player holds the previous frame).
 *
 * Pure. `outMs` is output-time ms; the returned index is `round(outMs*fps/1000)`.
 */
export function speedGridIndex(outMs: number, fps: number): number {
  return Math.round((outMs * fps) / 1000);
}

/** Display window (ms) `keystrokeBadgeAt` uses — kept in sync with the
 *  `KEYSTROKE_DISPLAY_MS` constant private to compositor.ts (both derive the
 *  driving event's age the same way; duplicated here rather than exported
 *  from the compositor since it's an internal detail of that module's pure
 *  grouping function, not part of its public contract). */
const KEYSTROKE_DISPLAY_MS = 800;

/**
 * Resolve the keystroke badge overlay (label + fade alpha) for SOURCE time
 * `tMs`, given the recording's pre-split key events and the project's
 * `allKeys` setting. Thin wrapper around `keystrokeBadgeAt` (the label
 * lookup) plus a second small backward scan to find the driving event's age
 * for `keystrokeBadgeAlpha` — mirrors the editor preview's
 * `keystrokeOverlayAt` in EditorView.tsx so preview and export fade
 * identically. Returns `null` when there's no qualifying event in the window.
 */
function keystrokeOverlayAt(
  tMs: number,
  keyEvents: RecEvent[],
  allKeys: boolean,
): OverlayState["keystroke"] {
  const badge = keystrokeBadgeAt(tMs, keyEvents, { allKeys });
  if (!badge) return null;
  let age = 0;
  for (let i = keyEvents.length - 1; i >= 0; i--) {
    const e = keyEvents[i];
    if (e.k !== "key" || e.t > tMs || tMs - e.t > KEYSTROKE_DISPLAY_MS) continue;
    age = tMs - e.t;
    break;
  }
  return { label: badge.label, alpha: keystrokeBadgeAlpha(age) };
}

/** Output frame rate. Source frames above this are dropped down to it. */
const TARGET_FPS = 30;
/** Encoder backpressure threshold — never let the queue grow unbounded. */
const MAX_ENCODE_QUEUE = 8;

// ---- GIF export constants + pure helpers ----------------------------------
// The GIF path re-uses the SAME decode→composite loop and the SAME `speedGridIndex`
// quantization as the MP4 path, only on a coarser grid (15fps) and a smaller
// output. Keeping the grid math identical means a 30fps source drops to every
// other frame exactly the way the MP4 CFR pacing works — no separate cadence.

/** GIF output frame rate. Half of `TARGET_FPS`, so a 30fps source drops to
 *  every other frame on the shared CFR grid (see `speedGridIndex`). */
export const TARGET_GIF_FPS = 15;

/** GIF output width cap (px). Larger sources scale proportionally down to this;
 *  smaller ones are left at their own width. Keeps GIF byte-size and per-frame
 *  quantization cost bounded (GIF is a heavyweight format for screen video). */
export const GIF_MAX_WIDTH = 960;

/**
 * The GIF output canvas size for a source of `srcW`×`srcH`, capped so the width
 * never exceeds `maxWidth` and BOTH dimensions are even (video-friendly and it
 * keeps the palette-index buffer aligned). Scales proportionally when over the
 * cap; when under it, keeps the source width but still rounds each dimension to
 * the nearest even value. Never returns a zero dimension (clamped to ≥2) so the
 * encoder always gets a drawable frame.
 *
 * Pure. Even-rounding: `round(x/2)*2`, then `max(2, …)`.
 */
export function gifOutputSize(
  srcW: number,
  srcH: number,
  maxWidth: number = GIF_MAX_WIDTH,
): { w: number; h: number } {
  const toEven = (x: number): number => Math.max(2, Math.round(x / 2) * 2);
  if (srcW <= maxWidth) {
    return { w: toEven(srcW), h: toEven(srcH) };
  }
  const scale = maxWidth / srcW;
  return { w: toEven(maxWidth), h: toEven(srcH * scale) };
}

/** Centiseconds in the `[7,7,6]` GIF frame-delay cycle. Sums to 20cs / 3 frames. */
const GIF_DELAY_CYCLE_CS = [7, 7, 6] as const;

/**
 * The per-frame delay (centiseconds) for the GIF frame at grid position
 * `frameIndex`. GIF only stores delays at centisecond (1/100s) granularity, so
 * the exact 1/15s = 6.667cs per-frame delay can't be encoded directly. We cycle
 * `[7,7,6]` centiseconds: every 3 frames span 20cs = 0.20s, i.e. EXACTLY 15fps
 * on average (45 frames → 300cs → 3.00s). A fixed 7cs would drift to 14.29fps
 * and a fixed 6cs to 16.67fps; the 7/7/6 cycle holds true 15fps over whole
 * cycles with at most ±0.33cs of instantaneous jitter (imperceptible). Pure.
 */
export function gifFrameDelayCs(frameIndex: number): number {
  return GIF_DELAY_CYCLE_CS[frameIndex % GIF_DELAY_CYCLE_CS.length];
}

/** A muxer codec tag paired with the WebCodecs encoder config that produced it. */
type CodecChoice = {
  muxerCodec: "avc" | "hevc" | "vp9";
  encoderConfig: VideoEncoderConfig;
};

/**
 * Probe encoder support in priority order and return the first that validates.
 * H.264 High (avc1.640033) → HEVC (hvc1.1.6.L93.B0) → VP9 (vp09.00.10.08).
 * Throws a friendly error if none are supported (caller shows a toast; detail
 * is logged to console).
 */
async function pickCodec(width: number, height: number): Promise<CodecChoice> {
  const bitrate = Math.min(20_000_000, Math.max(4_000_000, Math.round(width * height * TARGET_FPS * 0.1)));
  const base: Omit<VideoEncoderConfig, "codec"> = {
    width,
    height,
    bitrate,
    framerate: TARGET_FPS,
    // Hint hardware/accelerated encoders; browser falls back to software.
    hardwareAcceleration: "no-preference",
  };

  const candidates: CodecChoice[] = [
    { muxerCodec: "avc", encoderConfig: { ...base, codec: "avc1.640033", avc: { format: "avc" } } },
    // HEVC: the `hevc: { format: "hevc" }` bitstream hint isn't in this
    // TS lib.dom, and mp4-muxer's HEVC path expects length-prefixed (hvcC)
    // NAL units, which is the WebCodecs default, so omit the hint.
    { muxerCodec: "hevc", encoderConfig: { ...base, codec: "hvc1.1.6.L93.B0" } },
    { muxerCodec: "vp9", encoderConfig: { ...base, codec: "vp09.00.10.08" } },
  ];

  for (const cand of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported(cand.encoderConfig);
      if (support.supported) {
        console.info("[render] using encoder codec", cand.encoderConfig.codec);
        return cand;
      }
      console.warn("[render] encoder codec not supported:", cand.encoderConfig.codec);
    } catch (e) {
      console.warn("[render] isConfigSupported threw for", cand.encoderConfig.codec, e);
    }
  }
  throw new Error("This Mac's browser engine can't encode video (no supported codec). See console for details.");
}

/** A demuxed video track: its samples-as-chunks plus the decoder config. */
type DemuxResult = {
  chunks: EncodedVideoChunk[];
  decoderConfig: VideoDecoderConfig;
  codedWidth: number;
  codedHeight: number;
};

/**
 * Extract the codec-private description (avcC or hvcC box body) that
 * VideoDecoder.configure needs, by serializing the box and stripping its 8-byte
 * header. Returns undefined for codecs that don't need one.
 */
function extractDescription(
  file: ReturnType<typeof createFile>,
  trackId: number,
): Uint8Array | undefined {
  const trak = file.getTrackById(trackId);
  const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0] as
    | { avcC?: { write: (s: DataStream) => void }; hvcC?: { write: (s: DataStream) => void } }
    | undefined;
  const box = entry?.avcC ?? entry?.hvcC;
  if (!box) return undefined;
  const stream = new DataStream(undefined, 0, DataStream.ENDIANNESS);
  box.write(stream);
  // The DataStream backing buffer may be over-allocated; use its virtual
  // byteLength. The written box includes an 8-byte header (size + fourcc); the
  // decoder wants only the box payload after it.
  const full = new Uint8Array(stream.buffer as unknown as ArrayBuffer, 0, stream.byteLength);
  return full.slice(8);
}

/** Demux the MP4 bytes into decodable video chunks + a decoder config. */
function demux(bytes: ArrayBuffer): Promise<DemuxResult> {
  return new Promise<DemuxResult>((resolve, reject) => {
    const file = createFile();
    const chunks: EncodedVideoChunk[] = [];
    let videoTrackId = -1;
    let decoderConfig: VideoDecoderConfig | null = null;
    let codedWidth = 0;
    let codedHeight = 0;

    file.onError = (module: string, msg: string) => {
      reject(new Error(`mp4box demux error (${module}): ${msg}`));
    };

    file.onReady = (info) => {
      const video = info.videoTracks[0];
      if (!video) {
        reject(new Error("Recording has no video track to render."));
        return;
      }
      videoTrackId = video.id;
      codedWidth = video.video?.width ?? video.track_width;
      codedHeight = video.video?.height ?? video.track_height;
      const description = extractDescription(file, videoTrackId);
      decoderConfig = {
        codec: video.codec,
        codedWidth,
        codedHeight,
        ...(description ? { description } : {}),
      };
      file.setExtractionOptions(videoTrackId, null, { nbSamples: Infinity });
      file.start();
    };

    file.onSamples = (_id: number, _user: unknown, samples: Sample[]) => {
      for (const s of samples) {
        if (!s.data) continue;
        chunks.push(
          new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            // mp4box timestamps are in track timescale units → microseconds.
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration: (s.duration * 1_000_000) / s.timescale,
            data: s.data,
          }),
        );
      }
    };

    // Feed the whole buffer in one shot (fileStart = 0), then flush. mp4box
    // needs the appended buffer to carry a `fileStart`; MP4BoxBuffer supplies it.
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0));
    file.flush();

    // onReady/onSamples fire synchronously inside appendBuffer/flush for a
    // complete in-memory file; resolve on the next tick once they've run.
    queueMicrotask(() => {
      if (!decoderConfig) {
        reject(new Error("Could not read the recording's video format."));
        return;
      }
      resolve({ chunks, decoderConfig, codedWidth, codedHeight });
    });
  });
}

/**
 * Lazily-decoding webcam frame supplier for the export path.
 *
 * Wraps a second `VideoDecoder` over the webcam file's demuxed chunks and,
 * for each requested MAIN source time, returns the co-occurring webcam frame
 * (`webcamTime = mainTime + offsetMs`, zero-order hold — see
 * `pickWebcamFrameIndex`). Frames are decoded ON DEMAND, only far enough ahead
 * of the requested time (`LOOKAHEAD_US`) to have the covering frame in hand —
 * we never decode the whole webcam file up front (memory). Superseded frames
 * are `close()`d promptly, keeping at most a couple of live `VideoFrame`s.
 *
 * Robustness (never fail the export):
 *   - The webcam stream ending early → the last decoded frame is held for every
 *     later main time (the decoder simply has no more chunks).
 *   - A decode error mid-render → logged once (console.warn) and the source
 *     goes inert: `frameAt` returns null forever after, so the render continues
 *     WITHOUT the overlay rather than throwing.
 */
class WebcamSource {
  private decoder: VideoDecoder;
  /** Decoded frames in ascending timestamp order, not yet superseded. */
  private buf: VideoFrame[] = [];
  /** Next chunk index to feed the decoder. */
  private nextChunk = 0;
  private readonly chunks: EncodedVideoChunk[];
  private readonly offsetMs: number;
  /** Sticky: once a decode error fires, the source is inert (no overlay). */
  private failed = false;
  private warnedFail = false;
  /** Set once every chunk has been fed AND flushed (stream fully drained). */
  private drained = false;
  private flushPromise: Promise<void> | null = null;

  /** Decode this far past the needed time before selecting, so the covering
   *  frame (and its immediate successor, for a clean hold) is present. */
  private static readonly LOOKAHEAD_US = 100_000; // 100ms
  /** Never keep more than this many decoded frames live at once. */
  private static readonly MAX_BUFFERED = 6;
  /** Decoder queue cap (backpressure), matching the main pipeline. */
  private static readonly MAX_DECODE_QUEUE = 8;

  constructor(chunks: EncodedVideoChunk[], decoderConfig: VideoDecoderConfig, offsetMs: number) {
    this.chunks = chunks;
    this.offsetMs = offsetMs;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.failed) {
          frame.close();
          return;
        }
        this.buf.push(frame);
      },
      error: (e) => this.markFailed(e),
    });
    try {
      this.decoder.configure(decoderConfig);
    } catch (e) {
      this.markFailed(e);
    }
  }

  private markFailed(e: unknown): void {
    this.failed = true;
    if (!this.warnedFail) {
      this.warnedFail = true;
      console.warn("[render] webcam decode failed; continuing without webcam overlay", e);
    }
    // Drop any buffered frames; from here on frameAt() returns null.
    for (const f of this.buf) f.close();
    this.buf = [];
  }

  /** True once we've fed every chunk and the decoder has flushed. */
  private allChunksFed(): boolean {
    return this.nextChunk >= this.chunks.length;
  }

  /** Feed more chunks until the newest buffered frame covers the WEBCAM time
   *  co-occurring with `mainSourceUs` (`= mainSourceUs + offsetMs*1000`, plus a
   *  lookahead), the buffer hits its cap, or the stream is exhausted. The
   *  buffered frame timestamps are in webcam-file time, so the comparison
   *  target must be offset-adjusted to that same clock. */
  private async pumpTo(mainSourceUs: number): Promise<void> {
    if (this.failed) return;
    const neededWebcamUs = mainSourceUs + this.offsetMs * 1000;
    const targetUs = neededWebcamUs + WebcamSource.LOOKAHEAD_US;
    while (
      !this.failed &&
      this.nextChunk < this.chunks.length &&
      // Stop once the last buffered frame is already past the target — we have
      // the covering frame (and a successor). Keeps decode roughly in step.
      (this.buf.length === 0 || this.buf[this.buf.length - 1].timestamp < targetUs)
    ) {
      // Cap live frames: if the buffer is full but we haven't reached the target
      // yet (e.g. a large positive offset asks to skip forward past many webcam
      // frames), drop the OLDEST buffered frame — but ONLY while the next frame
      // is also still at/before the needed webcam time, so the dropped one is
      // provably superseded (never the covering frame). This lets decode keep
      // advancing under a bounded live-frame count without ever discarding the
      // frame the picker would choose.
      while (
        this.buf.length >= WebcamSource.MAX_BUFFERED &&
        this.buf.length >= 2 &&
        this.buf[1].timestamp <= neededWebcamUs
      ) {
        const drop = this.buf.shift();
        drop?.close();
      }
      // If the buffer is full but the above couldn't safely drop (all frames are
      // near/after the needed time), stop pumping — we already have the covering
      // frame or the webcam simply hasn't reached this time; avoid unbounded
      // growth. The picker works with what's buffered.
      if (this.buf.length >= WebcamSource.MAX_BUFFERED) break;
      // Decoder-queue backpressure: wait for it to drain before feeding more.
      let guard = 0;
      let stalled = false;
      while (this.decoder.decodeQueueSize >= WebcamSource.MAX_DECODE_QUEUE && !this.failed) {
        await new Promise((r) => setTimeout(r, 1));
        if (++guard > 5000) {
          stalled = true; // ~5s hard cap; never wedge the render
          break;
        }
      }
      if (this.failed) return;
      // The queue never drained within the cap — skip decoding this chunk for
      // now rather than pushing further past MAX_DECODE_QUEUE (which would
      // defeat the point of the guard). Re-check on the next pumpTo() call
      // instead of spinning here; the outer while's timestamp condition still
      // governs when pumping stops altogether.
      if (stalled) break;
      this.decoder.decode(this.chunks[this.nextChunk++]);
      // Let the decoder surface output for the chunks fed so far.
      await new Promise((r) => setTimeout(r, 0));
    }
    // Once every chunk is fed, flush so trailing frames come out (needed to
    // hold the true last frame when the webcam stream ends before main).
    if (this.allChunksFed() && !this.drained && !this.failed) {
      if (!this.flushPromise) {
        this.flushPromise = this.decoder
          .flush()
          .then(() => {
            this.drained = true;
          })
          .catch((e) => this.markFailed(e));
      }
      await this.flushPromise;
    }
  }

  /**
   * The webcam frame co-occurring with the main frame at SOURCE time
   * `mainSourceUs` (µs), or null when there is none to draw (webcam not started
   * yet at this time, or the source has failed). Closes frames the render has
   * moved past so memory stays bounded. The returned frame is still owned by
   * this source — the caller must NOT close it (it's reused/held across calls).
   */
  async frameAt(mainSourceUs: number): Promise<VideoFrame | null> {
    if (this.failed) return null;
    await this.pumpTo(mainSourceUs);
    if (this.failed) return null;

    // pickWebcamFrameIndex applies the offset (webcamTime = mainTime + offset)
    // against the buffered webcam frame timestamps.
    const idx = pickWebcamFrameIndex(mainSourceUs, this.offsetMs, this.buf.map((f) => f.timestamp));
    if (idx < 0) {
      // Every buffered frame is still in the future (webcam not started yet at
      // this main time). Keep them for later frames; draw nothing now.
      return null;
    }
    // Close every frame strictly before the selected one — the render is past
    // them and (with a monotonically advancing main time) will never want them
    // again. The selected frame is retained so it can be held under subsequent
    // main frames until a newer webcam frame supersedes it.
    if (idx > 0) {
      for (let i = 0; i < idx; i++) this.buf[i].close();
      this.buf.splice(0, idx);
      return this.buf[0];
    }
    return this.buf[idx];
  }

  /** Release the decoder and any remaining frames. Safe to call twice. */
  close(): void {
    for (const f of this.buf) f.close();
    this.buf = [];
    try {
      if (this.decoder.state !== "closed") this.decoder.close();
    } catch {
      // already closed / never configured — ignore
    }
  }
}

/**
 * Output abstraction shared by the MP4 and GIF paths. The decode→composite loop
 * draws every frame onto ONE OffscreenCanvas (so all effects ride the shared
 * compositor identically), then hands the canvas + its CFR grid slot to the
 * sink. This is the ONLY place the two formats diverge — the composite is
 * byte-for-byte the same. A sink NEVER buffers all frames: the MP4 sink pushes
 * to a `VideoEncoder` (bounded queue), the GIF sink quantizes + `writeFrame`s
 * incrementally and discards the pixels each iteration.
 */
interface FrameSink {
  /** Output canvas size (px). The compositor targets exactly this. */
  readonly outW: number;
  readonly outH: number;
  /** Frames-per-second the CFR grid is quantized to (`speedGridIndex`). */
  readonly fps: number;
  /** True while downstream backpressure asks the feed loop to wait (MP4 only;
   *  the GIF encoder is synchronous so it's always false). */
  isBackpressured(): boolean;
  /** Emit the current canvas as the output frame that lands on CFR grid slot
   *  `gridIndex` (already validated as advancing). Sync draw already happened;
   *  the sink reads the canvas here. Must NOT retain the canvas past this call. */
  emit(canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D, gridIndex: number): void;
  /** Any async encoder error surfaced out-of-band (MP4). Null when none. */
  readonly error: unknown;
  /** Finish encoding and return the finished container bytes. */
  finalize(): Promise<Uint8Array>;
}

/** MP4 sink: the original WebCodecs `VideoEncoder` → `mp4-muxer` path. Kept
 *  behaviourally identical to the pre-GIF pipeline (same codec probe, keyframe
 *  cadence, bitrate, grid-slot timestamp). */
class Mp4Sink implements FrameSink {
  readonly outW: number;
  readonly outH: number;
  readonly fps = TARGET_FPS;
  private readonly muxer: Muxer<ArrayBufferTarget>;
  private readonly encoder: VideoEncoder;
  private readonly minFrameIntervalUs = 1_000_000 / TARGET_FPS;
  private encodedFrames = 0;
  private encodeError: unknown = null;

  private constructor(outW: number, outH: number, codec: CodecChoice) {
    this.outW = outW;
    this.outH = outH;
    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: codec.muxerCodec, width: outW, height: outH, frameRate: TARGET_FPS },
      fastStart: "in-memory",
    });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        this.encodeError = e;
        console.error("[render] VideoEncoder error", e);
      },
    });
    this.encoder.configure(codec.encoderConfig);
  }

  static async create(outW: number, outH: number): Promise<Mp4Sink> {
    const codec = await pickCodec(outW, outH);
    return new Mp4Sink(outW, outH, codec);
  }

  get error(): unknown {
    return this.encodeError;
  }

  isBackpressured(): boolean {
    return this.encoder.encodeQueueSize >= MAX_ENCODE_QUEUE;
  }

  emit(canvas: OffscreenCanvas, _ctx: OffscreenCanvasRenderingContext2D, gridIndex: number): void {
    // Emit on the CFR grid slot this frame mapped to. The timestamp is
    // `gridIndex/TARGET_FPS` (µs), NOT a running counter — so a trim re-anchors
    // to 0 and speed segments land at their retimed output time.
    const outFrame = new VideoFrame(canvas, {
      timestamp: Math.round(gridIndex * this.minFrameIntervalUs),
      duration: Math.round(this.minFrameIntervalUs),
    });
    const keyFrame = this.encodedFrames % (TARGET_FPS * 2) === 0; // keyframe every ~2s
    this.encoder.encode(outFrame, { keyFrame });
    outFrame.close();
    this.encodedFrames++;
  }

  async finalize(): Promise<Uint8Array> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.encodeError) throw this.encodeError;
    this.muxer.finalize();
    return new Uint8Array(this.muxer.target.buffer);
  }
}

/** GIF sink: incremental gifenc encode. Each emitted frame is read off the
 *  canvas (`getImageData`), quantized to a PER-FRAME 256-color palette
 *  (quality-first v1 — bigger files, no cross-frame banding), indexed, and
 *  `writeFrame`d immediately. The RGBA + index buffers are transient locals, so
 *  only the accumulating GIF byte stream grows — never a frame backlog.
 *
 *  Delay: gifenc's `writeFrame({delay})` is in ms and rounds to centiseconds
 *  internally, so we pass `gifFrameDelayCs(i)*10` to land EXACTLY on the
 *  intended centisecond (7/7/6 cycle → true 15fps average — see
 *  `gifFrameDelayCs`). GIF frames are consecutive (grid GAPS from slow-mo are
 *  ignored: GIF holds each frame for its own delay, so a "gap" just means the
 *  prior frame shows a touch longer — acceptable for a lossy share format). */
class GifSink implements FrameSink {
  readonly outW: number;
  readonly outH: number;
  readonly fps = TARGET_GIF_FPS;
  private readonly gif = GIFEncoder();
  private frameCount = 0;

  constructor(outW: number, outH: number) {
    this.outW = outW;
    this.outH = outH;
  }

  readonly error = null;

  isBackpressured(): boolean {
    return false; // synchronous encoder — no queue to drain
  }

  emit(_canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D, _gridIndex: number): void {
    const { data } = ctx.getImageData(0, 0, this.outW, this.outH);
    const rgba = new Uint8Array(data.buffer);
    // Per-frame palette (quality-first v1): quantize THIS frame to ≤256 colors,
    // then map its pixels to indices. Both buffers are dropped when this method
    // returns — nothing is held across frames but the growing GIF stream.
    const palette = quantize(rgba, 256, { format: "rgb565" });
    const index = applyPalette(rgba, palette, "rgb565");
    this.gif.writeFrame(index, this.outW, this.outH, {
      palette,
      // `delay` is ms; gifenc floors to centiseconds → pass exact cs*10.
      delay: gifFrameDelayCs(this.frameCount) * 10,
      repeat: 0, // loop forever
    });
    this.frameCount++;
  }

  async finalize(): Promise<Uint8Array> {
    this.gif.finish();
    return this.gif.bytes();
  }
}

/**
 * Render one recording end-to-end. Resolves with the finished container bytes:
 * an MP4 (default) or, when `opts.format === "gif"`, an animated GIF. Progress
 * is reported across three phases (decode → encode → mux); the caller turns it
 * into an inline "% " display.
 */
export async function renderRecording(opts: RenderRecordingOpts): Promise<Uint8Array> {
  const { fileUrl, eventsJsonl, durationMs, project, bgImage, onProgress } = opts;
  const appearance: Appearance = project.appearance;

  // Webcam SOURCE is opened when the row carries a webcam file AND the project
  // either shows the bubble OR has at least one "cut to camera" scene (M6) —
  // scenes render even with the bubble hidden, so a scenes-only project must
  // still decode the webcam. Offset null → 0.
  const webcamSettings = project.webcam;
  const webcamScenes = webcamSettings?.scenes ?? [];
  const wantWebcam = !!opts.webcamUrl && (!!webcamSettings?.show || webcamScenes.length > 0);
  const webcamOffsetMs = opts.webcamOffsetMs ?? 0;

  // --- Fetch source bytes ---
  onProgress({ phase: "decode", pct: 0 });
  const resp = await fetch(fileUrl);
  if (!resp.ok) {
    throw new Error(`Could not read the recording file (HTTP ${resp.status}).`);
  }
  const srcBytes = await resp.arrayBuffer();

  // --- Trim window (SOURCE-time ms) ---
  // clampTrim normalizes/clamps against the real duration; null → full length.
  const clamped = clampTrim(project.trim, durationMs);
  const trim: TrimWindow = clamped ?? { startMs: 0, endMs: durationMs };

  // --- Speed map (POST-TRIM source time → OUTPUT time) ---
  // Build the SAME map the audio retimer uses: shift the source-time speed
  // ranges into post-trim time (clipped to the trim window, offset by
  // trim.startMs), then integrate over the trimmed duration. The video pipeline
  // maps each kept frame's POST-TRIM source time through this map to get its
  // output timestamp; the audio (Rust `retime_wav_samples`) applies the same
  // shifted ranges to the trimmed WAV, so video and audio stay in lockstep.
  // Empty ranges ⇒ identity map ⇒ the classic re-anchored CFR behaviour.
  const trimmedDurationMs = trim.endMs - trim.startMs;
  const shiftedSpeedRanges = shiftRangesForTrim(project.speed, clamped);
  const speedMap: SpeedMap = buildSpeedMap(shiftedSpeedRanges, trimmedDurationMs);

  // --- Zoom timeline (optional) ---
  // The effective blocks come from `resolveZoomBlocks` — the SAME resolver the
  // editor preview uses — so the rendered file zooms exactly like the preview:
  //   mode "off" → no zoom; "custom" → the project's stored blocks; "auto" →
  //   generated from the recorded clicks (as before this was inlined here).
  //
  // NOTE: zoom blocks are SOURCE time (against the full, un-trimmed timeline),
  // so `zoomStateAt` MUST be queried with each frame's SOURCE timestamp — never
  // the re-anchored output time. If we passed output-time here, a trim that
  // lops off the first N seconds would shift every zoom block earlier by N
  // seconds and desync the pan/zoom from the content it was computed for. So:
  // trim-skip decisions and zoom lookup both use `tMsSource`; only the *emitted*
  // frame timestamp is re-anchored to t0.
  let zoomBlocks: ZoomBlock[] = [];
  // Synthetic-cursor overlay data (Task 6): when the project has the cursor
  // enabled AND the events parsed, keep the header + pre-split move/down
  // samples so the per-frame draw below can look up the cursor state at each
  // frame's SOURCE time (same source-time rule as the zoom lookup).
  let cursorHeader: EventsHeader | null = null;
  const cursorMoves: CursorSample[] = [];
  const cursorDowns: CursorSample[] = [];
  // Keystroke overlay data (Task 4): pre-split `k: "key"` events, alongside
  // the moves/downs split above, when the project has the overlay enabled.
  // Mirrors the editor preview's `keyEventsRef` — same source-time lookup.
  const keyEvents: RecEvent[] = [];
  if (eventsJsonl) {
    try {
      const { header, events } = parseEventsJsonl(eventsJsonl);
      zoomBlocks = resolveZoomBlocks(project, header, events, durationMs);
      if (header && project.cursor.enabled) {
        cursorHeader = header;
        for (const e of events) {
          if (e.k === "move") cursorMoves.push({ t: e.t, x: e.x, y: e.y });
          else if (e.k === "down") cursorDowns.push({ t: e.t, x: e.x, y: e.y });
        }
      }
      if (project.keystrokes.enabled) {
        for (const e of events) {
          if (e.k === "key") keyEvents.push(e);
        }
      }
    } catch (e) {
      // Non-fatal: render without zoom rather than failing the whole export.
      console.warn("[render] zoom resolution failed; rendering without zoom", e);
    }
  } else {
    // No events file, but a "custom" project may still carry stored blocks.
    zoomBlocks = resolveZoomBlocks(project, null, [], durationMs);
  }
  const drawCursor = project.cursor.enabled && cursorHeader !== null && cursorMoves.length > 0;
  // Cursor smoothing (Task 5): de-jitter the move path ONCE here (not per
  // frame) — the SAME shared `smoothCursorPath` the editor preview memoizes, so
  // preview and export smooth identically. strength 0 ⇒ identity (unchanged
  // path), so a pre-M4 project renders the exact same cursor track. Timestamps
  // are preserved, keeping the SOURCE-time lookup below valid.
  const smoothedMoves = smoothCursorPath(cursorMoves, project.cursor.smoothing);
  const cursorHideIdle = project.cursor.hideIdle;
  const cursorScale = cursorDrawScale(
    project.cursor.scale,
    cursorHeader?.capture.px_scale ?? 1,
  );
  const drawKeystrokes = project.keystrokes.enabled && keyEvents.length > 0;
  const keystrokesAllKeys = project.keystrokes.allKeys;
  // Motion blur (Task 5): on only when the project opts in AND there's a zoom
  // timeline to transition through (blur only smears the pan/zoom ramps). Off
  // ⇒ N=1 → `motionBlurSamples` returns a single state → a plain `drawCompositeV2`
  // via `drawCompositeBlurred` (byte-identical to pre-M4). Export always applies
  // blur when enabled (the preview may skip it under jank — see EditorView).
  const motionBlurN = project.motionBlur && zoomBlocks.length ? MOTION_BLUR_SAMPLES : 1;
  const frameIntervalMs = 1000 / TARGET_FPS;

  // Caption overlay (Task 3): unlike zoom/cursor/keystrokes, captions come
  // straight from the project (`generateCaptions`'s output persisted via the
  // editor's save path) — no events file involved. Drawn only when enabled AND
  // segments exist; looked up at each frame's SOURCE time via the shared
  // `captionAt`, same rule as the keystroke badge / zoom lookups (trim/speed
  // need no special handling here — see `frameInTrimWindow`/`speedMap` above).
  const captionSegments = project.captions.enabled ? (project.captions.segments ?? []) : [];
  const drawCaptions = captionSegments.length > 0;

  // Masks overlay (Task 4, M5): pixelate/highlight regions come straight from
  // the project (no events file). Clamped against the full source duration
  // (rect into [0,1], degenerate windows/zero-area rects dropped; time-overlaps
  // PRESERVED — see `clampMasks`), then looked up at each frame's SOURCE time
  // via the shared `masksAt` — same source-time rule as captions/scenes. Empty
  // ⇒ no masks drawn (pre-M5 byte-identical). Masks are suppressed during a
  // camera scene automatically (the compositor's scene branch returns first).
  const maskList: Mask[] = clampMasks(project.masks, durationMs);
  const drawMasks = maskList.length > 0;

  // Webcam M6 flags (auto-shrink, mirror, scenes). `showWebcamBubble` gates the
  // corner PiP; `drawScenes` gates the "cut to camera" full-frame ranges (which
  // render even when the bubble is hidden). Both looked up at SOURCE time via
  // the shared `webcamShrinkFactor` / `webcamSceneAt` the preview uses. Defaults
  // (autoShrink/mirror false, scenes []) leave the pre-M6 bubble untouched.
  const showWebcamBubble = !!webcamSettings?.show;
  const webcamAutoShrink = !!webcamSettings?.autoShrink;
  const webcamMirror = !!webcamSettings?.mirror;
  const drawScenes = webcamScenes.length > 0;

  // --- Demux ---
  const { chunks, decoderConfig, codedWidth, codedHeight } = await demux(srcBytes);
  if (chunks.length === 0) {
    throw new Error("Recording had no decodable video frames.");
  }

  // --- Webcam demux (optional, best-effort) ---
  // Fetch + demux the webcam file into its own chunk list + decoder config, and
  // wrap them in a lazily-decoding WebcamSource. Any failure here is non-fatal:
  // we log and render WITHOUT the overlay rather than aborting the export.
  let webcamSource: WebcamSource | null = null;
  if (wantWebcam && opts.webcamUrl) {
    try {
      const wResp = await fetch(opts.webcamUrl);
      if (!wResp.ok) throw new Error(`webcam fetch HTTP ${wResp.status}`);
      const wBytes = await wResp.arrayBuffer();
      const wDemux = await demux(wBytes);
      if (wDemux.chunks.length > 0) {
        webcamSource = new WebcamSource(wDemux.chunks, wDemux.decoderConfig, webcamOffsetMs);
      }
    } catch (e) {
      console.warn("[render] webcam demux failed; rendering without webcam overlay", e);
      webcamSource = null;
    }
  }

  // Output canvas size. MP4 honors the project's aspect preset (auto = source +
  // 2×padding, capped); GIF caps the SAME layout's width at GIF_MAX_WIDTH (even)
  // so big screens don't blow up the GIF. The compositor derives its content
  // rect from whatever outW/outH we give it, so every effect scales along.
  const format: "mp4" | "gif" = opts.format ?? "mp4";
  const layout = outputLayout(codedWidth, codedHeight, appearance.padding, appearance.aspect);
  let outW = layout.outW;
  let outH = layout.outH;
  if (format === "gif") {
    const g = gifOutputSize(layout.outW, layout.outH);
    outW = g.w;
    outH = g.h;
  }

  // --- Set up canvas + output sink ---
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not create a 2D drawing context for rendering.");

  // The sink is the ONLY divergence between MP4 and GIF: it owns the encoder,
  // the CFR grid fps, backpressure, and finalize. The composite loop is shared.
  const sink: FrameSink =
    format === "gif" ? new GifSink(outW, outH) : await Mp4Sink.create(outW, outH);
  const gridFps = sink.fps;

  // --- Decode → composite → encode ---
  const totalFrames = chunks.length;
  let decodedCount = 0;
  // Frames the decoder has emitted and we've made a keep/drop decision on —
  // used as the encode-phase progress numerator so 60fps sources (which drop
  // ~half their decoded frames under the grid filter below) don't stall
  // visually at ~50% while emitted frames lag behind totalFrames.
  let processedFrames = 0;
  // Speed-aware CFR pacing: instead of pacing on source-time spacing, each kept
  // frame is mapped through `speedMap` to an OUTPUT time, then quantized to the
  // sink's grid (`speedGridIndex(outMs, gridFps)`). A frame is kept only when
  // its grid index advances past the last emitted one — so sped-up regions that
  // collapse many source frames onto one slot drop the extras (holds ≤fps). For
  // MP4 the emitted timestamp is the grid slot itself so slowed regions leave
  // real gaps; GIF holds each frame for its own delay instead. GIF's 15fps grid
  // additionally drops a plain 30fps source to every other frame. Starts at -1
  // so the first kept frame (grid index ≥0) always advances.
  let lastGridIndex = -1;
  /** Backpressure stall guard: abort if the encode/decode queues make zero forward progress for this long. */
  const BACKPRESSURE_STALL_MS = 30_000;

  // The per-frame composite must `await` the webcam frame (async decode), but a
  // VideoDecoder `output` callback is synchronous. So the callback does only the
  // cheap keep/drop decisions synchronously, then hands each KEPT frame to a
  // serialized async composite chain (`compositeChain`) that awaits the webcam
  // frame, draws, and encodes — one frame at a time, in decode order. The feed
  // loop below bounds `pendingComposites` so we never let the chain fall far
  // behind (memory: each pending item pins a decoded main VideoFrame).
  let compositeChain: Promise<void> = Promise.resolve();
  let pendingComposites = 0;
  const MAX_PENDING_COMPOSITES = MAX_ENCODE_QUEUE;

  const decodeDone = new Promise<void>((resolveDecode, rejectDecode) => {
    const decoder = new VideoDecoder({
      output: (frame) => {
        // `frame.timestamp` is the SOURCE presentation time (µs). Use it for
        // BOTH the trim-skip decision and the zoom/cursor/webcam lookup; only
        // the emitted output frame's timestamp is re-anchored to the trim start.
        const tsSourceUs = frame.timestamp;
        const tMsSource = tsSourceUs / 1000;

        // Trim: drop frames outside the kept [startMs, endMs) window.
        if (!frameInTrimWindow(tsSourceUs, trim)) {
          frame.close();
          processedFrames++;
          onProgress({ phase: "encode", pct: Math.min(99, Math.round((processedFrames / totalFrames) * 100)) });
          return;
        }

        // Speed-aware CFR pacing. Map this frame's POST-TRIM source time
        // through `speedMap` to an OUTPUT time, then quantize to the sink's grid
        // (30fps for MP4, 15fps for GIF). Drop the frame unless its grid index
        // advances past the last emitted one (collapsing sped-up regions to
        // ≤fps). With no speed ranges the map is identity, so this reduces to
        // the classic "drop frames faster than the grid fps" pacing — which for
        // GIF's 15fps grid means a 30fps source drops to every other frame.
        const outMs = speedMap.srcToOut(tMsSource - trim.startMs);
        const gridIndex = speedGridIndex(outMs, gridFps);
        if (gridIndex <= lastGridIndex) {
          frame.close();
          processedFrames++;
          onProgress({ phase: "encode", pct: Math.min(99, Math.round((processedFrames / totalFrames) * 100)) });
          return;
        }
        lastGridIndex = gridIndex;

        // Enqueue the composite for this kept frame onto the serialized chain.
        // The frame is closed inside the async task once drawn.
        pendingComposites++;
        compositeChain = compositeChain.then(async () => {
          try {
            // Zoom sub-samples for this frame: a single current-time state when
            // blur is off / on a static stretch, or N eased states across the
            // last frame interval when inside a transition ramp (see
            // `motionBlurSamples`). `drawCompositeBlurred` accumulates them.
            const zoomSamples: ZoomState[] = zoomBlocks.length
              ? motionBlurSamples(tMsSource, zoomBlocks, motionBlurN, frameIntervalMs)
              : [{ cx: 0.5, cy: 0.5, scale: 1 }];
            // Synthetic cursor overlay, looked up at SOURCE time (same rule as
            // zoom: trim re-anchoring must not shift the cursor track). Uses the
            // pre-smoothed move path + the hideIdle fade flag (Task 5).
            const cursor = drawCursor
              ? cursorStateAt(tMsSource, smoothedMoves, cursorDowns, cursorHeader!, {
                  hideIdle: cursorHideIdle,
                })
              : null;
            // Keystroke badge overlay, looked up at SOURCE time — same rule as
            // zoom/cursor. Mirrors the editor preview's `keystrokeOverlayAt`.
            const keystroke = drawKeystrokes
              ? keystrokeOverlayAt(tMsSource, keyEvents, keystrokesAllKeys)
              : null;
            // Caption overlay, looked up at SOURCE time via the SAME shared
            // `captionAt` the editor preview uses — a caption spanning a
            // trimmed/sped region needs no special handling (identical rule to
            // the keystroke badge / zoom lookups above).
            const caption = drawCaptions ? captionAt(tMsSource, captionSegments) : null;
            // Masks active at SOURCE time (all currently-active — overlaps are
            // legal). Empty when disabled; suppressed during a scene below by
            // forcing `masks: []` on the scene overlay (the screen is hidden).
            const masks = drawMasks ? masksAt(tMsSource, maskList) : [];
            // Webcam overlay, co-occurring frame at SOURCE time. Convention:
            //   webcamTime = mainTime + offset_ms   (see pickWebcamFrameIndex).
            // WebcamSource owns the returned frame (held/reused) — do NOT close it.
            // Decoded ONCE and shared between the scene layout and the bubble.
            const wf =
              webcamSource && webcamSettings ? await webcamSource.frameAt(tsSourceUs) : null;

            // "Cut to camera" scene (M6): active when a scene covers this SOURCE
            // time AND a webcam frame is available. When the frame is missing
            // (webcam not started yet / decode failed), `scene` stays null and
            // the render falls back to the normal screen layout for this frame
            // (never a black frame). During a scene the bubble is NOT also drawn.
            const scene: OverlayState["scene"] =
              drawScenes && wf && webcamSceneAt(tMsSource, webcamScenes)
                ? { frame: wf, mirror: webcamMirror }
                : null;

            // Corner webcam bubble (only when shown AND not superseded by a
            // scene this frame). Auto-shrink follows the frame's PRIMARY zoom
            // state at tMsSource (a single value per frame, stable across the
            // motion-blur sub-samples per the M4 overlay-bundle invariant), not
            // the per-sub-sample zoom.
            let webcam: OverlayState["webcam"] = null;
            if (showWebcamBubble && wf && webcamSettings && !scene) {
              const scaleFactor =
                webcamAutoShrink && zoomBlocks.length
                  ? webcamShrinkFactor(zoomStateAt(tMsSource, zoomBlocks).scale)
                  : 1;
              webcam = {
                frame: wf,
                shape: webcamSettings.shape,
                corner: webcamSettings.corner,
                sizeFrac: webcamSettings.sizeFrac,
                scaleFactor,
                mirror: webcamMirror,
              };
            }
            // Motion blur collapses during a scene (zoom ignored ⇒ every
            // sub-sample resolves identically) — force a single draw.
            const frameZoomSamples = scene ? [zoomSamples[0]] : zoomSamples;
            drawCompositeBlurred(
              ctx,
              frame,
              frame.displayWidth,
              frame.displayHeight,
              outW,
              outH,
              appearance,
              frameZoomSamples,
              // Masks are content on the screen frame, so they're suppressed
              // during a "cut to camera" scene (the screen is hidden). Force []
              // when a scene is active — belt-and-suspenders with the
              // compositor's scene early-return, which also skips the mask draw.
              { cursor, webcam, keystroke, caption, scene, masks: scene ? [] : masks },
              cursorScale,
              bgImage,
            );
            frame.close();

            // Hand the freshly-composited canvas to the output sink for the CFR
            // grid slot this frame mapped to. MP4 re-anchors the encoded frame's
            // timestamp to `gridIndex/fps` (so a trim starts at 0 and speed
            // segments land at their retimed output time — video/audio share the
            // same `speedMap`); GIF reads the pixels, quantizes, and writes an
            // indexed frame with a per-slot centisecond delay. Neither retains
            // the canvas past this call, so memory stays bounded.
            sink.emit(canvas, ctx, gridIndex);
            processedFrames++;
            onProgress({ phase: "encode", pct: Math.min(99, Math.round((processedFrames / totalFrames) * 100)) });
          } catch (e) {
            try {
              frame.close();
            } catch {
              // already closed
            }
            rejectDecode(e);
          } finally {
            pendingComposites--;
          }
        });
      },
      error: (e) => rejectDecode(e),
    });

    decoder.configure(decoderConfig);

    void (async () => {
      try {
        for (const chunk of chunks) {
          // Backpressure: don't let the decode queue, the sink's encode queue,
          // or the pending-composite backlog balloon (memory — each pins a
          // decoded VideoFrame). The GIF sink is synchronous (`isBackpressured`
          // is always false), so only the decode queue + composite backlog gate
          // it — still bounded, since the composite drains one frame at a time.
          // Guard against an indefinite stall with a wall-clock timeout.
          const stallStartedAt = Date.now();
          while (
            sink.isBackpressured() ||
            decoder.decodeQueueSize >= MAX_ENCODE_QUEUE ||
            pendingComposites >= MAX_PENDING_COMPOSITES
          ) {
            await new Promise((r) => setTimeout(r, 1));
            if (sink.error) throw sink.error;
            if (Date.now() - stallStartedAt > BACKPRESSURE_STALL_MS) {
              throw new Error(
                `Render stalled: encoder/decoder queues made no progress for ${BACKPRESSURE_STALL_MS / 1000}s (decodeQueueSize=${decoder.decodeQueueSize}, pendingComposites=${pendingComposites}).`,
              );
            }
          }
          decoder.decode(chunk);
          decodedCount++;
          onProgress({ phase: "decode", pct: Math.min(99, Math.round((decodedCount / totalFrames) * 100)) });
        }
        await decoder.flush();
        // Drain any composites still queued after the last decoded frame.
        await compositeChain;
        decoder.close();
        resolveDecode();
      } catch (e) {
        rejectDecode(e);
      }
    })();
  });

  try {
    await decodeDone;
  } finally {
    // Release the webcam decoder + any held frames regardless of outcome.
    webcamSource?.close();
  }
  if (sink.error) throw sink.error;

  // --- Finalize ---
  // Same "mux" phase label for both formats (the UI maps it to "Finalizing
  // video"): MP4 flushes the encoder + muxer, GIF writes the trailer.
  onProgress({ phase: "mux", pct: 99 });
  const outBytes = await sink.finalize();

  onProgress({ phase: "mux", pct: 100 });
  return outBytes;
}
