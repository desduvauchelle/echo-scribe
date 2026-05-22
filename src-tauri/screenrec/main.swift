import Foundation
import ScreenCaptureKit
import AVFoundation

// echo-scribe-screenrec
// Phase 1: records the primary display + system audio to an MP4 via
// AVAssetWriter, writes a poster-frame thumbnail, and finalizes on SIGTERM.
// Status events go to stderr as line-delimited JSON; stdout is unused.

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

func emitFatal(_ kind: String, _ msg: String) -> Never {
    emit(["event": "error", "kind": kind, "msg": msg])
    exit(1)
}

// --- arg parsing: `record --out <path>` ---
var outPath: String?
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "record": break
        case "--out": i += 1; if i < args.count { outPath = args[i] }
        default: break
        }
        i += 1
    }
}
guard let outPath = outPath else {
    emitFatal("args", "missing --out <path>")
}

// Phase 1 stub: prove lifecycle. Replaced with real capture in Task 2.
emit(["event": "ready", "out": outPath])

signal(SIGTERM, SIG_IGN)
let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSrc.setEventHandler {
    emit(["event": "stopped", "path": outPath, "dur_ms": 0, "width": 0, "height": 0, "size": 0, "thumb": ""])
    exit(0)
}
termSrc.resume()

RunLoop.main.run()
