import Testing
import Foundation
@testable import Echo_Scribe

@Suite("NoteAnalysis")
struct NoteAnalysisTests {

    // MARK: - JSON Decoding

    @Test("decodes full JSON with projectAction")
    func decodesFullJSON() throws {
        let json = """
        {
          "processedText": "Schedule a meeting with the design team",
          "summary": "Design team meeting",
          "tasks": [{"title": "Book conference room", "dueDate": "2026-04-01"}],
          "projectAction": {"action": "assign", "name": "Work", "reason": null, "color": null, "description": null},
          "tags": ["meeting", "design"]
        }
        """
        let data = json.data(using: .utf8)!
        let analysis = try JSONDecoder().decode(NoteAnalysis.self, from: data)

        #expect(analysis.processedText == "Schedule a meeting with the design team")
        #expect(analysis.summary == "Design team meeting")
        #expect(analysis.tasks.count == 1)
        #expect(analysis.tasks.first?.title == "Book conference room")
        #expect(analysis.tasks.first?.dueDate == "2026-04-01")
        #expect(analysis.projectAction.action == .assign)
        #expect(analysis.projectAction.name == "Work")
        #expect(analysis.tags == ["meeting", "design"])
    }

    @Test("decodes JSON with create projectAction")
    func decodesCreateProjectAction() throws {
        let json = """
        {
          "processedText": "Start new garden project",
          "summary": "Garden planning",
          "tasks": [],
          "projectAction": {"action": "create", "name": "Garden", "reason": "New hobby", "color": "#34C759", "description": "Home garden project"},
          "tags": ["garden"]
        }
        """
        let data = json.data(using: .utf8)!
        let analysis = try JSONDecoder().decode(NoteAnalysis.self, from: data)

        #expect(analysis.projectAction.action == .create)
        #expect(analysis.projectAction.name == "Garden")
        #expect(analysis.projectAction.reason == "New hobby")
        #expect(analysis.projectAction.color == "#34C759")
        #expect(analysis.projectAction.description == "Home garden project")
    }

    @Test("falls back to legacy project string when projectAction missing")
    func fallsBackToLegacyProject() throws {
        let json = """
        {
          "processedText": "Some text",
          "summary": "Summary",
          "project": "Legacy Project"
        }
        """
        let data = json.data(using: .utf8)!
        let analysis = try JSONDecoder().decode(NoteAnalysis.self, from: data)

        #expect(analysis.projectAction.action == .assign)
        #expect(analysis.projectAction.name == "Legacy Project")
        #expect(analysis.project == "Legacy Project")
    }

    @Test("defaults to General when no project info provided")
    func defaultsToGeneral() throws {
        let json = """
        {
          "processedText": "Random thought",
          "summary": "Thought"
        }
        """
        let data = json.data(using: .utf8)!
        let analysis = try JSONDecoder().decode(NoteAnalysis.self, from: data)

        #expect(analysis.projectAction.action == .assign)
        #expect(analysis.projectAction.name == "General")
    }

    @Test("handles missing optional arrays gracefully")
    func handlesMissingArrays() throws {
        let json = """
        {
          "processedText": "Simple note",
          "summary": "Note"
        }
        """
        let data = json.data(using: .utf8)!
        let analysis = try JSONDecoder().decode(NoteAnalysis.self, from: data)

        #expect(analysis.tasks.isEmpty)
        #expect(analysis.tags.isEmpty)
    }

    // MARK: - Convenience Init

    @Test("convenience init creates assign projectAction")
    func convenienceInit() {
        let analysis = NoteAnalysis(
            processedText: "Test text",
            summary: "Test",
            tasks: [NoteAnalysis.ExtractedTask(title: "Do thing", dueDate: nil)],
            projectName: "My Project",
            tags: ["tag1"]
        )

        #expect(analysis.processedText == "Test text")
        #expect(analysis.projectAction.action == .assign)
        #expect(analysis.projectAction.name == "My Project")
        #expect(analysis.tasks.count == 1)
        #expect(analysis.tags == ["tag1"])
    }
}
