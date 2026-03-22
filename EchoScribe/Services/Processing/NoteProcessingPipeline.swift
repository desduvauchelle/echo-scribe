import Foundation

@MainActor
final class NoteProcessingPipeline {
    private let database: AppDatabase
    private let aiProcessor: AIProcessor

    init(database: AppDatabase, mlxService: MLXService) {
        self.database = database
        self.aiProcessor = AIProcessor(database: database, mlxService: mlxService)
    }

    /// Saves a raw transcript as a note and runs AI processing.
    @discardableResult
    func process(rawTranscript: String) async throws -> Note {
        // 1. Save raw note immediately
        var note = Note(rawTranscript: rawTranscript)
        try database.saveNote(&note)

        // 2. Run AI analysis (Phase 1 stub is synchronous/fast, Phase 2 will be async MLX)
        let noteId = note.id
        do {
            let analysis = try await aiProcessor.analyze(rawTranscript: rawTranscript)

            var projectId: String? = nil
            if analysis.project != "General" {
                let project = try database.findOrCreateProject(name: analysis.project)
                projectId = project.id
            }

            let dateFormatter = DateFormatter()
            dateFormatter.dateFormat = "yyyy-MM-dd"

            let tasks = analysis.tasks.map { extracted in
                NoteTask(
                    title: extracted.title,
                    dueDate: extracted.dueDate.flatMap { dateFormatter.date(from: $0) },
                    noteId: noteId,
                    projectId: projectId
                )
            }

            try database.updateNoteWithAIResults(
                noteId: noteId,
                processedText: analysis.processedText,
                summary: analysis.summary,
                projectId: projectId,
                tasks: tasks,
                tagNames: analysis.tags
            )
        } catch {
            print("AI processing failed for note \(noteId): \(error)")
        }

        return note
    }
}
