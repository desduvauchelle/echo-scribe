import CoreData
import SwiftUI

@MainActor
@Observable
final class ProjectsViewModel: NSObject, NSFetchedResultsControllerDelegate {
    var projects: [ProjectWithCount] = []
    var errorMessage: String?

    private let context: NSManagedObjectContext
    private var frc: NSFetchedResultsController<CDProject>?

    init(context: NSManagedObjectContext) {
        self.context = context
        super.init()
        setupFRC()
    }

    private func setupFRC() {
        let request: NSFetchRequest<CDProject> = CDProject.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "name", ascending: true)]

        let controller = NSFetchedResultsController(
            fetchRequest: request,
            managedObjectContext: context,
            sectionNameKeyPath: nil,
            cacheName: nil
        )
        controller.delegate = self
        frc = controller

        do {
            try controller.performFetch()
            refreshProjects()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refreshProjects() {
        projects = (frc?.fetchedObjects ?? []).map { project in
            let noteCount = (project.notes as? Set<CDNote>)?.count ?? 0
            return ProjectWithCount(project: project, noteCount: noteCount)
        }
    }

    // MARK: - NSFetchedResultsControllerDelegate

    nonisolated func controllerDidChangeContent(
        _ controller: NSFetchedResultsController<NSFetchRequestResult>
    ) {
        Task { @MainActor [weak self] in
            self?.refreshProjects()
        }
    }

    // MARK: - Actions

    func createProject(name: String, color: String = "#007AFF", description: String? = nil) {
        _ = CDProject.insert(in: context, name: name, color: color, projectDescription: description)
        PersistenceController.shared.save(context: context)
    }

    func updateProjectDescription(_ project: CDProject, description: String?) {
        project.projectDescription = description
        project.updatedAt = Date()
        PersistenceController.shared.save(context: context)
    }

    func deleteProject(_ project: CDProject) {
        context.delete(project)
        PersistenceController.shared.save(context: context)
    }

    var totalNoteCount: Int {
        projects.reduce(0) { $0 + $1.noteCount }
    }
}
