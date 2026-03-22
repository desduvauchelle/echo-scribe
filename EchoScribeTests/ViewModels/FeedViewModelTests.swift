import Testing
import CoreData
@testable import Echo_Scribe

@MainActor
@Suite("FeedViewModel")
struct FeedViewModelTests {

    // MARK: - Helpers

    private func makeContext() -> NSManagedObjectContext {
        TestHelpers.makePersistence().viewContext
    }

    // MARK: - Initial State

    @Test("loads notes on init")
    func loadsNotesOnInit() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Hello world")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Hello world")
    }

    @Test("empty feed when no notes exist")
    func emptyFeed() {
        let ctx = makeContext()
        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.isEmpty)
        #expect(vm.errorMessage == nil)
    }

    // MARK: - Search Filtering

    @Test("search filters by rawTranscript")
    func searchFiltersByTranscript() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Buy groceries")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Schedule meeting")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)

        vm.searchText = "groceries"
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Buy groceries")
    }

    @Test("search filters by processedText")
    func searchFiltersByProcessedText() throws {
        let ctx = makeContext()
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "raw text")
        note.processedText = "Cleaned up meeting notes"
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.searchText = "meeting"
        #expect(vm.notes.count == 1)
    }

    @Test("search is case insensitive")
    func searchCaseInsensitive() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Important Meeting")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.searchText = "important"
        #expect(vm.notes.count == 1)
    }

    // MARK: - Project Filtering

    @Test("filter by project")
    func filterByProject() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Work note", project: project)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Personal note")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)

        vm.selectedProjectId = project.id.uuidString
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Work note")
    }

    // MARK: - Tag Filtering

    @Test("filter by tag")
    func filterByTag() throws {
        let ctx = makeContext()
        let tag = TestHelpers.makeTag(in: ctx, name: "urgent")
        let note = TestHelpers.makeNote(in: ctx, rawTranscript: "Urgent task")
        note.addToTags(tag)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Normal task")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)

        vm.selectedTags = [tag.id.uuidString]
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Urgent task")
    }

    // MARK: - Date Range Filtering

    @Test("filter by date range")
    func filterByDateRange() throws {
        let ctx = makeContext()
        let calendar = Calendar.current
        let today = Date()
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        let lastWeek = calendar.date(byAdding: .day, value: -7, to: today)!

        TestHelpers.makeNote(in: ctx, rawTranscript: "Today note", createdAt: today)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Last week note", createdAt: lastWeek)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)

        vm.dateRange = yesterday...today
        #expect(vm.notes.count == 1)
        #expect(vm.notes.first?.note.rawTranscript == "Today note")
    }

    // MARK: - Clear Filters

    @Test("clearFilters resets all filters")
    func clearFiltersResetsAll() throws {
        let ctx = makeContext()
        let project = TestHelpers.makeProject(in: ctx, name: "Work")
        TestHelpers.makeNote(in: ctx, rawTranscript: "Work note", project: project)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Other note")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        vm.selectedProjectId = project.id.uuidString
        #expect(vm.notes.count == 1)

        vm.clearFilters()
        #expect(vm.notes.count == 2)
        #expect(vm.selectedProjectId == nil)
        #expect(vm.selectedTags.isEmpty)
        #expect(vm.searchText.isEmpty)
        #expect(vm.dateRange == nil)
    }

    // MARK: - Delete

    @Test("deleteNote removes note from feed")
    func deleteNoteRemovesFromFeed() throws {
        let ctx = makeContext()
        TestHelpers.makeNote(in: ctx, rawTranscript: "To delete")
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 1)

        let noteDetail = vm.notes.first!
        vm.deleteNote(noteDetail)
        #expect(vm.notes.isEmpty)
    }

    // MARK: - Sort Order

    @Test("notes are sorted newest first")
    func notesSortedNewestFirst() throws {
        let ctx = makeContext()
        let calendar = Calendar.current
        let now = Date()
        TestHelpers.makeNote(in: ctx, rawTranscript: "Older", createdAt: calendar.date(byAdding: .hour, value: -2, to: now)!)
        TestHelpers.makeNote(in: ctx, rawTranscript: "Newer", createdAt: now)
        try TestHelpers.saveAndWait(ctx)

        let vm = FeedViewModel(context: ctx)
        #expect(vm.notes.count == 2)
        #expect(vm.notes.first?.note.rawTranscript == "Newer")
        #expect(vm.notes.last?.note.rawTranscript == "Older")
    }
}
