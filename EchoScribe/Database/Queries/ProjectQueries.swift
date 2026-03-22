import Foundation
import GRDB

struct ProjectWithCount: Equatable {
    var project: Project
    var noteCount: Int
}

extension AppDatabase {

    // MARK: - Projects

    func saveProject(_ project: inout Project) throws {
        try dbQueue.write { db in
            try project.save(db)
        }
    }

    func deleteProject(id: String) throws {
        try dbQueue.write { db in
            _ = try Project.deleteOne(db, id: id)
        }
    }

    func fetchAllProjects() throws -> [Project] {
        try dbQueue.read { db in
            try Project.order(Column("name")).fetchAll(db)
        }
    }

    func fetchProjectsWithCounts() throws -> [ProjectWithCount] {
        try dbQueue.read { db in
            let projects = try Project.order(Column("name")).fetchAll(db)
            return try projects.map { project in
                let count = try project.notes.fetchCount(db)
                return ProjectWithCount(project: project, noteCount: count)
            }
        }
    }

    func findOrCreateProject(name: String) throws -> Project {
        try dbQueue.write { db in
            if let existing = try Project.filter(Column("name") == name).fetchOne(db) {
                return existing
            }
            var project = Project(name: name)
            try project.insert(db)
            return project
        }
    }
}
