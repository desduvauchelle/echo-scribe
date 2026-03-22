import CoreData

@MainActor
final class AIProcessor {
    private let persistence: PersistenceController
    private let mlxService: MLXService

    init(persistence: PersistenceController, mlxService: MLXService) {
        self.persistence = persistence
        self.mlxService = mlxService
    }

    func analyze(rawTranscript: String) async throws -> NoteAnalysis {
        // If model isn't loaded yet, try to load it
        if !mlxService.isModelLoaded {
            do {
                try await mlxService.loadModel()
            } catch {
                print("Model load failed, using fallback: \(error)")
                return fallbackAnalysis(rawTranscript: rawTranscript)
            }
        }

        let projects = fetchProjectInfo()
        let tags = fetchTagNames()
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: rawTranscript,
            existingProjects: projects,
            existingTags: tags
        )

        do {
            let response = try await mlxService.generate(prompt: prompt)
            return try parseAnalysis(from: response)
        } catch {
            print("AI analysis failed, using fallback: \(error)")
            return fallbackAnalysis(rawTranscript: rawTranscript)
        }
    }

    private func fetchProjectInfo() -> [(name: String, description: String?)] {
        let request: NSFetchRequest<CDProject> = CDProject.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "name", ascending: true)]
        return (try? persistence.viewContext.fetch(request).map { ($0.name, $0.projectDescription) }) ?? []
    }

    private func fetchTagNames() -> [String] {
        let request: NSFetchRequest<CDTag> = CDTag.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "name", ascending: true)]
        return (try? persistence.viewContext.fetch(request).map(\.name)) ?? []
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
            projectName: "General",
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
