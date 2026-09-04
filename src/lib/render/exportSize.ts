import type { AspectPreset, ExportResolution } from "../editorProject";
import { outputLayout } from "./compositor";

/** Fit the composition inside HD/UHD bounds, preserving its chosen aspect.
 * Portrait swaps the bounds. Native keeps the existing, capped canvas size.
 * Use the exact preset ratio so rounding a small source canvas cannot turn
 * a requested 1920 × 1080 export into 1918 × 1080. */
export function mp4OutputSize(
  frameW: number,
  frameH: number,
  padding: number,
  aspect: AspectPreset,
  resolution: ExportResolution,
): { w: number; h: number } {
  const layout = outputLayout(frameW, frameH, padding, aspect);
  if (resolution === "native") return { w: layout.outW, h: layout.outH };
  const ratios = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3 };
  const ratio = aspect === "auto"
    ? (frameW + 2 * padding) / (frameH + 2 * padding)
    : ratios[aspect];
  const short = resolution === "2160" ? 2160 : 1080;
  const long = short * 16 / 9;
  const maxW = ratio < 1 ? short : long;
  const maxH = ratio < 1 ? long : short;
  const h = Math.min(maxH, maxW / ratio);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { w: even(h * ratio), h: even(h) };
}
