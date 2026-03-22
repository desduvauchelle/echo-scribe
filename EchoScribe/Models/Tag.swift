import Foundation
import GRDB

struct Tag: Codable, Identifiable, Equatable, Hashable {
    var id: String
    var name: String

    init(id: String = UUID().uuidString, name: String) {
        self.id = id
        self.name = name
    }
}

extension Tag: FetchableRecord, PersistableRecord {
    static let databaseTableName = "tag"

    static let noteTags = hasMany(NoteTag.self)
    static let notes = hasMany(Note.self, through: noteTags, using: NoteTag.note)
}
