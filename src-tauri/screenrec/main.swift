import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import AppKit

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}
func emitFatal(_ kind: String, _ msg: String) -> Never {
    emit(["event": "error", "kind": kind, "msg": msg])
    exit(1)
}

let OWN_BUNDLE_ID = "com.echoscribe.app"

// ScreenCaptureKit window capture — SCContentFilter(desktopIndependentWindow:) —
// requires a WindowServer connection. A bare CLI process has none, so creating
// the window filter asserts CGS_REQUIRE_INIT. Establish the connection with a
// background (accessory) NSApplication; we still drive our own RunLoop below.
// This must run before any SCContentFilter usage, including --list-sources.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// --- window thumbnail helper (used by --list-sources) ---
// Uses ScreenCaptureKit's SCScreenshotManager rather than the deprecated
// CGWindowListCreateImage, which returns blank images for GPU-composited /
// transparent windows (e.g. our own Tauri window). SCK captures correctly.
@available(macOS 14.0, *)
func windowThumbnail(_ window: SCWindow, dir: URL) async -> String {
    let srcW = window.frame.width, srcH = window.frame.height
    guard srcW > 0, srcH > 0 else { return "" }
    let maxW = 320.0
    let scale = min(1.0, maxW / srcW)
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    config.width = max(1, Int(srcW * scale))
    config.height = max(1, Int(srcH * scale))
    config.showsCursor = false
    do {
        let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.5]) else { return "" }
        let url = dir.appendingPathComponent("win-\(window.windowID).jpg")
        try data.write(to: url)
        return url.path
    } catch {
        return ""
    }
}

// --- mode: `--list-sources` ---
if CommandLine.arguments.contains("--list-sources") {
    if #available(macOS 14.0, *) {
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                let displays = content.displays.map { d -> [String: Any] in
                    ["id": d.displayID, "width": d.width, "height": d.height,
                     "label": "Display \(d.displayID) (\(d.width)×\(d.height))"]
                }
                // Build (or recreate fresh) the thumbs directory so stale thumbs don't accumulate.
                let home = FileManager.default.homeDirectoryForCurrentUser
                let thumbsDir = home
                    .appendingPathComponent("Library/Application Support/EchoScribe/recordings/source-thumbs")
                try? FileManager.default.removeItem(at: thumbsDir)
                try? FileManager.default.createDirectory(at: thumbsDir, withIntermediateDirectories: true)
                // System apps whose windows are never useful capture targets.
                let excludedApps: Set<String> = [
                    "Window Server", "Dock", "Notification Center", "Control Center",
                    "Spotlight", "WindowManager", "Wallpaper",
                ]
                var windows: [[String: Any]] = []
                for w in content.windows {
                    guard let title = w.title, !title.isEmpty,
                          let app = w.owningApplication?.applicationName, w.isOnScreen,
                          w.frame.width > 80, w.frame.height > 80,
                          // Normal app windows live on layer 0; menubar, Dock,
                          // notifications, wallpaper, backstop all sit on other layers.
                          w.windowLayer == 0,
                          !excludedApps.contains(app) else { continue }
                    let thumb = await windowThumbnail(w, dir: thumbsDir)
                    windows.append(["id": w.windowID, "app": app, "title": title,
                                    "width": Int(w.frame.width), "height": Int(w.frame.height),
                                    "thumb": thumb])
                }
                let out: [String: Any] = ["displays": displays, "windows": windows]
                let data = try JSONSerialization.data(withJSONObject: out)
                FileHandle.standardOutput.write(data)
                exit(0)
            } catch {
                emitFatal("list_sources", error.localizedDescription)
            }
        }
        RunLoop.main.run()
    } else {
        emitFatal("os", "macOS 14+ required")
    }
}

// --- mode: `--list-cameras` ---
// Enumerate video-capture devices for the webcam picker. Enumeration itself does
// NOT require the Camera TCC grant (that's only needed to actually open a
// device for capture), so this succeeds even before the user has approved the
// prompt. We still degrade cleanly if the discovery API throws.
if CommandLine.arguments.contains("--list-cameras") {
    if #available(macOS 14.0, *) {
        // .builtInWideAngleCamera: 10.15+, .external: 14.0+, .continuityCamera: 14.0+
        // (iPhone-as-webcam). All valid on the macOS 14 floor.
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video,
            position: .unspecified
        )
        var cameras: [[String: Any]] = []
        for d in discovery.devices {
            cameras.append(["uid": d.uniqueID, "name": d.localizedName])
        }
        let out: [String: Any] = ["cameras": cameras]
        guard let data = try? JSONSerialization.data(withJSONObject: out) else {
            emitFatal("list_cameras", "failed to serialize camera list")
        }
        FileHandle.standardOutput.write(data)
        exit(0)
    } else {
        emitFatal("os", "macOS 14+ required")
    }
}

// --- mode: `extract-audio --in <mp4> --out <wav>` ---
func emitError(kind: String, msg: String) {
    emit(["event": "error", "kind": kind, "msg": msg])
}

func extractAudio(inPath: String, outPath: String, rate: Int) {
    let url = URL(fileURLWithPath: inPath)
    let asset = AVAsset(url: url)
    guard let track = asset.tracks(withMediaType: .audio).first else {
        emitError(kind: "no_audio", msg: "recording has no audio track")
        exit(3)
    }

    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) }
    catch { emitError(kind: "reader", msg: "\(error)"); exit(4) }

    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: rate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
        emitError(kind: "reader", msg: "cannot add audio output")
        exit(4)
    }
    reader.add(output)

    var pcm = Data()
    guard reader.startReading() else {
        emitError(kind: "reader", msg: "startReading failed: \(String(describing: reader.error))")
        exit(4)
    }
    while reader.status == .reading {
        guard let sample = output.copyNextSampleBuffer(),
              let block = CMSampleBufferGetDataBuffer(sample) else { continue }
        let length = CMBlockBufferGetDataLength(block)
        var bytes = [UInt8](repeating: 0, count: length)
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes)
        pcm.append(contentsOf: bytes)
        CMSampleBufferInvalidate(sample)
    }
    if reader.status == .failed {
        emitError(kind: "reader", msg: "read failed: \(String(describing: reader.error))")
        exit(4)
    }

    let sampleRate: UInt32 = UInt32(rate)
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
    let blockAlign = channels * (bitsPerSample / 8)
    let dataLen = UInt32(pcm.count)
    var header = Data()
    func append32(_ v: UInt32) { var x = v.littleEndian; header.append(Data(bytes: &x, count: 4)) }
    func append16(_ v: UInt16) { var x = v.littleEndian; header.append(Data(bytes: &x, count: 2)) }
    header.append("RIFF".data(using: .ascii)!)
    append32(36 + dataLen)
    header.append("WAVE".data(using: .ascii)!)
    header.append("fmt ".data(using: .ascii)!)
    append32(16)
    append16(1)
    append16(channels)
    append32(sampleRate)
    append32(byteRate)
    append16(blockAlign)
    append16(bitsPerSample)
    header.append("data".data(using: .ascii)!)
    append32(dataLen)

    var file = header
    file.append(pcm)
    do {
        try file.write(to: URL(fileURLWithPath: outPath))
    } catch {
        emitError(kind: "write", msg: "\(error)")
        exit(5)
    }

    let samples = Int(dataLen) / 2
    emit(["event": "done", "path": outPath, "samples": samples])
    exit(0)
}

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "extract-audio" {
    var inPath: String?
    var outPath: String?
    var rate = 16000
    var i = 2
    let a = CommandLine.arguments
    while i < a.count {
        if a[i] == "--in", i + 1 < a.count { inPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { outPath = a[i + 1]; i += 1 }
        else if a[i] == "--rate", i + 1 < a.count { rate = Int(a[i + 1]) ?? 16000; i += 1 }
        i += 1
    }
    guard let inPath, let outPath else {
        emitError(kind: "args", msg: "extract-audio requires --in and --out")
        exit(2)
    }
    extractAudio(inPath: inPath, outPath: outPath, rate: rate)
}

// --- mode: `mux-audio --video <mp4> --audio <wav> --out <mp4>` ---
func muxAudio(videoPath: String, audioPath: String, outPath: String) {
    let videoAsset = AVAsset(url: URL(fileURLWithPath: videoPath))
    let audioAsset = AVAsset(url: URL(fileURLWithPath: audioPath))
    guard let vTrack = videoAsset.tracks(withMediaType: .video).first else {
        emitError(kind: "no_video", msg: "no video track in source")
        exit(3)
    }
    guard let aTrack = audioAsset.tracks(withMediaType: .audio).first else {
        emitError(kind: "no_audio", msg: "no audio track in cleaned wav")
        exit(3)
    }

    let comp = AVMutableComposition()
    guard let cv = comp.addMutableTrack(withMediaType: .video,
                                        preferredTrackID: kCMPersistentTrackID_Invalid),
          let ca = comp.addMutableTrack(withMediaType: .audio,
                                        preferredTrackID: kCMPersistentTrackID_Invalid) else {
        emitError(kind: "compose", msg: "failed to add composition tracks")
        exit(4)
    }
    let vRange = CMTimeRange(start: .zero, duration: videoAsset.duration)
    do {
        try cv.insertTimeRange(vRange, of: vTrack, at: .zero)
        cv.preferredTransform = vTrack.preferredTransform
        let aDur = min(audioAsset.duration, videoAsset.duration)
        try ca.insertTimeRange(CMTimeRange(start: .zero, duration: aDur), of: aTrack, at: .zero)
    } catch {
        emitError(kind: "compose", msg: "\(error)")
        exit(4)
    }

    try? FileManager.default.removeItem(at: URL(fileURLWithPath: outPath))
    guard let export = AVAssetExportSession(asset: comp,
                                            presetName: AVAssetExportPresetHighestQuality) else {
        emitError(kind: "export", msg: "could not create export session")
        exit(5)
    }
    export.outputURL = URL(fileURLWithPath: outPath)
    export.outputFileType = .mp4
    let sem = DispatchSemaphore(value: 0)
    export.exportAsynchronously { sem.signal() }
    sem.wait()
    if export.status == .completed {
        emit(["event": "done", "path": outPath])
        exit(0)
    } else {
        emitError(kind: "export", msg: "\(String(describing: export.error))")
        exit(5)
    }
}

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "mux-audio" {
    var videoPath: String?
    var audioPath: String?
    var outPath: String?
    let a = CommandLine.arguments
    var i = 2
    while i < a.count {
        if a[i] == "--video", i + 1 < a.count { videoPath = a[i + 1]; i += 1 }
        else if a[i] == "--audio", i + 1 < a.count { audioPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { outPath = a[i + 1]; i += 1 }
        i += 1
    }
    guard let videoPath, let audioPath, let outPath else {
        emitError(kind: "args", msg: "mux-audio requires --video --audio --out")
        exit(2)
    }
    muxAudio(videoPath: videoPath, audioPath: audioPath, outPath: outPath)
}

// --- mode: `export --in <path> --out <path> --quality <1080|720|480>` ---
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "export" {
    var inPath: String?
    var exOutPath: String?
    var quality = "1080"
    let a = CommandLine.arguments
    var i = 2
    while i < a.count {
        if a[i] == "--in", i + 1 < a.count { inPath = a[i + 1]; i += 1 }
        else if a[i] == "--out", i + 1 < a.count { exOutPath = a[i + 1]; i += 1 }
        else if a[i] == "--quality", i + 1 < a.count { quality = a[i + 1]; i += 1 }
        i += 1
    }
    guard let ip = inPath, let op = exOutPath else { emitFatal("args", "export needs --in and --out") }
    let preset: String
    switch quality {
    case "480": preset = AVAssetExportPreset640x480
    case "720": preset = AVAssetExportPreset1280x720
    default:    preset = AVAssetExportPreset1920x1080
    }
    let asset = AVURLAsset(url: URL(fileURLWithPath: ip))
    let outURL = URL(fileURLWithPath: op)
    try? FileManager.default.removeItem(at: outURL)
    guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
        emitFatal("export", "cannot create export session for preset \(preset)")
    }
    session.outputURL = outURL
    session.outputFileType = .mp4
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
    timer.setEventHandler { emit(["event": "progress", "pct": Int(session.progress * 100)]) }
    timer.resume()
    session.exportAsynchronously {
        timer.cancel()
        if session.status == .completed {
            let size = (try? FileManager.default.attributesOfItem(atPath: op)[.size] as? Int) ?? 0
            emit(["event": "done", "path": op, "size": size])
            exit(0)
        } else {
            emit(["event": "error", "kind": "export", "msg": session.error?.localizedDescription ?? "export failed"])
            exit(1)
        }
    }
    RunLoop.main.run()
}

// --- arg parsing: `record --out <path> [--display <id>] [--window <id>] [--no-sysaudio] [--mic <uid>]` ---
var outPath: String?
var argDisplayID: UInt32?
var argWindowID: UInt32?
var argNoSysaudio: Bool = false
var argMicUID: String?
var argEventsPath: String?
var argHideCursor: Bool = false
var argCameraUID: String?
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        if args[i] == "--out", i + 1 < args.count { outPath = args[i + 1]; i += 1 }
        else if args[i] == "--display", i + 1 < args.count { argDisplayID = UInt32(args[i + 1]); i += 1 }
        else if args[i] == "--window", i + 1 < args.count { argWindowID = UInt32(args[i + 1]); i += 1 }
        else if args[i] == "--no-sysaudio" { argNoSysaudio = true }
        else if args[i] == "--mic", i + 1 < args.count { argMicUID = args[i + 1]; i += 1 }
        else if args[i] == "--events", i + 1 < args.count { argEventsPath = args[i + 1]; i += 1 }
        // Hide the system cursor from the capture. Used by the editor's
        // synthetic-cursor feature: the recording is captured cursor-free and a
        // stylized cursor is composited from the input-event track instead.
        else if args[i] == "--hide-cursor" { argHideCursor = true }
        // Record a webcam alongside the main capture to `<out-stem>.webcam.mp4`.
        // Video-only (mic is already in the main mix); failures degrade to a
        // warn event and the recording continues without a webcam file.
        else if args[i] == "--camera", i + 1 < args.count { argCameraUID = args[i + 1]; i += 1 }
        i += 1
    }
}
guard let outArg = outPath else { emitFatal("args", "missing --out <path>") }
let outURL = URL(fileURLWithPath: outArg)
try? FileManager.default.removeItem(at: outURL)

@available(macOS 14.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    var stream: SCStream!
    let outURL: URL
    var writer: AVAssetWriter!
    var videoInput: AVAssetWriterInput!
    var audioInput: AVAssetWriterInput?
    var sessionStarted = false
    var startPTS: CMTime = .zero
    var lastPTS: CMTime = .zero
    let pxWidth: Int
    let pxHeight: Int
    var finished = false
    var vAppended = 0
    var vFailed = 0
    var aAppended = 0
    var aFailed = 0
    // Video frames dropped *before* append to keep the writer alive: incomplete
    // SCStream frames (status != .complete, e.g. window occluded/relayout) and
    // frames whose pixel dimensions don't match the writer config (a mismatched
    // append puts AVAssetWriter into .failed permanently — killing the whole
    // recording). Logged so we can see whether drops correlate with breakage.
    var vSkippedIncomplete = 0
    var vSkippedDims = 0
    var firstSkipDimsLogged = false
    var firstFailureLogged = false
    // Serializes all access to sessionStarted/startPTS/lastPTS/finished and the
    // sample-buffer appends, which arrive on multiple queues:
    // SCStream screen (screenrec.screen), SCStream audio (screenrec.audio), and
    // — when --mic is set — the AVCaptureSession audio output (screenrec.mic).
    // One serial queue removes the torn-CMTime data race, serializes the mixer
    // FIFOs, and guarantees markAsFinished can't race an append.
    let stateQ = DispatchQueue(label: "screenrec.state")

    // --- audio configuration (Phase 2 Task 3) ---
    // sysOn: capture system audio from SCStream.  micOn: capture a microphone.
    //  - sys only  -> append SCStream .audio buffers directly to audioInput
    //  - mic only  -> append converted mic buffers to audioInput
    //  - both      -> mix system + mic FIFOs, append mixed CMSampleBuffers
    //  - neither   -> no audioInput (video only)
    let sysOn: Bool
    let micOn: Bool
    let micUID: String?
    // We add an audio track whenever ANY source is on.
    var wantAudio: Bool { sysOn || micOn }
    // When both sources are on we must software-mix.
    var doMix: Bool { sysOn && micOn }

    // --- mixer state (all guarded by stateQ) ---
    // Common interleaved Float32 / 48 kHz / stereo intermediate format. Both the
    // system and mic streams are converted to this before they are mixed or, in
    // single-source mode, wrapped back into a CMSampleBuffer for the AAC encoder.
    let mixFormat: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 48000,
        channels: 2,
        interleaved: true
    )!
    var sysConverter: AVAudioConverter?
    var micConverter: AVAudioConverter?
    // Interleaved stereo Float32 FIFOs: 2 floats per frame. We pull min(sys,mic)
    // frames once both have data; leftovers stay queued. Small drift is acceptable
    // for v1 (the two clocks are independent and we never resample to re-align).
    var sysFIFO: [Float] = []
    var micFIFO: [Float] = []
    // Running frame counter at 48 kHz used to synthesize a monotonic PTS for the
    // mixed / converted audio buffers, independent of the source PTS clocks.
    var audioSampleCount: Int64 = 0
    var cmFormatDesc: CMAudioFormatDescription?

    // --- mic capture (AVCaptureSession) ---
    var captureSession: AVCaptureSession?

    // --- input-event metadata capture (Task 3) ---
    // Records global mouse/keyboard events to a JSONL sidecar file. Timestamps
    // are ms offsets from the first appended video frame's PTS, so they align
    // with video time exactly. Nil when --events was not passed.
    var events: InputEventRecorder?

    // --- webcam capture (Task 7) ---
    // Records a standalone video-only webcam file alongside the main capture.
    // Its own AVCaptureSession + host-clock offset; nil when --camera was not
    // passed or the device couldn't be opened (degraded gracefully). Runs
    // independently of stateQ so it can never stall the main video/audio path.
    var webcam: WebcamRecorder?

    // Diagnostic counters for the new audio paths.
    var sysFramesIn = 0
    var micFramesIn = 0
    var mixedFramesOut = 0
    var audioConvertErrors = 0
    var cmBuildErrors = 0

    init(outURL: URL, width: Int, height: Int, sysOn: Bool, micOn: Bool, micUID: String?) {
        self.outURL = outURL
        self.pxWidth = width
        self.pxHeight = height
        self.sysOn = sysOn
        self.micOn = micOn
        self.micUID = micUID
        super.init()
    }

    func setupWriter() throws {
        writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: pxWidth,
            AVVideoHeightKey: pxHeight,
        ]
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoInput) else {
            throw NSError(domain: "screenrec", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "cannot add video input to writer"])
        }
        writer.add(videoInput)

        if wantAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 2,
                AVSampleRateKey: 48000,
                AVEncoderBitRateKey: 128000,
            ]
            let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            ai.expectsMediaDataInRealTime = true
            guard writer.canAdd(ai) else {
                throw NSError(domain: "screenrec", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "cannot add audio input to writer"])
            }
            writer.add(ai)
            audioInput = ai
        }

        guard writer.startWriting() else {
            throw NSError(domain: "screenrec", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: writer.error?.localizedDescription ?? "startWriting failed"])
        }
    }

    func start() throws {
        try setupWriter()
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "screenrec.screen"))
        // SCStream only delivers .audio when capturesAudio is true, which we set to
        // sysOn. In mic-only mode there is no SCStream audio output to register.
        if sysOn {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "screenrec.audio"))
        }
        if micOn {
            try setupMicCapture()
        }
        emit(["event": "diag", "phase": "outputs_added"])
        emit(["event": "diag", "phase": "starting_capture"])
        stream.startCapture { [weak self] err in
            if let err = err { emitFatal("start", err.localizedDescription) }
            // Start the mic session only after the SCStream capture is up so the
            // first mixed frames have somewhere to go. Failing to start the session
            // is non-fatal: we still produce video + whatever audio we do have.
            self?.captureSession?.startRunning()
            emit(["event": "ready"])
            self?.startHeartbeat()
        }
    }

    // MARK: - Microphone capture (AVCaptureSession)

    func setupMicCapture() throws {
        guard let uid = micUID else { return }
        // The frontend mic picker sends a cpal device *name*, which maps to
        // AVCaptureDevice.localizedName — match on that first. uniqueID is kept
        // as a secondary match, and the direct initializer as a final fallback.
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        let device = discovery.devices.first(where: { $0.localizedName == uid })
            ?? discovery.devices.first(where: { $0.uniqueID == uid })
            ?? AVCaptureDevice(uniqueID: uid)
            ?? discovery.devices.first
        guard let mic = device else {
            emit(["event": "warn", "msg": "mic device not found", "uid": uid])
            return
        }
        let session = AVCaptureSession()
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: mic)
        } catch {
            emit(["event": "warn", "msg": "mic input init failed", "err": error.localizedDescription])
            return
        }
        guard session.canAddInput(input) else {
            emit(["event": "warn", "msg": "cannot add mic input to session"])
            return
        }
        session.addInput(input)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "screenrec.mic"))
        guard session.canAddOutput(output) else {
            emit(["event": "warn", "msg": "cannot add mic output to session"])
            return
        }
        session.addOutput(output)
        captureSession = session
        emit(["event": "mic_ready", "device": mic.localizedName, "uid": mic.uniqueID])
    }

    // AVCaptureAudioDataOutputSampleBufferDelegate
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sampleBuffer.isValid else { return }
        // Route mic samples into the mixer on the shared state queue.
        stateQ.sync {
            if finished || !sessionStarted { return }
            ingestMicLocked(sampleBuffer)
        }
    }

    func startHeartbeat() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        t.schedule(deadline: .now() + 1, repeating: 1.0)
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            let (started, lpts, spts) = self.stateQ.sync { (self.sessionStarted, self.lastPTS, self.startPTS) }
            let dur = started ? CMTimeGetSeconds(CMTimeSubtract(lpts, spts)) * 1000.0 : 0
            emit(["event": "heartbeat", "ts": Date().timeIntervalSince1970, "dur_ms": Int(dur)])
        }
        t.resume()
        self.heartbeatTimer = t
    }
    var heartbeatTimer: DispatchSourceTimer?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        // All state mutation + the append run on the serial state queue so the
        // two SCStream delivery queues can't race each other or finalize.
        stateQ.sync {
            if finished { return }
            if !sessionStarted {
                // Start the writer session on the first COMPLETE video frame;
                // any audio delivered before that is dropped.
                guard type == .screen, Self.frameIsComplete(sampleBuffer) else { return }
                startPTS = pts
                writer.startSession(atSourceTime: pts)
                sessionStarted = true
                // Anchor input-event timestamps to the first video frame's PTS
                // (same host clock family as the SCStream sample-buffer PTS).
                events?.markFirstFrame(ptsSeconds: CMTimeGetSeconds(pts))
                // Same anchor for the webcam offset: firstMainFrameHostSeconds.
                webcam?.markMainFirstFrame(ptsSeconds: CMTimeGetSeconds(pts))
            }
            lastPTS = pts
            switch type {
            case .screen:
                // Only append COMPLETE frames. SCStream delivers .idle/.blank
                // frames when the window is occluded, minimized, or relaying out;
                // appending one fails and latches the writer to .failed, which
                // kills every subsequent frame. Skipping keeps the writer alive.
                guard Self.frameIsComplete(sampleBuffer) else { vSkippedIncomplete += 1; break }
                // Guard against a dimension change (window resized mid-capture):
                // the writer is fixed at pxWidth×pxHeight, so a differently-sized
                // pixel buffer would also latch .failed. Skip + log the first one.
                if let pb = CMSampleBufferGetImageBuffer(sampleBuffer) {
                    let bw = CVPixelBufferGetWidth(pb), bh = CVPixelBufferGetHeight(pb)
                    if bw != pxWidth || bh != pxHeight {
                        vSkippedDims += 1
                        if !firstSkipDimsLogged {
                            firstSkipDimsLogged = true
                            emit(["event": "warn", "msg": "frame dim mismatch",
                                  "buf_w": bw, "buf_h": bh, "writer_w": pxWidth, "writer_h": pxHeight])
                        }
                        break
                    }
                }
                if videoInput.isReadyForMoreMediaData {
                    if videoInput.append(sampleBuffer) { vAppended += 1 } else { vFailed += 1; reportAppendFailure("video") }
                }
            case .audio:
                guard sysOn else { break }
                if doMix {
                    // Both sources on: convert system audio into the FIFO and let
                    // the mixer drain matched pairs into the AAC track.
                    ingestSystemLocked(sampleBuffer)
                } else {
                    // System-only (original behavior): append SCStream audio directly.
                    if let ai = audioInput, ai.isReadyForMoreMediaData {
                        if ai.append(sampleBuffer) { aAppended += 1 } else { aFailed += 1; reportAppendFailure("audio") }
                    }
                }
            default:
                break
            }
        }
    }

    func reportAppendFailure(_ which: String) {
        guard !firstFailureLogged else { return }
        firstFailureLogged = true
        emit([
            "event": "warn",
            "msg": "append failed",
            "which": which,
            "writer_status": writer.status.rawValue,
            "writer_error": writer.error?.localizedDescription ?? "",
        ])
    }

    static func frameIsComplete(_ sb: CMSampleBuffer) -> Bool {
        guard let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
              let attachments = (attachmentsArray as NSArray).firstObject as? [SCStreamFrameInfo: Any],
              let statusRaw = attachments[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw) else { return false }
        return status == .complete
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "kind": "stream_stopped", "msg": error.localizedDescription])
        finalize(exitCode: 2)
    }

    func finalize(exitCode: Int32) {
        // Claim finalize exactly once on the state queue, so any in-flight
        // appends complete first and none start afterward.
        let proceed: Bool = stateQ.sync {
            if finished { return false }
            finished = true
            return true
        }
        guard proceed else { return }

        // Stop the mic session (outside stateQ — stopRunning blocks until the
        // capture queue drains, and the delegate takes stateQ; calling it inside
        // would deadlock). `finished` is already true so any late mic buffer is
        // dropped at the top of captureOutput.
        captureSession?.stopRunning()

        // Drain any leftover mixed audio so the final partial chunk isn't lost.
        if doMix {
            stateQ.sync { drainMixerLocked(flush: true) }
        }

        // Stop the input-event monitors, resolve pending timestamps, and write
        // the JSONL sidecar. Done once here so both stopped-event paths (the
        // no-frames path and the normal path) can report the same result.
        let ev = events?.finish()

        // Stop the webcam + wait (bounded) for its file to finalize. Done once
        // here so both stopped-event paths report the same webcam/offset. When
        // no webcam was configured this is ("", 0) and both fields are emitted
        // as empty/zero (Rust treats ""→None and omitted→None identically).
        let wc: (path: String, offsetMs: Int) = webcam?.finalize() ?? (path: "", offsetMs: 0)

        let (started, lpts, spts) = stateQ.sync { (sessionStarted, lastPTS, startPTS) }

        // No frames were ever written (e.g. permission denied before first
        // frame): cancel rather than violate startSession-before-finish.
        if !started {
            writer.cancelWriting()
            emit([
                "event": "stopped",
                "path": outURL.path,
                "dur_ms": 0,
                "width": pxWidth,
                "height": pxHeight,
                "size": 0,
                "thumb": "",
                "events": ev?.path ?? "",
                "n_events": ev?.nEvents ?? 0,
                "n_clicks": ev?.nClicks ?? 0,
                "webcam": wc.path,
                "webcam_offset_ms": wc.offsetMs,
            ])
            exit(exitCode)
        }

        let durMs = Int(CMTimeGetSeconds(CMTimeSubtract(lpts, spts)) * 1000.0)
        emit([
            "event": "diag",
            "phase": "pre_finish",
            "writer_status": writer.status.rawValue,
            "writer_error": writer.error?.localizedDescription ?? "",
            "v_appended": vAppended,
            "v_failed": vFailed,
            "v_skipped_incomplete": vSkippedIncomplete,
            "v_skipped_dims": vSkippedDims,
            "a_appended": aAppended,
            "a_failed": aFailed,
            "sys_frames_in": sysFramesIn,
            "mic_frames_in": micFramesIn,
            "mixed_frames_out": mixedFramesOut,
            "audio_conv_err": audioConvertErrors,
            "cm_build_err": cmBuildErrors,
        ])
        videoInput.markAsFinished()
        if wantAudio { audioInput?.markAsFinished() }
        writer.finishWriting { [weak self] in
            guard let self = self else { exit(exitCode) }
            let size: Int = (try? FileManager.default.attributesOfItem(atPath: self.outURL.path)[.size] as? Int) ?? 0
            emit([
                "event": "diag",
                "phase": "post_finish",
                "writer_status": self.writer.status.rawValue,
                "writer_error": self.writer.error?.localizedDescription ?? "",
                "size": size,
                "v_appended": self.vAppended,
                "a_appended": self.aAppended,
            ])
            let thumb = writeThumbnail(for: self.outURL)
            emit([
                "event": "stopped",
                "path": self.outURL.path,
                "dur_ms": durMs,
                "width": self.pxWidth,
                "height": self.pxHeight,
                "size": size,
                "thumb": thumb,
                "events": ev?.path ?? "",
                "n_events": ev?.nEvents ?? 0,
                "n_clicks": ev?.nClicks ?? 0,
                "webcam": wc.path,
                "webcam_offset_ms": wc.offsetMs,
            ])
            exit(exitCode)
        }
    }
}

// MARK: - Audio mixing (Phase 2 Task 3)
//
// Both system audio (SCStream .audio) and microphone audio (AVCaptureSession)
// are converted to a common interleaved Float32 / 48 kHz / stereo format and
// pushed into per-source FIFOs. Whenever both FIFOs hold at least one chunk we
// pull min(sysAvail, micAvail) frames from each, sum sample-by-sample (clamped to
// [-1, 1]), wrap the result in a CMSampleBuffer with a synthetic monotonic PTS,
// and append it to the AAC audioInput.
//
// In single-source mode (mic-only) the same FIFO/CMSampleBuffer machinery is used
// without the summing step, so we get one uniform path for converting raw PCM into
// the encoder's input.
//
// Drift note (v1): the system and mic clocks are independent. We never resample to
// re-align them, so over a long recording the two streams can drift by a few ms.
// This is acceptable for v1; perceptually negligible for meeting/voice content.
@available(macOS 14.0, *)
extension Recorder {
    private static let mixChunkFrames = 1024  // frames per drained chunk
    private static let stereo = 2             // floats per frame (interleaved)

    /// Convert an incoming source CMSampleBuffer into the common mix format and
    /// return interleaved stereo Float32 samples (count = frames * 2).
    /// `cache` is the per-source converter slot so we build each converter once.
    private func convertToMixSamples(_ sb: CMSampleBuffer, converter cache: inout AVAudioConverter?) -> [Float]? {
        guard let formatDesc = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else {
            return nil
        }
        var asbdCopy = asbd
        guard let inputFormat = AVAudioFormat(streamDescription: &asbdCopy) else { return nil }

        if cache == nil {
            cache = AVAudioConverter(from: inputFormat, to: mixFormat)
            // The converter handles sample-rate conversion (e.g. 44.1k mic -> 48k)
            // and channel up/down-mix (mono mic -> stereo) for us.
        }
        guard let converter = cache else { return nil }

        guard let pcmIn = pcmBuffer(from: sb, format: inputFormat) else { return nil }

        // Output capacity: scale by the sample-rate ratio plus slack.
        let ratio = mixFormat.sampleRate / inputFormat.sampleRate
        let outCap = AVAudioFrameCount(Double(pcmIn.frameLength) * ratio) + 1024
        guard let pcmOut = AVAudioPCMBuffer(pcmFormat: mixFormat, frameCapacity: outCap) else { return nil }

        var error: NSError?
        var done = false
        let status = converter.convert(to: pcmOut, error: &error) { _, outStatus in
            if done { outStatus.pointee = .noDataNow; return nil }
            done = true
            outStatus.pointee = .haveData
            return pcmIn
        }
        guard status == .haveData || status == .inputRanDry else {
            audioConvertErrors += 1
            return nil
        }
        let frames = Int(pcmOut.frameLength)
        guard frames > 0, let ch = pcmOut.floatChannelData else { return [] }
        // mixFormat is interleaved stereo, so channel 0 holds all L/R pairs
        // contiguously: [L0, R0, L1, R1, ...].
        let count = frames * Recorder.stereo
        return Array(UnsafeBufferPointer(start: ch[0], count: count))
    }

    /// Build an AVAudioPCMBuffer from a CMSampleBuffer (handles planar + interleaved).
    /// Mirrors the proven syscap implementation.
    private func pcmBuffer(from sb: CMSampleBuffer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let numSamples = CMSampleBufferGetNumSamples(sb)
        guard numSamples > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(numSamples)) else {
            return nil
        }
        buf.frameLength = AVAudioFrameCount(numSamples)

        var listSize: Int = 0
        var blockBuffer: CMBlockBuffer?
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: &listSize, bufferListOut: nil,
            bufferListSize: 0, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard status == noErr, listSize > 0 else { return nil }

        let listPtr = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { listPtr.deallocate() }
        let abListPtr = listPtr.assumingMemoryBound(to: AudioBufferList.self)

        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: nil, bufferListOut: abListPtr,
            bufferListSize: listSize, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer)
        guard status == noErr else { return nil }

        let src = UnsafeMutableAudioBufferListPointer(abListPtr)
        let dst = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList)
        let planes = min(src.count, dst.count)
        for i in 0..<planes {
            if let s = src[i].mData, let d = dst[i].mData {
                let n = min(Int(src[i].mDataByteSize), Int(dst[i].mDataByteSize))
                memcpy(d, s, n)
            }
        }
        return buf
    }

    /// Ingest a system-audio buffer. Must be called on stateQ.
    func ingestSystemLocked(_ sb: CMSampleBuffer) {
        guard let samples = convertToMixSamples(sb, converter: &sysConverter) else { return }
        sysFramesIn += samples.count / Recorder.stereo
        sysFIFO.append(contentsOf: samples)
        drainMixerLocked(flush: false)
    }

    /// Ingest a mic buffer. Must be called on stateQ.
    func ingestMicLocked(_ sb: CMSampleBuffer) {
        guard let samples = convertToMixSamples(sb, converter: &micConverter) else { return }
        micFramesIn += samples.count / Recorder.stereo
        if doMix {
            micFIFO.append(contentsOf: samples)
            drainMixerLocked(flush: false)
        } else {
            // mic-only: no summing; emit directly.
            emitMixedLocked(samples)
        }
    }

    /// Drain matched chunks from the two FIFOs, mixing sample-by-sample.
    /// When `flush` is true, also emit a final partial chunk of whatever overlap
    /// remains. Must be called on stateQ.
    func drainMixerLocked(flush: Bool) {
        guard doMix else { return }
        let stereo = Recorder.stereo
        while true {
            let sysFrames = sysFIFO.count / stereo
            let micFrames = micFIFO.count / stereo
            let avail = min(sysFrames, micFrames)
            if avail == 0 { break }
            if !flush && avail < Recorder.mixChunkFrames { break }
            let take = flush ? avail : min(avail, Recorder.mixChunkFrames)
            let n = take * stereo
            var mixed = [Float](repeating: 0, count: n)
            for i in 0..<n {
                let s = sysFIFO[i] + micFIFO[i]
                mixed[i] = s > 1.0 ? 1.0 : (s < -1.0 ? -1.0 : s)
            }
            sysFIFO.removeFirst(n)
            micFIFO.removeFirst(n)
            emitMixedLocked(mixed)
            if flush { break }  // flush emits exactly one final chunk
        }
    }

    /// Wrap interleaved stereo Float32 samples into a CMSampleBuffer with a
    /// synthetic monotonic PTS and append to the AAC audioInput. Must be on stateQ.
    func emitMixedLocked(_ samples: [Float]) {
        guard !samples.isEmpty, let ai = audioInput else { return }
        let frames = samples.count / Recorder.stereo
        guard frames > 0 else { return }

        guard let sbuf = makeAudioSampleBuffer(samples: samples, frames: frames, startFrame: audioSampleCount) else {
            cmBuildErrors += 1
            return
        }
        audioSampleCount += Int64(frames)
        if ai.isReadyForMoreMediaData {
            if ai.append(sbuf) { aAppended += 1; mixedFramesOut += frames }
            else { aFailed += 1; reportAppendFailure("audio_mix") }
        }
    }

    /// Build a CMSampleBuffer (interleaved Float32, 48 kHz, stereo) for the AAC
    /// encoder. PTS is derived from a running 48 kHz sample count so it advances
    /// monotonically regardless of the source clocks.
    func makeAudioSampleBuffer(samples: [Float], frames: Int, startFrame: Int64) -> CMSampleBuffer? {
        // Reuse one format description across calls.
        if cmFormatDesc == nil {
            var asbd = mixFormat.streamDescription.pointee
            var fd: CMAudioFormatDescription?
            let st = CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault,
                asbd: &asbd,
                layoutSize: 0, layout: nil,
                magicCookieSize: 0, magicCookie: nil,
                extensions: nil,
                formatDescriptionOut: &fd)
            guard st == noErr, let fd = fd else { return nil }
            cmFormatDesc = fd
        }
        guard let formatDesc = cmFormatDesc else { return nil }

        let bytesPerFrame = MemoryLayout<Float>.size * Recorder.stereo  // 8 bytes
        let dataSize = frames * bytesPerFrame

        // Copy the float samples into a CMBlockBuffer.
        var blockBuffer: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: dataSize,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: dataSize,
            flags: 0,
            blockBufferOut: &blockBuffer)
        guard status == kCMBlockBufferNoErr, let block = blockBuffer else { return nil }

        status = samples.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferReplaceDataBytes(
                with: base, blockBuffer: block,
                offsetIntoDestination: 0, dataLength: dataSize)
        }
        guard status == kCMBlockBufferNoErr else { return nil }

        let pts = CMTimeAdd(startPTS, CMTime(value: startFrame, timescale: 48000))
        let duration = CMTime(value: Int64(frames), timescale: 48000)
        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid)

        var sampleBuffer: CMSampleBuffer?
        status = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDesc,
            sampleCount: frames,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: [bytesPerFrame],
            sampleBufferOut: &sampleBuffer)
        guard status == noErr else { return nil }
        return sampleBuffer
    }
}

@available(macOS 14.0, *)
func writeThumbnail(for videoURL: URL) -> String {
    let thumbURL = videoURL.deletingPathExtension().appendingPathExtension("jpg")
    let asset = AVURLAsset(url: videoURL)
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: 640, height: 640)
    let time = CMTime(seconds: 0.5, preferredTimescale: 600)
    guard let cg = try? gen.copyCGImage(at: time, actualTime: nil) else { return "" }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { return "" }
    try? data.write(to: thumbURL)
    return thumbURL.path
}

@available(macOS 14.0, *)
final class Pinned {
    static let shared = Pinned()
    var recorder: Recorder?
    var termSource: DispatchSourceSignal?
}

// Clamp (w, h) so the long edge ≤ 3840, then enforce even dimensions for H.264.
func clampDims(_ w: Int, _ h: Int) -> (Int, Int) {
    var capW = w
    var capH = h
    let maxEdge = 3840
    let longEdge = max(capW, capH)
    if longEdge > maxEdge {
        let scale = Double(maxEdge) / Double(longEdge)
        capW = Int((Double(capW) * scale).rounded())
        capH = Int((Double(capH) * scale).rounded())
    }
    capW -= capW % 2   // H.264 requires even dimensions
    capH -= capH % 2
    return (capW, capH)
}

@available(macOS 14.0, *)
@MainActor
func run() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

        emit([
            "event": "diag", "phase": "record_query",
            "arg_window": argWindowID.map { Int($0) } as Any,
            "arg_display": argDisplayID.map { Int($0) } as Any,
            "no_sysaudio": argNoSysaudio, "mic": argMicUID ?? "",
            "hide_cursor": argHideCursor, "camera": argCameraUID ?? "",
            "n_windows": content.windows.count, "n_displays": content.displays.count,
        ])

        // Audio source selection. sysOn = capture system audio (default on,
        // suppressed by --no-sysaudio). micOn = capture a microphone (--mic <uid>).
        let sysOn = !argNoSysaudio
        let micOn = argMicUID != nil

        let cfg = SCStreamConfiguration()
        // SCStream system-audio capture is enabled iff we actually want system audio.
        cfg.capturesAudio = sysOn
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30) // 30 fps
        cfg.queueDepth = 6
        // Show the system cursor by default; --hide-cursor suppresses it so the
        // editor can composite a synthetic cursor from the input-event track.
        cfg.showsCursor = !argHideCursor
        // Keep delivered frames pinned to cfg.width×cfg.height even if the source
        // window resizes mid-capture, so the fixed-size writer never gets an
        // off-size buffer. The per-frame dimension guard below is the backstop.
        cfg.scalesToFit = true

        let filter: SCContentFilter
        let capW: Int
        let capH: Int
        // Capture geometry in POINTS (top-left origin, global coords) plus the
        // point→pixel scale, recorded in the input-event JSONL header so the
        // editor can map global-point event coords into video pixels.
        var captureRectPoints: CGRect = .zero
        var pxScaleForEvents: Double = 1.0

        if let windowID = argWindowID {
            // Window capture
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                let avail = content.windows.prefix(30).map { w -> [String: Any] in
                    ["id": w.windowID, "app": w.owningApplication?.applicationName ?? "", "title": w.title ?? "", "onScreen": w.isOnScreen]
                }
                emit(["event": "diag", "phase": "no_window_avail", "wanted": Int(windowID), "available": avail])
                emitFatal("no_window", "window \(windowID) not found")
            }
            emit(["event": "diag", "phase": "window_found", "id": Int(windowID), "title": window.title ?? "", "w": Int(window.frame.width), "h": Int(window.frame.height), "onScreen": window.isOnScreen])
            filter = SCContentFilter(desktopIndependentWindow: window)
            // SCWindow.frame is in POINTS but cfg.width/height are PIXELS. On a
            // Retina (2×) display that mismatch makes ScreenCaptureKit downscale
            // the capture to point resolution → half-res, pixelated output. Use
            // the filter's backing-pixel scale to capture at true resolution
            // (mirrors the display path, which already uses pixelWidth).
            let pxScale = CGFloat(filter.pointPixelScale)
            let rect = filter.contentRect
            let (w, h) = clampDims(Int((rect.width * pxScale).rounded()),
                                   Int((rect.height * pxScale).rounded()))
            capW = w; capH = h
            // Use filter.contentRect (NOT window.frame) as the events-header
            // rect: it is the exact rect the capture pixels come from, in the
            // same points/global-top-left space as SCWindow.frame but without
            // window.frame's shadow/content-inset origin+size offsets. Those
            // offsets shift AND resize the frame vs. the captured content, so
            // click normalization (x - rect.x)/rect.w must use contentRect to
            // land the zoom on the clicked region. capW/capH above are derived
            // from this same rect, so the mapping is internally consistent.
            captureRectPoints = rect
            pxScaleForEvents = Double(pxScale)
        } else {
            // Display capture (--display <id> or first display as default)
            let excluded = content.applications.filter { $0.bundleIdentifier == OWN_BUNDLE_ID }
            let display: SCDisplay
            if let displayID = argDisplayID,
               let found = content.displays.first(where: { $0.displayID == displayID }) {
                display = found
            } else if let first = content.displays.first {
                display = first
            } else {
                emitFatal("no_display", "no shareable display")
            }
            filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            // Capture at the display's true pixel resolution, but clamp the long
            // edge so we never exceed the H.264 encoder's maximum frame size. An
            // oversized frame makes AVAssetWriter fail on the first append and
            // produce a 0-byte file (observed on a 5120-wide display where the old
            // `display.width * 2` = 10240 exceeded the encoder limit).
            let mode = CGDisplayCopyDisplayMode(display.displayID)
            let (w, h) = clampDims(mode?.pixelWidth ?? display.width, mode?.pixelHeight ?? display.height)
            capW = w; capH = h
            // SCDisplay.frame is the display's rect in points (top-left origin,
            // global). Derive the point→pixel scale from the native pixel width.
            captureRectPoints = display.frame
            let pointsW = Double(display.width)
            pxScaleForEvents = pointsW > 0 ? Double(mode?.pixelWidth ?? display.width) / pointsW : 1.0
        }

        cfg.width = capW
        cfg.height = capH

        emit(["event": "diag", "phase": "filter_built", "w": capW, "h": capH, "capturesAudio": cfg.capturesAudio])

        let rec = Recorder(outURL: outURL, width: capW, height: capH, sysOn: sysOn, micOn: micOn, micUID: argMicUID)

        // Input-event metadata capture (Task 3). When --events is set, record
        // global mouse/keyboard events to a JSONL sidecar for post effects
        // (auto-zoom, keystroke overlay, cursor effects). Timestamps are anchored
        // to the first video frame's PTS via rec.events?.markFirstFrame(...).
        if let eventsPath = argEventsPath {
            let evRec = InputEventRecorder(
                outURL: URL(fileURLWithPath: eventsPath),
                captureKind: argWindowID != nil ? "window" : "display",
                captureRect: captureRectPoints,
                pxScale: pxScaleForEvents
            )
            evRec.start()
            rec.events = evRec
        }

        // Webcam capture (Task 7). When --camera is set, record a standalone
        // video-only webcam file to `<out-stem>.webcam.mp4`. Started BEFORE the
        // SCStream capture so the webcam is already rolling when the first main
        // frame lands (the offset is computed against that first frame). If the
        // device can't be opened WebcamRecorder returns nil (a warn was already
        // emitted) and we record with no webcam — never failing the recording.
        if let cameraUID = argCameraUID {
            let webcamURL = outURL.deletingPathExtension().appendingPathExtension("webcam.mp4")
            if let wc = WebcamRecorder(webcamURL: webcamURL, uid: cameraUID) {
                wc.start()
                rec.webcam = wc
            }
        }

        let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
        rec.stream = stream
        Pinned.shared.recorder = rec
        try rec.start()

        signal(SIGTERM, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler {
            emit(["event": "stop_requested"])
            stream.stopCapture { _ in
                Pinned.shared.recorder?.finalize(exitCode: 0)
            }
        }
        termSrc.resume()
        Pinned.shared.termSource = termSrc
    } catch {
        emitFatal("setup", error.localizedDescription)
    }
}

if #available(macOS 14.0, *) {
    Task { await run() }
    // Global NSEvent monitors (InputEvents.swift) require AppKit's event loop —
    // a bare RunLoop.main.run() registers the monitors but never delivers events.
    app.run()
} else {
    emitFatal("os", "macOS 14 or newer required")
}
