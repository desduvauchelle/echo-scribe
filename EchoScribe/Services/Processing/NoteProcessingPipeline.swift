import CoreData

@MainActor
final class NoteProcessingPipeline {
    private let persistence: PersistenceController
    private let aiProcessor: AIProcessor
    private static let aiTimeoutSeconds: UInt64 = 60

    init(persistence: PersistenceController, mlxService: MLXService) {
        self.persistence = persistence
        self.aiProcessor = AIProcessor(persistence: persistence, mlxService: mlxService)
    }

    /// Saves a raw transcript as a note and runs AI processing asynchronously.
    @discardableResult
    func process(rawTranscript: String) async throws -> CDNote {
        print("[Pipeline] process() — rawTranscript length=\(rawTranscript.count): \"\(rawTranscript.prefix(80))\"")

        // 1. Save raw note immediately on the view context
        let note = CDNote.insert(in: persistence.viewContext, rawTranscript: rawTranscript)
        persistence.save()

        let noteObjectID = note.objectID
        print("[Pipeline] process() — note saved, objectID=\(noteObjectID)")

        // 2. Run AI analysis with timeout — never leave a note stuck as "processing"
        print("[Pipeline] process() — starting AI analysis (timeout=\(Self.aiTimeoutSeconds)s)")
        let analysis: NoteAnalysis
        do {
            analysis = try await withTimeout(seconds: Self.aiTimeoutSeconds) {
                try await self.aiProcessor.analyze(rawTranscript: rawTranscript)
            }
            print("[Pipeline] process() — AI analysis complete: tasks=\(analysis.tasks.count), tags=\(analysis.tags.count), project=\(analysis.projectAction.name)")
        } catch {
            print("[Pipeline] process() — AI analysis FAILED or TIMED OUT: \(error)")
            print("[Pipeline] process() — using fallback analysis so note doesn't stay stuck")
            analysis = NoteAnalysis(
                processedText: rawTranscript,
                summary: String(rawTranscript.prefix(100)),
                tasks: [],
                projectName: "General",
                tags: []
            )
        }

        // 3. Write results (AI or fallback) on a background context
        do {
            let bgContext = persistence.newBackgroundContext()
            try await bgContext.perform {
                guard let bgNote = try bgContext.existingObject(with: noteObjectID) as? CDNote else {
                    print("[Pipeline] process() — could not find note in background context")
                    return
                }

                bgNote.processedText = analysis.processedText
                bgNote.summary = analysis.summary
                bgNote.isProcessed = true
                bgNote.updatedAt = Date()

                // Project — handle AI tool call action
                var assignedProject: CDProject? = nil
                let projectAction = analysis.projectAction

                switch projectAction.action {
                case .assign:
                    let req: NSFetchRequest<CDProject> = CDProject.fetchRequest()
                    req.predicate = NSPredicate(format: "name ==[cd] %@", projectAction.name)
                    req.fetchLimit = 1
                    assignedProject = try bgContext.fetch(req).first

                case .create:
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
                    _ = task
                }

                // Tags
                for tagName in analysis.tags {
                    let tag = CDTag.findOrCreate(name: tagName, in: bgContext)
                    bgNote.addToTags(tag)
                }

                try bgContext.save()
                print("[Pipeline] process() — background context saved, isProcessed=true")
            }

            // Force viewContext to pick up background changes and trigger FRC
            persistence.viewContext.refreshAllObjects()
            print("[Pipeline] process() — viewContext refreshed after background save")
        } catch {
            // Last resort: mark processed directly on viewContext so UI doesn't stay stuck
            print("[Pipeline] process() — background save FAILED: \(error), marking processed on viewContext")
            note.isProcessed = true
            note.processedText = rawTranscript
            note.summary = String(rawTranscript.prefix(100))
            note.updatedAt = Date()
            persistence.save()
        }

        print("[Pipeline] process() — done, returning note")
        return note
    }

    /// Runs an async closure with a timeout. Throws `CancellationError` if the timeout elapses.
    private func withTimeout<T: Sendable>(seconds: UInt64, operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let operationTask = Task { try await operation() }
        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            operationTask.cancel()
        }
        do {
            let result = try await operationTask.value
            timeoutTask.cancel()
            return result
        } catch {
            timeoutTask.cancel()
            throw error
        }
    }
}
