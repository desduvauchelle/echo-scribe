import Foundation

struct NoteWithDetails: Identifiable, Equatable {
    var note: CDNote
    var project: CDProject?
    var tasks: [CDNoteTask]
    var tags: [CDTag]

    var id: UUID { note.id }

    static func == (lhs: NoteWithDetails, rhs: NoteWithDetails) -> Bool {
        // After a managed object is deleted and context saved, accessing @NSManaged
        // properties (even isDeleted) can crash because the object becomes an
        // unfulfillable fault. Check managedObjectContext == nil as a safe indicator
        // that the object has been deleted from its store.
        guard lhs.note.managedObjectContext != nil,
              rhs.note.managedObjectContext != nil,
              !lhs.note.isDeleted,
              !rhs.note.isDeleted else { return false }
        return lhs.note.objectID == rhs.note.objectID &&
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
