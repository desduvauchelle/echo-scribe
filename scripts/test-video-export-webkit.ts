// bun scripts/test-video-export-webkit.ts (macOS, swiftc and ffmpeg/ffprobe).
// Exercises the real renderRecording pipeline in the system WKWebView used by
// Tauri. No Tucky instance, user recordings, database, or permissions touched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

if (process.platform !== "darwin") throw new Error("This check requires macOS WKWebView.");
const root = fileURLToPath(new URL("../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "tucky-video-export-"));
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  execFileSync("swiftc", [join(root, "scripts/video-export-webkit.swift"), "-o", join(work, "runner")]);
  // Sparse screen frames exercise CFR gap filling; a 30fps webcam exercises
  // the second decoder, including its shorter stream and offset handling.
  for (const [name, rate, duration] of [["main", 6, 2], ["webcam", 30, 1.5]] as const) {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=${rate}`,
      "-t", String(duration), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(work, `${name}.mp4`)]);
  }
  const entry = join(work, "probe.ts");
  await Bun.write(entry, `
    import { renderRecording } from ${JSON.stringify(resolve(root, "src/lib/render/renderPipeline.ts"))};
    import { defaultProject } from ${JSON.stringify(resolve(root, "src/lib/editorProject.ts"))};
    try {
      for (const scenario of ['mp4', 'trim-speed', 'gif']) {
        const project = defaultProject();
        project.appearance.aspect = '16:9';
        project.appearance.padding = 0;
        project.zoom.mode = 'off';
        project.webcam = { show: true, shape: 'circle', corner: 'br', sizeFrac: 0.2,
          autoShrink: false, mirror: false, scenes: [] };
        if (scenario === 'trim-speed') {
          project.trim = { startMs: 500, endMs: 2000 };
          project.speed = [{ startMs: 500, endMs: 2000, rate: 0.5 }];
        }
        let posterCount = 0;
        let progress;
        const bytes = await renderRecording({ fileUrl: '/main.mp4', webcamUrl: '/webcam.mp4',
          webcamOffsetMs: -100, eventsJsonl: null, durationMs: 2000, project, bgImage: null,
          format: scenario === 'gif' ? 'gif' : 'mp4',
          onPoster: () => posterCount++, onProgress: p => progress = p });
        if (posterCount !== 1 || progress.phase !== 'mux' || progress.pct !== 100)
          throw new Error('Missing poster or export completion: ' + scenario);
        const response = await fetch('/output/' + scenario, { method: 'POST', body: bytes });
        if (!response.ok) throw new Error(await response.text());
      }
      window.webkit.messageHandlers.result.postMessage('RESULT PASS: MP4, trim/speed, webcam, poster, GIF');
    } catch (error) { window.webkit.messageHandlers.result.postMessage('RESULT FAIL: ' + String(error)); }
  `);
  const bundle = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!bundle.success) throw new Error(String(bundle.logs));
  const checked = new Set<string>();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/probe.js") return new Response(bundle.outputs[0], { headers: { "Content-Type": "text/javascript" } });
    if (path === "/main.mp4" || path === "/webcam.mp4") return new Response(Bun.file(join(work, path.slice(1))));
    if (path.startsWith("/output/") && req.method === "POST") {
      try {
        const scenario = path.slice("/output/".length);
        assert(["mp4", "trim-speed", "gif"].includes(scenario));
        const out = join(work, scenario + (scenario === "gif" ? ".gif" : ".mp4"));
        await Bun.write(out, await req.arrayBuffer());
        const { streams: [video] } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
          "-show_entries", "stream=width,height,nb_frames,duration", "-of", "json", out], { encoding: "utf8" }));
        assert.equal(video.width, scenario === "gif" ? 320 : 1920);
        assert.equal(video.height, scenario === "gif" ? 180 : 1080);
        if (scenario !== "gif") {
          // Check every CFR slot survives, including fills and slowed frames.
          assert.equal(Number(video.nb_frames), scenario === "trim-speed" ? 90 : 60);
          assert(Math.abs(Number(video.duration) - (scenario === "trim-speed" ? 3 : 2)) < 0.001);
        } else assert(Number(video.nb_frames) > 1);
        checked.add(scenario);
        return new Response("ok");
      } catch (e) { return new Response(String(e), { status: 500 }); }
    }
    if (path === "/") return new Response('<script type="module" src="/probe.js"></script>', { headers: { "Content-Type": "text/html" } });
    return new Response("not found", { status: 404 });
  }});
  const run = Bun.spawn([join(work, "runner"), `http://127.0.0.1:${server.port}/`], { stdout: "inherit", stderr: "inherit" });
  assert.equal(await run.exited, 0, "Native export failed");
  assert.equal(checked.size, 3);
} finally {
  server?.stop(true);
  rmSync(work, { recursive: true, force: true });
}
