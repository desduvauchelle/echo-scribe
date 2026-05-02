import AVFoundation
import Foundation
import os

enum MicRecorderError: Error {
    case microphoneAccessDenied
    case engineStartFailed(Error)
    case noActiveRecording
}

final class MicRecorder {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "MicRecorder")
    private let engine = AVAudioEngine()
    private var outputFile: AVAudioFile?
    private var currentURL: URL?
    private let scratchDir: URL

    init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        scratchDir = appSupport.appendingPathComponent("EchoScribe/scratch/audio")
        try? FileManager.default.createDirectory(at: scratchDir, withIntermediateDirectories: true)
    }

    /// Request microphone permission if not already granted.
    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    /// Start recording. Returns an error if access is denied or engine fails.
    func start() async throws -> URL {
        let granted = await requestPermission()
        guard granted else { throw MicRecorderError.microphoneAccessDenied }

        let filename = "\(UUID().uuidString).wav"
        let outputURL = scratchDir.appendingPathComponent(filename)
        currentURL = outputURL

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        // Downsample to 16 kHz mono for speech recognition
        let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

        outputFile = try AVAudioFile(forWriting: outputURL, settings: targetFormat.settings)

        // Install a tap that converts from the engine's native format to 16 kHz mono
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let outputFile = self.outputFile else { return }
            // Convert buffer to target format
            guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else { return }
            let ratio = targetFormat.sampleRate / inputFormat.sampleRate
            let frameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
            guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCount) else { return }
            var error: NSError?
            converter.convert(to: convertedBuffer, error: &error, withInputFrom: { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            })
            if error == nil {
                try? outputFile.write(from: convertedBuffer)
            }
        }

        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            throw MicRecorderError.engineStartFailed(error)
        }

        // Auto-stop after 60 seconds (hard cap)
        Task {
            try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
            if engine.isRunning {
                logger.warning("Auto-stopping recording after 60s hard cap")
                _ = try? stop()
            }
        }

        logger.info("Recording started: \(outputURL.lastPathComponent)")
        return outputURL
    }

    /// Stop recording and return the URL of the audio file.
    func stop() throws -> URL {
        guard let url = currentURL else { throw MicRecorderError.noActiveRecording }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        outputFile = nil
        currentURL = nil
        logger.info("Recording stopped: \(url.lastPathComponent)")
        return url
    }
}
