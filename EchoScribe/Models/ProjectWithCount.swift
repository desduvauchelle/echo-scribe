import Foundation

struct ProjectWithCount: Identifiable {
    var id: UUID { project.id }
    var project: CDProject
    var noteCount: Int
    let name: String
    let color: String
    let projectDescription: String?

    init(project: CDProject, noteCount: Int) {
        self.project = project
        self.noteCount = noteCount
        self.name = project.name
        self.color = project.color
        self.projectDescription = project.projectDescription
    }
}
