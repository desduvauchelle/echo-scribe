import Foundation
import GRDB

final class AppDatabase: Sendable {
    let dbQueue: DatabaseQueue

    init(_ dbQueue: DatabaseQueue) throws {
        self.dbQueue = dbQueue
        try migrator.migrate(dbQueue)
    }

    private var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        #if DEBUG
        migrator.eraseDatabaseOnSchemaChange = true
        #endif

        migrator.registerMigration("v1_createSchema") { db in
            try db.create(table: "project") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("color", .text).notNull().defaults(to: "#007AFF")
                t.column("createdAt", .datetime).notNull()
                t.column("updatedAt", .datetime).notNull()
            }

            try db.create(table: "note") { t in
                t.primaryKey("id", .text)
                t.column("rawTranscript", .text).notNull()
                t.column("processedText", .text)
                t.column("summary", .text)
                t.column("projectId", .text).references("project", onDelete: .setNull)
                t.column("createdAt", .datetime).notNull()
                t.column("updatedAt", .datetime).notNull()
                t.column("audioFilePath", .text)
                t.column("isProcessed", .boolean).notNull().defaults(to: false)
            }

            try db.create(table: "task") { t in
                t.primaryKey("id", .text)
                t.column("title", .text).notNull()
                t.column("dueDate", .datetime)
                t.column("isCompleted", .boolean).notNull().defaults(to: false)
                t.column("noteId", .text).references("note", onDelete: .cascade)
                t.column("projectId", .text).references("project", onDelete: .setNull)
                t.column("createdAt", .datetime).notNull()
            }

            try db.create(table: "tag") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull().unique()
            }

            try db.create(table: "noteTag") { t in
                t.column("noteId", .text).notNull().references("note", onDelete: .cascade)
                t.column("tagId", .text).notNull().references("tag", onDelete: .cascade)
                t.primaryKey(["noteId", "tagId"])
            }
        }

        return migrator
    }
}

extension AppDatabase {
    static let shared = makeShared()

    private static func makeShared() -> AppDatabase {
        do {
            let appSupportURL = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            ).appendingPathComponent("EchoScribe", isDirectory: true)

            try FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)

            let dbURL = appSupportURL.appendingPathComponent("db.sqlite")
            let dbQueue = try DatabaseQueue(path: dbURL.path)
            return try AppDatabase(dbQueue)
        } catch {
            fatalError("Failed to initialize database: \(error)")
        }
    }

    /// In-memory database for previews and tests
    static func empty() throws -> AppDatabase {
        let dbQueue = try DatabaseQueue(configuration: .init())
        return try AppDatabase(dbQueue)
    }
}
