import Foundation
import GRDB
import SwiftUI

@MainActor
@Observable
final class FeedViewModel {
    var notes: [NoteWithDetails] = []
    var isLoading = false
    var errorMessage: String?

    // Filters
    var selectedProjectId: String?
    var selectedTags: Set<String> = []
    var searchText = ""
    var dateRange: ClosedRange<Date>?

    private let database: AppDatabase
    private var observation: AnyDatabaseCancellable?

    init(database: AppDatabase) {
        self.database = database
        startObservation()
    }

    func startObservation() {
        let observation = ValueObservation.tracking { db -> [NoteWithDetails] in
            let notes = try Note.order(Column("createdAt").desc).fetchAll(db)
            return try notes.map { note in
                let project = try note.project.fetchOne(db)
                let tasks = try note.tasks.fetchAll(db)
                let tags = try note.tags.fetchAll(db)
                return NoteWithDetails(note: note, project: project, tasks: tasks, tags: tags)
            }
        }

        self.observation = observation.start(in: database.dbQueue, onError: { [weak self] error in
            self?.errorMessage = error.localizedDescription
        }, onChange: { [weak self] noteDetails in
            guard let self else { return }
            self.notes = self.applyFilters(to: noteDetails)
        })
    }

    private func applyFilters(to notes: [NoteWithDetails]) -> [NoteWithDetails] {
        var filtered = notes

        if let projectId = selectedProjectId {
            filtered = filtered.filter { $0.note.projectId == projectId }
        }

        if !selectedTags.isEmpty {
            filtered = filtered.filter { noteDetail in
                let tagIds = Set(noteDetail.tags.map(\.id))
                return !selectedTags.isDisjoint(with: tagIds)
            }
        }

        if !searchText.isEmpty {
            let search = searchText.lowercased()
            filtered = filtered.filter { noteDetail in
                noteDetail.note.displayText.lowercased().contains(search) ||
                (noteDetail.note.summary?.lowercased().contains(search) ?? false)
            }
        }

        if let dateRange {
            filtered = filtered.filter { dateRange.contains($0.note.createdAt) }
        }

        return filtered
    }

    func deleteNote(_ noteDetail: NoteWithDetails) {
        do {
            try database.deleteNote(id: noteDetail.note.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearFilters() {
        selectedProjectId = nil
        selectedTags = []
        searchText = ""
        dateRange = nil
        startObservation()
    }
}
