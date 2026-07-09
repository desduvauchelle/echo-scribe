/// <reference types="vite/client" />

// Minimal ambient types for `gifenc` (ships no .d.ts). Only the surface the
// render pipeline uses: the streaming encoder + the per-frame palette helpers.
declare module "gifenc" {
  /** A palette entry: [r, g, b] or [r, g, b, a], each 0–255. */
  export type GifPalette = number[][];

  export interface GifFrameOptions {
    /** Palette for THIS frame (per-frame palette = quality-first). */
    palette?: GifPalette;
    /** Frame delay in milliseconds (encoder rounds to centiseconds internally). */
    delay?: number;
    /** Force this to be treated as the first frame (writes the GIF header). */
    first?: boolean;
    /** Loop count; 0 = loop forever (default). */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: GifFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: {
    initialCapacity?: number;
    auto?: boolean;
  }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number },
  ): GifPalette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;
}
