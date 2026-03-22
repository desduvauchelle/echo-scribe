import CoreData

@MainActor
final class NoteProcessingPipeline {
    private let persistence: PersistenceController
    private let aiProcessor: AIProcessor

    init(persistence: PersistenceController, mlxService: MLXService) {
        self.persistence = persistence
        self.aiProcessor = AIProcessor(persistence: persistence, mlxService: mlxService)
    }

    /// Saves a raw transcript as a note and runs AI processing asynchronously.
    @discardableResult
    func process(rawTranscript: String) async throws -> CDNote {
        // 1. Save raw note immediately on the view context
        let note = CDNote.insert(in: persistence.viewContext, rawTranscript: rawTranscript)
        persistence.save()

        let noteObjectID = note.objectID

        // 2. Run AI analysis
        do {
            let analysis = try await aiProcessor.analyze(rawTranscript: rawTranscript)

            // 3. Write AI results on a background context
            let bgContext = persistence.newBackgroundContext()
            try await bgContext.perform {
                guard let bgNote = try bgContext.existingObject(with: noteObjectID) as? CDNote else {
                    return
                }

                bgNote.processedText = analysis.processedText
                bgNote.summary = analysis.summary
                bgNote.isProcessed = true
                bgNote.updatedAt = Date()

                // Project — handle AI tool call action
                var assignedProject: CDProject? = nil
                let projectAction = analysis.projectAction

                if projectAction.name != "General" {
                    switch projectAction.action {
                    case .assign:
                        // Only assign to an existing project
                        let req: NSFetchRequest<CDProject> = CDProject.fetchRequest()
                        req.predicate = NSPredicate(format: "name ==[cd] %@", projectAction.name)
                        req.fetchLimit = 1
                        assignedProject = try bgContext.fetch(req).first

                    case .create:
                        // Check if it already exists (avoid duplicates)
                        let req: NSFetchRequest<CDProject> = CDProject.fetchRequest()
                        req.predicate = NSPredicate(format: "name ==[cd] %@", projectAction.name)
                        req.fetchLimit = 1
                        if let existing = try bgContext.fetch(req).first {
                            assignedProject = existing
                        } else {
                            let color = projectAction.color ?? "#007AFF"
                            assignedProject = CDProject.insert(
                                in: bgContext,
                                name: projectAction.name,
                                color: color,
                                projectDescription: projectAction.description
                            )
                        }
                    }

                    bgNote.project = assignedProject
                }

                // Tasks
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "yyyy-MM-dd"
                for extracted in analysis.tasks {
                    let task = CDNoteTask.insert(
                        in: bgContext,
                        title: extracted.title,
                        note: bgNote,
                        project: assignedProject,
                        dueDate: extracted.dueDate.flatMap { dateFormatter.date(from: $0) }
                    )
                    _ = task // suppress unused warning
                }

                // Tags
                for tagName in analysis.tags {
                    let tag = CDTag.findOrCreate(name: tagName, in: bgContext)
                    bgNote.addToTags(tag)
                }

                try bgContext.save()
            }
        } catch {
            print("AI processing failed for note \(noteObjectID): \(error)")
        }

        return note
    }
}
