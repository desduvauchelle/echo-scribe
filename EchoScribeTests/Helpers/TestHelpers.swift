import CoreData
@testable import Echo_Scribe

/// Shared test utilities for creating in-memory Core Data stacks and test entities.
enum TestHelpers {

    /// Creates a fresh in-memory PersistenceController for each test.
    static func makePersistence() -> PersistenceController {
        PersistenceController(inMemory: true)
    }

    // MARK: - Entity Factories

    @discardableResult
    static func makeNote(
        in context: NSManagedObjectContext,
        rawTranscript: String = "Test transcript",
        processedText: String? = nil,
        summary: String? = nil,
        isProcessed: Bool = false,
        project: CDProject? = nil,
        createdAt: Date = Date()
    ) -> CDNote {
        let note = CDNote.insert(in: context, rawTranscript: rawTranscript)
        note.processedText = processedText
        note.summary = summary
        note.isProcessed = isProcessed
        note.project = project
        note.createdAt = createdAt
        note.updatedAt = createdAt
        return note
    }

    @discardableResult
    static func makeProject(
        in context: NSManagedObjectContext,
        name: String = "Test Project",
        color: String = "#007AFF",
        description: String? = nil
    ) -> CDProject {
        CDProject.insert(in: context, name: name, color: color, projectDescription: description)
    }

    @discardableResult
    static func makeTag(
        in context: NSManagedObjectContext,
        name: String = "test-tag"
    ) -> CDTag {
        CDTag.findOrCreate(name: name, in: context)
    }

    @discardableResult
    static func makeTask(
        in context: NSManagedObjectContext,
        title: String = "Test Task",
        isCompleted: Bool = false,
        note: CDNote? = nil,
        project: CDProject? = nil
    ) -> CDNoteTask {
        let task = CDNoteTask(context: context)
        task.id = UUID()
        task.title = title
        task.isCompleted = isCompleted
        task.createdAt = Date()
        task.note = note
        task.project = project
        return task
    }

    /// Save and wait for the context to be fully synced.
    static func saveAndWait(_ context: NSManagedObjectContext) throws {
        if context.hasChanges {
            try context.save()
        }
    }
}
