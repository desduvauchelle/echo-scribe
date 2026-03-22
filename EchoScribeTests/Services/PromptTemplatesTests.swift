import Testing
@testable import Echo_Scribe

@Suite("PromptTemplates")
struct PromptTemplatesTests {

    @Test("prompt includes transcript text")
    func includesTranscript() {
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: "Buy milk and eggs",
            existingProjects: [],
            existingTags: []
        )
        #expect(prompt.contains("Buy milk and eggs"))
    }

    @Test("prompt includes existing project names")
    func includesProjects() {
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: "test",
            existingProjects: [("Work", "Office tasks"), ("Personal", nil)],
            existingTags: []
        )
        #expect(prompt.contains("Work: Office tasks"))
        #expect(prompt.contains("Personal"))
    }

    @Test("prompt includes existing tags")
    func includesTags() {
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: "test",
            existingProjects: [],
            existingTags: ["meeting", "urgent"]
        )
        #expect(prompt.contains("meeting, urgent"))
    }

    @Test("prompt shows None yet when no projects exist")
    func showsNoneForEmptyProjects() {
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: "test",
            existingProjects: [],
            existingTags: []
        )
        #expect(prompt.contains("None yet"))
    }

    @Test("prompt requests JSON format")
    func requestsJSON() {
        let prompt = PromptTemplates.noteAnalysisPrompt(
            transcript: "test",
            existingProjects: [],
            existingTags: []
        )
        #expect(prompt.contains("processedText"))
        #expect(prompt.contains("projectAction"))
    }
}
