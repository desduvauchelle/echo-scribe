import Foundation
import MLXLLM
import MLXLMCommon

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
    var modelName = "mlx-community/Qwen2.5-3B-Instruct-4bit"

    private var modelContainer: ModelContainer?
    private var chatSession: ChatSession?

    func loadModel() async throws {
        guard modelContainer == nil else { return }

        modelState = .downloading(progress: 0)

        do {
            let container = try await loadModelContainer(id: modelName) { [weak self] progress in
                Task { @MainActor in
                    self?.modelState = .downloading(progress: progress.fractionCompleted)
                }
            }
            self.modelContainer = container
            self.chatSession = ChatSession(
                container,
                instructions: "You are a precise JSON-outputting assistant. Respond ONLY with valid JSON, no markdown fences or extra text.",
                generateParameters: .init(temperature: 0.1, topP: 0.9)
            )
            modelState = .ready
        } catch {
            modelState = .error(error.localizedDescription)
            throw error
        }
    }

    func generate(prompt: String) async throws -> String {
        if modelContainer == nil {
            try await loadModel()
        }

        guard let chatSession else {
            throw MLXServiceError.modelNotLoaded
        }

        // Clear previous conversation so each analysis is independent
        await chatSession.clear()

        let response = try await chatSession.respond(to: prompt)
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
