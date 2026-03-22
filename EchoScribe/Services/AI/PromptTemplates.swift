import Foundation

enum PromptTemplates {
    static func noteAnalysisPrompt(transcript: String, existingProjects: [String]) -> String {
        let projectList = existingProjects.isEmpty ? "None yet" : existingProjects.joined(separator: ", ")

        return """
        You are a note analysis assistant. Given a raw voice transcript, extract:
        1. A cleaned-up version of the text (fix speech artifacts, filler words, grammar)
        2. A one-line summary
        3. Any actionable tasks (each with optional due date in YYYY-MM-DD format)
        4. A suggested project name from the existing list, or a new short name if none fit. Use "General" if unclear.
        5. Up to 5 relevant tags (lowercase, single words or short phrases)

        Existing projects: \(projectList)

        Respond ONLY with valid JSON in this exact format:
        {
          "processedText": "...",
          "summary": "...",
          "tasks": [{"title": "...", "dueDate": "YYYY-MM-DD or null"}],
          "project": "...",
          "tags": ["..."]
        }

        Transcript: "\(transcript)"
        """
    }
}
