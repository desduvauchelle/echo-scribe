import Foundation
import GRDB
import SwiftUI

@MainActor
@Observable
final class ProjectsViewModel {
    var projects: [ProjectWithCount] = []
    var errorMessage: String?

    private let database: AppDatabase
    private var observation: AnyDatabaseCancellable?

    init(database: AppDatabase) {
        self.database = database
        startObservation()
    }

    func startObservation() {
        let observation = ValueObservation.tracking { db -> [ProjectWithCount] in
            let projects = try Project.order(Column("name")).fetchAll(db)
            return try projects.map { project in
                let count = try project.notes.fetchCount(db)
                return ProjectWithCount(project: project, noteCount: count)
            }
        }

        self.observation = observation.start(in: database.dbQueue, onError: { [weak self] error in
            self?.errorMessage = error.localizedDescription
        }, onChange: { [weak self] projects in
            self?.projects = projects
        })
    }

    func createProject(name: String, color: String = "#007AFF") {
        do {
            var project = Project(name: name, color: color)
            try database.saveProject(&project)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteProject(_ project: Project) {
        do {
            try database.deleteProject(id: project.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    var totalNoteCount: Int {
        projects.reduce(0) { $0 + $1.noteCount }
    }
}
