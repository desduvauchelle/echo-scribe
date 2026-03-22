import Foundation
import GRDB

struct Project: Codable, Identifiable, Equatable, Hashable {
    var id: String
    var name: String
    var color: String
    var createdAt: Date
    var updatedAt: Date

    init(id: String = UUID().uuidString, name: String, color: String = "#007AFF", createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id
        self.name = name
        self.color = color
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

extension Project: FetchableRecord, PersistableRecord {
    static let databaseTableName = "project"

    static let notes = hasMany(Note.self)
    static let tasks = hasMany(NoteTask.self)

    var notes: QueryInterfaceRequest<Note> {
        request(for: Project.notes)
    }

    var tasks: QueryInterfaceRequest<NoteTask> {
        request(for: Project.tasks)
    }
}
