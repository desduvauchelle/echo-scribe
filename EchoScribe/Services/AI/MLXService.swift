import Foundation
import MLX
import SwiftUI
@preconcurrency import MLXLLM
@preconcurrency import MLXLMCommon

enum AIModelVariant: String, CaseIterable, Identifiable {
    case qwen05B  = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
    case qwen15B  = "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
    case qwen3B   = "mlx-community/Qwen2.5-3B-Instruct-4bit"
    case qwen7B   = "mlx-community/Qwen2.5-7B-Instruct-4bit"
    case llama1B  = "mlx-community/Llama-3.2-1B-Instruct-4bit"
    case llama3B  = "mlx-community/Llama-3.2-3B-Instruct-4bit"
    case mistral7B = "mlx-community/Mistral-7B-Instruct-v0.3-4bit"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .qwen05B: return "Qwen 2.5 0.5B"
        case .qwen15B: return "Qwen 2.5 1.5B"
        case .qwen3B: return "Qwen 2.5 3B"
        case .qwen7B: return "Qwen 2.5 7B"
        case .llama1B: return "Llama 3.2 1B"
        case .llama3B: return "Llama 3.2 3B"
        case .mistral7B: return "Mistral 7B"
        }
    }

    var familyName: String {
        switch self {
        case .qwen05B, .qwen15B, .qwen3B, .qwen7B: return "Qwen 2.5"
        case .llama1B, .llama3B: return "Llama 3.2"
        case .mistral7B: return "Mistral"
        }
    }

    var storageSize: String {
        switch self {
        case .qwen05B: return "~350 MB"
        case .qwen15B: return "~900 MB"
        case .qwen3B: return "~1.8 GB"
        case .qwen7B: return "~4.5 GB"
        case .llama1B: return "~700 MB"
        case .llama3B: return "~1.8 GB"
        case .mistral7B: return "~4.5 GB"
        }
    }

    var ramRequired: String {
        switch self {
        case .qwen05B: return "~512 MB"
        case .qwen15B: return "~1.2 GB"
        case .qwen3B: return "~2.5 GB"
        case .qwen7B: return "~5 GB"
        case .llama1B: return "~1 GB"
        case .llama3B: return "~2.5 GB"
        case .mistral7B: return "~5 GB"
        }
    }

    var qualityStars: Int {
        switch self {
        case .qwen05B: return 1
        case .qwen15B, .llama1B: return 2
        case .qwen3B, .llama3B: return 3
        case .qwen7B, .mistral7B: return 4
        }
    }

    var sizeDescription: String {
        switch self {
        case .qwen05B: return "Fastest, basic quality (\(storageSize))"
        case .qwen15B: return "Fast, good for simple tasks (\(storageSize))"
        case .qwen3B: return "Balanced speed and quality (\(storageSize))"
        case .qwen7B: return "Best Qwen quality, needs more RAM (\(storageSize))"
        case .llama1B: return "Fast, strong English support (\(storageSize))"
        case .llama3B: return "Balanced, great for English (\(storageSize))"
        case .mistral7B: return "Strong reasoning, needs more RAM (\(storageSize))"
        }
    }

    var detailedDescription: String {
        switch self {
        case .qwen05B: return "Best for quick processing on any Mac. May miss nuance in complex notes."
        case .qwen15B: return "Good balance for everyday notes. Works well on 8 GB Macs."
        case .qwen3B: return "Recommended for most users. Reliable extraction of tasks and summaries."
        case .qwen7B: return "Highest quality analysis. Best with 16 GB+ RAM."
        case .llama1B: return "Lightweight Meta model. Excellent English comprehension."
        case .llama3B: return "Strong all-around model from Meta. Good task extraction."
        case .mistral7B: return "Excellent reasoning and structure. Best with 16 GB+ RAM."
        }
    }

    var isDefault: Bool { self == .qwen3B }

    /// Normalized quality score (0.0–1.0) for comparison bars
    var qualityScore: Double {
        switch self {
        case .qwen05B: return 0.15
        case .qwen15B, .llama1B: return 0.40
        case .qwen3B, .llama3B: return 0.65
        case .qwen7B, .mistral7B: return 0.90
        }
    }

    /// Normalized speed score (0.0–1.0) for comparison bars
    var speedScore: Double {
        switch self {
        case .qwen05B: return 0.95
        case .qwen15B: return 0.80
        case .llama1B: return 0.75
        case .qwen3B, .llama3B: return 0.55
        case .qwen7B, .mistral7B: return 0.25
        }
    }

    /// Normalized storage size (0.0–1.0) for comparison bars
    var normalizedSize: Double {
        switch self {
        case .qwen05B: return 0.08
        case .llama1B: return 0.16
        case .qwen15B: return 0.20
        case .qwen3B, .llama3B: return 0.40
        case .qwen7B, .mistral7B: return 1.0
        }
    }
}

enum MLXModelState: Equatable {
    case notDownloaded
    case downloading(progress: Double)
    case ready
    case error(String)

    static func == (lhs: MLXModelState, rhs: MLXModelState) -> Bool {
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
final class MLXService {
    var modelState: MLXModelState = .notDownloaded
    var selectedVariant: AIModelVariant
    var modelName: String { selectedVariant.rawValue }

    private var modelContainer: ModelContainer?
    private var chatSession: ChatSession?
    private var idleUnloadTask: Task<Void, Never>?
    private static let idleTimeout: Duration = .seconds(60)

    init() {
        if let saved = UserDefaults.standard.string(forKey: Constants.selectedAIModelKey),
           let variant = AIModelVariant(rawValue: saved) {
            self.selectedVariant = variant
        } else {
            self.selectedVariant = .qwen3B
        }

        // Install a global MLX error handler to prevent fatalError crashes.
        // Without this, any MLX C++ error triggers fatalError in ErrorHandler.dispatch().
        setErrorHandler({ message, _ in
            let msg = message.map { String(cString: $0) } ?? "Unknown MLX error"
            print("[MLX] Error intercepted: \(msg)")
        })
    }

    func switchModel(to variant: AIModelVariant) {
        guard variant != selectedVariant else { return }
        if case .downloading = modelState { return }
        selectedVariant = variant
        unloadModel()
        UserDefaults.standard.set(variant.rawValue, forKey: Constants.selectedAIModelKey)
    }

    func unloadModel() {
        idleUnloadTask?.cancel()
        idleUnloadTask = nil
        modelContainer = nil
        chatSession = nil
        modelState = .notDownloaded
        print("[MLX] unloadModel() — model released from memory")
    }

    private func scheduleIdleUnload() {
        idleUnloadTask?.cancel()
        idleUnloadTask = Task { [weak self] in
            try? await Task.sleep(for: Self.idleTimeout)
            guard !Task.isCancelled else { return }
            self?.unloadModel()
        }
    }

    func loadModel() async throws {
        print("[MLX] loadModel() — entry, modelContainer==nil: \(modelContainer == nil), modelName=\(modelName)")
        idleUnloadTask?.cancel()
        idleUnloadTask = nil
        guard modelContainer == nil else {
            print("[MLX] loadModel() — already loaded, skipping")
            return
        }

        modelState = .downloading(progress: 0)
        print("[MLX] loadModel() — starting download/load for \(modelName)")

        do {
            let container = try await loadModelContainer(id: modelName) { [weak self] progress in
                Task { @MainActor in
                    let fraction = progress.fractionCompleted
                    self?.modelState = .downloading(progress: fraction)
                    // Log at 25% intervals to avoid spam
                    if fraction < 0.01 || (fraction * 100).truncatingRemainder(dividingBy: 25) < 1 {
                        print("[MLX] loadModel() — download progress: \(Int(fraction * 100))%")
                    }
                }
            }
            print("[MLX] loadModel() — container loaded, creating ChatSession")
            self.modelContainer = container
            self.chatSession = ChatSession(
                container,
                instructions: "You are a precise JSON-outputting assistant. Respond ONLY with valid JSON, no markdown fences or extra text.",
                generateParameters: .init(maxTokens: 1024, temperature: 0.1, topP: 0.9)
            )
            modelState = .ready
            print("[MLX] loadModel() — ready")
        } catch {
            print("[MLX] loadModel() — FAILED: \(error)")
            modelState = .error(error.localizedDescription)
            throw error
        }
    }

    func generate(prompt: String) async throws -> String {
        print("[MLX] generate() — entry, prompt length=\(prompt.count), modelContainer==nil: \(modelContainer == nil)")
        if modelContainer == nil {
            print("[MLX] generate() — model not loaded, calling loadModel()")
            try await loadModel()
        }

        guard let chatSession else {
            print("[MLX] generate() — chatSession is nil after load, throwing")
            throw MLXServiceError.modelNotLoaded
        }

        print("[MLX] generate() — clearing chat session")
        await chatSession.clear()

        print("[MLX] generate() — calling chatSession.respond()...")
        let response = try await chatSession.respond(to: prompt)
        print("[MLX] generate() — respond() returned, response length=\(response.count)")
        scheduleIdleUnload()
        return response
    }

    var isModelLoaded: Bool {
        modelContainer != nil
    }
}

enum MLXServiceError: LocalizedError {
    case modelNotLoaded

    var errorDescription: String? {
        switch self {
        case .modelNotLoaded: return "AI model is not loaded"
        }
    }
}
