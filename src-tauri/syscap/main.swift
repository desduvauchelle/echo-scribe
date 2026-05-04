import Foundation
import ScreenCaptureKit
import AVFoundation
import Accelerate

// echo-scribe-syscap
// Reads ScreenCaptureKit audio, downmixes to mono, resamples to 16 kHz Int16,
// writes raw PCM to stdout. Status events go to stderr as line-delimited JSON.

let TARGET_RATE: Double = 16_000
let OWN_BUNDLE_ID = "com.echoscribe.app"

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

func emitFatal(_ kind: String, _ msg: String) -> Never {
    emit(["event": "error", "kind": kind, "msg": msg])
    exit(1)
}

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    // Set after init to break the chicken-and-egg with SCStream's delegate parameter.
    var stream: SCStream!
    var converter: AVAudioConverter?
    let outputFormat: AVAudioFormat
    var heartbeatTimer: DispatchSourceTimer?

    override init() {
        self.outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: TARGET_RATE,
            channels: 1,
            interleaved: true
        )!
        super.init()
    }

    func start() throws {
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "syscap.audio"))
        stream.startCapture { [weak self] err in
            if let err = err {
                emitFatal("start", err.localizedDescription)
            }
            emit(["event": "ready"])
            self?.startHeartbeat()
        }
    }

    func startHeartbeat() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        t.schedule(deadline: .now() + 1, repeating: 1.0)
        t.setEventHandler {
            emit(["event": "heartbeat", "ts": Date().timeIntervalSince1970])
        }
        t.resume()
        heartbeatTimer = t
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return }

        var asbdCopy = asbd
        let inputFormat = AVAudioFormat(streamDescription: &asbdCopy)!
        if converter == nil {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        }

        guard let pcmIn = bufferFromCMSampleBuffer(sampleBuffer, format: inputFormat) else { return }

        let frameCount = AVAudioFrameCount(Double(pcmIn.frameLength) * (TARGET_RATE / inputFormat.sampleRate))
        guard let pcmOut = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCount + 256) else { return }

        var error: NSError?
        var done = false
        let status = converter?.convert(to: pcmOut, error: &error) { _, outStatus in
            if done {
                outStatus.pointee = .endOfStream
                return nil
            }
            done = true
            outStatus.pointee = .haveData
            return pcmIn
        }

        guard status == .haveData || status == .inputRanDry else {
            if let e = error { emit(["event": "warn", "msg": "convert: \(e.localizedDescription)"]) }
            return
        }

        guard let int16Channel = pcmOut.int16ChannelData else { return }
        let bytes = Int(pcmOut.frameLength) * MemoryLayout<Int16>.size
        let data = Data(bytes: int16Channel[0], count: bytes)
        FileHandle.standardOutput.write(data)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "kind": "stream_stopped", "msg": error.localizedDescription])
        exit(2)
    }
}

func bufferFromCMSampleBuffer(_ sb: CMSampleBuffer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let numSamples = CMSampleBufferGetNumSamples(sb)
    guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(numSamples)) else { return nil }
    buf.frameLength = AVAudioFrameCount(numSamples)
    var blockBuffer: CMBlockBuffer?
    var audioBufferList = AudioBufferList()
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sb,
        bufferListSizeNeededOut: nil,
        bufferListOut: &audioBufferList,
        bufferListSize: MemoryLayout<AudioBufferList>.size,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    )
    guard status == noErr else { return nil }
    let abl = UnsafeMutableAudioBufferListPointer(&audioBufferList)
    if let mDataIn = abl[0].mData, let dst = buf.audioBufferList.pointee.mBuffers.mData {
        memcpy(dst, mDataIn, Int(abl[0].mDataByteSize))
    }
    return buf
}

// --- main ---

@MainActor
func run() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            emitFatal("no_display", "no shareable display")
        }
        let excludedApps = content.applications.filter { $0.bundleIdentifier == OWN_BUNDLE_ID }

        let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        // Minimize video work: capture a 2x2 frame at 1 fps. We discard video frames anyway.
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let cap = Capture()
        let stream = SCStream(filter: filter, configuration: cfg, delegate: cap)
        cap.stream = stream
        try cap.start()

        // Stay alive until SIGTERM. Trap it to flush stdout.
        signal(SIGTERM, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler {
            stream.stopCapture { _ in
                FileHandle.standardOutput.synchronizeFile()
                exit(0)
            }
        }
        termSrc.resume()

        // Block forever
        await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
    } catch {
        emitFatal("setup", error.localizedDescription)
    }
}

if #available(macOS 13.0, *) {
    Task { await run() }
    RunLoop.main.run()
} else {
    emitFatal("os", "macOS 13 or newer required")
}
