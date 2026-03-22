import CoreData
import SwiftUI

@MainActor
@Observable
final class FeedViewModel: NSObject, NSFetchedResultsControllerDelegate {
    var notes: [NoteWithDetails] = []
    var isLoading = false
    var errorMessage: String?

    // Filters — any change automatically rebuilds the fetch (via didSet)
    var selectedProjectId: String? { didSet { if !isClearingFilters { rebuildFRC() } } }
    var selectedTags: Set<String> = [] { didSet { if !isClearingFilters { rebuildFRC() } } }
    var searchText = "" { didSet { if !isClearingFilters { rebuildFRC() } } }
    var dateRange: ClosedRange<Date>? { didSet { if !isClearingFilters { rebuildFRC() } } }

    private let context: NSManagedObjectContext
    private var frc: NSFetchedResultsController<CDNote>?
    private var isClearingFilters = false

    init(context: NSManagedObjectContext) {
        self.context = context
        super.init()
        rebuildFRC()
    }

    // MARK: - FRC Management

    private func rebuildFRC() {
        let request: NSFetchRequest<CDNote> = CDNote.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "createdAt", ascending: false)]
        request.predicate = buildPredicate()
        request.relationshipKeyPathsForPrefetching = ["project", "tags", "tasks"]

        let controller = NSFetchedResultsController(
            fetchRequest: request,
            managedObjectContext: context,
            sectionNameKeyPath: nil,
            cacheName: nil
        )
        controller.delegate = self
        frc = controller

        do {
            try controller.performFetch()
            refreshNotes()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func buildPredicate() -> NSPredicate? {
        var predicates: [NSPredicate] = []

        if let projectIdString = selectedProjectId,
           let uuid = UUID(uuidString: projectIdString) {
            predicates.append(NSPredicate(format: "project.id == %@", uuid as CVarArg))
        }

        if !selectedTags.isEmpty {
            let uuids = selectedTags.compactMap { UUID(uuidString: $0) }
            if !uuids.isEmpty {
                predicates.append(NSPredicate(format: "ANY tags.id IN %@", uuids as CVarArg))
            }
        }

        if !searchText.isEmpty {
            predicates.append(NSPredicate(
                format: "rawTranscript CONTAINS[cd] %@ OR processedText CONTAINS[cd] %@",
                searchText, searchText
            ))
        }

        if let range = dateRange {
            predicates.append(NSPredicate(
                format: "createdAt >= %@ AND createdAt <= %@",
                range.lowerBound as NSDate,
                range.upperBound as NSDate
            ))
        }

        guard !predicates.isEmpty else { return nil }
        return NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
    }

    private func refreshNotes() {
        notes = (frc?.fetchedObjects ?? []).map(NoteWithDetails.from)
    }

    // MARK: - NSFetchedResultsControllerDelegate

    nonisolated func controllerDidChangeContent(
        _ controller: NSFetchedResultsController<NSFetchRequestResult>
    ) {
        Task { @MainActor [weak self] in
            self?.refreshNotes()
        }
    }

    // MARK: - Actions

    func deleteNote(_ noteDetail: NoteWithDetails) {
        context.delete(noteDetail.note)
        PersistenceController.shared.save(context: context)
    }

    func clearFilters() {
        isClearingFilters = true
        selectedProjectId = nil
        selectedTags = []
        searchText = ""
        dateRange = nil
        isClearingFilters = false
        rebuildFRC()
    }

    /// Kept for call-site compatibility — now a no-op alias for rebuildFRC.
    func startObservation() {
        rebuildFRC()
    }
}
