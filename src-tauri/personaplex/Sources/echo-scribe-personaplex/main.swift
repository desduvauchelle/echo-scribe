import Foundation
import PersonaPlex

let sidecarVersion = "0.1.0"

func usage() -> Never {
    let text = """
    echo-scribe-personaplex \(sidecarVersion) — Tucky beta sidecar for NVIDIA PersonaPlex-7B

    usage:
      echo-scribe-personaplex download --model-dir DIR [--model-id ID]
      echo-scribe-personaplex chat --model-dir DIR [--model-id ID] [--voice NATF2]
                                   [--prompt TEXT] [--no-aec] [--no-warmup] [--max-steps N]
                                   [--input-wav IN --output-wav OUT [--post-steps N]]
                                   [--ignore-stdin]
      echo-scribe-personaplex voices
      echo-scribe-personaplex version

    Events are JSON lines on stdout; logs go to stderr. A chat session stops on
    SIGTERM/SIGINT, on the line "stop" on stdin, or when stdin closes.

    """
    FileHandle.standardError.write(Data(text.utf8))
    exit(64)
}

var argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else { usage() }
argv.removeFirst()

var values: [String: String] = [:]
var flags = Set<String>()
var idx = 0
while idx < argv.count {
    let arg = argv[idx]
    guard arg.hasPrefix("--") else { usage() }
    let key = String(arg.dropFirst(2))
    if idx + 1 < argv.count, !argv[idx + 1].hasPrefix("--") {
        values[key] = argv[idx + 1]
        idx += 2
    } else {
        flags.insert(key)
        idx += 1
    }
}

switch command {
case "version", "--version":
    print("echo-scribe-personaplex \(sidecarVersion)")
    exit(0)
case "voices":
    let list = PersonaPlexVoice.allCases.map { ["id": $0.rawValue, "label": $0.displayName] }
    let data = try! JSONSerialization.data(withJSONObject: list, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
case "download", "chat":
    break
default:
    usage()
}

// From here on stdout carries JSON events only (EventSink re-routes fd 1).
let sink = EventSink.shared
let stop = StopFlag()

guard let modelDirPath = values["model-dir"], !modelDirPath.isEmpty else {
    sink.error("--model-dir is required")
    exit(64)
}
let modelDir = URL(fileURLWithPath: modelDirPath, isDirectory: true)
let modelId = values["model-id"] ?? PersonaPlexModel.modelId8bit

// Signals: turn SIGTERM/SIGINT into a graceful stop so audio engines shut down
// and a final "stopped" event is emitted. SIGPIPE would otherwise kill us if
// Tucky's read end vanished mid-write.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGPIPE, SIG_IGN)
let signalQueue = DispatchQueue(label: "echo-scribe-personaplex.signals")
let signalSources: [DispatchSourceSignal] = [SIGINT, SIGTERM].map { sig in
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler { stop.requestStop("signal") }
    source.resume()
    return source
}

// Parent watchdog: Tucky holds our stdin open for the session's lifetime. EOF
// means it quit or crashed — stop rather than keep the mic + 9 GB of weights.
if !flags.contains("ignore-stdin") {
    let watchdog = Thread {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).lowercased() == "stop" {
                stop.requestStop("stop-command")
                return
            }
        }
        stop.requestStop("stdin-closed")
    }
    watchdog.name = "stdin-watchdog"
    watchdog.start()
}

sink.emit([
    "event": "hello",
    "version": sidecarVersion,
    "command": command,
    "pid": Int(getpid()),
    "model_id": modelId,
    "model_dir": modelDir.path,
])

let exitCode: Int32
switch command {
case "download":
    let task = Task { await DownloadRunner.run(modelId: modelId, modelDir: modelDir) }
    stop.onStop { task.cancel() }
    exitCode = await task.value
case "chat":
    var opts = ChatOptions(modelDir: modelDir)
    opts.modelId = modelId
    if let v = values["voice"] {
        guard let voice = PersonaPlexVoice(rawValue: v) else {
            sink.error("unknown voice \(v); one of \(PersonaPlexVoice.allCases.map(\.rawValue).joined(separator: ", "))")
            exit(64)
        }
        opts.voice = voice
    }
    opts.prompt = values["prompt"]
    opts.aec = !flags.contains("no-aec")
    opts.warmup = !flags.contains("no-warmup")
    if let s = values["max-steps"], let n = Int(s), n > 0 { opts.maxSteps = n }
    if let s = values["post-steps"], let n = Int(s), n >= 0 { opts.postSteps = n }
    if let p = values["input-wav"] { opts.inputWav = URL(fileURLWithPath: p) }
    if let p = values["output-wav"] { opts.outputWav = URL(fileURLWithPath: p) }
    if opts.inputWav != nil && opts.outputWav == nil {
        sink.error("--input-wav requires --output-wav")
        exit(64)
    }
    exitCode = await ChatRunner.run(opts, stop: stop)
default:
    exitCode = 64
}
exit(exitCode)
