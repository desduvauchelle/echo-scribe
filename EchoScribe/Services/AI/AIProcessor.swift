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
        print("[AIProcessor] analyze() — entry, isModelLoaded=\(mlxService.isModelLoaded), modelState=\(mlxService.modelState)")

        // If model isn't loaded yet, try to load it
        if !mlxService.isModelLoaded {
            print("[AIProcessor] analyze() — model not loaded, calling loadModel()")
            do {
                try await mlxService.loadModel()
                print("[AIProcessor] analyze() — loadModel() succeeded")
            } catch {
                print("[AIProcessor] analyze() — loadModel() FAILED: \(error), using fallback")
                return fallbackAnalysis(rawTranscript: rawTranscript)
            }
        }

        let projects = fetchProjectInfo()
        let tags = fetchTagNames()
        print("[AIProcessor] analyze() — fetched \(projects.count) projects, \(tags.count) tags")

        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: rawTranscript,
            existingProjects: projects,
            existingTags: tags
        )
        print("[AIProcessor] analyze() — prompt length=\(prompt.count), calling generate()")

        do {
            let response = try await mlxService.generate(prompt: prompt)
            print("[AIProcessor] analyze() — generate() returned, response length=\(response.count)")
            print("[AIProcessor] analyze() — response preview: \"\(response.prefix(300))\"")

            let analysis = try parseAnalysis(from: response)
            print("[AIProcessor] analyze() — parseAnalysis succeeded: summary=\"\(analysis.summary.prefix(80))\"")
            return analysis
        } catch {
            print("[AIProcessor] analyze() — FAILED: \(error), using fallback")
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
