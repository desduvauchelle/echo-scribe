import Foundation

struct NoteAnalysis: Codable {
    let processedText: String
    let summary: String
    let tasks: [ExtractedTask]
    let projectAction: ProjectAction
    let tags: [String]

    /// Backwards compatibility: falls back to assign action with the raw project name.
    let project: String?

    struct ExtractedTask: Codable {
        let title: String
        let dueDate: String?
    }

    struct ProjectAction: Codable {
        let action: ActionType
        let name: String
        let reason: String?
        let color: String?
        let description: String?

        enum ActionType: String, Codable {
            case assign
            case create
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        processedText = try container.decode(String.self, forKey: .processedText)
        summary = try container.decode(String.self, forKey: .summary)
        tasks = try container.decodeIfPresent([ExtractedTask].self, forKey: .tasks) ?? []
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        project = try container.decodeIfPresent(String.self, forKey: .project)

        // Support both new projectAction format and legacy project string
        if let action = try? container.decode(ProjectAction.self, forKey: .projectAction) {
            projectAction = action
        } else {
            let projectName = project ?? "General"
            projectAction = ProjectAction(action: .assign, name: projectName, reason: nil, color: nil, description: nil)
        }
    }
}

extension NoteAnalysis {
    /// Convenience for fallback analysis
    init(processedText: String, summary: String, tasks: [ExtractedTask], projectName: String, tags: [String]) {
        self.processedText = processedText
        self.summary = summary
        self.tasks = tasks
        self.projectAction = ProjectAction(action: .assign, name: projectName, reason: nil, color: nil, description: nil)
        self.project = projectName
        self.tags = tags
    }
}
