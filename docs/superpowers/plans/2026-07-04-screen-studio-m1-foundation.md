# Screen Studio Parity — Milestone 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two real defects found in the recording feature audit, then build the foundation every Screen Studio-style effect depends on: input-event metadata capture during recording, an auto-zoom segment generator, and a proven WebCodecs render pipeline that exports a recording with background + animated zoom applied.

**Architecture:** Capture stays in the Swift sidecar (adds NSEvent global monitors writing a platform-neutral `.events.jsonl`); edit/render logic is pure TypeScript in the webview (cross-platform by construction). See `docs/superpowers/specs/2026-07-04-screen-studio-parity-design.md`.

**Tech Stack:** Swift (ScreenCaptureKit sidecar), Rust (Tauri v2 backend, rusqlite), TypeScript/React frontend, `bun test` (bun:test) for TS units, WebCodecs + `mp4box` (demux) + `mp4-muxer` (mux) for the render spike.

## Global Constraints

- Every fallible boundary op logs success AND failure via `tracing` with a `target:` (project CLAUDE.md).
- UI failures show a short friendly message; raw detail goes to the log only.
- Next free DB migration number is **22** (19–21 are taken; check `MIGRATIONS` tail in `src-tauri/src/db/schema.rs` before numbering — concurrent-branch collisions have happened).
- Swift sidecar source changes require rebuilding the committed binary: `bash scripts/build-screenrec.sh` (updates `src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin`) — commit the binary with the source change.
- Rust tests: `cd src-tauri && cargo test --lib`. TS tests: `bun test`. TS typecheck: `bun run build` (tsc).
- No ffmpeg. No new native deps for rendering — WebCodecs only.
- Do not log secrets. Never break the 453 passing Rust tests.
- Work happens on branch `feat/screen-studio-m1`.

---

### Task 1: Release CI builds all three sidecars

The release workflow only rebuilds syscap; screenrec and calmatch ship stale committed binaries and have **no x86_64 binaries at all**, so Intel releases are broken.

**Files:**
- Modify: `.github/workflows/release.yml` (after the "Build syscap sidecar" step, line 52-53)

**Interfaces:**
- Produces: CI steps that run `scripts/build-screenrec.sh` and `scripts/build-calmatch.sh` on both matrix legs, so `bun tauri build` bundles fresh, arch-correct sidecars.

- [ ] **Step 1: Verify both build scripts are arch-aware and runnable locally**

Run: `bash scripts/build-screenrec.sh && bash scripts/build-calmatch.sh`
Expected: both succeed and produce/refresh `src-tauri/binaries/echo-scribe-{screenrec,calmatch}-aarch64-apple-darwin`. Read both scripts; confirm they derive the target triple from `uname -m` (so the same command produces x86_64 binaries on the macos-13 runner). If a script hardcodes aarch64, fix it to mirror `scripts/build-syscap.sh`.

- [ ] **Step 2: Add the CI steps**

In `.github/workflows/release.yml`, replace:

```yaml
      - name: Build syscap sidecar
        run: bash scripts/build-syscap.sh
```

with:

```yaml
      - name: Build syscap sidecar
        run: bash scripts/build-syscap.sh

      - name: Build screenrec sidecar
        run: bash scripts/build-screenrec.sh

      - name: Build calmatch sidecar
        run: bash scripts/build-calmatch.sh
```

- [ ] **Step 3: Validate workflow YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml scripts/build-screenrec.sh scripts/build-calmatch.sh
git commit -m "fix(release): build screenrec + calmatch sidecars in CI for both architectures"
```

---

### Task 2: Surface auto-denoise failures to the user

`spawn_auto_denoise` (`src-tauri/src/commands.rs:3426-3432`) only logs a warning on failure — the user never learns the post-recording audio cleanup failed.

**Files:**
- Modify: `src-tauri/src/commands.rs:3423-3432` (`spawn_auto_denoise`)
- Modify: `src/views/sections/RecordingsView.tsx` (event listener block, ~lines 303-346)

**Interfaces:**
- Consumes: existing `run_denoise(app, id)`, `useToasts()` from `src/components/ToastProvider.tsx` (tones: `"info" | "error" | "success"`).
- Produces: Tauri event `denoise-failed` with payload `{ id: string, message: string }`.

- [ ] **Step 1: Emit a `denoise-failed` event from Rust**

Replace `spawn_auto_denoise` with:

```rust
/// Run denoise as a background task. Full error detail goes to the log;
/// the frontend gets a `denoise-failed` event with a friendly message.
pub(crate) fn spawn_auto_denoise(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_denoise(app.clone(), id.clone()).await {
            tracing::warn!(target: "denoise", recording_id = %id, %e, "auto-denoise after recording stop failed");
            let _ = app.emit(
                "denoise-failed",
                serde_json::json!({
                    "id": id,
                    "message": "Audio cleanup failed — the original recording is untouched. See Settings → Diagnostics → logs for details.",
                }),
            );
        }
    });
}
```

- [ ] **Step 2: Build to verify**

Run: `cd src-tauri && cargo build 2>&1 | tail -3`
Expected: compiles with no new warnings.

- [ ] **Step 3: Show a toast in RecordingsView**

In the existing `useEffect` that registers `listen(...)` handlers (~line 303), add alongside the `denoise-progress` listener (follow the exact unlisten/cleanup pattern already used there):

```tsx
const unlistenDenoiseFailed = listen<{ id: string; message: string }>(
  "denoise-failed",
  (e) => {
    showToast({ tone: "error", message: e.payload.message });
  },
);
```

and include it in the effect's cleanup. Use the component's existing toast access if present; otherwise `const { showToast } = useToasts();` (check `ToastProvider.tsx` for the exact context API — match its real function name and `ToastInput` shape).

- [ ] **Step 4: Typecheck**

Run: `bun run build`
Expected: tsc passes, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src/views/sections/RecordingsView.tsx
git commit -m "fix(screenrec): surface auto-denoise failures with a friendly toast"
```

---

### Task 3: Input-event metadata capture in the Swift sidecar

The foundation for auto-zoom, keystroke overlay, cursor effects. During `record`, capture global mouse/keyboard events and write them as JSONL next to the MP4. Timestamps are ms offsets from the **first appended video frame** so they align with video time exactly.

**Files:**
- Create: `src-tauri/screenrec/InputEvents.swift`
- Modify: `src-tauri/screenrec/Package.swift:11` (`sources: ["main.swift", "InputEvents.swift"]`)
- Modify: `src-tauri/screenrec/main.swift` (arg parsing ~line 329-346; `Recorder.finalize` ~line 657; first-frame append site; `run()` ~line 1025)

**Interfaces:**
- Consumes: `emit(_:)` JSON-to-stderr helper (`main.swift:7`), `Recorder` first-frame PTS `spts` (host-time clock).
- Produces: CLI flag `record ... --events <path>`; JSONL file where line 1 is a header and subsequent lines are events; `stopped` event gains optional fields `"events": <path>`, `"n_events": <int>`, `"n_clicks": <int>`.

**Event schema (v1, platform-neutral — Windows sidecar must emit the same):**

```jsonc
{"k":"header","v":1,"capture":{"kind":"display","rect":[0,0,1728,1117],"px_scale":2.0},"screen_h":1117}
{"t":123,"k":"move","x":512.5,"y":300.2}          // t = ms since first video frame; x/y in GLOBAL points, top-left origin
{"t":150,"k":"down","b":"l","x":512.5,"y":300.2}  // b: l|r|o (left/right/other)
{"t":180,"k":"up","b":"l","x":512.5,"y":300.2}
{"t":200,"k":"scroll","x":512.5,"y":300.2,"dx":0.0,"dy":-3.0}
{"t":250,"k":"key","code":36,"mods":["cmd"]}       // keyDown only; mods subset of cmd|shift|alt|ctrl|fn
```

Coordinate note: AppKit's global coords are bottom-left origin; convert to top-left (`y_topleft = screen_h_points - y_appkit`) before writing, and record `capture.rect` (the captured display's frame or window's frame at start, in points, top-left origin) plus `px_scale` so the editor can map to video pixels.

- [ ] **Step 1: Write `InputEvents.swift`**

```swift
import AppKit
import CoreMedia

/// Records global input events to a JSONL file during capture.
/// Events are buffered and stamped with host-clock time; offsets are
/// resolved against the first video frame's PTS at write time.
final class InputEventRecorder {
    private let outURL: URL
    private var monitors: [Any] = []
    private var lines: [String] = []
    private var pending: [(hostTime: Double, obj: [String: Any])] = []
    private var firstFramePTS: Double? // seconds, host clock
    private let queue = DispatchQueue(label: "input-events")
    private var lastMoveAt: Double = 0
    private(set) var nEvents = 0
    private(set) var nClicks = 0
    private let screenHPoints: Double
    private var keyMonitorActive = false

    init(outURL: URL, captureKind: String, captureRect: CGRect, pxScale: Double) {
        self.outURL = outURL
        self.screenHPoints = Double(NSScreen.screens.first?.frame.height ?? 0)
        let header: [String: Any] = [
            "k": "header", "v": 1,
            "capture": [
                "kind": captureKind,
                "rect": [captureRect.origin.x, captureRect.origin.y, captureRect.width, captureRect.height],
                "px_scale": pxScale,
            ],
            "screen_h": screenHPoints,
        ]
        appendLine(header)
    }

    private func now() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) }

    private func topLeftY(_ appKitY: Double) -> Double { screenHPoints - appKitY }

    private func appendLine(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        lines.append(s)
    }

    /// Called from the video path when the first frame is appended.
    func markFirstFrame(ptsSeconds: Double) {
        queue.async { self.firstFramePTS = ptsSeconds }
    }

    private func record(_ obj: [String: Any], hostTime: Double) {
        queue.async {
            self.nEvents += 1
            if let k = obj["k"] as? String, k == "down" { self.nClicks += 1 }
            self.pending.append((hostTime, obj))
            self.drainPending()
        }
    }

    private func drainPending() {
        guard let t0 = firstFramePTS else { return }
        for (host, var obj) in pending {
            obj["t"] = Int(((host - t0) * 1000.0).rounded())
            appendLine(obj)
        }
        pending.removeAll()
    }

    func start() {
        let mouseMask: NSEvent.EventTypeMask = [
            .mouseMoved, .leftMouseDragged, .rightMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp, .scrollWheel,
        ]
        if let m = NSEvent.addGlobalMonitorForEvents(matching: mouseMask, handler: { [weak self] ev in
            self?.handleMouse(ev)
        }) { monitors.append(m) }
        // Key events require Accessibility trust (inherited from the parent
        // app's grant). If not trusted the monitor never fires — degrade
        // gracefully; keystroke overlay just has no data.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] ev in
            self?.handleKey(ev)
        }) { monitors.append(m); keyMonitorActive = true }
        emit(["event": "diag", "phase": "input_events_started",
              "ax_trusted": AXIsProcessTrusted(), "key_monitor": keyMonitorActive])
    }

    private func handleMouse(_ ev: NSEvent) {
        let host = now()
        let loc = NSEvent.mouseLocation
        let x = Double(loc.x), y = topLeftY(Double(loc.y))
        switch ev.type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
            if host - lastMoveAt < 1.0 / 60.0 { return } // throttle to ~60 Hz
            lastMoveAt = host
            record(["k": "move", "x": x, "y": y], hostTime: host)
        case .leftMouseDown:  record(["k": "down", "b": "l", "x": x, "y": y], hostTime: host)
        case .leftMouseUp:    record(["k": "up", "b": "l", "x": x, "y": y], hostTime: host)
        case .rightMouseDown: record(["k": "down", "b": "r", "x": x, "y": y], hostTime: host)
        case .rightMouseUp:   record(["k": "up", "b": "r", "x": x, "y": y], hostTime: host)
        case .otherMouseDown: record(["k": "down", "b": "o", "x": x, "y": y], hostTime: host)
        case .otherMouseUp:   record(["k": "up", "b": "o", "x": x, "y": y], hostTime: host)
        case .scrollWheel:
            record(["k": "scroll", "x": x, "y": y,
                    "dx": Double(ev.scrollingDeltaX), "dy": Double(ev.scrollingDeltaY)], hostTime: host)
        default: break
        }
    }

    private func handleKey(_ ev: NSEvent) {
        let host = now()
        var mods: [String] = []
        if ev.modifierFlags.contains(.command) { mods.append("cmd") }
        if ev.modifierFlags.contains(.shift) { mods.append("shift") }
        if ev.modifierFlags.contains(.option) { mods.append("alt") }
        if ev.modifierFlags.contains(.control) { mods.append("ctrl") }
        if ev.modifierFlags.contains(.function) { mods.append("fn") }
        record(["k": "key", "code": Int(ev.keyCode), "mods": mods], hostTime: host)
    }

    /// Stop monitors, resolve remaining offsets, write the file.
    /// Returns (path, nEvents, nClicks); nil path on write failure.
    func finish() -> (path: String?, nEvents: Int, nClicks: Int) {
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors.removeAll()
        var result: (String?, Int, Int) = (nil, 0, 0)
        queue.sync {
            drainPending()
            let text = lines.joined(separator: "\n") + "\n"
            do {
                try text.write(to: outURL, atomically: true, encoding: .utf8)
                result = (outURL.path, nEvents, nClicks)
            } catch {
                emit(["event": "warn", "kind": "events_write", "msg": error.localizedDescription])
                result = (nil, nEvents, nClicks)
            }
        }
        return result
    }
}
```

- [ ] **Step 2: Wire into `main.swift`**

1. Arg parsing (near `--out` handling, ~line 329-346): add `--events <path>` → `var argEventsPath: String?`.
2. In `run()` after `capW`/`capH` are known: if `argEventsPath` is set, create `InputEventRecorder(outURL: URL(fileURLWithPath: path), captureKind: argWindowID != nil ? "window" : "display", captureRect: <window.frame or display frame in points, converted to top-left origin>, pxScale: <pxScale used for capture>)`, call `.start()`, and hand it to the `Recorder` (add a `var events: InputEventRecorder?` property on `Recorder`).
3. In the video append path, at the point where the first frame's `spts` is set (search for where `started` flips true / `startSession` is called), call `events?.markFirstFrame(ptsSeconds: CMTimeGetSeconds(spts))`.
4. In `Recorder.finalize` (~line 657), before each `stopped` emit, call `let ev = events?.finish()` and extend BOTH `stopped` payloads (the no-frames one and the normal one) with:

```swift
"events": ev?.path ?? "",
"n_events": ev?.nEvents ?? 0,
"n_clicks": ev?.nClicks ?? 0,
```

5. Update `Package.swift` sources to `["main.swift", "InputEvents.swift"]`.

- [ ] **Step 3: Build the sidecar**

Run: `bash scripts/build-screenrec.sh`
Expected: swift build succeeds, binary copied to `src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin`.

- [ ] **Step 4: Smoke-test a real 5-second recording with events**

```bash
cd /tmp && "$OLDPWD/src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin" \
  record --out /tmp/evtest.mp4 --events /tmp/evtest.events.jsonl --no-sysaudio &
PID=$!; sleep 5; kill -TERM $PID; wait $PID
head -3 /tmp/evtest.events.jsonl
```

Move the mouse during the 5s. Expected: stderr shows `input_events_started` then `stopped` with `"events"`, `"n_events" > 0`; the JSONL starts with a header line and contains `move` events with monotonically increasing non-negative `t`. (If run over SSH without a WindowServer session, note it and verify via the app in Task 7 instead.)

- [ ] **Step 5: Commit (source + rebuilt binary together)**

```bash
git add src-tauri/screenrec/ src-tauri/binaries/echo-scribe-screenrec-aarch64-apple-darwin
git commit -m "feat(screenrec): capture input-event metadata (--events) for post effects"
```

---

### Task 4: Rust plumbing — events path through DB to frontend

**Files:**
- Modify: `src-tauri/src/screenrec/mod.rs` (`start()` ~line 300-383, `parse_stopped` ~line 158-171, `StoppedInfo` struct, tests ~line 425-467)
- Modify: `src-tauri/src/db/schema.rs` (append migration **22**; update the two tests asserting latest version 21)
- Modify: `src-tauri/src/db/recordings.rs` (`RecordingRow`, `insert`, row mapper; tests)
- Modify: `src-tauri/src/commands.rs` (`stop_screen_recording_inner` ~line 3355 builds the row; `delete_recording` also removes the events file)
- Modify: `src/lib/api.ts` (`RecordingRow` type, ~line 1128)

**Interfaces:**
- Consumes: sidecar `stopped` event now carrying optional `events` (string path), `n_events`, `n_clicks` (Task 3).
- Produces: `RecordingRow.events_path: Option<String>` (Rust) / `events_path: string | null` (TS); recordings DB column `events_path TEXT`; sidecar spawned with `--events <recordings_dir>/<id>.events.jsonl`.

- [ ] **Step 1: Write failing tests**

In `src-tauri/src/screenrec/mod.rs` tests, extend the existing `parse_stopped_extracts_fields` pattern:

```rust
#[test]
fn parse_stopped_extracts_events_path() {
    let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":"","events":"/r/a.events.jsonl","n_events":42,"n_clicks":3}"#;
    let info = parse_stopped(line).unwrap();
    assert_eq!(info.events_path.as_deref(), Some("/r/a.events.jsonl"));
}

#[test]
fn parse_stopped_events_optional() {
    let line = r#"{"event":"stopped","path":"/r/a.mp4","dur_ms":5000,"width":100,"height":100,"size":1,"thumb":""}"#;
    let info = parse_stopped(line).unwrap();
    assert_eq!(info.events_path, None);
}
```

In `src-tauri/src/db/recordings.rs` tests, following the existing round-trip pattern (e.g. the denoised-path test):

```rust
#[test]
fn events_path_round_trip() {
    let conn = test_conn();
    let mut r = sample_row("rec-ev");
    r.events_path = Some("/r/rec-ev.events.jsonl".into());
    insert(&conn, &r).unwrap();
    let got = get(&conn, "rec-ev").unwrap().unwrap();
    assert_eq!(got.events_path.as_deref(), Some("/r/rec-ev.events.jsonl"));
}
```

(Adapt helper names to the file's actual test helpers.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib screenrec:: db::recordings:: 2>&1 | tail -5`
Expected: compile errors — `events_path` field doesn't exist.

- [ ] **Step 3: Implement**

1. `schema.rs`: append to `MIGRATIONS`:

```rust
    (
        22,
        r#"
ALTER TABLE recordings ADD COLUMN events_path TEXT;
"#,
    ),
```

Update the tests that assert the latest schema version (currently 21 → 22).
2. `recordings.rs`: add `pub events_path: Option<String>` to `RecordingRow`; add the column to `insert`'s SQL + params and to the SELECT/row-mapping used by `list`/`get`.
3. `screenrec/mod.rs`: add `pub events_path: Option<String>` to the stopped-info struct; parse optional `events` (treat `""` as `None`); in `start()`, always pass `--events <recordings_dir>/<id>.events.jsonl` (derive from the `--out` path: same stem, `.events.jsonl` suffix).
4. `commands.rs`: `stop_screen_recording_inner` sets `events_path: info.events_path.clone()` on the row; `delete_recording` also best-effort-removes the events file (mirror how the thumbnail is removed, log result with `target: "screenrec"`).
5. `api.ts`: add `events_path: string | null;` to `RecordingRow`.

- [ ] **Step 4: Run the full Rust suite + typecheck**

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -3 && cd .. && bun run build`
Expected: all tests pass (453 + new), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ src/lib/api.ts
git commit -m "feat(screenrec): persist input-events path (migration 22) through DB and API"
```

---

### Task 5: Auto-zoom segment generator (pure TS, TDD)

Deterministic Screen Studio-style algorithm: cluster clicks in time+space into zoom blocks with lead-in/hold, clamped viewport centers, merged overlaps.

**Files:**
- Create: `src/lib/autoZoom.ts`
- Test: `tests/autoZoom.test.ts` (bun:test, mirrors `tests/formatTemplates.test.ts` style)

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:

```ts
export type RecEvent =
  | { t: number; k: "move"; x: number; y: number }
  | { t: number; k: "down" | "up"; b: "l" | "r" | "o"; x: number; y: number }
  | { t: number; k: "scroll"; x: number; y: number; dx: number; dy: number }
  | { t: number; k: "key"; code: number; mods: string[] };

export type EventsHeader = {
  k: "header"; v: number;
  capture: { kind: "display" | "window"; rect: [number, number, number, number]; px_scale: number };
  screen_h: number;
};

export type ZoomBlock = {
  startMs: number; endMs: number;
  // zoom center in normalized capture coords (0..1 relative to capture.rect)
  cx: number; cy: number;
  scale: number;           // e.g. 2.0
  mode: "auto";
};

export function parseEventsJsonl(text: string): { header: EventsHeader | null; events: RecEvent[] };
export function generateAutoZoom(
  header: EventsHeader,
  events: RecEvent[],
  durationMs: number,
  opts?: Partial<AutoZoomOptions>,
): ZoomBlock[];

export type AutoZoomOptions = {
  scale: number;          // default 2.0
  leadInMs: number;       // default 800  (zoom starts this long before first click)
  holdMs: number;         // default 1600 (zoom holds this long after last click)
  clusterGapMs: number;   // default 3000 (clicks closer than this join a block)
  clusterDistFrac: number;// default 0.25 (…and within this fraction of capture diagonal)
  minBlockMs: number;     // default 2000
};
```

Algorithm (implement exactly):
1. Take `down` events only (any button). No clicks → return `[]` (Screen Studio's documented behavior).
2. Normalize click coords into capture space: `nx = (x - rect[0]) / rect[2]`, `ny = (y - rect[1]) / rect[3]`; drop clicks outside `[0,1]`.
3. Greedy clustering in event order: a click joins the current cluster iff `t - lastT <= clusterGapMs` AND its distance to the cluster centroid `<= clusterDistFrac` (in normalized units, diagonal = √2 normalized ≈ use straight Euclidean on nx/ny). Otherwise start a new cluster.
4. Per cluster → block: `startMs = max(0, firstT - leadInMs)`, `endMs = min(durationMs, lastT + holdMs)`, extend to `minBlockMs` (centered growth, clamped to [0, durationMs]); center = centroid clamped so the zoom viewport stays inside frame: `cx ∈ [0.5/scale, 1 - 0.5/scale]`, same for `cy`.
5. Merge blocks that overlap or touch after expansion (weighted-by-click-count centroid for the merged center, re-clamped).

- [ ] **Step 1: Write failing tests** (`tests/autoZoom.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { generateAutoZoom, parseEventsJsonl, type EventsHeader, type RecEvent } from "../src/lib/autoZoom";

const header: EventsHeader = {
  k: "header", v: 1,
  capture: { kind: "display", rect: [0, 0, 1000, 1000], px_scale: 2 },
  screen_h: 1000,
};
const click = (t: number, x: number, y: number): RecEvent => ({ t, k: "down", b: "l", x, y });

describe("parseEventsJsonl", () => {
  test("parses header and events, skips blank/garbage lines", () => {
    const text = [
      JSON.stringify(header),
      JSON.stringify(click(100, 10, 10)),
      "",
      "not json",
      JSON.stringify({ t: 200, k: "move", x: 1, y: 2 }),
    ].join("\n");
    const { header: h, events } = parseEventsJsonl(text);
    expect(h?.capture.rect).toEqual([0, 0, 1000, 1000]);
    expect(events.length).toBe(2);
  });
});

describe("generateAutoZoom", () => {
  test("no clicks -> no zoom blocks", () => {
    expect(generateAutoZoom(header, [{ t: 5, k: "move", x: 1, y: 1 }], 10000)).toEqual([]);
  });

  test("single click makes one min-length block with lead-in", () => {
    const blocks = generateAutoZoom(header, [click(5000, 500, 500)], 20000);
    expect(blocks.length).toBe(1);
    const b = blocks[0];
    expect(b.startMs).toBe(4200);            // 5000 - 800 lead-in
    expect(b.endMs).toBe(6600);              // 5000 + 1600 hold
    expect(b.cx).toBeCloseTo(0.5);
    expect(b.cy).toBeCloseTo(0.5);
    expect(b.scale).toBe(2.0);
  });

  test("nearby clicks cluster into one block", () => {
    const blocks = generateAutoZoom(header, [click(1000, 400, 400), click(2500, 450, 420)], 30000);
    expect(blocks.length).toBe(1);
    expect(blocks[0].startMs).toBe(200);     // 1000 - 800
    expect(blocks[0].endMs).toBe(4100);      // 2500 + 1600
  });

  test("distant-in-time clicks make separate blocks", () => {
    const blocks = generateAutoZoom(header, [click(1000, 500, 500), click(10000, 500, 500)], 30000);
    expect(blocks.length).toBe(2);
  });

  test("distant-in-space clicks split even when close in time", () => {
    const blocks = generateAutoZoom(header, [click(1000, 100, 100), click(1500, 900, 900)], 30000);
    expect(blocks.length).toBe(2);
  });

  test("center clamps so viewport stays in frame", () => {
    const blocks = generateAutoZoom(header, [click(5000, 10, 10)], 20000);
    expect(blocks[0].cx).toBeCloseTo(0.25);  // 0.5/scale with scale=2
    expect(blocks[0].cy).toBeCloseTo(0.25);
  });

  test("block end clamps to duration; short block grows to minBlockMs", () => {
    const blocks = generateAutoZoom(header, [click(19900, 500, 500)], 20000);
    expect(blocks[0].endMs).toBe(20000);
    expect(blocks[0].endMs - blocks[0].startMs).toBeGreaterThanOrEqual(2000);
  });

  test("overlapping blocks merge", () => {
    const blocks = generateAutoZoom(
      header,
      [click(1000, 200, 200), click(4200, 800, 800), click(4300, 810, 810)],
      30000,
    );
    // block1 ends 2600, block2 starts 3400 -> no merge; tighten:
    const merged = generateAutoZoom(
      header,
      [click(1000, 200, 200), click(2000, 800, 800), click(2100, 810, 810)],
      30000,
    );
    expect(merged.length).toBe(1);
    expect(blocks.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/autoZoom.test.ts`
Expected: FAIL — module `../src/lib/autoZoom` not found.

- [ ] **Step 3: Implement `src/lib/autoZoom.ts`** per the algorithm spec above. Keep it dependency-free.

- [ ] **Step 4: Run tests until green**

Run: `bun test tests/autoZoom.test.ts`
Expected: all pass. If an expected constant disagrees with the algorithm as written, fix the *implementation* unless the test contradicts the algorithm spec — the spec is the source of truth.

- [ ] **Step 5: Commit**

```bash
git add src/lib/autoZoom.ts tests/autoZoom.test.ts
git commit -m "feat(editor): auto-zoom segment generator from click events (TDD)"
```

---

### Task 6: WebCodecs render pipeline — "Render (beta)" export

The de-risking spike, shipped as a real feature: decode the recording, composite background + padding + rounded corners + animated auto-zoom on canvas, re-encode to MP4. Video-only in M1 (audio passthrough is M2; say so in the UI label).

**Files:**
- Create: `src/lib/render/renderPipeline.ts` (decode→composite→encode orchestration)
- Create: `src/lib/render/compositor.ts` (pure canvas draw: appearance + zoom transform for a frame at time t)
- Modify: `package.json` (add `mp4box`, `mp4-muxer`)
- Modify: `src/views/sections/RecordingsView.tsx` (add "Render (beta)" action + progress)
- Modify: `src-tauri/src/commands.rs` + `src/lib/api.ts` (two small commands: `read_recording_events(id) -> String` returning the JSONL text, and `save_rendered_recording(id, bytes) -> String` writing `<id>.rendered.mp4` into the recordings dir and appending `{"quality":"rendered","path":...,"size":...}` to the row's `exports` JSON via the existing `update_exports`)
- Test: `tests/compositor.test.ts` (pure math only)

**Interfaces:**
- Consumes: `parseEventsJsonl`, `generateAutoZoom`, `ZoomBlock` from Task 5; `RecordingRow.events_path` from Task 4.
- Produces:

```ts
// compositor.ts
export type Appearance = {
  padding: number;        // px in OUTPUT space
  cornerRadius: number;   // px, on the video frame
  background: { type: "solid"; color: string } | { type: "gradient"; from: string; to: string };
};
// Pure: which source rect is visible at time t given zoom blocks (with ease-in-out
// interpolation over `transitionMs` at block edges), in normalized coords.
export function zoomStateAt(tMs: number, blocks: ZoomBlock[], transitionMs?: number): { cx: number; cy: number; scale: number };
export function drawComposite(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource, frameW: number, frameH: number,
  outW: number, outH: number, appearance: Appearance,
  zoom: { cx: number; cy: number; scale: number }): void;

// renderPipeline.ts
export type RenderProgress = { phase: "decode" | "encode" | "mux"; pct: number };
export async function renderRecording(opts: {
  fileUrl: string;            // convertFileSrc URL of the mp4
  eventsJsonl: string | null; // raw text or null -> no zoom
  durationMs: number;
  appearance: Appearance;
  onProgress: (p: RenderProgress) => void;
}): Promise<Uint8Array>;      // finished MP4 bytes
```

Implementation notes for the engineer:
- Demux with `mp4box` (`onSamples` → `EncodedVideoChunk`s), decode with `VideoDecoder`, composite each `VideoFrame` via `drawComposite` onto an `OffscreenCanvas` sized to the source's pixel dims + 2×padding (cap long edge at 3840), encode with `VideoEncoder` (try `avc1.640033` High; if `VideoEncoder.isConfigSupported` rejects H.264, fall back in order to `hvc1`, then `vp09.00.10.08` with webm-muxer — record which codec worked in the task report), mux with `mp4-muxer` at 30fps.
- `zoomStateAt`: identity `{cx:.5, cy:.5, scale:1}` outside blocks; ease-in-out cubic over `transitionMs` (default 500ms) into and out of each block.
- Frame pacing: drive by decoded frame timestamps; drop to ≤30fps if source is higher.
- Backpressure: await `encoder.encodeQueueSize < 8` between frames — do NOT buffer all frames (memory).
- The Tauri `read_recording_events` command must return an error string (not panic) when `events_path` is NULL or the file is gone; the UI then renders without zoom.
- UI: in the RecordingsView detail action row add a "Render (beta)" button — tooltip "Re-renders with background + auto-zoom. No audio yet." — showing `RenderProgress` inline like the existing export flow, error toast on failure (friendly message, detail to console).
- Hardcode M1 appearance defaults: `{ padding: 96, cornerRadius: 16, background: { type: "gradient", from: "#1e3a5f", to: "#0f1b2d" } }`.

- [ ] **Step 1: Write failing tests for the pure parts** (`tests/compositor.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { zoomStateAt } from "../src/lib/render/compositor";
import type { ZoomBlock } from "../src/lib/autoZoom";

const block: ZoomBlock = { startMs: 2000, endMs: 6000, cx: 0.3, cy: 0.7, scale: 2, mode: "auto" };

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
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/compositor.test.ts` → module not found.

- [ ] **Step 3: Add deps** — `bun add mp4box mp4-muxer`

- [ ] **Step 4: Implement** `compositor.ts` (pure math green first: `bun test tests/compositor.test.ts`), then `renderPipeline.ts`, then the two Tauri commands (+ register in `lib.rs` `generate_handler!`, + `api.ts` wrappers), then the UI button.

- [ ] **Step 5: Verify** — `bun test && bun run build && cd src-tauri && cargo test --lib 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/render/ tests/compositor.test.ts package.json bun.lock src/views/sections/RecordingsView.tsx src/lib/api.ts src-tauri/src/
git commit -m "feat(editor): WebCodecs render pipeline — Render (beta) with background + auto-zoom"
```

---

### Task 7: End-to-end verification in the real app

**Files:** none (verification only; fixes go in follow-up commits)

- [ ] **Step 1: Build + install** — `bun tauri build --bundles app`, then the skip-TCC reinstall from CLAUDE.md (no permission-related changes in this milestone; NSEvent global monitors ride on the app's existing Accessibility grant).
- [ ] **Step 2: Record a ~20s screen recording, clicking in 2-3 distinct places.** Verify: recording appears in library; `~/Library/Application Support/EchoScribe/recordings/<id>.events.jsonl` exists with header + events; DB row has `events_path`; `screenrec-last.log` shows `input_events_started`.
- [ ] **Step 3: Click "Render (beta)".** Verify: progress advances, output plays, background + rounded corners visible, zoom animates into the clicked regions and back out.
- [ ] **Step 4: Failure paths.** Delete the events file, render again → renders without zoom (no crash). Check the log for the friendly error trail.
- [ ] **Step 5: Record with the mic on** → confirm auto-denoise still runs (or its failure now shows a toast).

---

## Self-review notes

- Spec coverage: CI fix (T1), denoise surfacing (T2), event capture (T3), persistence (T4), auto-zoom (T5), render proof + user-visible feature (T6), E2E (T7). M1 scope from the design doc is fully covered.
- Type consistency: `events_path` (Rust snake_case / TS snake_case in `RecordingRow` — matches existing convention of raw serde rows), `ZoomBlock` camelCase fields used identically in Tasks 5 and 6. `parseEventsJsonl`/`generateAutoZoom`/`zoomStateAt` names consistent across tasks.
- Known deliberate deferrals: audio passthrough in rendered exports (M2), appearance UI (M2), cursor re-render (M4).
