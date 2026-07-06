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
import { generateAutoZoom, parseEventsJsonl, type ZoomBlock } from "../autoZoom";
import { clampTrim, type EditorProject } from "../editorProject";
import { drawCompositeV2, zoomStateAt, type Appearance } from "./compositor";

export type RenderProgress = { phase: "decode" | "encode" | "mux"; pct: number };

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
/** Cap the output long edge so a 5K capture doesn't blow up encode time/memory. */
const MAX_LONG_EDGE = 3840;
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

/** Compute the output canvas size: source pixels + 2×padding, long edge capped. */
function outputSize(
  srcW: number,
  srcH: number,
  padding: number,
): { outW: number; outH: number } {
  let outW = srcW + 2 * padding;
  let outH = srcH + 2 * padding;
  const longEdge = Math.max(outW, outH);
  if (longEdge > MAX_LONG_EDGE) {
    const k = MAX_LONG_EDGE / longEdge;
    outW = Math.round(outW * k);
    outH = Math.round(outH * k);
  }
  // Encoders require even dimensions.
  outW -= outW % 2;
  outH -= outH % 2;
  return { outW, outH };
}

/**
 * Render one recording end-to-end. Resolves with the finished MP4 bytes.
 * Progress is reported across three phases (decode → encode → mux); the caller
 * turns it into an inline "% " display.
 */
export async function renderRecording(opts: RenderRecordingOpts): Promise<Uint8Array> {
  const { fileUrl, eventsJsonl, durationMs, project, bgImage, onProgress } = opts;
  const appearance: Appearance = project.appearance;

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
  if (eventsJsonl) {
    try {
      const { header, events } = parseEventsJsonl(eventsJsonl);
      if (header) zoomBlocks = generateAutoZoom(header, events, durationMs);
    } catch (e) {
      // Non-fatal: render without zoom rather than failing the whole export.
      console.warn("[render] auto-zoom generation failed; rendering without zoom", e);
    }
  }

  // --- Demux ---
  const { chunks, decoderConfig, codedWidth, codedHeight } = await demux(srcBytes);
  if (chunks.length === 0) {
    throw new Error("Recording had no decodable video frames.");
  }

  const { outW, outH } = outputSize(codedWidth, codedHeight, appearance.padding);

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

  const decodeDone = new Promise<void>((resolveDecode, rejectDecode) => {
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          // `frame.timestamp` is the SOURCE presentation time (µs). Use it for
          // BOTH the trim-skip decision and the zoom lookup; only the emitted
          // output frame's timestamp is re-anchored to the trim start below.
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

          const zoom = zoomBlocks.length ? zoomStateAt(tMsSource, zoomBlocks) : { cx: 0.5, cy: 0.5, scale: 1 };
          // Overlays (cursor/webcam) are Tasks 6/8 — pass null for now.
          drawCompositeV2(
            ctx,
            frame,
            frame.displayWidth,
            frame.displayHeight,
            outW,
            outH,
            appearance,
            zoom,
            { cursor: null, webcam: null },
            project.cursor.scale,
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
          rejectDecode(e);
        }
      },
      error: (e) => rejectDecode(e),
    });

    decoder.configure(decoderConfig);

    void (async () => {
      try {
        for (const chunk of chunks) {
          // Backpressure: don't let either queue balloon (memory). Guard against an
          // indefinite stall (e.g. a wedged encoder that never drains) with a wall-clock
          // timeout rather than spinning forever.
          const stallStartedAt = Date.now();
          while (encoder.encodeQueueSize >= MAX_ENCODE_QUEUE || decoder.decodeQueueSize >= MAX_ENCODE_QUEUE) {
            await new Promise((r) => setTimeout(r, 1));
            if (encodeError) throw encodeError;
            if (Date.now() - stallStartedAt > BACKPRESSURE_STALL_MS) {
              throw new Error(
                `Render stalled: encoder/decoder queues made no progress for ${BACKPRESSURE_STALL_MS / 1000}s (encodeQueueSize=${encoder.encodeQueueSize}, decodeQueueSize=${decoder.decodeQueueSize}).`,
              );
            }
          }
          decoder.decode(chunk);
          decodedCount++;
          onProgress({ phase: "decode", pct: Math.min(99, Math.round((decodedCount / totalFrames) * 100)) });
        }
        await decoder.flush();
        decoder.close();
        resolveDecode();
      } catch (e) {
        rejectDecode(e);
      }
    })();
  });

  await decodeDone;
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
