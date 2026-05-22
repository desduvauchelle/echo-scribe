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

// --- arg parsing: `record --out <path>` ---
var outPath: String?
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        if args[i] == "--out", i + 1 < args.count { outPath = args[i + 1]; i += 1 }
        i += 1
    }
}
guard let outArg = outPath else { emitFatal("args", "missing --out <path>") }
let outURL = URL(fileURLWithPath: outArg)
try? FileManager.default.removeItem(at: outURL)

@available(macOS 14.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream!
    let outURL: URL
    var writer: AVAssetWriter!
    var videoInput: AVAssetWriterInput!
    var audioInput: AVAssetWriterInput!
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
    var firstFailureLogged = false
    // Serializes all access to sessionStarted/startPTS/lastPTS/finished and the
    // sample-buffer appends, which arrive on two separate SCStream queues
    // (screenrec.screen + screenrec.audio). One serial queue removes the
    // torn-CMTime data race and guarantees markAsFinished can't race an append.
    let stateQ = DispatchQueue(label: "screenrec.state")

    init(outURL: URL, width: Int, height: Int) {
        self.outURL = outURL
        self.pxWidth = width
        self.pxHeight = height
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

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 2,
            AVSampleRateKey: 48000,
            AVEncoderBitRateKey: 128000,
        ]
        audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(audioInput) else {
            throw NSError(domain: "screenrec", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "cannot add audio input to writer"])
        }
        writer.add(audioInput)

        guard writer.startWriting() else {
            throw NSError(domain: "screenrec", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: writer.error?.localizedDescription ?? "startWriting failed"])
        }
    }

    func start() throws {
        try setupWriter()
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "screenrec.screen"))
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "screenrec.audio"))
        stream.startCapture { [weak self] err in
            if let err = err { emitFatal("start", err.localizedDescription) }
            emit(["event": "ready"])
            self?.startHeartbeat()
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
            }
            lastPTS = pts
            switch type {
            case .screen:
                if videoInput.isReadyForMoreMediaData {
                    if videoInput.append(sampleBuffer) { vAppended += 1 } else { vFailed += 1; reportAppendFailure("video") }
                }
            case .audio:
                if audioInput.isReadyForMoreMediaData {
                    if audioInput.append(sampleBuffer) { aAppended += 1 } else { aFailed += 1; reportAppendFailure("audio") }
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
            "a_appended": aAppended,
            "a_failed": aFailed,
        ])
        videoInput.markAsFinished()
        audioInput.markAsFinished()
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
            ])
            exit(exitCode)
        }
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

@available(macOS 14.0, *)
@MainActor
func run() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { emitFatal("no_display", "no shareable display") }
        let excluded = content.applications.filter { $0.bundleIdentifier == OWN_BUNDLE_ID }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        // Capture at the display's true pixel resolution, but clamp the long
        // edge so we never exceed the H.264 encoder's maximum frame size. An
        // oversized frame makes AVAssetWriter fail on the first append and
        // produce a 0-byte file (observed on a 5120-wide display where the old
        // `display.width * 2` = 10240 exceeded the encoder limit).
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        var capW = mode?.pixelWidth ?? display.width
        var capH = mode?.pixelHeight ?? display.height
        let maxEdge = 3840
        let longEdge = max(capW, capH)
        if longEdge > maxEdge {
            let scale = Double(maxEdge) / Double(longEdge)
            capW = Int((Double(capW) * scale).rounded())
            capH = Int((Double(capH) * scale).rounded())
        }
        capW -= capW % 2   // H.264 requires even dimensions
        capH -= capH % 2
        cfg.width = capW
        cfg.height = capH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30) // 30 fps
        cfg.queueDepth = 6
        cfg.showsCursor = true

        let rec = Recorder(outURL: outURL, width: cfg.width, height: cfg.height)
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
    RunLoop.main.run()
} else {
    emitFatal("os", "macOS 14 or newer required")
}
