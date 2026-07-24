import Foundation
import ScreenCaptureKit
import AVFoundation
import Accelerate
import CoreGraphics

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

// --- mode: `--probe` ---
// Non-prompting Screen Recording TCC check for this sidecar process.
if CommandLine.arguments.contains("--probe") {
    exit(CGPreflightScreenCaptureAccess() ? 0 : 1)
}

// --- mode: `--request` ---
// Prompting Screen Recording TCC request for this sidecar process.
if CommandLine.arguments.contains("--request") {
    exit(CGRequestScreenCaptureAccess() ? 0 : 1)
}

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    // Set after init to break the chicken-and-egg with SCStream's delegate parameter.
    var stream: SCStream!
    var converter: AVAudioConverter?
    let outputFormat: AVAudioFormat
    var heartbeatTimer: DispatchSourceTimer?

    // Diagnostic counters (atomic via serial heartbeat queue access)
    var audioBufferCount: Int = 0
    var screenBufferCount: Int = 0
    var otherBufferCount: Int = 0
    var invalidBufferCount: Int = 0
    var missingFormatCount: Int = 0
    var missingPcmBufferCount: Int = 0
    var conversionErrorCount: Int = 0
    var bytesWrittenToStdout: Int = 0
    var loggedFirstAudio = false
    var pcmAllocFailCount: Int = 0
    var cmGetListFailCount: Int = 0
    var memcpyMissingDstCount: Int = 0
    var loggedFirstFailure = false

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
        // Register BOTH audio AND screen outputs. SCStream stalls audio delivery
        // when no consumer drains screen samples — even for audio-only callers —
        // because the stream backpressures on video. Our `didOutputSampleBuffer`
        // already filters with `type == .audio`, so screen frames are ignored.
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "syscap.audio"))
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "syscap.screen"))
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
        var tick: Int = 0
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            tick += 1
            // Always emit a tiny heartbeat each second (so liveness is visible).
            emit(["event": "heartbeat", "ts": Date().timeIntervalSince1970])
            // Emit a full diag snapshot every 30s, OR immediately if any error
            // counter is non-zero (so failures surface within ~1s of starting).
            let hasError = self.invalidBufferCount > 0
                || self.missingFormatCount > 0
                || self.missingPcmBufferCount > 0
                || self.conversionErrorCount > 0
            if tick % 30 == 0 || hasError {
                emit([
                    "event": "diag",
                    "audio_cb": self.audioBufferCount,
                    "screen_cb": self.screenBufferCount,
                    "other_cb": self.otherBufferCount,
                    "invalid": self.invalidBufferCount,
                    "no_format": self.missingFormatCount,
                    "no_pcm": self.missingPcmBufferCount,
                    "pcm_alloc_fail": self.pcmAllocFailCount,
                    "cm_getlist_fail": self.cmGetListFailCount,
                    "memcpy_no_dst": self.memcpyMissingDstCount,
                    "conv_err": self.conversionErrorCount,
                    "stdout_bytes": self.bytesWrittenToStdout,
                ])
            }
        }
        t.resume()
        heartbeatTimer = t
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Track every callback by type so we can confirm in heartbeats whether
        // SCStream is delivering anything at all.
        switch type {
        case .audio:  audioBufferCount += 1
        case .screen: screenBufferCount += 1; return  // we don't process video
        // macOS 15+ adds .microphone; we don't use it, but enumerate it explicitly
        // so the compiler doesn't warn about exhaustiveness.
        default:      otherBufferCount += 1; return
        }

        if !sampleBuffer.isValid {
            invalidBufferCount += 1
            return
        }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else {
            missingFormatCount += 1
            return
        }

        if !loggedFirstAudio {
            loggedFirstAudio = true
            emit([
                "event": "first_audio",
                "in_rate": asbd.mSampleRate,
                "in_channels": asbd.mChannelsPerFrame,
                "in_format_id": asbd.mFormatID,
                "in_format_flags": asbd.mFormatFlags,
                "in_bits": asbd.mBitsPerChannel,
                "in_bytes_per_frame": asbd.mBytesPerFrame,
                "in_bytes_per_packet": asbd.mBytesPerPacket,
                "in_frames_per_packet": asbd.mFramesPerPacket,
            ])
        }

        var asbdCopy = asbd
        guard let inputFormat = AVAudioFormat(streamDescription: &asbdCopy) else {
            missingPcmBufferCount += 1
            if !loggedFirstFailure {
                loggedFirstFailure = true
                emit(["event": "warn", "msg": "AVAudioFormat(streamDescription:) returned nil"])
            }
            return
        }
        if converter == nil {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
            if converter == nil {
                emit(["event": "warn", "msg": "AVAudioConverter init returned nil"])
            }
        }

        guard let pcmIn = bufferFromCMSampleBuffer(sampleBuffer, format: inputFormat) else {
            missingPcmBufferCount += 1
            return
        }

        let frameCount = AVAudioFrameCount(Double(pcmIn.frameLength) * (TARGET_RATE / inputFormat.sampleRate))
        guard let pcmOut = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCount + 256) else { return }

        var error: NSError?
        var done = false
        let status = converter?.convert(to: pcmOut, error: &error) { _, outStatus in
            if done {
                // .noDataNow (NOT .endOfStream): we have one buffer to give,
                // and more will arrive in future convert() calls. .endOfStream
                // would tell the converter to flush and shut down — after which
                // it refuses subsequent input forever. The input-block enum is
                // AVAudioConverterInputStatus (not the output enum), so the case
                // is spelled .noDataNow rather than .inputRanDry.
                outStatus.pointee = .noDataNow
                return nil
            }
            done = true
            outStatus.pointee = .haveData
            return pcmIn
        }

        guard status == .haveData || status == .inputRanDry else {
            conversionErrorCount += 1
            if let e = error {
                // Log the first 5 conversion errors with detail; don't flood for the rest.
                if conversionErrorCount <= 5 {
                    emit([
                        "event": "warn",
                        "msg": "convert failed",
                        "status_raw": status?.rawValue ?? -1,
                        "ns_error": e.localizedDescription,
                        "ns_code": e.code,
                    ])
                }
            }
            return
        }

        guard let int16Channel = pcmOut.int16ChannelData else { return }
        let bytes = Int(pcmOut.frameLength) * MemoryLayout<Int16>.size
        let data = Data(bytes: int16Channel[0], count: bytes)
        FileHandle.standardOutput.write(data)
        bytesWrittenToStdout += bytes
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "kind": "stream_stopped", "msg": error.localizedDescription])
        exit(2)
    }
}

@available(macOS 13.0, *)
extension Capture {
    func bufferFromCMSampleBuffer(_ sb: CMSampleBuffer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let numSamples = CMSampleBufferGetNumSamples(sb)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(numSamples)) else {
            pcmAllocFailCount += 1
            if !loggedFirstFailure {
                loggedFirstFailure = true
                emit([
                    "event": "warn",
                    "msg": "AVAudioPCMBuffer init returned nil",
                    "num_samples": numSamples,
                    "common_format": format.commonFormat.rawValue,
                    "is_interleaved": format.isInterleaved,
                    "channels": format.channelCount,
                ])
            }
            return nil
        }
        buf.frameLength = AVAudioFrameCount(numSamples)

        // Query the required AudioBufferList size first; for non-interleaved (planar)
        // multi-channel audio, the list is larger than a single AudioBufferList struct,
        // and using the fixed-size variant truncates the channel array — which is the
        // canonical reason this function used to silently fail for SCStream audio.
        var listSize: Int = 0
        var blockBuffer: CMBlockBuffer?
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb,
            bufferListSizeNeededOut: &listSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: nil
        )
        guard status == noErr, listSize > 0 else {
            cmGetListFailCount += 1
            if !loggedFirstFailure {
                loggedFirstFailure = true
                emit([
                    "event": "warn",
                    "msg": "CMSampleBufferGetAudioBufferList (size query) failed",
                    "status": Int(status),
                    "list_size": listSize,
                ])
            }
            return nil
        }

        let listPtr = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { listPtr.deallocate() }
        let abListPtr = listPtr.assumingMemoryBound(to: AudioBufferList.self)

        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb,
            bufferListSizeNeededOut: nil,
            bufferListOut: abListPtr,
            bufferListSize: listSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else {
            cmGetListFailCount += 1
            if !loggedFirstFailure {
                loggedFirstFailure = true
                emit([
                    "event": "warn",
                    "msg": "CMSampleBufferGetAudioBufferList (fill) failed",
                    "status": Int(status),
                ])
            }
            return nil
        }

        // Copy each channel plane into the corresponding plane of the PCM buffer.
        // For non-interleaved Float32 stereo, this means 2 planes of `numSamples`
        // float32s each — the previous implementation copied only the first plane.
        let src = UnsafeMutableAudioBufferListPointer(abListPtr)
        let dst = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList)
        let planes = min(src.count, dst.count)
        for i in 0..<planes {
            if let s = src[i].mData, let d = dst[i].mData {
                let n = min(Int(src[i].mDataByteSize), Int(dst[i].mDataByteSize))
                memcpy(d, s, n)
            } else if dst[i].mData == nil {
                memcpyMissingDstCount += 1
            }
        }
        return buf
    }
}

// --- main ---

// Pinned at module scope so `Capture` (which owns the SCStream delegate role —
// SCStream holds delegates weakly) and the SIGTERM dispatch source survive past
// `run()` returning. Previously `run()` ended with `await withCheckedContinuation { _ in }`,
// which Swift 5.9+ detects as a leaked continuation, tears down the Task, and drops
// the local `cap`/`termSrc` — the stream lost its delegate and never emitted "ready".
@available(macOS 13.0, *)
final class Pinned {
    static let shared = Pinned()
    var capture: Capture?
    var termSource: DispatchSourceSignal?
}

@available(macOS 13.0, *)
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
        Pinned.shared.capture = cap
        try cap.start()

        // Stay alive until SIGTERM.
        signal(SIGTERM, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler {
            emit(["event": "stop_requested"])
            stream.stopCapture { _ in
                emit(["event": "stopped"])
                // Note: do NOT call FileHandle.standardOutput.synchronizeFile() —
                // stdout is a pipe to the parent and fsync on a pipe throws
                // NSFileHandleOperationException ("Operation not supported").
                exit(0)
            }
        }
        termSrc.resume()
        Pinned.shared.termSource = termSrc

        // run() returns here; `Pinned.shared` keeps `cap` and `termSrc` alive,
        // and `RunLoop.main.run()` in the entry point keeps the process running.
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
