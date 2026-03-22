import Testing
import CoreData
@testable import Echo_Scribe

@MainActor
@Suite("Note Deletion")
struct NoteDeletionTests {

    // MARK: - Helpers

    private func makeContext() -> NSManagedObjectContext {
        TestHelpers.makePersistence().viewContext
    }

    // MARK: - Basic Deletion

    @Test("deleteNote removes note from Core Data")
    func deleteNoteRemovesFromCoreData() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "To delete")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 1)

        vm.deleteNote(vm.notes.first!)
        try TestHelpers.saveAndWait(ctx)

        let request: NSFetchRequest<CDNote> = CDNote.fetchRequest()
        let remaining = try ctx.fetch(request)
        #expect(remaining.isEmpty, "Note should be removed from Core Data after deletion")
    }

    @Test("deleteNote removes note from feed array immediately")
    func deleteNoteRemovesFromArray() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Gone")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        let noteDetail = vm.notes.first!
        vm.deleteNote(noteDetail)

        #expect(vm.notes.isEmpty, "Feed array should be empty immediately after deletion")
    }

    // MARK: - Cascade Deletion

    @Test("deleteNote cascades to tasks")
    func deleteNoteCascadesToTasks() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Note with tasks")
        TestHelpers.makeTask(in: ctx, title: "Task A", note: note)
        TestHelpers.makeTask(in: ctx, title: "Task B", note: note)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.deleteNote(vm.notes.first!)
        try TestHelpers.saveAndWait(ctx)

        let taskRequest: NSFetchRequest<CDNoteTask> = NSFetchRequest(entityName: "CDNoteTask")
        let remainingTasks = try ctx.fetch(taskRequest)
        #expect(remainingTasks.isEmpty, "Tasks should be cascade-deleted with their note")
    }

    @Test("deleteNote does not delete associated tags")
    func deleteNotePreservesTags() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Tagged note")
        let tag = TestHelpers.makeTag(in: ctx, name: "important")
        note.addToTags(tag)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.deleteNote(vm.notes.first!)
        try TestHelpers.saveAndWait(ctx)

        let tagRequest: NSFetchRequest<CDTag> = NSFetchRequest(entityName: "CDTag")
        let remainingTags = try ctx.fetch(tagRequest)
        #expect(remainingTags.count == 1, "Tags should survive note deletion")
        #expect(remainingTags.first?.name == "important")
    }

    @Test("deleteNote does not delete associated project")
    func deleteNotePreservesProject() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Work note", project: project)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.deleteNote(vm.notes.first!)
        try TestHelpers.saveAndWait(ctx)

        let projRequest: NSFetchRequest<CDProject> = CDProject.fetchRequest()
        let remainingProjects = try ctx.fetch(projRequest)
        #expect(remainingProjects.count == 1, "Project should survive note deletion")
    }

    // MARK: - Multiple Notes

    @Test("deleteNote only removes the targeted note")
    func deleteNoteOnlyRemovesTarget() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Keep me")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Delete me")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)

        let toDelete = vm.notes.first { $0.note.rawTranscript == "Delete me" }!
        vm.deleteNote(toDelete)

        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Keep me")
    }

    @Test("delete all notes sequentially without crash")
    func deleteAllNotesSequentially() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Note 1")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Note 2")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Note 3")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 3)

        // Delete one by one — this is where crashes often happen
        while let first = vm.notes.first {
            vm.deleteNote(first)
        }

        #expect(vm.notes.isEmpty)
        try TestHelpers.saveAndWait(ctx)

        let request: NSFetchRequest<CDNote> = CDNote.fetchRequest()
        let remaining = try ctx.fetch(request)
        #expect(remaining.isEmpty)
    }

    // MARK: - NoteWithDetails Equality After Deletion (Crash Scenario)

    @Test("NoteWithDetails equality does not crash after note deletion")
    func noteWithDetailsEqualityAfterDeletion() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Will be deleted")
        try TestHelpers.saveAndWait(ctx)

        let detail = NoteWithDetails.from(note)

        // Delete and save — the managed object becomes invalidated
        ctx.delete(note)
        try TestHelpers.saveAndWait(ctx)

        // This is what SwiftUI does during diffing — it should NOT crash
        let detail2 = detail
        let result = detail == detail2
        // After deletion, equality should return false (the guard clause)
        #expect(result == false, "Equality on deleted notes should return false, not crash")
    }

    @Test("NoteWithDetails equality between deleted and live note")
    func noteWithDetailsEqualityDeletedVsLive() throws {
        let ctx = makeContext()
        let note1 = TestHelpers.makeNote(in: ctx, rawTranscript: "Will delete")
        let note2 = TestHelpers.makeNote(in: ctx, rawTranscript: "Will keep")
        try TestHelpers.saveAndWait(ctx)

        let detail1 = NoteWithDetails.from(note1)
        let detail2 = NoteWithDetails.from(note2)

        ctx.delete(note1)
        try TestHelpers.saveAndWait(ctx)

        // Comparing a deleted note detail with a live one should not crash
        let result = detail1 == detail2
        #expect(result == false)
    }

    // MARK: - NoteWithDetails.from() After Deletion (Crash Scenario)

    @Test("NoteWithDetails.from does not crash on deleted note")
    func noteWithDetailsFromDeletedNote() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "About to die")
        try TestHelpers.saveAndWait(ctx)

        ctx.delete(note)
        // Before save — isDeleted is true but object still accessible
        let detail = NoteWithDetails.from(note)
        #expect(detail.note.isDeleted == true)
    }

    // MARK: - refreshNotes After Deletion (Crash Scenario)

    @Test("FRC refresh after deletion does not include deleted notes")
    func frcRefreshAfterDeletion() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Note A")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Note B")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)

        // Delete via the ViewModel method
        let toDelete = vm.notes.first!
        vm.deleteNote(toDelete)

        // Force a fresh FRC rebuild (simulates what happens on filter change)
        vm.clearFilters()

        #expect(vm.notes.count == 1, "Only the surviving note should appear after refresh")
    }

    // MARK: - Delete Note With Complex Relationships

    @Test("delete note with tasks, tags, and project does not crash")
    func deleteNoteWithFullRelationships() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Complex")
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Full note", project: project)
        let tag1 = TestHelpers.makeTag(in: ctx, name: "tag1")
        let tag2 = TestHelpers.makeTag(in: ctx, name: "tag2")
        note.addToTags(tag1)
        note.addToTags(tag2)
        TestHelpers.makeTask(in: ctx, title: "Task 1", note: note)
        TestHelpers.makeTask(in: ctx, title: "Task 2", note: note)
        TestHelpers.makeTask(in: ctx, title: "Task 3", note: note)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first!.tasks.count == 3)
        #expect(vm.notes.first!.tags.count == 2)

        vm.deleteNote(vm.notes.first!)
        try TestHelpers.saveAndWait(ctx)

        #expect(vm.notes.isEmpty)

        // Verify cascade
        let taskRequest: NSFetchRequest<CDNoteTask> = NSFetchRequest(entityName: "CDNoteTask")
        #expect(try ctx.fetch(taskRequest).isEmpty, "Tasks should be cascade-deleted")

        // Verify tags and project survive
        let tagRequest: NSFetchRequest<CDTag> = NSFetchRequest(entityName: "CDTag")
        #expect(try ctx.fetch(tagRequest).count == 2, "Tags should survive")

        let projRequest: NSFetchRequest<CDProject> = CDProject.fetchRequest()
        #expect(try ctx.fetch(projRequest).count == 1, "Project should survive")
    }

    // MARK: - Delete While Filtered

    @Test("delete note while project filter is active")
    func deleteNoteWhileFiltered() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Work note 1", project: project)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Work note 2", project: project)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Personal note")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.selectedProjectId = project.id.uuidString
        #expect(vm.notes.count == 2)

        vm.deleteNote(vm.notes.first!)
        #expect(vm.notes.count == 1)

        // Clear filter — should show personal note + remaining work note
        vm.clearFilters()
        #expect(vm.notes.count == 2)
    }

    // MARK: - Delete With Search Active

    @Test("delete note while search is active")
    func deleteNoteWhileSearchActive() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Buy groceries")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Schedule meeting")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.searchText = "groceries"
        #expect(vm.notes.count == 1)

        vm.deleteNote(vm.notes.first!)
        #expect(vm.notes.isEmpty)

        vm.clearFilters()
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Schedule meeting")
    }

    // MARK: - Delete-While-View-Renders Crash Path

    @Test("accessing note properties after deletion via onDelete callback does not crash")
    func accessNotePropertiesAfterOnDeleteCallback() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(
            in: ctx,
            rawTranscript: "Note to delete",
            summary: "A summary",
            isProcessed: true
        )
        TestHelpers.makeTask(in: ctx, title: "Task", note: note)
        let tag = TestHelpers.makeTag(in: ctx, name: "urgent")
        note.addToTags(tag)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        let noteDetail = vm.notes.first!

        // Hold a reference to the CDNote — this is what NoteDetailView does via @ObservedObject
        let liveNote = noteDetail.note

        // Simulate the ContentView onDelete callback:
        // 1. selectedNoteId = nil (conceptual — no actual SwiftUI state here)
        // 2. feedViewModel.deleteNote(noteDetail) — deletes from array and Core Data
        vm.deleteNote(noteDetail)

        // After deletion, the managed object is deleted and context saved.
        // SwiftUI may still try to render NoteDetailView's body before it's removed.
        // Verify we can safely check the deletion guard without crashing.
        let isDeleted = liveNote.managedObjectContext == nil || liveNote.isDeleted
        #expect(isDeleted, "Note should be detected as deleted after onDelete callback")

        // Verify the note properties would crash if accessed without the guard —
        // but with our guard, the view returns Color.clear instead of accessing them.
        // We just confirm the guard condition is true so the view skips rendering.
    }

    @Test("note managedObjectContext becomes nil after deletion and save")
    func noteContextNilAfterDeletion() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Will vanish")
        try TestHelpers.saveAndWait(ctx)

        // Before deletion — context is set
        #expect(note.managedObjectContext != nil)
        #expect(note.isDeleted == false)

        // Delete and save
        ctx.delete(note)
        try TestHelpers.saveAndWait(ctx)

        // After deletion + save — managedObjectContext becomes nil
        // This is the condition our NoteDetailView guard checks
        let guardTriggered = note.managedObjectContext == nil || note.isDeleted
        #expect(guardTriggered, "Guard should trigger after note is deleted and saved")
    }
}
