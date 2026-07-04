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
        // AppKit global coords anchor at the PRIMARY screen's bottom-left (+y up);
        // CG/SCDisplay/SCWindow frames anchor at the primary's top-left (+y down).
        // `primaryHeight - appKitY` is the canonical AppKit→CG global conversion and
        // is valid for points on ANY display, not just the primary — both spaces
        // mirror around the primary screen's top edge. screens.first is the primary
        // (origin (0,0) in AppKit space) by AppKit contract.
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
            // Main-thread only: NSEvent global monitor callbacks arrive on the main thread; lastMoveAt has a single writer.
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
            // If the first video frame never arrived, drainPending() never stamped
            // any pending events and the file below is header-only. Report zero
            // counts in that case so they agree with the (empty) file content —
            // the file is the source of truth, not the raw record() tally.
            let reportedEvents = firstFramePTS == nil ? 0 : nEvents
            let reportedClicks = firstFramePTS == nil ? 0 : nClicks
            let text = lines.joined(separator: "\n") + "\n"
            do {
                try text.write(to: outURL, atomically: true, encoding: .utf8)
                result = (outURL.path, reportedEvents, reportedClicks)
            } catch {
                emit(["event": "warn", "kind": "events_write", "msg": error.localizedDescription])
                result = (nil, reportedEvents, reportedClicks)
            }
        }
        return result
    }
}
