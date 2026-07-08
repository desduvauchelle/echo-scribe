// WebCodecs render pipeline: decode an MP4 → composite background + padding +
// rounded corners + animated auto-zoom on an OffscreenCanvas → re-encode → mux
// to a fresh MP4. Video-only in M1 (no audio). This is both a shippable
// "Render (beta)" feature and the de-risking spike proving decode→composite→
// encode works inside Tauri's WKWebView (Safari-17-era WebCodecs).
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
import {
  generateAutoZoom,
  parseEventsJsonl,
  type EventsHeader,
  type ZoomBlock,
} from "../autoZoom";
import { clampTrim, type EditorProject } from "../editorProject";
import {
  cursorDrawScale,
  cursorStateAt,
  drawCompositeV2,
  outputLayout,
  zoomStateAt,
  type Appearance,
  type CursorSample,
  type OverlayState,
} from "./compositor";

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

/** Output frame rate. Source frames above this are dropped down to it. */
const TARGET_FPS = 30;
/** Encoder backpressure threshold — never let the queue grow unbounded. */
const MAX_ENCODE_QUEUE = 8;

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
 * Render one recording end-to-end. Resolves with the finished MP4 bytes.
 * Progress is reported across three phases (decode → encode → mux); the caller
 * turns it into an inline "% " display.
 */
export async function renderRecording(opts: RenderRecordingOpts): Promise<Uint8Array> {
  const { fileUrl, eventsJsonl, durationMs, project, bgImage, onProgress } = opts;
  const appearance: Appearance = project.appearance;

  // Webcam overlay is on only when the project shows it, the row carries a
  // webcam file, AND the project has webcam settings. Offset null → 0.
  const webcamSettings = project.webcam;
  const wantWebcam = !!opts.webcamUrl && !!webcamSettings?.show;
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

  // --- Zoom timeline (optional) ---
  // NOTE: auto-zoom blocks are generated in SOURCE time (against the full,
  // un-trimmed timeline), so `zoomStateAt` MUST be queried with each frame's
  // SOURCE timestamp — never the re-anchored output time. If we passed
  // output-time here, a trim that lops off the first N seconds would shift
  // every zoom block earlier by N seconds and desync the pan/zoom from the
  // content it was computed for. So: trim-skip decisions and zoom lookup both
  // use `tMsSource`; only the *emitted* frame timestamp is re-anchored to t0.
  let zoomBlocks: ZoomBlock[] = [];
  // Synthetic-cursor overlay data (Task 6): when the project has the cursor
  // enabled AND the events parsed, keep the header + pre-split move/down
  // samples so the per-frame draw below can look up the cursor state at each
  // frame's SOURCE time (same source-time rule as the zoom lookup).
  let cursorHeader: EventsHeader | null = null;
  const cursorMoves: CursorSample[] = [];
  const cursorDowns: CursorSample[] = [];
  if (eventsJsonl) {
    try {
      const { header, events } = parseEventsJsonl(eventsJsonl);
      if (header) {
        zoomBlocks = generateAutoZoom(header, events, durationMs);
        if (project.cursor.enabled) {
          cursorHeader = header;
          for (const e of events) {
            if (e.k === "move") cursorMoves.push({ t: e.t, x: e.x, y: e.y });
            else if (e.k === "down") cursorDowns.push({ t: e.t, x: e.x, y: e.y });
          }
        }
      }
    } catch (e) {
      // Non-fatal: render without zoom rather than failing the whole export.
      console.warn("[render] auto-zoom generation failed; rendering without zoom", e);
    }
  }
  const drawCursor = project.cursor.enabled && cursorHeader !== null && cursorMoves.length > 0;
  const cursorScale = cursorDrawScale(
    project.cursor.scale,
    cursorHeader?.capture.px_scale ?? 1,
  );

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

  // Output canvas size honors the project's aspect preset (auto = source +
  // 2×padding, capped). The compositor derives the SAME content rect internally.
  const { outW, outH } = outputLayout(codedWidth, codedHeight, appearance.padding, appearance.aspect);

  // --- Set up canvas, muxer, encoder ---
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not create a 2D drawing context for rendering.");

  const codec = await pickCodec(outW, outH);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: codec.muxerCodec, width: outW, height: outH, frameRate: TARGET_FPS },
    fastStart: "in-memory",
  });

  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
      console.error("[render] VideoEncoder error", e);
    },
  });
  encoder.configure(codec.encoderConfig);

  // --- Decode → composite → encode ---
  const totalFrames = chunks.length;
  let decodedCount = 0;
  let encodedFrames = 0;
  // Frames the decoder has emitted and we've made a keep/drop decision on —
  // used as the encode-phase progress numerator so 60fps sources (which drop
  // ~half their decoded frames under the TARGET_FPS filter below) don't stall
  // visually at ~50% while encodedFrames lags behind totalFrames.
  let processedFrames = 0;
  const minFrameIntervalUs = 1_000_000 / TARGET_FPS;
  let lastEmittedUs = -Infinity;
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

        // Frame pacing: drop frames that arrive faster than TARGET_FPS.
        if (frame.timestamp - lastEmittedUs < minFrameIntervalUs - 1) {
          frame.close();
          processedFrames++;
          onProgress({ phase: "encode", pct: Math.min(99, Math.round((processedFrames / totalFrames) * 100)) });
          return;
        }
        lastEmittedUs = frame.timestamp;

        // Enqueue the composite for this kept frame onto the serialized chain.
        // The frame is closed inside the async task once drawn.
        pendingComposites++;
        compositeChain = compositeChain.then(async () => {
          try {
            const zoom = zoomBlocks.length ? zoomStateAt(tMsSource, zoomBlocks) : { cx: 0.5, cy: 0.5, scale: 1 };
            // Synthetic cursor overlay, looked up at SOURCE time (same rule as
            // zoom: trim re-anchoring must not shift the cursor track).
            const cursor = drawCursor
              ? cursorStateAt(tMsSource, cursorMoves, cursorDowns, cursorHeader!)
              : null;
            // Webcam overlay, co-occurring frame at SOURCE time. Convention:
            //   webcamTime = mainTime + offset_ms   (see pickWebcamFrameIndex).
            // WebcamSource owns the returned frame (held/reused) — do NOT close it.
            let webcam: OverlayState["webcam"] = null;
            if (webcamSource && webcamSettings) {
              const wf = await webcamSource.frameAt(tsSourceUs);
              if (wf) {
                webcam = {
                  frame: wf,
                  shape: webcamSettings.shape,
                  corner: webcamSettings.corner,
                  sizeFrac: webcamSettings.sizeFrac,
                };
              }
            }
            drawCompositeV2(
              ctx,
              frame,
              frame.displayWidth,
              frame.displayHeight,
              outW,
              outH,
              appearance,
              zoom,
              { cursor, webcam },
              cursorScale,
              bgImage,
            );
            frame.close();

            // Re-anchor: the first KEPT frame becomes t0; CFR from there. Output
            // timeline is independent of the source trim offset so the muxed mp4
            // starts at 0 with no leading gap.
            const outFrame = new VideoFrame(canvas, {
              timestamp: Math.round(encodedFrames * minFrameIntervalUs),
              duration: Math.round(minFrameIntervalUs),
            });
            const keyFrame = encodedFrames % (TARGET_FPS * 2) === 0; // keyframe every ~2s
            encoder.encode(outFrame, { keyFrame });
            outFrame.close();
            encodedFrames++;
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
          // Backpressure: don't let the decode queue, the encode queue, or the
          // pending-composite backlog balloon (memory — each pins a VideoFrame).
          // Guard against an indefinite stall with a wall-clock timeout.
          const stallStartedAt = Date.now();
          while (
            encoder.encodeQueueSize >= MAX_ENCODE_QUEUE ||
            decoder.decodeQueueSize >= MAX_ENCODE_QUEUE ||
            pendingComposites >= MAX_PENDING_COMPOSITES
          ) {
            await new Promise((r) => setTimeout(r, 1));
            if (encodeError) throw encodeError;
            if (Date.now() - stallStartedAt > BACKPRESSURE_STALL_MS) {
              throw new Error(
                `Render stalled: encoder/decoder queues made no progress for ${BACKPRESSURE_STALL_MS / 1000}s (encodeQueueSize=${encoder.encodeQueueSize}, decodeQueueSize=${decoder.decodeQueueSize}, pendingComposites=${pendingComposites}).`,
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
  if (encodeError) throw encodeError;

  // --- Finalize ---
  onProgress({ phase: "mux", pct: 99 });
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  muxer.finalize();

  onProgress({ phase: "mux", pct: 100 });
  return new Uint8Array(muxer.target.buffer);
}
