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
    private var transcriptionTimer: Task<Void, Never>?

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
        guard !isRecording else { return }

        if asrManager == nil {
            do {
                try await loadModel()
            } catch {
                throw SpeechError.parakeetModelNotLoaded
            }
        }

        bufferLock.withLock { audioSamples.removeAll() }
        finalTranscript = ""

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
        startPeriodicTranscription()
    }

    func stopRecording() async -> String {
        transcriptionTimer?.cancel()
        transcriptionTimer = nil

        audioCaptureManager.stopCapture()
        isRecording = false

        // Final transcription pass on all accumulated audio
        let audioArray: [Float] = bufferLock.withLock {
            let samples = audioSamples
            audioSamples.removeAll()
            return samples
        }

        if !audioArray.isEmpty {
            if let text = await transcribeAudio(audioArray) {
                finalTranscript = text
            }
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

                let audioArray: [Float] = self.bufferLock.withLock {
                    return self.audioSamples
                }
                guard !audioArray.isEmpty else { continue }

                if let text = await self.transcribeAudio(audioArray), !text.isEmpty {
                    self.finalTranscript = text
                    self.continuation?.yield(TranscriptionUpdate(
                        partialText: text,
                        isFinal: false,
                        confidence: 0.95
                    ))
                }
            }
        }
    }

    nonisolated private func transcribeAudio(_ audioArray: [Float]) async -> String? {
        do {
            let manager = await MainActor.run { self.asrManager }
            guard let manager else { return nil }

            // Parakeet expects 16kHz mono audio — resample if needed
            let sampleRate = await MainActor.run {
                self.audioCaptureManager.inputFormat?.sampleRate ?? 16000
            }
            let samples: [Float]
            if sampleRate != 16000 {
                samples = resampleAudio(audioArray, fromRate: sampleRate, toRate: 16000)
            } else {
                samples = audioArray
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
