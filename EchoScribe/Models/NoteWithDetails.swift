import Foundation

struct NoteWithDetails: Identifiable, Equatable {
    var note: CDNote
    var project: CDProject?
    var tasks: [CDNoteTask]
    var tags: [CDTag]

    var id: UUID { note.id }

    static func == (lhs: NoteWithDetails, rhs: NoteWithDetails) -> Bool {
        lhs.note.objectID == rhs.note.objectID &&
        lhs.note.updatedAt == rhs.note.updatedAt &&
        lhs.tasks.map(\.objectID) == rhs.tasks.map(\.objectID) &&
        lhs.tags.map(\.objectID) == rhs.tags.map(\.objectID)
    }

    static func from(_ note: CDNote) -> NoteWithDetails {
        NoteWithDetails(
            note: note,
            project: note.project,
            tasks: note.tasksArray,
            tags: note.tagsArray
        )
    }
}
