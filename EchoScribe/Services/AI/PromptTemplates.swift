import Foundation

enum PromptTemplates {
    static func noteAnalysisPrompt(transcript: String, existingProjects: [(name: String, description: String?)], existingTags: [String]) -> String {
        let projectList: String
        if existingProjects.isEmpty {
            projectList = "None yet"
        } else {
            projectList = existingProjects.map { project in
                if let desc = project.description, !desc.isEmpty {
                    return "- \(project.name): \(desc)"
                } else {
                    return "- \(project.name)"
                }
            }.joined(separator: "\n")
        }
        let tagList = existingTags.isEmpty ? "None yet" : existingTags.joined(separator: ", ")

        return """
        You are a note analysis assistant. Given a raw voice transcript, extract:
        1. A cleaned-up version of the text (fix speech artifacts, filler words, grammar)
        2. A one-line summary
        3. Any actionable tasks (each with optional due date in YYYY-MM-DD format)
        4. A project assignment using the projectAction tool call (see below)
        5. Up to 5 relevant tags (lowercase, single words or short phrases). Prefer reusing existing tags when they fit.

        Existing projects:
        \(projectList)

        Existing tags: \(tagList)

        PROJECT ASSIGNMENT RULES (projectAction):
        You MUST decide how to handle the project for this note using the "projectAction" field:
        - Use {"action": "assign", "name": "<existing project name>"} to assign to an existing project. Use the project descriptions above to determine which project best fits the note content.
        - Use {"action": "create", "name": "<new name>", "reason": "<why>", "color": "<hex>", "description": "<one-line description>"} to create a NEW project. Only do this when the note clearly represents a distinct new initiative, topic, or area of work that does not fit any existing project. Provide a short reason, a hex color (e.g. "#34C759"), and a brief description of what this project is about.
        - If the note is too vague or general, assign to "General".
        - Do NOT create a new project for one-off thoughts or minor topics.

        Respond ONLY with valid JSON in this exact format:
        {
          "processedText": "...",
          "summary": "...",
          "tasks": [{"title": "...", "dueDate": "YYYY-MM-DD or null"}],
          "projectAction": {"action": "assign or create", "name": "...", "reason": "only if create", "color": "#hex only if create", "description": "only if create"},
          "tags": ["..."]
        }

        Transcript: "\(transcript)"
        """
    }
}
