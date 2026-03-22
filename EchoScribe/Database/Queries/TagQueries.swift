import Foundation
import GRDB

extension AppDatabase {

    // MARK: - Tags

    func fetchAllTags() throws -> [Tag] {
        try dbQueue.read { db in
            try Tag.order(Column("name")).fetchAll(db)
        }
    }

    func findOrCreateTag(name: String) throws -> Tag {
        try dbQueue.write { db in
            if let existing = try Tag.filter(Column("name") == name).fetchOne(db) {
                return existing
            }
            var tag = Tag(name: name)
            try tag.insert(db)
            return tag
        }
    }
}
