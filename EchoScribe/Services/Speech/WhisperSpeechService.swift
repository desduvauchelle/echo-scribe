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
    private var audioSamples: [Float] = []
    private let bufferLock = NSLock()
    private var continuation: AsyncStream<TranscriptionUpdate>.Continuation?
    private var audioLevelContinuation: AsyncStream<Float>.Continuation?
    private var finalTranscript = ""
    private var accumulatedTranscript = ""
    private var chunkStartIndex = 0
    private var transcriptionTimer: Task<Void, Never>?
    private var modelUnloadTask: Task<Void, Never>?
    private var modelLoadTask: Task<Void, Error>?
    private static let modelIdleTimeout: Duration = .seconds(30)

    /// Maximum chunk duration in seconds, staying within model context window (~30s)
    private let maxChunkDurationSeconds: Double = 25.0

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
        print("[WhisperService] downloadModel() — selectedModel=\(selectedModel)")
        guard whisperKit == nil else {
            print("[WhisperService] downloadModel() — whisperKit already loaded, skipping")
            return
        }

        modelState = .downloading(progress: 0)
        print("[WhisperService] downloadModel() — initialising WhisperKit...")

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
            print("[WhisperService] downloadModel() — WhisperKit ready for model=\(selectedModel)")
            // Mark variant as downloaded too
            if let variant = WhisperModelVariant(rawValue: selectedModel) {
                variantStates[variant] = .downloaded
            }
        } catch {
            modelState = .error(error.localizedDescription)
            print("[WhisperService] downloadModel() ERROR — \(error)")
            throw error
        }
    }

    // MARK: - SpeechServiceProtocol

    func startRecording() async throws {
        modelUnloadTask?.cancel()
        modelUnloadTask = nil
        modelLoadTask?.cancel()
        modelLoadTask = nil
        print("[WhisperService] startRecording() — isRecording=\(isRecording), whisperKitLoaded=\(whisperKit != nil)")
        guard !isRecording else {
            print("[WhisperService] startRecording() blocked — already recording")
            return
        }

        bufferLock.withLock {
            audioSamples.removeAll()
        }
        finalTranscript = ""
        accumulatedTranscript = ""
        chunkStartIndex = 0
        print("[WhisperService] startRecording() — starting audio capture immediately")

        do {
            try audioCaptureManager.startCapture(
                audioLevelCallback: { [weak self] level in
                    self?.audioLevelContinuation?.yield(level)
                },
                audioBufferCallback: { [weak self] samples in
                    guard let self else { return }
                    self.bufferLock.lock()
                    self.audioSamples.append(contentsOf: samples)
                    self.bufferLock.unlock()
                }
            )
        } catch {
            print("[WhisperService] startRecording() — audio capture failed: \(error)")
            throw error
        }

        isRecording = true
        print("[WhisperService] startRecording() — audio capture started, isRecording=true")

        if whisperKit == nil {
            print("[WhisperService] startRecording() — whisperKit is nil, loading model in background...")
            modelLoadTask = Task { [weak self] in
                guard let self else { return }
                try await self.downloadModel()
                guard self.isRecording else { return }
                print("[WhisperService] model loaded while recording — starting periodic transcription")
                self.startPeriodicTranscription()
            }
        } else {
            print("[WhisperService] startRecording() — whisperKit already loaded, starting transcription")
            startPeriodicTranscription()
        }
    }

    func stopRecording() async -> String {
        print("[WhisperService] stopRecording() — stopping capture and running final transcription")
        transcriptionTimer?.cancel()
        transcriptionTimer = nil

        audioCaptureManager.stopCapture()
        isRecording = false

        // Wait for model to finish loading if it's still in progress
        if let loadTask = modelLoadTask {
            print("[WhisperService] stopRecording() — waiting for model to finish loading...")
            do {
                try await loadTask.value
            } catch {
                print("[WhisperService] stopRecording() — model load failed: \(error)")
                modelLoadTask = nil
                bufferLock.withLock { audioSamples.removeAll() }
                continuation?.yield(TranscriptionUpdate(partialText: "", isFinal: true, confidence: 0))
                continuation?.finish()
                continuation = nil
                audioLevelContinuation?.finish()
                audioLevelContinuation = nil
                scheduleModelUnload()
                return accumulatedTranscript
            }
            modelLoadTask = nil
            print("[WhisperService] stopRecording() — model loaded, proceeding with transcription")
        }

        // Final transcription of only the current chunk
        let currentChunkAudio: [Float] = bufferLock.withLock {
            guard chunkStartIndex < audioSamples.count else {
                audioSamples.removeAll()
                return []
            }
            let chunk = Array(audioSamples[chunkStartIndex...])
            audioSamples.removeAll()
            return chunk
        }

        print("[WhisperService] stopRecording() — currentChunk sampleCount=\(currentChunkAudio.count), accumulated=\"\(accumulatedTranscript.prefix(60))\"")

        if !currentChunkAudio.isEmpty {
            if let text = await transcribeAudio(currentChunkAudio) {
                finalTranscript = accumulatedTranscript.isEmpty
                    ? text
                    : accumulatedTranscript + " " + text
                print("[WhisperService] stopRecording() — final transcription: \"\(finalTranscript.prefix(80))\"")
            } else {
                finalTranscript = accumulatedTranscript
                print("[WhisperService] stopRecording() — final transcription returned nil, using accumulated")
            }
        } else {
            finalTranscript = accumulatedTranscript
            print("[WhisperService] stopRecording() — no current chunk samples, using accumulated")
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

        print("[WhisperService] stopRecording() — returning finalTranscript length=\(finalTranscript.count)")
        scheduleModelUnload()
        return finalTranscript
    }

    private func scheduleModelUnload() {
        modelUnloadTask?.cancel()
        modelUnloadTask = Task { [weak self] in
            try? await Task.sleep(for: Self.modelIdleTimeout)
            guard !Task.isCancelled else { return }
            guard let self, !self.isRecording else { return }
            self.whisperKit = nil
            self.modelState = .notDownloaded
            print("[WhisperService] model unloaded after idle timeout")
        }
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
        print("[WhisperService] startPeriodicTranscription() — starting 2s periodic transcription loop")
        transcriptionTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { break }

                let sampleRate = self.audioCaptureManager.inputFormat?.sampleRate ?? 16000
                let maxChunkSamples = Int(self.maxChunkDurationSeconds * sampleRate)

                // Snapshot current chunk under lock
                let (chunkAudio, currentChunkStart): ([Float], Int) = self.bufferLock.withLock {
                    let start = self.chunkStartIndex
                    guard start < self.audioSamples.count else { return ([], start) }
                    let chunk = Array(self.audioSamples[start...])
                    return (chunk, start)
                }

                print("[WhisperService] periodicTranscription tick — chunkSamples=\(chunkAudio.count), accumulated=\"\(self.accumulatedTranscript.prefix(40))\"")
                guard !chunkAudio.isEmpty else { continue }

                // Check if we need to finalize the current chunk (exceeded max duration)
                if chunkAudio.count >= maxChunkSamples {
                    // Finalize: transcribe the full chunk
                    let finalChunkAudio = Array(chunkAudio.prefix(maxChunkSamples))
                    if let text = await self.transcribeAudio(finalChunkAudio), !text.isEmpty {
                        self.accumulatedTranscript = self.accumulatedTranscript.isEmpty
                            ? text
                            : self.accumulatedTranscript + " " + text
                        print("[WhisperService] chunk finalized — accumulated: \"\(self.accumulatedTranscript.prefix(80))\"")
                    }
                    // Advance chunk start
                    self.bufferLock.withLock {
                        self.chunkStartIndex = currentChunkStart + maxChunkSamples
                    }

                    // Transcribe remainder as live partial
                    let remainderAudio: [Float] = self.bufferLock.withLock {
                        guard self.chunkStartIndex < self.audioSamples.count else { return [] }
                        return Array(self.audioSamples[self.chunkStartIndex...])
                    }
                    var liveText = ""
                    if !remainderAudio.isEmpty {
                        liveText = await self.transcribeAudio(remainderAudio) ?? ""
                    }

                    let fullText = self.accumulatedTranscript + (liveText.isEmpty ? "" : " " + liveText)
                    self.finalTranscript = fullText
                    self.continuation?.yield(TranscriptionUpdate(
                        partialText: fullText, isFinal: false, confidence: 0.9
                    ))
                } else {
                    // Normal case: transcribe current chunk only
                    if let text = await self.transcribeAudio(chunkAudio), !text.isEmpty {
                        let fullText = self.accumulatedTranscript.isEmpty
                            ? text
                            : self.accumulatedTranscript + " " + text
                        print("[WhisperService] periodicTranscription — result: \"\(fullText.prefix(80))\"")
                        self.finalTranscript = fullText
                        self.continuation?.yield(TranscriptionUpdate(
                            partialText: fullText, isFinal: false, confidence: 0.9
                        ))
                    } else {
                        print("[WhisperService] periodicTranscription — transcription empty or nil")
                    }
                }
            }
        }
    }

    nonisolated private func transcribeAudio(_ audioArray: [Float]) async -> String? {
        print("[WhisperService] transcribeAudio() — sampleCount=\(audioArray.count)")

        let samplesToTranscribe: [Float]
        if UserDefaults.standard.bool(forKey: Constants.removeSilenceKey) {
            let sampleRate = await MainActor.run {
                self.audioCaptureManager.inputFormat?.sampleRate ?? 16000
            }
            samplesToTranscribe = SilenceRemover.removeSilence(from: audioArray, sampleRate: sampleRate)
            print("[WhisperService] silence removal: \(audioArray.count) → \(samplesToTranscribe.count) samples")
            guard !samplesToTranscribe.isEmpty else {
                print("[WhisperService] all silence removed, skipping transcription")
                return nil
            }
        } else {
            samplesToTranscribe = audioArray
        }

        do {
            let results = try await MainActor.run { self.whisperKit }?.transcribe(audioArray: samplesToTranscribe)
            let text = results?.first?.text.trimmingCharacters(in: .whitespacesAndNewlines)
            print("[WhisperService] transcribeAudio() — result: \(text.map { "\"\($0.prefix(80))\"" } ?? "nil")")
            return text
        } catch {
            print("[WhisperService] transcribeAudio() ERROR — \(error)")
            return nil
        }
    }
}
