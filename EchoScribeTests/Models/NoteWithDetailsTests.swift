import Testing
import CoreData
@testable import Echo_Scribe

@MainActor
@Suite("NoteWithDetails")
struct NoteWithDetailsTests {

    private func makeContext() -> NSManagedObjectContext {
        TestHelpers.makePersistence().viewContext
    }

    @Test("from(_:) maps note fields correctly")
    func fromMapsFields() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work")
        let note = TestHelpers.makeNote(
            in: ctx,
            rawTranscript: "Hello",
            processedText: "Processed hello",
            summary: "Summary",
            project: project
        )
        let tag = TestHelpers.makeTag(in: ctx, name: "meeting")
        note.addToTags(tag)
        let task = TestHelpers.makeTask(in: ctx, title: "Follow up", note: note)
        try TestHelpers.saveAndWait(ctx)

        let details = NoteWithDetails.from(note)

        #expect(details.id == note.id)
        #expect(details.note.rawTranscript == "Hello")
        #expect(details.project?.name == "Work")
        #expect(details.tags.count == 1)
        #expect(details.tags.first?.name == "meeting")
        #expect(details.tasks.count == 1)
        #expect(details.tasks.first?.title == "Follow up")
    }

    @Test("from(_:) handles note with no relationships")
    func fromHandlesNoRelationships() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Standalone note")
        try TestHelpers.saveAndWait(ctx)

        let details = NoteWithDetails.from(note)

        #expect(details.project == nil)
        #expect(details.tags.isEmpty)
        #expect(details.tasks.isEmpty)
    }

    @Test("equality compares objectID and updatedAt")
    func equalityCheck() throws {
        let ctx = makeContext()
        let note1 = TestHelpers.makeNote(in: ctx, rawTranscript: "Note A")
        let note2 = TestHelpers.makeNote(in: ctx, rawTranscript: "Note B")
        try TestHelpers.saveAndWait(ctx)

        let details1 = NoteWithDetails.from(note1)
        let details2 = NoteWithDetails.from(note2)
        let details1Copy = NoteWithDetails.from(note1)

        #expect(details1 != details2)
        #expect(details1 == details1Copy)
    }
}
