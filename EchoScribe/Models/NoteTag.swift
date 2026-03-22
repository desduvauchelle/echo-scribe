import Foundation
import GRDB

struct NoteTag: Codable, Equatable {
    var noteId: String
    var tagId: String
}

extension NoteTag: FetchableRecord, PersistableRecord {
    static let databaseTableName = "noteTag"

    static let note = belongsTo(Note.self)
    static let tag = belongsTo(Tag.self)
}
