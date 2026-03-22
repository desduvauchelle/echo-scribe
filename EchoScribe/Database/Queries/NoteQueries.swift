import Foundation
import GRDB

struct NoteWithDetails: Equatable {
    var note: Note
    var project: Project?
    var tasks: [NoteTask]
    var tags: [Tag]
}

extension AppDatabase {

    // MARK: - Notes

    func saveNote(_ note: inout Note) throws {
        try dbQueue.write { db in
            try note.save(db)
        }
    }

    func deleteNote(id: String) throws {
        try dbQueue.write { db in
            _ = try Note.deleteOne(db, id: id)
        }
    }

    func fetchNote(id: String) throws -> Note? {
        try dbQueue.read { db in
            try Note.fetchOne(db, id: id)
        }
    }

    func fetchAllNotes(
        projectId: String? = nil,
        searchText: String? = nil,
        isProcessed: Bool? = nil
    ) throws -> [Note] {
        try dbQueue.read { db in
            var request = Note.all().order(Column("createdAt").desc)

            if let projectId {
                request = request.filter(Column("projectId") == projectId)
            }
            if let searchText, !searchText.isEmpty {
                request = request.filter(
                    Column("rawTranscript").like("%\(searchText)%") ||
                    Column("processedText").like("%\(searchText)%")
                )
            }
            if let isProcessed {
                request = request.filter(Column("isProcessed") == isProcessed)
            }

            return try request.fetchAll(db)
        }
    }

    func fetchNoteWithDetails(id: String) throws -> NoteWithDetails? {
        try dbQueue.read { db in
            guard let note = try Note.fetchOne(db, id: id) else { return nil }
            let project = try note.project.fetchOne(db)
            let tasks = try note.tasks.fetchAll(db)
            let tags = try note.tags.fetchAll(db)
            return NoteWithDetails(note: note, project: project, tasks: tasks, tags: tags)
        }
    }

    func fetchAllNotesWithDetails(
        projectId: String? = nil,
        tagIds: Set<String>? = nil,
        searchText: String? = nil,
        dateRange: ClosedRange<Date>? = nil
    ) throws -> [NoteWithDetails] {
        try dbQueue.read { db in
            var request = Note.all().order(Column("createdAt").desc)

            if let projectId {
                request = request.filter(Column("projectId") == projectId)
            }
            if let searchText, !searchText.isEmpty {
                request = request.filter(
                    Column("rawTranscript").like("%\(searchText)%") ||
                    Column("processedText").like("%\(searchText)%")
                )
            }
            if let dateRange {
                request = request.filter(
                    Column("createdAt") >= dateRange.lowerBound &&
                    Column("createdAt") <= dateRange.upperBound
                )
            }

            var notes = try request.fetchAll(db)

            // Filter by tags if specified
            if let tagIds, !tagIds.isEmpty {
                notes = try notes.filter { note in
                    let noteTagIds = try note.tags.fetchAll(db).map(\.id)
                    return !tagIds.isDisjoint(with: noteTagIds)
                }
            }

            return try notes.map { note in
                let project = try note.project.fetchOne(db)
                let tasks = try note.tasks.fetchAll(db)
                let tags = try note.tags.fetchAll(db)
                return NoteWithDetails(note: note, project: project, tasks: tasks, tags: tags)
            }
        }
    }

    func updateNoteWithAIResults(
        noteId: String,
        processedText: String,
        summary: String,
        projectId: String?,
        tasks: [NoteTask],
        tagNames: [String]
    ) throws {
        try dbQueue.write { db in
            guard var note = try Note.fetchOne(db, id: noteId) else { return }

            note.processedText = processedText
            note.summary = summary
            note.projectId = projectId
            note.isProcessed = true
            note.updatedAt = Date()
            try note.update(db)

            for var task in tasks {
                task.noteId = noteId
                task.projectId = projectId
                try task.insert(db)
            }

            for tagName in tagNames {
                var tag: Tag
                if let existing = try Tag.filter(Column("name") == tagName).fetchOne(db) {
                    tag = existing
                } else {
                    tag = Tag(name: tagName)
                    try tag.insert(db)
                }
                let noteTag = NoteTag(noteId: noteId, tagId: tag.id)
                try noteTag.insert(db)
            }
        }
    }

    func reassignNoteProject(noteId: String, projectId: String?) throws {
        try dbQueue.write { db in
            guard var note = try Note.fetchOne(db, id: noteId) else { return }
            note.projectId = projectId
            note.updatedAt = Date()
            try note.update(db)
        }
    }

    func updateNoteText(noteId: String, processedText: String) throws {
        try dbQueue.write { db in
            guard var note = try Note.fetchOne(db, id: noteId) else { return }
            note.processedText = processedText
            note.updatedAt = Date()
            try note.update(db)
        }
    }

    func updateNoteSummary(noteId: String, summary: String) throws {
        try dbQueue.write { db in
            guard var note = try Note.fetchOne(db, id: noteId) else { return }
            note.summary = summary
            note.updatedAt = Date()
            try note.update(db)
        }
    }

    func setNoteTags(noteId: String, tagNames: [String]) throws {
        try dbQueue.write { db in
            try NoteTag.filter(Column("noteId") == noteId).deleteAll(db)
            for tagName in tagNames {
                let tag: Tag
                if let existing = try Tag.filter(Column("name") == tagName).fetchOne(db) {
                    tag = existing
                } else {
                    var newTag = Tag(name: tagName)
                    try newTag.insert(db)
                    tag = newTag
                }
                let noteTag = NoteTag(noteId: noteId, tagId: tag.id)
                try noteTag.insert(db)
            }
        }
    }
}
