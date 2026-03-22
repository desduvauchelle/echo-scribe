import Foundation
@preconcurrency import WhisperKit
import AVFoundation

enum WhisperModelVariant: String, CaseIterable, Identifiable {
    case tiny = "openai_whisper-tiny"
    case base = "openai_whisper-base"
    case small = "openai_whisper-small"
    case medium = "openai_whisper-medium"
    case largeTurbo = "openai_whisper-large-v3-v20240930_turbo"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .tiny: return "Tiny"
        case .base: return "Base"
        case .small: return "Small"
        case .medium: return "Medium"
        case .largeTurbo: return "Large v3 Turbo"
        }
    }

    var sizeDescription: String {
        switch self {
        case .tiny: return "Fastest, least accurate (~75 MB)"
        case .base: return "Fast, basic accuracy (~140 MB)"
        case .small: return "Balanced speed and accuracy (~460 MB)"
        case .medium: return "High accuracy, slower (~1.5 GB)"
        case .largeTurbo: return "Best accuracy, optimized speed (~3 GB)"
        }
    }

    var accuracyScore: Double {
        switch self {
        case .tiny: return 0.3
        case .base: return 0.45
        case .small: return 0.65
        case .medium: return 0.85
        case .largeTurbo: return 1.0
        }
    }

    var speedScore: Double {
        switch self {
        case .tiny: return 1.0
        case .base: return 0.85
        case .small: return 0.65
        case .medium: return 0.4
        case .largeTurbo: return 0.55
        }
    }

    var downloadSizeMB: Int {
        switch self {
        case .tiny: return 75
        case .base: return 140
        case .small: return 460
        case .medium: return 1500
        case .largeTurbo: return 3000
        }
    }

    var formattedSize: String {
        if downloadSizeMB >= 1000 {
            return String(format: "%.1f GB", Double(downloadSizeMB) / 1000.0)
        }
        return "\(downloadSizeMB) MB"
    }

    var normalizedSize: Double {
        Double(downloadSizeMB) / 3000.0
    }
}

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

enum WhisperVariantDownloadState: Equatable {
    case notDownloaded
    case downloading(progress: Double)
    case downloaded
    case error(String)
}

@MainActor
@Observable
final class WhisperSpeechService: SpeechServiceProtocol {
    private(set) var isRecording = false
    var modelState: WhisperModelState = .notDownloaded
    var selectedModel: String = "openai_whisper-large-v3-v20240930_turbo"
    var variantStates: [WhisperModelVariant: WhisperVariantDownloadState] = [:]

    private var whisperKit: WhisperKit?
    private let audioCaptureManager = AudioCaptureManager()

    var audioDeviceManager: AudioDeviceManager? {
        didSet { audioCaptureManager.audioDeviceManager = audioDeviceManager }
    }
    private var audioBuffers: [AVAudioPCMBuffer] = []
    private let bufferLock = NSLock()
    private var continuation: AsyncStream<TranscriptionUpdate>.Continuation?
    private var audioLevelContinuation: AsyncStream<Float>.Continuation?
    private var finalTranscript = ""
    private var transcriptionTimer: Task<Void, Never>?

    var isModelLoaded: Bool {
        whisperKit != nil
    }

    init() {
        scanDownloadedModels()
    }

    // MARK: - Model Management

    static func whisperKitModelBasePath() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            .appendingPathComponent("huggingface/models/argmaxinc/whisperkit-coreml")
    }

    func scanDownloadedModels() {
        let basePath = Self.whisperKitModelBasePath()
        for variant in WhisperModelVariant.allCases {
            // Preserve downloading/error states
            if case .downloading = variantStates[variant] { continue }

            let modelDir = basePath.appendingPathComponent(variant.rawValue)
            let configFile = modelDir.appendingPathComponent("config.json")
            if FileManager.default.fileExists(atPath: configFile.path) {
                variantStates[variant] = .downloaded
            } else {
                variantStates[variant] = .notDownloaded
            }
        }
    }

    func downloadVariant(_ variant: WhisperModelVariant) async throws {
        variantStates[variant] = .downloading(progress: 0)

        do {
            // Use WhisperKit to download the model (it caches locally)
            let _ = try await WhisperKit(
                model: variant.rawValue,
                verbose: false,
                logLevel: .none,
                prewarm: false,
                load: false
            )
            variantStates[variant] = .downloaded
        } catch {
            variantStates[variant] = .error(error.localizedDescription)
            throw error
        }
    }

    func deleteVariant(_ variant: WhisperModelVariant) {
        guard variant.rawValue != selectedModel else { return }

        let modelDir = Self.whisperKitModelBasePath().appendingPathComponent(variant.rawValue)
        try? FileManager.default.removeItem(at: modelDir)
        variantStates[variant] = .notDownloaded
    }

    func activateVariant(_ variant: WhisperModelVariant) async throws {
        selectedModel = variant.rawValue
        whisperKit = nil
        modelState = .notDownloaded

        // If not downloaded yet, download first
        if variantStates[variant] != .downloaded {
            try await downloadVariant(variant)
        }

        // Now load into memory
        try await downloadModel()
    }

    func switchModel(to variant: WhisperModelVariant) {
        guard variant.rawValue != selectedModel else { return }
        selectedModel = variant.rawValue
        whisperKit = nil
        modelState = .notDownloaded
    }

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
            // Mark variant as downloaded too
            if let variant = WhisperModelVariant(rawValue: selectedModel) {
                variantStates[variant] = .downloaded
            }
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

        bufferLock.withLock { audioBuffers.removeAll() }
        finalTranscript = ""

        try audioCaptureManager.startCapture(
            audioLevelCallback: { [weak self] level in
                self?.audioLevelContinuation?.yield(level)
            },
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
        audioLevelContinuation?.finish()
        audioLevelContinuation = nil

        return finalTranscript
    }

    func transcriptionUpdates() -> AsyncStream<TranscriptionUpdate> {
        AsyncStream { continuation in
            self.continuation = continuation
        }
    }

    func audioLevelUpdates() -> AsyncStream<Float> {
        AsyncStream { continuation in
            self.audioLevelContinuation = continuation
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
