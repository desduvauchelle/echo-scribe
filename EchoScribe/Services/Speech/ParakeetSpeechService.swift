import Foundation
import AVFoundation
@preconcurrency import FluidAudio

enum ParakeetModelVariant: String, CaseIterable, Identifiable {
    case v2 = "parakeet-tdt-0.6b-v2"
    case v3 = "parakeet-tdt-0.6b-v3"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .v2: return "Parakeet v2 (English)"
        case .v3: return "Parakeet v3 (Multilingual)"
        }
    }

    var sizeDescription: String {
        switch self {
        case .v2: return "English-only, higher recall (~350 MB)"
        case .v3: return "25 European languages (~350 MB)"
        }
    }

    var accuracyScore: Double {
        switch self {
        case .v2: return 0.95
        case .v3: return 0.90
        }
    }

    var speedScore: Double {
        switch self {
        case .v2: return 0.95
        case .v3: return 0.90
        }
    }

    var downloadSizeMB: Int { 350 }

    var formattedSize: String { "350 MB" }

    var normalizedSize: Double { 350.0 / 3000.0 }

    var asrVersion: AsrModelVersion {
        switch self {
        case .v2: return .v2
        case .v3: return .v3
        }
    }
}

enum ParakeetModelState: Equatable {
    case notDownloaded
    case downloading(progress: Double)
    case ready
    case error(String)

    static func == (lhs: ParakeetModelState, rhs: ParakeetModelState) -> Bool {
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
final class ParakeetSpeechService: SpeechServiceProtocol {
    private(set) var isRecording = false
    var modelState: ParakeetModelState = .notDownloaded
    var selectedVariant: ParakeetModelVariant = .v3

    private var asrManager: AsrManager?
    private var asrModels: AsrModels?
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
        asrManager != nil
    }

    // MARK: - Model Management

    func loadModel() async throws {
        guard asrManager == nil else { return }

        modelState = .downloading(progress: 0.5)
        print("[ParakeetService] loadModel() — downloading and loading \(selectedVariant.displayName)...")

        do {
            let models = try await AsrModels.downloadAndLoad(version: selectedVariant.asrVersion)
            self.asrModels = models
            let manager = AsrManager()
            try await manager.initialize(models: models)
            self.asrManager = manager
            modelState = .ready
            print("[ParakeetService] loadModel() — ready")
        } catch {
            modelState = .error(error.localizedDescription)
            print("[ParakeetService] loadModel() ERROR — \(error)")
            throw error
        }
    }

    func switchModel(to variant: ParakeetModelVariant) {
        guard variant != selectedVariant else { return }
        selectedVariant = variant
        asrManager = nil
        asrModels = nil
        modelState = .notDownloaded
    }

    // MARK: - SpeechServiceProtocol

    func startRecording() async throws {
        modelUnloadTask?.cancel()
        modelUnloadTask = nil
        modelLoadTask?.cancel()
        modelLoadTask = nil
        guard !isRecording else { return }

        bufferLock.withLock {
            audioSamples.removeAll()
        }
        finalTranscript = ""
        accumulatedTranscript = ""
        chunkStartIndex = 0

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
            throw error
        }

        isRecording = true

        if asrManager == nil {
            print("[ParakeetService] startRecording() — model not loaded, loading in background...")
            modelLoadTask = Task { [weak self] in
                guard let self else { return }
                try await self.loadModel()
                guard self.isRecording else { return }
                print("[ParakeetService] model loaded while recording — starting periodic transcription")
                self.startPeriodicTranscription()
            }
        } else {
            startPeriodicTranscription()
        }
    }

    func stopRecording() async -> String {
        transcriptionTimer?.cancel()
        transcriptionTimer = nil

        audioCaptureManager.stopCapture()
        isRecording = false

        // Wait for model to finish loading if it's still in progress
        if let loadTask = modelLoadTask {
            print("[ParakeetService] stopRecording() — waiting for model to finish loading...")
            do {
                try await loadTask.value
            } catch {
                print("[ParakeetService] stopRecording() — model load failed: \(error)")
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
            print("[ParakeetService] stopRecording() — model loaded, proceeding with transcription")
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

        if !currentChunkAudio.isEmpty {
            if let text = await transcribeAudio(currentChunkAudio) {
                finalTranscript = accumulatedTranscript.isEmpty
                    ? text
                    : accumulatedTranscript + " " + text
            } else {
                finalTranscript = accumulatedTranscript
            }
        } else {
            finalTranscript = accumulatedTranscript
        }

        continuation?.yield(TranscriptionUpdate(
            partialText: finalTranscript,
            isFinal: true,
            confidence: 0.95
        ))

        continuation?.finish()
        continuation = nil
        audioLevelContinuation?.finish()
        audioLevelContinuation = nil

        scheduleModelUnload()
        return finalTranscript
    }

    private func scheduleModelUnload() {
        modelUnloadTask?.cancel()
        modelUnloadTask = Task { [weak self] in
            try? await Task.sleep(for: Self.modelIdleTimeout)
            guard !Task.isCancelled else { return }
            guard let self, !self.isRecording else { return }
            self.asrManager = nil
            self.asrModels = nil
            self.modelState = .notDownloaded
            print("[ParakeetService] model unloaded after idle timeout")
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

                guard !chunkAudio.isEmpty else { continue }

                // Check if we need to finalize the current chunk (exceeded max duration)
                if chunkAudio.count >= maxChunkSamples {
                    // Finalize: transcribe the full chunk
                    let finalChunkAudio = Array(chunkAudio.prefix(maxChunkSamples))
                    if let text = await self.transcribeAudio(finalChunkAudio), !text.isEmpty {
                        self.accumulatedTranscript = self.accumulatedTranscript.isEmpty
                            ? text
                            : self.accumulatedTranscript + " " + text
                        print("[ParakeetService] chunk finalized — accumulated: \"\(self.accumulatedTranscript.prefix(80))\"")
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
                        partialText: fullText, isFinal: false, confidence: 0.95
                    ))
                } else {
                    // Normal case: transcribe current chunk only
                    if let text = await self.transcribeAudio(chunkAudio), !text.isEmpty {
                        let fullText = self.accumulatedTranscript.isEmpty
                            ? text
                            : self.accumulatedTranscript + " " + text
                        self.finalTranscript = fullText
                        self.continuation?.yield(TranscriptionUpdate(
                            partialText: fullText, isFinal: false, confidence: 0.95
                        ))
                    }
                }
            }
        }
    }

    nonisolated private func transcribeAudio(_ audioArray: [Float]) async -> String? {
        do {
            let manager = await MainActor.run { self.asrManager }
            guard let manager else { return nil }

            let sampleRate = await MainActor.run {
                self.audioCaptureManager.inputFormat?.sampleRate ?? 16000
            }

            // Apply silence removal if enabled (before resampling for accuracy)
            var processedAudio = audioArray
            if UserDefaults.standard.bool(forKey: Constants.removeSilenceKey) {
                processedAudio = SilenceRemover.removeSilence(from: audioArray, sampleRate: sampleRate)
                print("[ParakeetService] silence removal: \(audioArray.count) → \(processedAudio.count) samples")
                guard !processedAudio.isEmpty else {
                    print("[ParakeetService] all silence removed, skipping transcription")
                    return nil
                }
            }

            // Parakeet expects 16kHz mono audio — resample if needed
            let samples: [Float]
            if sampleRate != 16000 {
                samples = resampleAudio(processedAudio, fromRate: sampleRate, toRate: 16000)
            } else {
                samples = processedAudio
            }

            let result = try await manager.transcribe(samples)
            return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            print("[ParakeetService] transcribeAudio() ERROR — \(error)")
            return nil
        }
    }

    nonisolated private func resampleAudio(_ samples: [Float], fromRate: Double, toRate: Double) -> [Float] {
        let ratio = toRate / fromRate
        let outputLength = Int(Double(samples.count) * ratio)
        var output = [Float](repeating: 0, count: outputLength)
        for i in 0..<outputLength {
            let srcIndex = Double(i) / ratio
            let srcIndexFloor = Int(srcIndex)
            let frac = Float(srcIndex - Double(srcIndexFloor))
            if srcIndexFloor + 1 < samples.count {
                output[i] = samples[srcIndexFloor] * (1 - frac) + samples[srcIndexFloor + 1] * frac
            } else if srcIndexFloor < samples.count {
                output[i] = samples[srcIndexFloor]
            }
        }
        return output
    }
}
