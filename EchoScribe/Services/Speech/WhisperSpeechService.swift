import Foundation
import WhisperKit
import AVFoundation

enum WhisperModelState: Equatable {
    case notDownloaded
    case downloading(progress: Double)
    case ready
    case error(String)

    static func == (lhs: WhisperModelState, rhs: WhisperModelState) -> Bool {
        switch (lhs, rhs) {
        case (.notDownloaded, .notDownloaded): return true
        case (.ready, .ready): return true
        case (.downloading(let a), .downloading(let b)): return a == b
        case (.error(let a), .error(let b)): return a == b
        default: return false
        }
    }
}

@MainActor
@Observable
final class WhisperSpeechService: SpeechServiceProtocol {
    private(set) var isRecording = false
    var modelState: WhisperModelState = .notDownloaded
    var selectedModel: String = "openai_whisper-large-v3-v20240930_turbo"

    private var whisperKit: WhisperKit?
    private let audioCaptureManager = AudioCaptureManager()
    private var audioBuffers: [AVAudioPCMBuffer] = []
    private let bufferLock = NSLock()
    private var continuation: AsyncStream<TranscriptionUpdate>.Continuation?
    private var finalTranscript = ""
    private var transcriptionTimer: Task<Void, Never>?

    var isModelLoaded: Bool {
        whisperKit != nil
    }

    // MARK: - Model Management

    func downloadModel() async throws {
        guard whisperKit == nil else { return }

        modelState = .downloading(progress: 0)

        do {
            let pipe = try await WhisperKit(
                model: selectedModel,
                verbose: false,
                logLevel: .none,
                prewarm: true,
                load: true
            )
            self.whisperKit = pipe
            modelState = .ready
        } catch {
            modelState = .error(error.localizedDescription)
            throw error
        }
    }

    // MARK: - SpeechServiceProtocol

    func startRecording() async throws {
        guard !isRecording else { return }

        if whisperKit == nil {
            do {
                try await downloadModel()
            } catch {
                throw SpeechError.whisperModelNotLoaded
            }
        }

        bufferLock.lock()
        audioBuffers.removeAll()
        bufferLock.unlock()
        finalTranscript = ""

        try audioCaptureManager.startCapture(
            audioLevelCallback: { _ in },
            audioBufferCallback: { [weak self] buffer in
                guard let self else { return }
                self.bufferLock.lock()
                self.audioBuffers.append(buffer)
                self.bufferLock.unlock()
            }
        )

        isRecording = true
        startPeriodicTranscription()
    }

    func stopRecording() async -> String {
        transcriptionTimer?.cancel()
        transcriptionTimer = nil

        audioCaptureManager.stopCapture()
        isRecording = false

        // Final transcription pass on all accumulated audio
        let audioArray = collectAudioSamples()
        if !audioArray.isEmpty {
            if let text = await transcribeAudio(audioArray) {
                finalTranscript = text
            }
        }

        continuation?.yield(TranscriptionUpdate(
            partialText: finalTranscript,
            isFinal: true,
            confidence: 0.9
        ))

        continuation?.finish()
        continuation = nil

        return finalTranscript
    }

    func transcriptionUpdates() -> AsyncStream<TranscriptionUpdate> {
        AsyncStream { continuation in
            self.continuation = continuation
        }
    }

    // MARK: - Private

    private func startPeriodicTranscription() {
        transcriptionTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { break }

                let audioArray = self.collectAudioSamples()
                guard !audioArray.isEmpty else { continue }

                if let text = await self.transcribeAudio(audioArray), !text.isEmpty {
                    self.finalTranscript = text
                    self.continuation?.yield(TranscriptionUpdate(
                        partialText: text,
                        isFinal: false,
                        confidence: 0.9
                    ))
                }
            }
        }
    }

    private func collectAudioSamples() -> [Float] {
        bufferLock.lock()
        let currentBuffers = audioBuffers
        bufferLock.unlock()

        var audioArray: [Float] = []
        for buffer in currentBuffers {
            guard let channelData = buffer.floatChannelData?[0] else { continue }
            let frames = Int(buffer.frameLength)
            audioArray.append(contentsOf: UnsafeBufferPointer(start: channelData, count: frames))
        }
        return audioArray
    }

    nonisolated private func transcribeAudio(_ audioArray: [Float]) async -> String? {
        do {
            let results = try await MainActor.run { self.whisperKit }?.transcribe(audioArray: audioArray)
            let text = results?.first?.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return text
        } catch {
            print("WhisperKit transcription error: \(error)")
            return nil
        }
    }
}
