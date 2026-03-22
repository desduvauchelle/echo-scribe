import Foundation
import GRDB

struct Note: Codable, Identifiable, Equatable {
    var id: String
    var rawTranscript: String
    var processedText: String?
    var summary: String?
    var projectId: String?
    var createdAt: Date
    var updatedAt: Date
    var audioFilePath: String?
    var isProcessed: Bool

    init(
        id: String = UUID().uuidString,
        rawTranscript: String,
        processedText: String? = nil,
        summary: String? = nil,
        projectId: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        audioFilePath: String? = nil,
        isProcessed: Bool = false
    ) {
        self.id = id
        self.rawTranscript = rawTranscript
        self.processedText = processedText
        self.summary = summary
        self.projectId = projectId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.audioFilePath = audioFilePath
        self.isProcessed = isProcessed
    }

    var displayText: String {
        processedText ?? rawTranscript
    }
}

extension Note: FetchableRecord, PersistableRecord {
    static let databaseTableName = "note"

    static let project = belongsTo(Project.self)
    static let tasks = hasMany(NoteTask.self)
    static let noteTags = hasMany(NoteTag.self)
    static let tags = hasMany(Tag.self, through: noteTags, using: NoteTag.tag)

    var project: QueryInterfaceRequest<Project> {
        request(for: Note.project)
    }

    var tasks: QueryInterfaceRequest<NoteTask> {
        request(for: Note.tasks)
    }

    var tags: QueryInterfaceRequest<Tag> {
        request(for: Note.tags)
    }
}
