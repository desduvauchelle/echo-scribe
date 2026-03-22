import Foundation
import GRDB

/// Named `NoteTask` to avoid conflict with Swift's `Task` type.
struct NoteTask: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var dueDate: Date?
    var isCompleted: Bool
    var noteId: String?
    var projectId: String?
    var createdAt: Date

    init(
        id: String = UUID().uuidString,
        title: String,
        dueDate: Date? = nil,
        isCompleted: Bool = false,
        noteId: String? = nil,
        projectId: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.dueDate = dueDate
        self.isCompleted = isCompleted
        self.noteId = noteId
        self.projectId = projectId
        self.createdAt = createdAt
    }
}

extension NoteTask: FetchableRecord, PersistableRecord {
    static let databaseTableName = "task"

    static let note = belongsTo(Note.self)
    static let project = belongsTo(Project.self)

    var note: QueryInterfaceRequest<Note> {
        request(for: NoteTask.note)
    }

    var project: QueryInterfaceRequest<Project> {
        request(for: NoteTask.project)
    }
}
