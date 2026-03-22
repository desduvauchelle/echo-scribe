import Testing
import CoreData
@testable import Echo_Scribe

@MainActor
@Suite("Persistence Integration")
struct PersistenceIntegrationTests {

    private func makeContext() -> NSManagedObjectContext {
        TestHelpers.makePersistence().viewContext
    }

    // MARK: - Note CRUD

    @Test("create and fetch a note")
    func createAndFetchNote() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Test note content")
        try TestHelpers.saveAndWait(ctx)

        let request: NSFetchRequest<CDNote> = CDNote.fetchRequest()
        let results = try ctx.fetch(request)

        #expect(results.count == 1)
        #expect(results.first?.rawTranscript == "Test note content")
        #expect(results.first?.id == note.id)
    }

    @Test("note defaults are set correctly")
    func noteDefaults() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Defaults test")
        try TestHelpers.saveAndWait(ctx)

        #expect(note.isProcessed == false)
        #expect(note.processedText == nil)
        #expect(note.summary == nil)
    }

    @Test("displayText returns processedText when available")
    func displayTextPreference() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "raw", processedText: "processed")
        #expect(note.displayText == "processed")
    }

    @Test("displayText falls back to rawTranscript")
    func displayTextFallback() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "raw text only")
        #expect(note.displayText == "raw text only")
    }

    // MARK: - Project CRUD

    @Test("create project with all fields")
    func createProject() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work", color: "#FF0000", description: "Work stuff")
        try TestHelpers.saveAndWait(ctx)

        let request: NSFetchRequest<CDProject> = CDProject.fetchRequest()
        let results = try ctx.fetch(request)

        #expect(results.count == 1)
        #expect(results.first?.name == "Work")
        #expect(results.first?.color == "#FF0000")
        #expect(results.first?.projectDescription == "Work stuff")
    }

    // MARK: - Relationships

    @Test("note-project relationship")
    func noteProjectRelationship() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work")
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Work note", project: project)
        try TestHelpers.saveAndWait(ctx)

        #expect(note.project?.name == "Work")
        #expect((project.notes as? Set<CDNote>)?.count == 1)
    }

    @Test("note-tag many-to-many relationship")
    func noteTagRelationship() throws {
        let ctx = makeContext()
        let note1 = TestHelpers.makeNote(in: ctx, rawTranscript: "Note 1")
        let note2 = TestHelpers.makeNote(in: ctx, rawTranscript: "Note 2")
        let tag = TestHelpers.makeTag(in: ctx, name: "shared")
        note1.addToTags(tag)
        note2.addToTags(tag)
        try TestHelpers.saveAndWait(ctx)

        #expect(note1.tagsArray.count == 1)
        #expect(note2.tagsArray.count == 1)
        #expect((tag.notes as? Set<CDNote>)?.count == 2)
    }

    @Test("note-task relationship with cascade delete")
    func noteTaskCascadeDelete() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Note with tasks")
        TestHelpers.makeTask(in: ctx, title: "Task 1", note: note)
        TestHelpers.makeTask(in: ctx, title: "Task 2", note: note)
        try TestHelpers.saveAndWait(ctx)

        #expect(note.tasksArray.count == 2)

        // Delete the note — tasks should cascade
        ctx.delete(note)
        try TestHelpers.saveAndWait(ctx)

        let taskRequest: NSFetchRequest<CDNoteTask> = NSFetchRequest(entityName: "CDNoteTask")
        let remainingTasks = try ctx.fetch(taskRequest)
        #expect(remainingTasks.isEmpty)
    }

    // MARK: - Tag findOrCreate

    @Test("findOrCreate returns existing tag")
    func findOrCreateExisting() throws {
        let ctx = makeContext()
        let original = CDTag.findOrCreate(name: "Meeting", in: ctx)
        try TestHelpers.saveAndWait(ctx)

        let found = CDTag.findOrCreate(name: "meeting", in: ctx)
        #expect(original.id == found.id)
    }

    @Test("findOrCreate normalizes name to lowercase")
    func findOrCreateNormalizes() throws {
        let ctx = makeContext()
        let tag = CDTag.findOrCreate(name: "  URGENT  ", in: ctx)
        #expect(tag.name == "urgent")
    }

    // MARK: - Sorting

    @Test("tasksArray sorts by createdAt")
    func tasksArraySorted() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Note")
        let calendar = Calendar.current
        let now = Date()

        let task1 = TestHelpers.makeTask(in: ctx, title: "First", note: note)
        task1.createdAt = calendar.date(byAdding: .hour, value: -1, to: now)!

        let task2 = TestHelpers.makeTask(in: ctx, title: "Second", note: note)
        task2.createdAt = now

        try TestHelpers.saveAndWait(ctx)

        let sorted = note.tasksArray
        #expect(sorted.first?.title == "First")
        #expect(sorted.last?.title == "Second")
    }

    @Test("tagsArray sorts alphabetically")
    func tagsArraySorted() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Note")
        let tagB = TestHelpers.makeTag(in: ctx, name: "beta")
        let tagA = TestHelpers.makeTag(in: ctx, name: "alpha")
        note.addToTags(tagB)
        note.addToTags(tagA)
        try TestHelpers.saveAndWait(ctx)

        let sorted = note.tagsArray
        #expect(sorted.first?.name == "alpha")
        #expect(sorted.last?.name == "beta")
    }
}
