import AudioCommon
import Foundation

/// Fetches the public 8-bit MLX conversion into Tucky's model directory using
/// speech-swift's resumable, checksummed downloader. Progress is byte-weighted
/// across the whole file set.
enum DownloadRunner {
    /// Same file set `PersonaPlexModel.fromPretrained` asks for.
    static let weightFiles = [
        "temporal.safetensors",
        "depformer.safetensors",
        "embeddings.safetensors",
        "mimi.safetensors",
        "voices/*.safetensors",
        "tokenizer_spm_32k_3.model",
        "config.json",
    ]

    static func run(modelId: String, modelDir: URL) async -> Int32 {
        let sink = EventSink.shared
        do {
            try FileManager.default.createDirectory(at: modelDir, withIntermediateDirectories: true)
            sink.emit(["event": "progress", "fraction": 0.0])
            let throttle = ProgressThrottle()
            try await HuggingFaceDownloader.downloadWeights(
                modelId: modelId,
                to: modelDir,
                additionalFiles: weightFiles,
                offlineMode: false
            ) { fraction in
                if throttle.shouldEmit(fraction) {
                    sink.emit(["event": "progress", "fraction": fraction])
                }
            }
            sink.emit(["event": "progress", "fraction": 1.0])
            sink.emit(["event": "done"])
            return 0
        } catch is CancellationError {
            sink.emit(["event": "stopped", "reason": "cancelled"])
            return 0
        } catch {
            if Task.isCancelled {
                sink.emit(["event": "stopped", "reason": "cancelled"])
                return 0
            }
            sink.error("download failed: \(error.localizedDescription) [\(error)]")
            return 1
        }
    }
}

final class ProgressThrottle: @unchecked Sendable {
    private let lock = NSLock()
    private var last = -1.0
    private var lastAt = Date.distantPast

    func shouldEmit(_ fraction: Double) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        if fraction >= 1.0 || fraction - last >= 0.005 || now.timeIntervalSince(lastAt) >= 1.0 {
            last = fraction
            lastAt = now
            return true
        }
        return false
    }
}
