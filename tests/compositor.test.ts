import { describe, expect, test } from "bun:test";
import {
  zoomStateAt,
  webcamRect,
  cursorStateAt,
  cursorDrawScale,
  coverCrop,
  imgWidth,
  imgHeight,
  outputLayout,
  canvasToCapture,
  keystrokeBadgeAt,
  captionAt,
  CAPTION_STRIP_HEIGHT_FRAC,
  keystrokeBottomMargin,
  type CursorSample,
  type OutputLayout,
  type ZoomState,
} from "../src/lib/render/compositor";
import type { ZoomBlock, EventsHeader, RecEvent } from "../src/lib/autoZoom";
import type { CaptionSegment } from "../src/lib/editorProject";

const block: ZoomBlock = { startMs: 2000, endMs: 6000, cx: 0.3, cy: 0.7, scale: 2, mode: "auto" };

describe("outputLayout", () => {
  const isEven = (n: number) => n % 2 === 0;

  describe("auto (backwards-compatible)", () => {
    test("canvas = frame + 2*padding; content at (p, p) sized (frameW, frameH)", () => {
      // 1920+192=2112 and 1080+192=1272 are both even, so no rounding bite: the
      // content rect is exactly the frame.
      const L = outputLayout(1920, 1080, 96, "auto");
      expect(L.outW).toBe(1920 + 2 * 96); // 2112
      expect(L.outH).toBe(1080 + 2 * 96); // 1272
      expect(L.contentX).toBe(96);
      expect(L.contentY).toBe(96);
      expect(L.contentW).toBe(1920);
      expect(L.contentH).toBe(1080);
    });

    test("zero padding: canvas equals the frame, content fills it", () => {
      const L = outputLayout(1280, 720, 0, "auto");
      expect(L.outW).toBe(1280);
      expect(L.outH).toBe(720);
      expect(L.contentX).toBe(0);
      expect(L.contentY).toBe(0);
      expect(L.contentW).toBe(1280);
      expect(L.contentH).toBe(720);
    });

    test("auto is exactly the legacy outputSize math (source + 2*padding, even)", () => {
      // The legacy renderPipeline.outputSize did: outW = srcW + 2p, outH = srcH
      // + 2p, then even-rounding. auto must reproduce that byte-for-byte.
      for (const [w, h, p] of [
        [1920, 1080, 96],
        [1710, 1069, 37], // odd dims + odd padding → even rounding must bite
        [800, 600, 0],
      ] as const) {
        const L = outputLayout(w, h, p, "auto");
        let ew = w + 2 * p;
        let eh = h + 2 * p;
        ew -= ew % 2;
        eh -= eh % 2;
        expect(L.outW).toBe(ew);
        expect(L.outH).toBe(eh);
      }
    });
  });

  describe("fixed aspect — centering & short-axis padding", () => {
    test("16:9 around a TALL-ish window puts the extra space left/right", () => {
      // Content box for a 1000x1000 frame with p=50 is 1100x1100 (square).
      // Smallest 16:9 rect containing 1100x1100: height=1100 → width=1100*16/9
      // ≈ 1955.6. So width grows, height stays: extra lands left+right.
      const L = outputLayout(1000, 1000, 50, "16:9");
      expect(L.outW / L.outH).toBeCloseTo(16 / 9, 2);
      expect(L.outH).toBe(1100); // content box height drives the short axis
      expect(L.outW).toBeGreaterThan(1100); // widened
      // content box (1100x1100) centered horizontally, flush vertically. The
      // centering offset is computed off the unrounded canvas, so allow ~1px.
      const boxW = 1100;
      const expectedBoxX = (L.outW - boxW) / 2;
      expect(L.contentX).toBeCloseTo(expectedBoxX + 50, -1); // + padding
      expect(L.contentY).toBeCloseTo(50, -1); // flush to top band + padding
      expect(L.contentW).toBeCloseTo(1000, -1);
      expect(L.contentH).toBeCloseTo(1000, -1);
    });

    test("16:9 around a WIDE-short window puts the extra space top/bottom", () => {
      // A 2000x400 frame, p=0 → content box 2000x400 (5:1, wider than 16:9).
      // Smallest 16:9 rect containing it: width=2000 → height=2000*9/16=1125.
      // So height grows: extra lands top+bottom.
      const L = outputLayout(2000, 400, 0, "16:9");
      expect(L.outW / L.outH).toBeCloseTo(16 / 9, 2);
      expect(L.outW).toBe(2000); // content box width drives the long axis
      expect(L.outH).toBeGreaterThan(400); // heightened (letterbox top/bottom)
      // centered vertically, flush horizontally (allow ~1px for even-rounding).
      expect(L.contentX).toBeCloseTo(0, -1);
      const expectedBoxY = (L.outH - 400) / 2;
      expect(L.contentY).toBeCloseTo(expectedBoxY, -1);
      expect(L.contentW).toBeCloseTo(2000, -1);
      expect(L.contentH).toBeCloseTo(400, -1);
    });

    test("9:16 (portrait) around a landscape window pads top/bottom", () => {
      // 1600x900 frame, p=0 → box 1600x900 (landscape). 9:16 target is tall:
      // width=1600 drives → height=1600*16/9≈2844. Extra top/bottom.
      const L = outputLayout(1600, 900, 0, "9:16");
      expect(L.outW / L.outH).toBeCloseTo(9 / 16, 2);
      expect(L.outW).toBe(1600);
      expect(L.outH).toBeGreaterThan(900);
      expect(L.contentX).toBeCloseTo(0, -1);
      expect(L.contentY).toBeCloseTo((L.outH - 900) / 2, -1);
    });

    test("1:1 around a landscape window pads top/bottom to square", () => {
      // 1600x900 landscape box → square canvas 1600x1600; the wider width drives
      // the square, so the extra height lands top/bottom (flush horizontally).
      const L = outputLayout(1600, 900, 0, "1:1");
      expect(L.outW).toBe(L.outH); // square
      expect(L.outW).toBe(1600); // long axis (width) of the box drives the square
      expect(L.contentX).toBeCloseTo(0, -1); // flush horizontally
      expect(L.contentY).toBeCloseTo((L.outH - 900) / 2, -1); // centered vertically
    });

    test("4:3 around a 16:9 window pads top/bottom", () => {
      // 1920x1080 (16:9) is wider than 4:3 → width drives, height grows.
      const L = outputLayout(1920, 1080, 0, "4:3");
      expect(L.outW / L.outH).toBeCloseTo(4 / 3, 2);
      expect(L.outW).toBe(1920);
      expect(L.outH).toBeGreaterThan(1080);
    });

    test("the frame content box always fits inside the canvas", () => {
      for (const aspect of ["16:9", "9:16", "1:1", "4:3"] as const) {
        for (const [w, h, p] of [
          [1920, 1080, 96],
          [1000, 1000, 50],
          [400, 1200, 20],
          [1200, 400, 0],
        ] as const) {
          const L = outputLayout(w, h, p, aspect);
          // content rect fully inside canvas
          expect(L.contentX).toBeGreaterThanOrEqual(-1e-6);
          expect(L.contentY).toBeGreaterThanOrEqual(-1e-6);
          expect(L.contentX + L.contentW).toBeLessThanOrEqual(L.outW + 1e-6);
          expect(L.contentY + L.contentH).toBeLessThanOrEqual(L.outH + 1e-6);
        }
      }
    });

    test("outW/outH are always even integers", () => {
      for (const aspect of ["auto", "16:9", "9:16", "1:1", "4:3"] as const) {
        for (const [w, h, p] of [
          [1921, 1081, 37],
          [1000, 1000, 51],
          [1710, 1069, 13],
        ] as const) {
          const L = outputLayout(w, h, p, aspect);
          expect(Number.isInteger(L.outW)).toBe(true);
          expect(Number.isInteger(L.outH)).toBe(true);
          expect(isEven(L.outW)).toBe(true);
          expect(isEven(L.outH)).toBe(true);
        }
      }
    });
  });

  describe("3840 long-edge cap", () => {
    test("caps the long edge and preserves aspect (content scaled down)", () => {
      // 5000x2000 frame, p=0, 16:9. Box is 5000x2000 (2.5:1 wider than 16:9) →
      // width drives: outW=5000, outH=5000*9/16=2812.5. Long edge 5000 > 3840,
      // so scale by 3840/5000 = 0.768 → outW≈3840, outH≈2160.
      const L = outputLayout(5000, 2000, 0, "16:9");
      expect(Math.max(L.outW, L.outH)).toBeLessThanOrEqual(3840);
      // long edge hits the cap (within even-rounding)
      expect(Math.max(L.outW, L.outH)).toBeGreaterThanOrEqual(3840 - 2);
      expect(L.outW / L.outH).toBeCloseTo(16 / 9, 2);
      // content shrank proportionally: originally 5000 wide content, now scaled
      // by ~0.768 → ~3840. (Frame content, not the whole canvas.)
      expect(L.contentW).toBeCloseTo(5000 * (3840 / 5000), 0);
    });

    test("cap in auto mode matches legacy proportional downscale", () => {
      // 5000x3000 + p=0 → 5000x3000, long edge 5000 → k=3840/5000=0.768.
      const L = outputLayout(5000, 3000, 0, "auto");
      expect(Math.max(L.outW, L.outH)).toBeLessThanOrEqual(3840);
      let ew = Math.round(5000 * 0.768);
      let eh = Math.round(3000 * 0.768);
      ew -= ew % 2;
      eh -= eh % 2;
      expect(L.outW).toBe(ew);
      expect(L.outH).toBe(eh);
    });

    test("padding scales with the cap (documented choice: whole layout × k)", () => {
      // With a binding cap, the ENTIRE layout — content box, centering bands,
      // and padding — is scaled by k. So the padding gap between the content
      // rect and its box edge shrinks to padding*k. This is the documented
      // decision (padding scales, not nominal).
      // 8000x4000 + p=400 → box 8800x4800; 16:9 wider-than target so width
      // drives: outW≈8800, outH≈8800*9/16=4950; long edge 8800 > 3840 →
      // k = 3840/8800.
      const capped = outputLayout(8000, 4000, 400, "16:9");
      const k = 3840 / 8800;
      const boxW = 8800 * k; // scaled content-box width
      const centeringBand = (capped.outW - boxW) / 2;
      // The left padding gap (contentX minus the centering band) == padding*k.
      expect(capped.contentX - centeringBand).toBeCloseTo(400 * k, -1);
      // And the content itself is the frame scaled by k.
      expect(capped.contentW).toBeCloseTo(8000 * k, -1);
      expect(capped.contentH).toBeCloseTo(4000 * k, -1);
    });
  });

  describe("auto-equivalence to legacy geometry", () => {
    test("auto content rect equals the old implicit (padding, padding, outW-2p, outH-2p)", () => {
      // The old drawFrameLayer used content = (p, p, outW-2p, outH-2p) with
      // outW=frameW+2p. auto must reproduce exactly that so existing composite
      // output is pixel-identical.
      for (const [w, h, p] of [
        [1920, 1080, 96],
        [1280, 720, 0],
        [640, 480, 128],
      ] as const) {
        const L = outputLayout(w, h, p, "auto");
        expect(L.contentX).toBe(p);
        expect(L.contentY).toBe(p);
        expect(L.contentW).toBe(L.outW - 2 * p);
        expect(L.contentH).toBe(L.outH - 2 * p);
      }
    });
  });
});

describe("zoomStateAt", () => {
  test("identity outside blocks", () => {
    expect(zoomStateAt(0, [block])).toEqual({ cx: 0.5, cy: 0.5, scale: 1 });
    expect(zoomStateAt(10000, [block])).toEqual({ cx: 0.5, cy: 0.5, scale: 1 });
  });
  test("full zoom mid-block", () => {
    expect(zoomStateAt(4000, [block])).toEqual({ cx: 0.3, cy: 0.7, scale: 2 });
  });
  test("halfway through transition is between states", () => {
    const s = zoomStateAt(2250, [block], 500);
    expect(s.scale).toBeGreaterThan(1);
    expect(s.scale).toBeLessThan(2);
  });
  test("transition is monotonic entering the block", () => {
    let prev = 1;
    for (let t = 2000; t <= 2500; t += 50) {
      const s = zoomStateAt(t, [block], 500);
      expect(s.scale).toBeGreaterThanOrEqual(prev);
      prev = s.scale;
    }
    expect(prev).toBeCloseTo(2);
  });
});

describe("canvasToCapture", () => {
  // Content rect at (100, 50), 800×400 inside a larger canvas (the padding /
  // letterbox band surrounds it).
  const layout: OutputLayout = {
    outW: 1000,
    outH: 500,
    contentX: 100,
    contentY: 50,
    contentW: 800,
    contentH: 400,
  };
  const identity: ZoomState = { cx: 0.5, cy: 0.5, scale: 1 };

  test("identity: content-rect corners map to capture (0,0) and (1,1)", () => {
    const tl = canvasToCapture(100, 50, layout, identity);
    expect(tl).not.toBeNull();
    expect(tl!.nx).toBeCloseTo(0);
    expect(tl!.ny).toBeCloseTo(0);
    const br = canvasToCapture(900, 450, layout, identity);
    expect(br!.nx).toBeCloseTo(1);
    expect(br!.ny).toBeCloseTo(1);
  });

  test("identity: content-rect center maps to capture (0.5, 0.5)", () => {
    const c = canvasToCapture(500, 250, layout, identity);
    expect(c!.nx).toBeCloseTo(0.5);
    expect(c!.ny).toBeCloseTo(0.5);
  });

  test("click in the padding / letterbox band returns null", () => {
    expect(canvasToCapture(50, 250, layout, identity)).toBeNull(); // left of content
    expect(canvasToCapture(950, 250, layout, identity)).toBeNull(); // right of content
    expect(canvasToCapture(500, 10, layout, identity)).toBeNull(); // above content
    expect(canvasToCapture(500, 490, layout, identity)).toBeNull(); // below content
  });

  test("degenerate layout (zero content size) returns null", () => {
    const zero: OutputLayout = { ...layout, contentW: 0 };
    expect(canvasToCapture(500, 250, zero, identity)).toBeNull();
  });

  test("round-trips the drawCompositeV2 forward cursor mapping", () => {
    // Forward mapping (from drawCompositeV2's cursor path): a capture point maps
    // to an on-screen pixel inside the content rect. Inverting that pixel must
    // recover the original capture point.
    const zoom: ZoomState = { cx: 0.3, cy: 0.7, scale: 2 };
    const capture = { x: 0.35, y: 0.62 };
    const scale = zoom.scale;
    const sampleFracW = 1 / scale;
    const sampleFracH = 1 / scale;
    let sfx = zoom.cx - sampleFracW / 2;
    let sfy = zoom.cy - sampleFracH / 2;
    sfx = Math.max(0, Math.min(sfx, 1 - sampleFracW));
    sfy = Math.max(0, Math.min(sfy, 1 - sampleFracH));
    const u = (capture.x - sfx) / sampleFracW;
    const v = (capture.y - sfy) / sampleFracH;
    const px = layout.contentX + u * layout.contentW;
    const py = layout.contentY + v * layout.contentH;

    const back = canvasToCapture(px, py, layout, zoom);
    expect(back).not.toBeNull();
    expect(back!.nx).toBeCloseTo(capture.x);
    expect(back!.ny).toBeCloseTo(capture.y);
  });

  test("zoomed: content center maps to the (clamped) zoom center", () => {
    // With scale 2 and center (0.3, 0.7), the visible window is clamped so its
    // top-left is at (max(0, 0.3-0.25)=0.05, max(0,0.7-0.25)=0.45). The content
    // rect center (u=v=0.5) therefore maps to (0.05+0.25, 0.45+0.25) = (0.3, 0.7).
    const zoom: ZoomState = { cx: 0.3, cy: 0.7, scale: 2 };
    const c = canvasToCapture(500, 250, layout, zoom);
    expect(c!.nx).toBeCloseTo(0.3);
    expect(c!.ny).toBeCloseTo(0.7);
  });
});

describe("webcamRect", () => {
  const OUT_W = 1920;
  const OUT_H = 1080;
  const MARGIN = 24;

  test("size math: width = sizeFrac * outW; circle is square", () => {
    const r = webcamRect(OUT_W, OUT_H, "br", 0.2, "circle");
    expect(r.w).toBeCloseTo(0.2 * OUT_W); // 384
    expect(r.h).toBeCloseTo(r.w); // square for circle
  });

  test("rounded uses 4:3 aspect (h = w * 3/4)", () => {
    const r = webcamRect(OUT_W, OUT_H, "br", 0.2, "rounded");
    expect(r.w).toBeCloseTo(0.2 * OUT_W); // 384
    expect(r.h).toBeCloseTo(r.w * 0.75); // 288
  });

  test("bottom-right corner honors 24px margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "br", 0.2, "circle");
    expect(r.x + r.w).toBeCloseTo(OUT_W - MARGIN);
    expect(r.y + r.h).toBeCloseTo(OUT_H - MARGIN);
  });

  test("bottom-left corner honors margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "bl", 0.2, "circle");
    expect(r.x).toBeCloseTo(MARGIN);
    expect(r.y + r.h).toBeCloseTo(OUT_H - MARGIN);
  });

  test("top-right corner honors margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "tr", 0.2, "circle");
    expect(r.x + r.w).toBeCloseTo(OUT_W - MARGIN);
    expect(r.y).toBeCloseTo(MARGIN);
  });

  test("top-left corner honors margin", () => {
    const r = webcamRect(OUT_W, OUT_H, "tl", 0.2, "circle");
    expect(r.x).toBeCloseTo(MARGIN);
    expect(r.y).toBeCloseTo(MARGIN);
  });

  test("larger sizeFrac yields a larger rect", () => {
    const small = webcamRect(OUT_W, OUT_H, "br", 0.15, "circle");
    const big = webcamRect(OUT_W, OUT_H, "br", 0.35, "circle");
    expect(big.w).toBeGreaterThan(small.w);
    // both remain margin-anchored at the corner
    expect(big.x + big.w).toBeCloseTo(OUT_W - MARGIN);
    expect(small.x + small.w).toBeCloseTo(OUT_W - MARGIN);
  });

  test("PIN (ratified M2.1 behavior): auto-mode bubble is sized + anchored against the FULL canvas, padding included", () => {
    // This pins the deliberate M2.1 decision — the webcam PiP is a CANVAS-level
    // overlay (Screen-Studio-style): `sizeFrac` is a fraction of the output
    // canvas width (the M2 data contract's "fraction of output width"), and the
    // 24px margin anchors to the canvas edge, not the content rect. In "auto"
    // the canvas is frame + 2*padding, so vs. M2's content-anchored placement
    // the bubble is larger (sizeFrac × 2112, not × 1920) and sits in the
    // padding gutter. Intentional; no webcam projects predate M2.1 (webcam
    // capture was broken until M2.1 Task 1). If this test breaks, someone
    // changed ratified render output — do not "fix" the numbers casually.
    const L = outputLayout(1920, 1080, 96, "auto");
    expect(L.outW).toBe(2112); // 1920 + 2*96
    expect(L.outH).toBe(1272); // 1080 + 2*96

    const r = webcamRect(L.outW, L.outH, "br", 0.25, "circle");
    expect(r.w).toBe(528); // 0.25 * 2112 (canvas width, NOT 0.25*1920 = 480)
    expect(r.h).toBe(528); // circle → square
    expect(r.x).toBe(1560); // 2112 - 24 - 528 (flush to CANVAS right edge)
    expect(r.y).toBe(720); // 1272 - 24 - 528 (flush to CANVAS bottom edge)
    // The bubble overhangs the content rect (frame at 96..2016 × 96..1176)
    // into the padding gutter: it ends 24px from the canvas edge, inside the
    // 96px padding band — impossible under M2's content-anchored placement.
    expect(r.x + r.w).toBeGreaterThan(L.contentX + L.contentW);
    expect(r.y + r.h).toBeGreaterThan(L.contentY + L.contentH);
  });
});

describe("coverCrop", () => {
  test("wide source into a square dst crops the sides, keeps full height", () => {
    // 1280×720 (16:9) into a 1:1 mask → sample a centered 720×720 square.
    const c = coverCrop(1280, 720, 200, 200);
    expect(c.sh).toBeCloseTo(720); // full height sampled
    expect(c.sw).toBeCloseTo(720); // square crop
    expect(c.sx).toBeCloseTo((1280 - 720) / 2); // centered horizontally
    expect(c.sy).toBeCloseTo(0);
  });

  test("wide source into a 4:3 dst crops the sides", () => {
    // 1280×720 (16:9) into 4:3 → sample full height, width = 720 * 4/3 = 960.
    const c = coverCrop(1280, 720, 400, 300);
    expect(c.sh).toBeCloseTo(720);
    expect(c.sw).toBeCloseTo(960);
    expect(c.sx).toBeCloseTo((1280 - 960) / 2); // 160
    expect(c.sy).toBeCloseTo(0);
  });

  test("tall source into a square dst crops top/bottom, keeps full width", () => {
    // 480×640 (3:4 portrait) into 1:1 → sample a centered 480×480 square.
    const c = coverCrop(480, 640, 200, 200);
    expect(c.sw).toBeCloseTo(480); // full width sampled
    expect(c.sh).toBeCloseTo(480); // square crop
    expect(c.sx).toBeCloseTo(0);
    expect(c.sy).toBeCloseTo((640 - 480) / 2); // centered vertically
  });

  test("matching aspect samples the whole source (no crop)", () => {
    const c = coverCrop(640, 480, 400, 300); // both 4:3
    expect(c.sx).toBeCloseTo(0);
    expect(c.sy).toBeCloseTo(0);
    expect(c.sw).toBeCloseTo(640);
    expect(c.sh).toBeCloseTo(480);
  });

  test("the crop rect stays within the source bounds", () => {
    for (const [sw, sh] of [[1920, 1080], [720, 1280], [1000, 1000]] as const) {
      for (const [dw, dh] of [[200, 200], [400, 300], [100, 400]] as const) {
        const c = coverCrop(sw, sh, dw, dh);
        expect(c.sx).toBeGreaterThanOrEqual(-1e-6);
        expect(c.sy).toBeGreaterThanOrEqual(-1e-6);
        expect(c.sx + c.sw).toBeLessThanOrEqual(sw + 1e-6);
        expect(c.sy + c.sh).toBeLessThanOrEqual(sh + 1e-6);
        // Cropped rect must carry the destination's aspect ratio.
        expect(c.sw / c.sh).toBeCloseTo(dw / dh);
      }
    }
  });

  test("degenerate dimensions fall back to the full source rect", () => {
    expect(coverCrop(0, 100, 10, 10)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 100 });
    expect(coverCrop(100, 100, 0, 10)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100 });
  });
});

describe("imgWidth / imgHeight", () => {
  // Regression for M2 Task 8 finding 1: WebCodecs `VideoFrame` (what the
  // export path's WebcamSource feeds into the webcam-draw code) exposes
  // `displayWidth`/`displayHeight` (and `codedWidth`/`codedHeight`), NOT
  // `videoWidth`/`width` like an HTMLVideoElement or HTMLImageElement. If
  // imgWidth/imgHeight don't check those fields, they return 0 for a
  // VideoFrame, and the webcam PiP silently falls back to a stretched draw
  // instead of the intended cover-crop.

  test("HTMLVideoElement shape (videoWidth/videoHeight) is read", () => {
    const shim = { videoWidth: 1280, videoHeight: 720 } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(1280);
    expect(imgHeight(shim)).toBe(720);
  });

  test("VideoFrame shape (displayWidth/displayHeight only) is read — the export path", () => {
    // A minimal shim mirroring exactly what a decoded WebCodecs VideoFrame
    // exposes for sizing: no videoWidth/width, only display*/coded*.
    const shim = {
      displayWidth: 1920,
      displayHeight: 1080,
      codedWidth: 1920,
      codedHeight: 1080,
    } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(1920);
    expect(imgHeight(shim)).toBe(1080);
  });

  test("VideoFrame shape falls back to codedWidth/codedHeight when display* is absent", () => {
    const shim = { codedWidth: 640, codedHeight: 480 } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(640);
    expect(imgHeight(shim)).toBe(480);
  });

  test("HTMLImageElement/ImageBitmap shape (width/height) is read", () => {
    const shim = { width: 300, height: 150 } as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(300);
    expect(imgHeight(shim)).toBe(150);
  });

  test("unknown shape returns 0 for both", () => {
    const shim = {} as unknown as CanvasImageSource;
    expect(imgWidth(shim)).toBe(0);
    expect(imgHeight(shim)).toBe(0);
  });

  test("behavioral: a VideoFrame-shaped webcam source drives coverCrop (aspect-fill), not a stretch fallback", () => {
    // This mirrors the real decision in drawCompositeV2: `iw > 0 && ih > 0`
    // picks coverCrop; otherwise it falls back to a plain stretch. Before the
    // fix, a VideoFrame-shaped source (display*/coded* only, no
    // videoWidth/width) measured 0×0 here and would have taken the stretch
    // branch — this asserts it now takes the crop branch, with correct math.
    const webcamFrame = {
      displayWidth: 1280,
      displayHeight: 720,
      codedWidth: 1280,
      codedHeight: 720,
    } as unknown as CanvasImageSource;

    const iw = imgWidth(webcamFrame);
    const ih = imgHeight(webcamFrame);
    expect(iw).toBeGreaterThan(0);
    expect(ih).toBeGreaterThan(0);

    // Destination is a circular PiP rect (square, e.g. 200x200) — same as the
    // "circle" shape branch in drawCompositeV2.
    const dstW = 200;
    const dstH = 200;
    const usesCoverCrop = iw > 0 && ih > 0;
    expect(usesCoverCrop).toBe(true);

    const c = coverCrop(iw, ih, dstW, dstH);
    // 16:9 source into a 1:1 dest crops the sides, keeping full height, and
    // the sampled rect must carry the destination's aspect ratio (i.e. NOT a
    // stretch of the full untouched 1280x720 source into 200x200).
    expect(c.sh).toBeCloseTo(720);
    expect(c.sw).toBeCloseTo(720);
    expect(c.sw / c.sh).toBeCloseTo(dstW / dstH);
  });
});

describe("cursorStateAt", () => {
  // A capture rect at global origin (100, 200), 800×600 points. Normalization
  // is (px - 100)/800, (py - 200)/600. So point (500, 500) → (0.5, 0.5).
  const header: EventsHeader = {
    k: "header",
    v: 1,
    capture: { kind: "display", rect: [100, 200, 800, 600], px_scale: 2 },
    screen_h: 900,
  };
  // Two move samples 1s apart: at t=1000 the cursor is at the rect center;
  // at t=2000 it's at the bottom-right quadrant point (700, 500) → (0.75, 0.5).
  const moves: CursorSample[] = [
    { t: 1000, x: 500, y: 500 }, // → (0.5, 0.5)
    { t: 2000, x: 700, y: 500 }, // → (0.75, 0.5)
  ];

  test("exact sample hit returns that sample normalized", () => {
    const s = cursorStateAt(1000, moves, [], header);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.5);
    expect(s!.y).toBeCloseTo(0.5);
    expect(s!.clickAge).toBeNull();
  });

  test("midpoint lerps between the two surrounding samples", () => {
    // Halfway (t=1500) between (0.5,0.5) and (0.75,0.5) → (0.625, 0.5).
    const s = cursorStateAt(1500, moves, [], header);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.625);
    expect(s!.y).toBeCloseTo(0.5);
  });

  test("before first sample holds the first when within 2000ms", () => {
    const s = cursorStateAt(500, moves, [], header); // 500ms before first
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.5);
    expect(s!.y).toBeCloseTo(0.5);
  });

  test("after last sample holds the last when within 2000ms", () => {
    const s = cursorStateAt(3500, moves, [], header); // 1500ms after last
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.75);
    expect(s!.y).toBeCloseTo(0.5);
  });

  test("before first beyond 2000ms → null (cursor hidden)", () => {
    // First sample is at t=1000; query well before it with no sample within 2s.
    expect(cursorStateAt(-1500, moves, [], header)).toBeNull();
  });

  test("after last beyond 2000ms → null", () => {
    expect(cursorStateAt(4500, moves, [], header)).toBeNull(); // 2500ms after last
  });

  test("gap between surrounding samples > 2000ms → null", () => {
    // Two samples 3s apart: any query landing between them straddles a
    // >2000ms gap, so the cursor is hidden regardless of nearness to a side.
    const sparse: CursorSample[] = [
      { t: 0, x: 500, y: 500 },
      { t: 3000, x: 700, y: 500 },
    ];
    expect(cursorStateAt(1000, sparse, [], header)).toBeNull(); // in a 3s gap
    expect(cursorStateAt(1500, sparse, [], header)).toBeNull();
    // Exact hits on the bracketing samples still resolve (no interpolation gap).
    expect(cursorStateAt(0, sparse, [], header)).not.toBeNull();
    expect(cursorStateAt(3000, sparse, [], header)).not.toBeNull();
  });

  test("interpolation across a gap ≤ 2000ms resolves", () => {
    // A 2000ms gap is exactly at the limit (not > 2000ms), so it interpolates.
    const ok: CursorSample[] = [
      { t: 0, x: 500, y: 500 },
      { t: 2000, x: 700, y: 500 },
    ];
    const s = cursorStateAt(1000, ok, [], header);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(0.625); // midpoint of 0.5..0.75
  });

  test("empty moves → null", () => {
    expect(cursorStateAt(1000, [], [], header)).toBeNull();
  });

  test("clickAge is set when a down is within the ripple window", () => {
    const downs: CursorSample[] = [{ t: 1200, x: 500, y: 500 }];
    const s = cursorStateAt(1500, moves, downs, header); // 300ms after the down
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeCloseTo(300);
  });

  test("clickAge is null when the most recent down is older than 400ms", () => {
    const downs: CursorSample[] = [{ t: 1000, x: 500, y: 500 }];
    const s = cursorStateAt(1500, moves, downs, header); // 500ms after → outside window
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeNull();
  });

  test("clickAge ignores downs that occur after tMs", () => {
    const downs: CursorSample[] = [{ t: 1800, x: 700, y: 500 }]; // after t=1500
    const s = cursorStateAt(1500, moves, downs, header);
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeNull();
  });

  test("clickAge uses the most recent down at or before tMs", () => {
    const downs: CursorSample[] = [
      { t: 900, x: 500, y: 500 },
      { t: 1450, x: 600, y: 500 }, // most recent ≤ 1500
      { t: 1900, x: 700, y: 500 }, // after tMs, ignored
    ];
    const s = cursorStateAt(1500, moves, downs, header); // 50ms after t=1450
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeCloseTo(50);
  });

  test("clickAge exactly at the down (age 0) is inside the window", () => {
    const downs: CursorSample[] = [{ t: 1500, x: 500, y: 500 }];
    const s = cursorStateAt(1500, moves, downs, header);
    expect(s).not.toBeNull();
    expect(s!.clickAge).toBeCloseTo(0);
  });
});

describe("cursorDrawScale", () => {
  test("scales linearly with user scale and px_scale", () => {
    const base = cursorDrawScale(1, 1);
    expect(cursorDrawScale(2, 1)).toBeCloseTo(base * 2);
    expect(cursorDrawScale(1, 2)).toBeCloseTo(base * 2); // Retina capture
    expect(cursorDrawScale(3, 2)).toBeCloseTo(base * 6);
  });

  test("invalid inputs fall back to 1", () => {
    const base = cursorDrawScale(1, 1);
    expect(cursorDrawScale(0, 1)).toBeCloseTo(base);
    expect(cursorDrawScale(NaN, 1)).toBeCloseTo(base);
    expect(cursorDrawScale(1, 0)).toBeCloseTo(base);
    expect(cursorDrawScale(1, NaN)).toBeCloseTo(base);
  });
});

describe("keystrokeBadgeAt", () => {
  const keyEv = (t: number, code: number, mods: string[]): RecEvent => ({
    t,
    k: "key",
    code,
    mods,
  });

  test("no key events -> null", () => {
    expect(keystrokeBadgeAt(1000, [], { allKeys: false })).toBeNull();
  });

  test("modifier combo within the 800ms window renders the badge", () => {
    // cmd+S at t=1000, code 0x01 = "S".
    const events = [keyEv(1000, 0x01, ["cmd"])];
    const badge = keystrokeBadgeAt(1200, events, { allKeys: false });
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("⌘S");
  });

  test("exactly at the 800ms edge still qualifies (tMs - t <= 800)", () => {
    const events = [keyEv(1000, 0x01, ["cmd"])];
    const badge = keystrokeBadgeAt(1800, events, { allKeys: false });
    expect(badge).not.toBeNull();
  });

  test("just past the 800ms window is excluded", () => {
    const events = [keyEv(1000, 0x01, ["cmd"])];
    const badge = keystrokeBadgeAt(1801, events, { allKeys: false });
    expect(badge).toBeNull();
  });

  test("future events (t > tMs) are never considered", () => {
    const events = [keyEv(2000, 0x01, ["cmd"])];
    expect(keystrokeBadgeAt(1000, events, { allKeys: false })).toBeNull();
  });

  test("latest qualifying event wins when multiple are in the window", () => {
    const events = [keyEv(1000, 0x01, ["cmd"]), keyEv(1200, 0x02, ["cmd"])]; // cmd+S then cmd+D
    const badge = keystrokeBadgeAt(1400, events, { allKeys: false });
    expect(badge!.label).toBe("⌘D");
  });

  // ---- Privacy filter (non-negotiable default) ---------------------------
  // Default (allKeys: false) renders ONLY modifier combos: at least one of
  // cmd/ctrl/alt/fn must be present. Plain typing (no mods, or shift-only —
  // which is just capitalized plain text) must render nothing.

  test("plain key with no mods at all is excluded by default", () => {
    const events = [keyEv(1000, 0x00, [])]; // bare "A"
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).toBeNull();
  });

  test("shift-only is excluded by default (capitalized typing, not a combo)", () => {
    const events = [keyEv(1000, 0x00, ["shift"])]; // Shift+A = "A" typed
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).toBeNull();
  });

  test("cmd qualifies by default", () => {
    const events = [keyEv(1000, 0x00, ["cmd"])];
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).not.toBeNull();
  });

  test("ctrl qualifies by default", () => {
    const events = [keyEv(1000, 0x00, ["ctrl"])];
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).not.toBeNull();
  });

  test("alt qualifies by default", () => {
    const events = [keyEv(1000, 0x00, ["alt"])];
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).not.toBeNull();
  });

  test("fn qualifies by default", () => {
    const events = [keyEv(1000, 0x00, ["fn"])];
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).not.toBeNull();
  });

  test("shift+cmd qualifies by default (cmd present, not shift-only)", () => {
    const events = [keyEv(1000, 0x00, ["shift", "cmd"])];
    const badge = keystrokeBadgeAt(1200, events, { allKeys: false });
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("⇧⌘A");
  });

  test("latest-wins skips a later DISqualifying event and falls back to an earlier qualifying one within the window", () => {
    // cmd+S at t=1000 (qualifies), then bare "A" (no mods) at t=1300 (doesn't).
    // Per spec, latest QUALIFYING event wins — the plain keystroke at 1300
    // must not surface (privacy) and must not blank out the still-live badge.
    const events = [keyEv(1000, 0x01, ["cmd"]), keyEv(1300, 0x00, [])];
    const badge = keystrokeBadgeAt(1400, events, { allKeys: false });
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("⌘S");
  });

  // ---- allKeys: true (opt-in "show all keys") -----------------------------

  test("allKeys true renders plain typing with no mods", () => {
    const events = [keyEv(1000, 0x00, [])];
    const badge = keystrokeBadgeAt(1200, events, { allKeys: true });
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe("A");
  });

  test("allKeys true still renders modifier combos", () => {
    const events = [keyEv(1000, 0x01, ["cmd"])];
    const badge = keystrokeBadgeAt(1200, events, { allKeys: true });
    expect(badge!.label).toBe("⌘S");
  });

  // ---- Unknown keycode handling -------------------------------------------

  test("unknown keycode is skipped entirely (falls back to an earlier qualifying event)", () => {
    const events = [keyEv(1000, 0x01, ["cmd"]), keyEv(1200, 9999, ["cmd"])];
    const badge = keystrokeBadgeAt(1400, events, { allKeys: false });
    expect(badge!.label).toBe("⌘S");
  });

  test("unknown keycode with no earlier qualifying event -> null", () => {
    const events = [keyEv(1000, 9999, ["cmd"])];
    expect(keystrokeBadgeAt(1200, events, { allKeys: false })).toBeNull();
  });

  test("non-key events in the array are ignored", () => {
    const events: RecEvent[] = [
      { t: 1000, k: "move", x: 10, y: 10 },
      keyEv(1100, 0x01, ["cmd"]),
    ];
    const badge = keystrokeBadgeAt(1200, events, { allKeys: false });
    expect(badge!.label).toBe("⌘S");
  });

  test("consecutive identical labels within the window stay the same badge (stable, no flicker)", () => {
    // Two cmd+S events close together: the label at any query time in-window
    // is identical either way (latest-wins naturally satisfies "same label").
    const events = [keyEv(1000, 0x01, ["cmd"]), keyEv(1100, 0x01, ["cmd"])];
    const badge = keystrokeBadgeAt(1150, events, { allKeys: false });
    expect(badge!.label).toBe("⌘S");
  });
});

describe("captionAt", () => {
  const seg = (startMs: number, endMs: number, text: string): CaptionSegment => ({
    startMs,
    endMs,
    text,
  });

  test("no segments -> null", () => {
    expect(captionAt(1000, [])).toBeNull();
  });

  test("time inside a segment returns its text", () => {
    const segments = [seg(1000, 2000, "hello world")];
    expect(captionAt(1500, segments)).toBe("hello world");
  });

  test("time before the first segment -> null", () => {
    const segments = [seg(1000, 2000, "hello world")];
    expect(captionAt(500, segments)).toBeNull();
  });

  test("time after the last segment -> null", () => {
    const segments = [seg(1000, 2000, "hello world")];
    expect(captionAt(2500, segments)).toBeNull();
  });

  test("exactly at startMs is inside (half-open [start, end))", () => {
    const segments = [seg(1000, 2000, "hello world")];
    expect(captionAt(1000, segments)).toBe("hello world");
  });

  test("exactly at endMs is outside (half-open [start, end))", () => {
    const segments = [seg(1000, 2000, "hello world")];
    expect(captionAt(2000, segments)).toBeNull();
  });

  test("gap between two segments -> null", () => {
    const segments = [seg(0, 1000, "first"), seg(2000, 3000, "second")];
    expect(captionAt(1500, segments)).toBeNull();
  });

  test("finds the correct segment among many (binary search correctness)", () => {
    const segments = [
      seg(0, 1000, "a"),
      seg(1000, 2000, "b"),
      seg(2000, 3000, "c"),
      seg(3000, 4000, "d"),
      seg(4000, 5000, "e"),
    ];
    expect(captionAt(500, segments)).toBe("a");
    expect(captionAt(1000, segments)).toBe("b");
    expect(captionAt(1999, segments)).toBe("b");
    expect(captionAt(3500, segments)).toBe("d");
    expect(captionAt(4999, segments)).toBe("e");
    expect(captionAt(5000, segments)).toBeNull();
  });

  test("single-element list", () => {
    const segments = [seg(100, 200, "only")];
    expect(captionAt(150, segments)).toBe("only");
    expect(captionAt(50, segments)).toBeNull();
    expect(captionAt(250, segments)).toBeNull();
  });

  test("touching segments (startMs === prev.endMs) resolve to the later one at the boundary", () => {
    const segments = [seg(0, 1000, "first"), seg(1000, 2000, "second")];
    expect(captionAt(999, segments)).toBe("first");
    expect(captionAt(1000, segments)).toBe("second");
  });
});

describe("keystroke badge offset when captions are active", () => {
  // The keystroke badge draws bottom-center of the content rect. When captions
  // are enabled AND a caption is showing, the badge must shift up by one
  // "strip height" so the two never collide. `keystrokeBottomMargin` is the
  // shared layout helper both the badge draw and any caller use to compute
  // that offset; `CAPTION_STRIP_HEIGHT_FRAC` is the shared constant driving it.
  test("CAPTION_STRIP_HEIGHT_FRAC is a small positive fraction of content height", () => {
    expect(CAPTION_STRIP_HEIGHT_FRAC).toBeGreaterThan(0);
    expect(CAPTION_STRIP_HEIGHT_FRAC).toBeLessThan(0.3);
  });

  test("keystrokeBottomMargin is larger when a caption is showing than when it isn't", () => {
    const dh = 1000;
    const withoutCaption = keystrokeBottomMargin(dh, false);
    const withCaption = keystrokeBottomMargin(dh, true);
    expect(withCaption).toBeGreaterThan(withoutCaption);
  });

  test("keystrokeBottomMargin offset scales with content height", () => {
    const small = keystrokeBottomMargin(200, true) - keystrokeBottomMargin(200, false);
    const large = keystrokeBottomMargin(2000, true) - keystrokeBottomMargin(2000, false);
    expect(large).toBeGreaterThan(small);
  });

  test("keystrokeBottomMargin is deterministic and pure", () => {
    expect(keystrokeBottomMargin(1000, true)).toBe(keystrokeBottomMargin(1000, true));
    expect(keystrokeBottomMargin(1000, false)).toBe(keystrokeBottomMargin(1000, false));
  });
});
