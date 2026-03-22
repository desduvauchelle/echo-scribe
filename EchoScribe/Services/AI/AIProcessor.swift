import Foundation

@MainActor
final class AIProcessor {
    private let database: AppDatabase
    private let mlxService: MLXService

    init(database: AppDatabase, mlxService: MLXService) {
        self.database = database
        self.mlxService = mlxService
    }

    func analyze(rawTranscript: String) async throws -> NoteAnalysis {
        // If model isn't loaded yet, use fallback
        if !mlxService.isModelLoaded {
            do {
                try await mlxService.loadModel()
            } catch {
                print("Model load failed, using fallback: \(error)")
                return fallbackAnalysis(rawTranscript: rawTranscript)
            }
        }

        let projects = try database.fetchAllProjects().map(\.name)
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: rawTranscript,
            existingProjects: projects
        )

        do {
            let response = try await mlxService.generate(prompt: prompt)
            return try parseAnalysis(from: response)
        } catch {
            print("AI analysis failed, using fallback: \(error)")
            return fallbackAnalysis(rawTranscript: rawTranscript)
        }
    }

    private func parseAnalysis(from response: String) throws -> NoteAnalysis {
        let jsonString = extractJSON(from: response)

        guard let data = jsonString.data(using: .utf8) else {
            throw AIProcessorError.invalidResponse
        }

        return try JSONDecoder().decode(NoteAnalysis.self, from: data)
    }

    private func extractJSON(from text: String) -> String {
        // Try to find JSON between code fences
        if let range = text.range(of: "```json\n") ?? text.range(of: "```\n") {
            let start = range.upperBound
            if let end = text.range(of: "\n```", range: start..<text.endIndex) {
                return String(text[start..<end.lowerBound])
            }
        }

        // Try to find raw JSON object
        if let start = text.firstIndex(of: "{"),
           let end = text.lastIndex(of: "}") {
            return String(text[start...end])
        }

        return text
    }

    private func fallbackAnalysis(rawTranscript: String) -> NoteAnalysis {
        NoteAnalysis(
            processedText: rawTranscript,
            summary: String(rawTranscript.prefix(100)),
            tasks: [],
            project: "General",
            tags: []
        )
    }
}

enum AIProcessorError: LocalizedError {
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "Could not parse AI response"
        }
    }
}
